"""The booster data job (v0.4.0, PROG02): MTGJSON's booster data into a collation per product.

MTGJSON (MIT licence) describes each set's boosters in its set file, `data.booster.<name>`: the
booster layouts with their weights, and the sheets, each a weighted list of MTGJSON card uuids
with its foil flag and rules. A run:
- brings the products up to content/pack-prices.json, and adds the expansions, core sets, Masters
  and draft sets that MTGJSON's set list shows released since that list (their play, draft, set,
  collector, Jumpstart and plain boosters, at 500 tokens until priced);
- fetches the set file of every product's set, and of the sets its sheets draw from, one at a time
  with a pause between requests, asking only for files changed since the last fetch (ETag and
  If-Modified-Since); a file that has not changed is read from the folder;
- resolves every sheet card through its Scryfall ID to a printing in the catalog, and so to its
  card;
- stores a product's collation as a new revision when it differs from the current one. A product
  with a card the catalog cannot resolve is not sold until it can be; Administration lists them.
  A product whose booster MTGJSON no longer describes is marked missing.
Runs are weekly (and when an administrator asks), after the catalog's first import. Transient
failures (MTGJSON unreachable, slow or limiting) are retried with backoff; the last good
collations stay in use. Its final transaction holds the job's lease, as the catalog's does.
"""

import hashlib
import json
import logging
import lzma
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import httpx
from sqlalchemy import Engine, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.collation import Collation, Layout, Sheet, SheetCard
from api.config import Settings
from api.models import (
    BoosterCollation,
    BoosterSource,
    BoosterSyncRun,
    CardPrinting,
    CatalogRevision,
    ScheduledJob,
    ShopProduct,
)
from api.products import ensure_products, price_list
from api.version import APP_VERSION
from catalog import sync
from catalog.importer import Fence, Fenced
from catalog.scryfall import SyncError, sha256_of

log = logging.getLogger(__name__)
KIND = "booster_sync"
FILE_HOSTS = frozenset({"mtgjson.com"})
HEADERS = {"User-Agent": f"CommanderDuels/{APP_VERSION}", "Accept": "*/*"}
FOLDER = "mtgjson"
SET_LIST = "SetList"
# Bounds on one file: as downloaded (xz), and as JSON. The largest set file the shop reads (The
# List) was 1.9 MB packed and 17 MB of JSON on 2026-10-21; a file is read whole, so the bound
# keeps a broken or hostile one from taking the worker's memory.
MAX_DOWNLOAD = 32 << 20
MAX_JSON = 96 << 20
DOWNLOAD_SECONDS = 300.0
# Between two requests to MTGJSON.
PAUSE_SECONDS = 0.5
CHUNK = 1 << 16
RESOLVE_BATCH = 1000
UNRESOLVED_KEPT = 25
# Sets after the price list that the shop takes up by itself, and which of their boosters.
DISCOVERED_TYPES = frozenset({"expansion", "core", "masters", "draft_innovation"})
DISCOVERED_BOOSTERS = ("play", "draft", "set", "collector", "jumpstart", "default")
BOOSTER_WORDS = {
    "play": "Play Booster",
    "draft": "Draft Booster",
    "set": "Set Booster",
    "collector": "Collector Booster",
    "jumpstart": "Jumpstart Booster",
    "default": "Booster Pack",
}
COLOR_ORDER = "WUBRG"
RESERVED_NAMES = frozenset(
    {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{n}" for n in range(1, 10)),
        *(f"LPT{n}" for n in range(1, 10)),
    }
)
# Runs wait this long for the catalog's first import, or for another run, without an attempt.
WAIT = timedelta(minutes=5)


# Set files.


@dataclass(frozen=True)
class CardRef:
    scryfall_id: str | None
    name: str
    colors: str
    finishes: tuple[str, ...]


@dataclass
class SetFile:
    code: str
    name: str
    released: date | None
    type: str
    version: str
    sha256: str
    boosters: dict[str, Any]
    cards: dict[str, CardRef]


