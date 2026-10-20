"""Scryfall's bulk data: what it advertises, bounded downloads and streamed records (CAT01).

The bulk-data list is the only API request a sync makes. Each file is downloaded once into the
catalog folder while its SHA-256 is computed, then read record by record: JSON Lines (gzip), as
Scryfall advertises today in jsonl_download_uri, or a JSON array (download_uri) through a
streaming decoder. Nothing assumes a dated file name or a permanent response shape: a dataset is
found by its type, and its transfer format by the field that names it. Every read is bounded:
compressed and decompressed bytes, one record's size and the time a download may take.
"""

import gzip
import hashlib
import io
import json
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import IO, Any, Literal, cast
from urllib.parse import urlsplit

import httpx

from api.version import APP_VERSION

DATASETS = ("oracle_cards", "default_cards", "rulings", "oracle_tags")
# Bulk files are served from Scryfall's own hosts; a URI elsewhere is refused.
FILE_HOSTS = frozenset({"data.scryfall.io", "api.scryfall.com"})
HEADERS = {"User-Agent": f"CommanderDuels/{APP_VERSION}", "Accept": "application/json"}
CHUNK = 1 << 16


class SyncError(Exception):
    """Why a sync stopped. Transient errors are retried with backoff; the others wait for the
    next scheduled run, since retrying cannot help (CAT sync workflow)."""

    def __init__(self, code: str, message: str, *, transient: bool = False) -> None:
        super().__init__(message)
        self.code, self.message, self.transient = code, message, transient


@dataclass(frozen=True)
class Limits:
    compressed_bytes: int = 1 << 30
    decompressed_bytes: int = 4 << 30
    record_bytes: int = 1 << 20
    download_seconds: float = 1800.0


@dataclass(frozen=True)
class BulkFile:
    dataset: str
    updated_at: datetime
    uri: str
    encoding: Literal["jsonl", "json"]
    compressed_size: int | None


@dataclass(frozen=True)
class Download:
    path: Path
    sha256: str
    compressed_bytes: int
    etag: str | None
    last_modified: str | None


def retry_after(response: httpx.Response) -> str:
    return str(response.headers.get("retry-after", ""))


def discover(client: httpx.Client, base_url: str) -> dict[str, BulkFile]:
    """The advertised file of each dataset this catalog imports."""
    try:
        response = client.get(f"{base_url.rstrip('/')}/bulk-data", headers=HEADERS)
    except httpx.HTTPError as error:
        raise SyncError("scryfall_unreachable", f"Scryfall did not answer: {error}", transient=True)
    if response.status_code == 429:
        raise SyncError(
            "scryfall_rate_limited",
            f"Scryfall asked us to slow down (Retry-After {retry_after(response) or 'unset'}).",
            transient=True,
        )
    if response.status_code >= 500:
        raise SyncError(
            "scryfall_unavailable", f"Scryfall answered {response.status_code}.", transient=True
        )
    if response.status_code != 200:
        raise SyncError("scryfall_refused", f"Scryfall answered {response.status_code}.")
    try:
        listing = response.json()
        items = listing["data"]
        if not isinstance(items, list):
            raise TypeError("data is not a list")
    except (ValueError, KeyError, TypeError) as error:
        raise SyncError("bulk_list_invalid", f"Scryfall's bulk-data list changed shape: {error}")
    found: dict[str, BulkFile] = {}
    for item in items:
        if not isinstance(item, dict) or item.get("type") not in DATASETS:
            continue
        found[item["type"]] = bulk_file(item)
    missing = [dataset for dataset in DATASETS if dataset not in found]
    if missing:
        raise SyncError("bulk_dataset_missing", "Scryfall no longer lists " + ", ".join(missing))
    return found


def bulk_file(item: dict[str, Any]) -> BulkFile:
    dataset = str(item["type"])
    uri, encoding = item.get("jsonl_download_uri"), "jsonl"
    if not uri:
        uri, encoding = item.get("download_uri"), "json"
    if not isinstance(uri, str) or not uri:
        raise SyncError("bulk_format_unknown", f"{dataset} names no download format we read.")
    parts = urlsplit(uri)
    if parts.scheme != "https" or parts.hostname not in FILE_HOSTS:
        raise SyncError("bulk_host_refused", f"{dataset} is served from {parts.hostname}.")
    try:
        updated = datetime.fromisoformat(str(item["updated_at"]))
    except (KeyError, ValueError) as error:
        raise SyncError("bulk_list_invalid", f"{dataset} has no usable updated_at: {error}")
    if updated.tzinfo is None:
        raise SyncError("bulk_list_invalid", f"{dataset}'s updated_at has no time zone.")
    size = item.get("compressed_size")
    return BulkFile(
        dataset=dataset,
        updated_at=updated,
        uri=uri,
        encoding=encoding,  # type: ignore[arg-type]
        compressed_size=size if isinstance(size, int) else None,
    )