def malformed(code: str, reason: str) -> SyncError:
    return SyncError("set_file_invalid", f"{code}: {reason}")


def read_set(code: str, path: Path) -> SetFile:
    """A set file (xz-compressed, or plain JSON for fixtures), bounded and checked for the parts
    the shop reads. Downloaded files are untrusted data."""
    try:
        if path.suffix == ".xz":
            with lzma.open(path, "rb") as packed:
                raw = packed.read(MAX_JSON + 1)
        else:
            with path.open("rb") as plain:
                raw = plain.read(MAX_JSON + 1)
    except (OSError, lzma.LZMAError) as error:
        raise malformed(code, f"unreadable ({error.__class__.__name__})") from None
    if len(raw) > MAX_JSON:
        raise SyncError("set_file_too_large", f"{code} unpacks to more than {MAX_JSON} bytes.")
    try:
        content = json.loads(raw)
    except (ValueError, RecursionError):
        raise malformed(code, "invalid JSON") from None
    if not isinstance(content, dict) or not isinstance(content.get("data"), dict):
        raise malformed(code, "no data object")
    data = content["data"]
    meta = mapping(content.get("meta"))
    boosters = data.get("booster") or {}
    if not isinstance(boosters, dict):
        raise malformed(code, "booster is not an object")
    cards: dict[str, CardRef] = {}
    for kind in ("cards", "tokens"):
        listed = data.get(kind) or []
        if not isinstance(listed, list):
            raise malformed(code, f"{kind} is not a list")
        for card in listed:
            if not isinstance(card, dict) or not isinstance(card.get("uuid"), str):
                continue
            scryfall = mapping(card.get("identifiers")).get("scryfallId")
            colors = listing(card.get("colors"))
            finishes = listing(card.get("finishes"))
            cards[card["uuid"]] = CardRef(
                scryfall_id=scryfall if isinstance(scryfall, str) else None,
                name=str(card.get("name", "")),
                colors="".join(color for color in COLOR_ORDER if color in colors),
                finishes=tuple(str(finish) for finish in finishes),
            )
    return SetFile(
        code=code,
        name=str(data.get("name", code)),
        released=parse_date(data.get("releaseDate")),
        type=str(data.get("type", "")),
        version=str(meta.get("version", "unknown")),
        sha256=sha256_of(path),
        boosters=boosters,
        cards=cards,
    )