def download(client: httpx.Client, bulk: BulkFile, folder: Path, limits: Limits) -> Download:
    """Streams the file to folder/<dataset>.<encoding>[.gz].part, then renames it into place."""
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / file_name(bulk)
    partial = target.with_name(target.name + ".part")
    digest = hashlib.sha256()
    size = 0
    started = time.monotonic()
    headers = {**HEADERS, "Accept": "*/*"}
    try:
        with client.stream("GET", bulk.uri, headers=headers) as response:
            if response.status_code == 429 or response.status_code >= 500:
                raise SyncError(
                    "download_unavailable",
                    f"{bulk.dataset}: the file host answered {response.status_code}.",
                    transient=True,
                )
            if response.status_code != 200:
                raise SyncError(
                    "download_refused",
                    f"{bulk.dataset}: the file host answered {response.status_code}.",
                )
            with partial.open("wb") as out:
                for chunk in response.iter_raw(CHUNK):
                    size += len(chunk)
                    if size > limits.compressed_bytes:
                        raise SyncError(
                            "download_too_large",
                            f"{bulk.dataset} is larger than {limits.compressed_bytes} bytes.",
                        )
                    if time.monotonic() - started > limits.download_seconds:
                        raise SyncError(
                            "download_too_slow",
                            f"{bulk.dataset} took longer than {limits.download_seconds:.0f} s.",
                            transient=True,
                        )
                    digest.update(chunk)
                    out.write(chunk)
            etag = response.headers.get("etag")
            last_modified = response.headers.get("last-modified")
    except httpx.HTTPError as error:
        partial.unlink(missing_ok=True)
        raise SyncError(
            "download_interrupted",
            f"{bulk.dataset}: the download broke off: {error}",
            transient=True,
        )
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    if bulk.compressed_size is not None and size != bulk.compressed_size:
        partial.unlink(missing_ok=True)
        raise SyncError(
            "download_incomplete",
            f"{bulk.dataset}: {size} bytes arrived, {bulk.compressed_size} were advertised.",
            transient=True,
        )
    partial.replace(target)
    return Download(target, digest.hexdigest(), size, etag, last_modified)


def file_name(bulk: BulkFile) -> str:
    return f"{bulk.dataset}.jsonl.gz" if bulk.encoding == "jsonl" else f"{bulk.dataset}.json"


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Reader:
    """Records of one downloaded file, counted and bounded. decompressed is the byte count read
    so far."""

    def __init__(self, path: Path, encoding: str, limits: Limits, dataset: str) -> None:
        self.path, self.encoding, self.limits, self.dataset = path, encoding, limits, dataset
        self.decompressed = 0
        self.count = 0

    def __iter__(self) -> Iterator[dict[str, Any]]:
        opened = cast(
            IO[bytes], gzip.open(self.path, "rb") if self.gzipped() else self.path.open("rb")
        )
        with opened as stream:
            records = self.lines(stream) if self.encoding == "jsonl" else self.array(stream)
            for record in records:
                self.count += 1
                yield record

    def gzipped(self) -> bool:
        with self.path.open("rb") as source:
            return source.read(2) == b"\x1f\x8b"

    def grow(self, size: int) -> None:
        self.decompressed += size
        if self.decompressed > self.limits.decompressed_bytes:
            raise SyncError(
                "dataset_too_large",
                f"{self.dataset} unpacks to more than {self.limits.decompressed_bytes} bytes.",
            )

    def malformed(self, where: str, reason: str) -> SyncError:
        return SyncError("record_malformed", f"{self.dataset} {where}: {reason}")

    def lines(self, stream: IO[bytes]) -> Iterator[dict[str, Any]]:
        number = 0
        while True:
            line = stream.readline(self.limits.record_bytes + 1)
            if not line:
                return
            number += 1
            self.grow(len(line))
            if len(line) > self.limits.record_bytes and not line.endswith(b"\n"):
                raise self.malformed(f"line {number}", "the record is too large")
            if not line.strip():
                continue
            yield self.decode(line, f"line {number}")

    def array(self, stream: IO[bytes]) -> Iterator[dict[str, Any]]:
        """A top-level JSON array, decoded one element at a time with raw_decode."""
        decoder = json.JSONDecoder()
        text = io.TextIOWrapper(stream, encoding="utf-8")
        buffer, position, number = "", 0, 0
        started = ended = False
        while not ended:
            chunk = text.read(CHUNK)
            self.grow(len(chunk))
            ended = not chunk
            buffer, position = buffer[position:] + chunk, 0
            while True:
                while position < len(buffer) and buffer[position] in " \t\r\n,":
                    position += 1
                if position >= len(buffer):
                    break
                if not started:
                    if buffer[position] != "[":
                        raise self.malformed("start", "the file is not a JSON array")
                    started, position = True, position + 1
                    continue
                if buffer[position] == "]":
                    return
                try:
                    record, end = decoder.raw_decode(buffer, position)
                except (json.JSONDecodeError, RecursionError):
                    # Perhaps only cut off by the chunk; more text decides.
                    if ended or len(buffer) - position > self.limits.record_bytes:
                        raise self.malformed(f"element {number + 1}", "invalid JSON") from None
                    break
                number += 1
                if not isinstance(record, dict):
                    raise self.malformed(f"element {number}", "not an object")
                position = end
                yield record
        raise self.malformed("end", "the array is not closed")

    def decode(self, line: bytes, where: str) -> dict[str, Any]:
        try:
            record = json.loads(line)
        except (ValueError, RecursionError) as error:
            raise self.malformed(where, f"invalid JSON ({error.__class__.__name__})") from None
        if not isinstance(record, dict):
            raise self.malformed(where, "not an object")
        return record