def mapping(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def listing(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def parse_date(value: object) -> date | None:
    try:
        return date.fromisoformat(str(value)) if value else None
    except ValueError:
        return None


@dataclass(frozen=True)
class Fetched:
    path: Path
    sha256: str
    changed: bool
    size: int
    etag: str | None
    last_modified: str | None


def file_url(base_url: str, name: str) -> str:
    """MTGJSON's address of a file. Set codes that are reserved file names on Windows (Conflux,
    CON) are served with an underscore: CON_.json.xz."""
    stem = f"{name}_" if name.upper() in RESERVED_NAMES else name
    return f"{base_url.rstrip('/')}/{stem}.json.xz"


def fetch(
    client: httpx.Client,
    base_url: str,
    name: str,
    folder: Path,
    previous: BoosterSource | None,
) -> Fetched | None:
    """One file from MTGJSON (<name>.json.xz) into the folder: only if it changed since the last
    fetch, when the file from then is still here. None when MTGJSON has no such file."""
    url = file_url(base_url, name)
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in FILE_HOSTS:
        raise SyncError(
            "mtgjson_host_refused", f"Booster data is not fetched from {parts.hostname}."
        )
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / url.rsplit("/", 1)[-1]
    headers = dict(HEADERS)
    kept = previous is not None and target.exists() and sha256_of(target) == previous.sha256
    if kept and previous is not None:
        if previous.etag:
            headers["If-None-Match"] = previous.etag
        if previous.last_modified:
            headers["If-Modified-Since"] = previous.last_modified
    partial = target.with_name(target.name + ".part")
    digest = hashlib.sha256()
    size = 0
    started = time.monotonic()
    try:
        with client.stream("GET", url, headers=headers) as response:
            if response.status_code == 304 and kept and previous is not None:
                return Fetched(
                    target, previous.sha256, False, 0, previous.etag, previous.last_modified
                )
            if response.status_code == 404:
                return None
            if response.status_code == 429 or response.status_code >= 500:
                raise SyncError(
                    "mtgjson_unavailable",
                    f"{name}: MTGJSON answered {response.status_code}.",
                    transient=True,
                )
            if response.status_code != 200:
                raise SyncError(
                    "mtgjson_refused", f"{name}: MTGJSON answered {response.status_code}."
                )
            with partial.open("wb") as out:
                for chunk in response.iter_raw(CHUNK):
                    size += len(chunk)
                    if size > MAX_DOWNLOAD:
                        raise SyncError(
                            "download_too_large", f"{name} is larger than {MAX_DOWNLOAD} bytes."
                        )
                    if time.monotonic() - started > DOWNLOAD_SECONDS:
                        raise SyncError(
                            "download_too_slow",
                            f"{name} took longer than {DOWNLOAD_SECONDS:.0f} s.",
                            transient=True,
                        )
                    digest.update(chunk)
                    out.write(chunk)
            etag = response.headers.get("etag")
            modified = response.headers.get("last-modified")
    except httpx.HTTPError as error:
        partial.unlink(missing_ok=True)
        raise SyncError(
            "mtgjson_unreachable", f"{name}: MTGJSON did not answer: {error}", transient=True
        ) from None
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    partial.replace(target)
    sha = digest.hexdigest()
    return Fetched(target, sha, previous is None or previous.sha256 != sha, size, etag, modified)


# Collations.


@dataclass(frozen=True)
class ProductKey:
    id: UUID
    set_code: str
    booster: str


@dataclass
class Result:
    product: ProductKey
    status: str
    collation: Collation | None = None
    version: str = ""
    source_sha256: str = ""
    unresolved: list[dict[str, object]] = field(default_factory=list)
    unresolved_count: int = 0


def finish_of(foil: bool, sheet: str, finishes: tuple[str, ...]) -> str:
    """A sheet card's finish: the sheet's, or the only one the printing has."""
    if not foil:
        if "nonfoil" in finishes or not finishes:
            return "nonfoil"
        return "etched" if finishes == ("etched",) else "foil"
    if "etched" in sheet.lower() or finishes == ("etched",):
        return "etched"
    return "foil"


def booster_sets(code: str, booster: dict[str, Any]) -> list[str]:
    listed = booster.get("sourceSetCodes")
    codes = [str(item) for item in listed] if isinstance(listed, list) else []
    return [code, *(item for item in codes if item != code)]


def build(
    product: ProductKey,
    booster: dict[str, Any],
    cards: dict[str, CardRef],
    printings: dict[str, UUID],
) -> tuple[Collation | None, list[dict[str, object]], int]:
    """A product's collation from its booster entry, every card resolved to a printing; or the
    cards that could not be, a few of them and how many."""
    sheets_given = booster.get("sheets")
    layouts_given = booster.get("boosters")
    if not isinstance(sheets_given, dict) or not isinstance(layouts_given, list):
        raise malformed(product.set_code, f"booster {product.booster} has no sheets or layouts")
    layouts: list[Layout] = []
    for layout in layouts_given:
        contents = layout.get("contents") if isinstance(layout, dict) else None
        weight = layout.get("weight") if isinstance(layout, dict) else None
        if not isinstance(contents, dict) or not isinstance(weight, int) or weight <= 0:
            continue
        slots = tuple((str(name), int(count)) for name, count in contents.items() if count)
        if slots:
            layouts.append(Layout(slots, weight))
    used = {name for layout in layouts for name, _ in layout.contents}
    unresolved: list[dict[str, object]] = []
    count = 0
    sheets: dict[str, Sheet] = {}
    for name in sorted(used):
        given = sheets_given.get(name)
        if not isinstance(given, dict) or not isinstance(given.get("cards"), dict):
            raise malformed(product.set_code, f"booster {product.booster} lacks sheet {name}")
        foil = bool(given.get("foil"))
        entries: list[SheetCard] = []
        for uuid, weight in given["cards"].items():
            ref = cards.get(uuid)
            printing = printings.get(ref.scryfall_id) if ref and ref.scryfall_id else None
            if ref is None or printing is None:
                count += 1
                if len(unresolved) < UNRESOLVED_KEPT:
                    unresolved.append(
                        {
                            "sheet": name,
                            "name": ref.name if ref else None,
                            "scryfall_id": ref.scryfall_id if ref else None,
                            "mtgjson_uuid": uuid,
                        }
                    )
                continue
            if not isinstance(weight, int) or weight <= 0:
                continue
            entries.append(
                SheetCard(printing, weight, ref.colors, finish_of(foil, name, ref.finishes))
            )
        if not entries and not count:
            raise malformed(product.set_code, f"sheet {name} of {product.booster} is empty")
        sheets[name] = Sheet(
            foil=foil,
            fixed=bool(given.get("fixed")),
            balance_colors=bool(given.get("balanceColors")),
            allow_duplicates=bool(given.get("allowDuplicates")),
            cards=tuple(entries),
        )
    if count or not layouts:
        return None, unresolved, count
    return Collation(tuple(layouts), sheets), [], 0


def resolve(session: Session, scryfall_ids: Iterable[str]) -> dict[str, UUID]:
    """Catalog printings by Scryfall ID."""
    wanted = sorted({value for value in scryfall_ids if value})
    found: dict[str, UUID] = {}
    for start in range(0, len(wanted), RESOLVE_BATCH):
        batch = []
        for value in wanted[start : start + RESOLVE_BATCH]:
            try:
                batch.append(UUID(value))
            except ValueError:
                continue
        for scryfall_id, printing_id in session.execute(
            select(CardPrinting.scryfall_id, CardPrinting.id).where(
                CardPrinting.scryfall_id.in_(batch)
            )
        ):
            found[str(scryfall_id)] = printing_id
    return found


class Collector:
    """Builds every product's collation from set files that open_set supplies (None: MTGJSON has
    no such file). Each set file is read once, its cards kept for the sets that draw from it."""

    def __init__(
        self,
        engine: Engine,
        open_set: Callable[[str], SetFile | None],
        check: Callable[[], None] = lambda: None,
    ) -> None:
        self.engine, self.open_set, self.check = engine, open_set, check
        self.cards: dict[str, dict[str, CardRef] | None] = {}
        self.digests: dict[str, str] = {}
        self.versions: dict[str, str] = {}
        # Sets whose own products are still to come, and those of them read early as a source.
        self.waiting: set[str] = set()
        self.held: dict[str, SetFile] = {}

    def set_file(self, code: str) -> SetFile | None:
        if code in self.held:
            return self.held.pop(code)
        if code in self.cards and self.cards[code] is None:
            return None
        found = self.open_set(code)
        self.cards[code] = found.cards if found else None
        if found is not None:
            self.digests[code] = found.sha256
            self.versions[code] = found.version
        self.check()
        return found

    def cards_of(self, code: str) -> dict[str, CardRef] | None:
        if code not in self.cards:
            found = self.set_file(code)
            if found is not None and code in self.waiting:
                self.held[code] = found
        return self.cards[code]

    def collect(self, products: list[ProductKey]) -> list[Result]:
        results: list[Result] = []
        by_set: dict[str, list[ProductKey]] = {}
        for product in products:
            by_set.setdefault(product.set_code, []).append(product)
        self.waiting = set(by_set)
        for code in sorted(by_set):
            self.waiting.discard(code)
            found = self.set_file(code)
            for product in by_set[code]:
                booster = found.boosters.get(product.booster) if found else None
                if found is None or not isinstance(booster, dict):
                    results.append(Result(product, "missing"))
                    continue
                results.append(self.product(product, found, booster))
        return results

    def product(self, product: ProductKey, found: SetFile, booster: dict[str, Any]) -> Result:
        cards: dict[str, CardRef] = {}
        codes = booster_sets(found.code, booster)
        for code in codes:
            cards.update(self.cards_of(code) or {})
        wanted = set()
        for sheet in mapping(booster.get("sheets")).values():
            if isinstance(sheet, dict) and isinstance(sheet.get("cards"), dict):
                for uuid in sheet["cards"]:
                    ref = cards.get(uuid)
                    if ref and ref.scryfall_id:
                        wanted.add(ref.scryfall_id)
        with Session(self.engine) as session:
            printings = resolve(session, wanted)
        collation, unresolved, count = build(product, booster, cards, printings)
        source = hashlib.sha256(
            "".join(self.digests.get(code, "") for code in codes).encode()
        ).hexdigest()
        if collation is None:
            return Result(product, "unresolved", unresolved=unresolved, unresolved_count=count)
        return Result(product, "ready", collation, found.version, source)


def apply(
    engine: Engine,
    results: list[Result],
    fence: Fence,
    run_id: UUID | None,
    now: datetime,
) -> dict[str, int]:
    """Stores the results in one transaction, holding the job's lease: a new collation revision
    where a product's changed, and every product's data status."""
    counts = {"ready": 0, "unresolved": 0, "missing": 0, "revisions": 0}
    with Session(engine) as session, session.begin():
        fence.hold(session)
        catalog = session.scalar(select(func.max(CatalogRevision.id)))
        for result in results:
            product = session.get(ShopProduct, result.product.id)
            if product is None:
                continue
            counts[result.status] += 1
            product.checked_at = now
            product.updated_at = now
            product.data_status = result.status
            product.unresolved = result.unresolved
            product.unresolved_count = result.unresolved_count
            if result.collation is None:
                continue
            digest = result.collation.digest()
            current = (
                session.get(BoosterCollation, product.collation_id)
                if product.collation_id
                else None
            )
            product.pack_size = result.collation.pack_size()
            if current is not None and current.digest == digest:
                continue
            last = session.scalar(
                select(func.max(BoosterCollation.revision)).where(
                    BoosterCollation.product_id == product.id
                )
            )
            layouts, sheets = result.collation.to_json()
            row = BoosterCollation(
                id=uuid4(),
                product_id=product.id,
                revision=(last or 0) + 1,
                mtgjson_version=result.version,
                source_sha256=result.source_sha256,
                digest=digest,
                layouts=layouts,
                sheets=sheets,
                cards=len(result.collation.printings()),
                sync_run_id=run_id,
                catalog_revision_id=catalog,
                created_at=now,
            )
            session.add(row)
            session.flush()
            product.collation_id = row.id
            counts["revisions"] += 1
    return counts


def product_keys(engine: Engine) -> list[ProductKey]:
    with Session(engine) as session:
        return [
            ProductKey(product.id, product.set_code, product.booster)
            for product in session.scalars(
                select(ShopProduct).order_by(ShopProduct.set_code, ShopProduct.booster)
            )
        ]


def load_local(engine: Engine, folder: Path, content_dir: str) -> dict[str, int]:
    """Collations from set files in a folder (<SET>.json or <SET>.json.xz), with no job and no
    network: the test fixture for tests and the browser journeys. Products whose set file is not
    there are left as they were."""

    def open_set(code: str) -> SetFile | None:
        for name in (f"{code}.json", f"{code}.json.xz"):
            if (folder / name).is_file():
                return read_set(code, folder / name)
        return None

    ensure_products(engine, content_dir)
    present = {path.name.split(".")[0] for path in folder.iterdir()}
    products = [key for key in product_keys(engine) if key.set_code in present]
    results = Collector(engine, open_set).collect(products)
    return apply(engine, results, Fence(None, 0), None, datetime.now(UTC))


# The job.


def due_time(settings: Settings, day: date) -> datetime:
    """A week's run: its Monday, an hour after the catalog's daily sync."""
    monday = day - timedelta(days=day.weekday())
    start = sync.due_time(settings, datetime.combine(monday, datetime.min.time(), UTC))
    return start + timedelta(hours=1)


def week_key(day: date) -> str:
    year, week, _ = day.isocalendar()
    return f"{KIND}:{year}-W{week:02d}"


def ensure_scheduled(engine: Engine, settings: Settings, now: datetime) -> None:
    """Keeps this week's and next week's runs queued; a new installation's first run is due at
    once, and waits for the catalog's first import."""
    if not settings.catalog_dir:
        return
    for day in (now.date(), now.date() + timedelta(days=7)):
        key = week_key(day)
        with Session(engine) as session:
            if session.scalar(select(ScheduledJob.id).where(ScheduledJob.deduplication_key == key)):
                continue
            session.add(
                ScheduledJob(
                    kind=KIND,
                    deduplication_key=key,
                    payload={"trigger": "schedule"},
                    status="pending",
                    due_at=due_time(settings, day),
                )
            )
            try:
                session.commit()
            except IntegrityError:
                session.rollback()


def ensure_collated(engine: Engine, settings: Settings, now: datetime) -> bool:
    """On the worker's start, which is each deploy: products a version brought that have no
    booster data yet (Alpha and Beta in v0.6.1) get a run at once, rather than waiting for
    Monday's. Once for each set of such products, so a product whose data cannot be built does
    not start a run on every deploy. The run is logged as a scheduled one. True if one was
    queued."""
    if not settings.catalog_dir:
        return False
    ensure_products(engine, settings.content_dir)
    with Session(engine) as session:
        waiting = sorted(
            f"{product.set_code}/{product.booster}"
            for product in session.scalars(
                select(ShopProduct).where(
                    ShopProduct.data_status == "waiting", ShopProduct.collation_id.is_(None)
                )
            )
        )
    if not waiting:
        return False
    digest = hashlib.sha256(",".join(waiting).encode()).hexdigest()[:16]
    with Session(engine) as session:
        session.add(
            ScheduledJob(
                kind=KIND,
                deduplication_key=f"{KIND}:waiting:{digest}",
                payload={"trigger": "deploy"},
                status="pending",
                due_at=now,
            )
        )
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            return False
    log.info("Booster data queued for %d products without it: %s", len(waiting), waiting[:8])
    return True


def request_now(session: Session, user_id: UUID, now: datetime) -> ScheduledJob | None:
    """Queues a run for an administrator; None while one is queued or running already."""
    busy = session.scalar(
        select(ScheduledJob.id).where(
            ScheduledJob.kind == KIND,
            ScheduledJob.due_at <= now,
            ScheduledJob.status.in_(("pending", "running")),
        )
    )
    if busy is not None:
        return None
    job = ScheduledJob(
        kind=KIND,
        deduplication_key=f"{KIND}:manual:{now.isoformat()}:{user_id}",
        payload={"trigger": "manual", "requested_by": str(user_id)},
        status="pending",
        due_at=now,
    )
    session.add(job)
    return job


def overlapping(engine: Engine, job: sync.Claimed, now: datetime) -> bool:
    with Session(engine) as session:
        return (
            session.scalar(
                select(ScheduledJob.id).where(
                    ScheduledJob.kind == KIND,
                    ScheduledJob.id != job.id,
                    ScheduledJob.status == "running",
                    ScheduledJob.lease_until > now,
                )
            )
            is not None
        )


class Run:
    def __init__(
        self,
        engine: Engine,
        settings: Settings,
        client: httpx.Client,
        job: sync.Claimed,
        now: datetime,
        heartbeat: sync.Heartbeat,
        pause: float,
    ) -> None:
        self.engine, self.settings, self.client, self.job = engine, settings, client, job
        self.heartbeat, self.pause = heartbeat, pause
        self.started = now
        self.folder = Path(settings.catalog_dir) / FOLDER
        self.base = str(settings.booster_url)
        self.requests = 0
        self.discovered: dict[str, SetFile] = {}
        self.stats: dict[str, Any] = {"downloaded": [], "unchanged": 0, "bytes": 0}
        trigger = job.payload.get("trigger", "schedule")
        requested = job.payload.get("requested_by")
        with Session(engine) as session, session.begin():
            run = BoosterSyncRun(
                job_id=job.id,
                generation=job.generation,
                trigger=trigger if trigger in ("schedule", "manual") else "schedule",
                requested_by=UUID(requested) if isinstance(requested, str) else None,
                attempt=int(job.payload.get("attempt", 1)),
                started_at=now,
                status="running",
                stats={},
            )
            session.add(run)
            session.flush()
            self.run_id = run.id

    def finish(self, status: str, code: str | None, message: str | None, **values: Any) -> None:
        with Session(self.engine) as session, session.begin():
            session.execute(
                update(BoosterSyncRun)
                .where(BoosterSyncRun.id == self.run_id)
                .values(
                    status=status,
                    error_code=code,
                    error_message=message,
                    finished_at=datetime.now(UTC),
                    stats={
                        **self.stats,
                        "seconds": round((datetime.now(UTC) - self.started).total_seconds(), 1),
                    },
                    **values,
                )
            )

    def get(self, name: str) -> Fetched | None:
        """One file, a pause after the one before, its validators recorded."""
        if self.requests and self.pause:
            time.sleep(self.pause)
        self.requests += 1
        with Session(self.engine) as session:
            previous = session.get(BoosterSource, name)
        got = fetch(self.client, self.base, name, self.folder, previous)
        now = datetime.now(UTC)
        if got is None:
            return None
        if got.size:
            self.stats["bytes"] += got.size
            self.stats["downloaded"].append(name)
        else:
            self.stats["unchanged"] += 1
        with Session(self.engine) as session, session.begin():
            source = session.get(BoosterSource, name)
            if source is None:
                source = BoosterSource(name=name, fetched_at=now)
                session.add(source)
            source.url = file_url(self.base, name)
            source.sha256 = got.sha256
            source.size = got.path.stat().st_size
            source.etag = got.etag
            source.last_modified = got.last_modified
            if got.size:
                source.fetched_at = now
            source.checked_at = now
        self.heartbeat.check()
        return got

    def open_set(self, code: str) -> SetFile | None:
        # A set file read to discover its products is not asked for twice in one run.
        if code in self.discovered:
            return self.discovered.pop(code)
        got = self.get(code)
        if got is None:
            return None
        found = read_set(code, got.path)
        with Session(self.engine) as session, session.begin():
            source = session.get(BoosterSource, code)
            if source is not None:
                source.mtgjson_version = found.version[:64]
        return found

    def discover(self, known: frozenset[str], since: date | None, today: date) -> list[str]:
        """Sets MTGJSON lists as released since the price list, whose boosters the shop takes up
        by itself: their products are added, at 500 tokens until priced."""
        if since is None:
            return []
        got = self.get(SET_LIST)
        if got is None:
            return []
        try:
            with lzma.open(got.path, "rb") as stream:
                raw = stream.read(MAX_JSON + 1)
            listing = json.loads(raw)
            sets = listing["data"]
            if len(raw) > MAX_JSON or not isinstance(sets, list):
                raise ValueError("not a list")
        except (OSError, lzma.LZMAError, ValueError, KeyError, TypeError):
            raise SyncError("set_list_invalid", "MTGJSON's set list changed shape.") from None
        found = []
        for item in sets:
            if not isinstance(item, dict):
                continue
            code, released = str(item.get("code", "")), parse_date(item.get("releaseDate"))
            if (
                code
                and code not in known
                and item.get("type") in DISCOVERED_TYPES
                and not item.get("isOnlineOnly")
                and released is not None
                and since < released <= today
            ):
                found.append(code)
        added = []
        for code in sorted(found):
            set_file = self.open_set(code)
            if set_file is None:
                continue
            self.discovered[code] = set_file
            for booster in DISCOVERED_BOOSTERS:
                entry = set_file.boosters.get(booster)
                if not isinstance(entry, dict):
                    continue
                languages = entry.get("languages")
                if isinstance(languages, list) and languages and "en" not in languages:
                    continue
                name = entry.get("name")
                if self.add_product(set_file, booster, str(name) if name else None):
                    added.append(f"{code}/{booster}")
        return added

    def add_product(self, set_file: SetFile, booster: str, name: str | None) -> bool:
        now = datetime.now(UTC)
        try:
            with Session(self.engine) as session, session.begin():
                session.add(
                    ShopProduct(
                        set_code=set_file.code,
                        booster=booster,
                        set_name=set_file.name,
                        name=name or f"{set_file.name} {BOOSTER_WORDS[booster]}",
                        released=set_file.released,
                        origin="mtgjson",
                        on_sale=True,
                        data_status="waiting",
                        unresolved=[],
                        unresolved_count=0,
                        created_at=now,
                        updated_at=now,
                    )
                )
        except IntegrityError:
            return False
        return True

    def execute(self) -> sync.Outcome:
        content = self.settings.content_dir
        ensure_products(self.engine, content)
        listing = price_list(content)
        with Session(self.engine) as session:
            known = frozenset(session.scalars(select(ShopProduct.set_code).distinct()))
        today = self.started.date()
        self.stats["discovered"] = self.discover(known, listing.as_of if listing else None, today)
        collector = Collector(self.engine, self.open_set, self.heartbeat.check)
        results = collector.collect(product_keys(self.engine))
        versions = sorted(set(collector.versions.values()))
        self.stats["mtgjson_version"] = versions[-1] if versions else None
        self.stats["sets"] = len(collector.cards)
        counts = apply(
            self.engine,
            results,
            Fence(self.job.id, self.job.generation),
            self.run_id,
            datetime.now(UTC),
        )
        self.stats.update(counts)
        self.stats["products"] = len(results)
        status = "succeeded" if counts["revisions"] else "unchanged"
        self.finish(status, None, None)
        log.info("Booster data: %s", {key: self.stats[key] for key in counts})
        return sync.Outcome("completed", "imported" if counts["revisions"] else "unchanged")


def catalog_ready(engine: Engine) -> bool:
    with Session(engine) as session:
        return session.scalar(select(CatalogRevision.id).limit(1)) is not None


def handle(
    engine: Engine,
    settings: Settings,
    client: httpx.Client,
    job: sync.Claimed,
    heartbeat_seconds: float | None = 20.0,
    pause: float = PAUSE_SECONDS,
) -> sync.Outcome:
    now = datetime.now(UTC)
    if not settings.catalog_dir:
        return sync.Outcome("failed", "boosters_off")
    if overlapping(engine, job, now):
        return sync.Outcome("pending", "waiting_for_other_run", retry_at=now + WAIT)
    # Collations resolve to the catalog's printings: the first run waits for its first import.
    if not catalog_ready(engine):
        return sync.Outcome("pending", "waiting_for_catalog", retry_at=now + WAIT)
    with sync.Heartbeat(engine, job, heartbeat_seconds) as heartbeat:
        run = Run(engine, settings, client, job, now, heartbeat, pause)
        attempt = int(job.payload.get("attempt", 1))
        try:
            return run.execute()
        except Fenced:
            run.finish("fenced", "fenced", "Another worker took this run over.")
            return sync.Outcome("fenced", "fenced", run_id=run.run_id)
        except SyncError as error:
            retry = error.transient and attempt < sync.MAX_ATTEMPTS
            retry_at = now + sync.backoff(attempt) if retry else None
            run.finish("failed", error.code, error.message, next_attempt_at=retry_at)
            log.warning("Booster data failed (%s): %s", error.code, error.message)
            if retry:
                return sync.Outcome("pending", error.code, retry_at=retry_at, run_id=run.run_id)
            return sync.Outcome("failed", error.code, run_id=run.run_id)
        except Exception as error:
            run.finish("failed", "internal_error", f"{error.__class__.__name__}: {error}")
            log.exception("Booster data failed unexpectedly")
            return sync.Outcome("failed", "internal_error", run_id=run.run_id)
