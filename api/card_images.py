"""Card images, fetched from Scryfall once, cached on disk and served from our own origin.

The engine's card views carry only a card's name, so an image is looked up by the exact name:
Scryfall's named-card search answers with the card's JSON, the API downloads the JPEG it names
from Scryfall's image host, keeps it under CD_CARD_IMAGE_DIR and records the printing, face and
artist in card_images. Browsers only ever talk to this site. A name Scryfall does not know
(tokens, misspellings) is recorded as missing and asked about again after a week.

Scryfall asks for 50-100 ms between requests to its API, so this process spaces them at least
120 ms apart; downloads from its image host are not limited. Concurrent requests for one name
fetch it once.
"""

import asyncio
import logging
import math
import os
import tempfile
import time
from collections import Counter
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from typing import Annotated, Any, Literal, cast
from uuid import UUID

import httpx
from fastapi import APIRouter, Query, Request, Response
from sqlalchemy import Engine
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api.auth import ERRORS
from api.config import Settings
from api.identity import Active, ApiError, utcnow
from api.models import CardImage
from api.schemas import Contract, Error
from api.version import APP_VERSION

log = logging.getLogger("api.card_images")
router = APIRouter(prefix="/api/v1", responses=ERRORS | {422: {"model": Error}})

ImageSize = Literal["normal", "large"]
# 1-200 characters, none of them control characters (Unicode category Cc).
CardName = Annotated[
    str,
    Query(
        min_length=1,
        max_length=200,
        pattern=r"^[^\x00-\x1f\x7f-\x9f]+$",
        description="The card's exact name, as the game shows it.",
    ),
]

API_SPACING = 0.12
MISSING_RETRY = timedelta(days=7)
MAX_IMAGE_BYTES = 2 * 1024 * 1024
JPEG_MAGIC = b"\xff\xd8\xff"
IMAGE_HOST = "scryfall.io"
# The browser keeps an image for a week: a file name's content never changes.
IMAGE_CACHE_CONTROL = "private, max-age=604800, immutable"
USER_AGENT = f"CommanderDuels/{APP_VERSION}"
API_HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json"}
IMAGE_HEADERS = {"User-Agent": USER_AGENT, "Accept": "image/jpeg"}


class CardImageInfo(Contract):
    """The printing whose image the cache serves for a name, for crediting its artist."""

    name: str
    status: Literal["found", "missing"]
    artist: str | None
    set_code: str | None
    collector_number: str | None


def images_unavailable() -> ApiError:
    return ApiError(
        404, "images_unavailable", "Card images are not set up: the API needs CD_CARD_IMAGE_DIR."
    )


def missing() -> ApiError:
    return ApiError(404, "card_image_missing", "Scryfall has no image for this card.")


def unavailable(reason: str) -> ApiError:
    log.warning("Card image lookup failed: %s", reason)
    return ApiError(
        503, "card_images_unavailable", "Card images are not available right now. Try again."
    )


def file_name(scryfall_id: UUID, face: int | None, size: ImageSize) -> str:
    """The image's file: Scryfall's card ID (a UUID, so never a path), its face and its size."""
    return f"{scryfall_id}{'' if face is None else f'-f{face}'}-{size}.jpg"


def text_of(source: dict[str, Any], key: str) -> str | None:
    value = source.get(key)
    return value if isinstance(value, str) and value else None


def chosen_face(card: dict[str, Any], name: str) -> tuple[int | None, dict[str, Any]] | None:
    """The face whose image to show and the object holding its image_uris, or None when Scryfall
    has no image. Transform and modal double-faced cards keep an image on each face: the face
    with the requested name, else the card's own image if it has one, else the front. Split,
    flip and adventure cards share the card's own image."""
    faces = card.get("card_faces")
    illustrated = [
        (index, face)
        for index, face in enumerate(faces if isinstance(faces, list) else [])
        if isinstance(face, dict) and isinstance(face.get("image_uris"), dict)
    ]
    wanted = name.casefold()
    for index, face in illustrated:
        if str(face.get("name", "")).casefold() == wanted:
            return index, face
    if isinstance(card.get("image_uris"), dict):
        return None, card
    return illustrated[0] if illustrated else None


def image_url(source: dict[str, Any], size: ImageSize) -> str | None:
    """The JPEG's address, only on Scryfall's own image host over HTTPS (the JSON comes from
    outside; nothing it names elsewhere is fetched)."""
    url = source["image_uris"].get(size)
    if not isinstance(url, str):
        return None
    try:
        parsed = httpx.URL(url)
    except httpx.InvalidURL as error:
        raise unavailable("Scryfall named an invalid image address") from error
    host = parsed.host
    if (
        parsed.scheme != "https"
        or parsed.port not in (None, 443)
        or not (host == IMAGE_HOST or host.endswith("." + IMAGE_HOST))
    ):
        raise unavailable(f"refused an image address on {host or 'no host'}")
    return url


def read_image(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def write_atomically(path: Path, image: bytes) -> None:
    """Readers see the whole file or none: it is written beside its name, then renamed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=".", suffix=".part")
    try:
        with os.fdopen(handle, "wb") as file:
            file.write(image)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    except OSError:
        Path(temporary).unlink(missing_ok=True)
        # Another name for the same printing may have written it first.
        if not path.is_file():
            raise


def lookup(database: Engine, name: str) -> CardImage | None:
    with Session(database) as db:
        return db.get(CardImage, name)


def record(database: Engine, entry: CardImage) -> None:
    """Inserts or replaces the name's row. Every column must be set on the entry: merging leaves
    the stored value of an unset one."""
    with Session(database) as db:
        db.merge(entry)
        db.commit()


def missing_entry(name: str) -> CardImage:
    return CardImage(
        name=name,
        status="missing",
        scryfall_id=None,
        face=None,
        set_code=None,
        collector_number=None,
        artist=None,
        checked_at=utcnow(),
    )


class CardImageCache:
    """The images on disk, and the lookups that fill it. One per API process."""

    def __init__(self, settings: Settings, database: Engine, client: httpx.AsyncClient) -> None:
        self.directory = Path(settings.card_image_dir) if settings.card_image_dir else None
        self.api_url = str(settings.scryfall_url).rstrip("/")
        self.database = database
        self.client = client
        # A name's lock lives only while a request holds or awaits it: names come from clients.
        self.locks: dict[str, asyncio.Lock] = {}
        self.waiting: Counter[str] = Counter()
        self.spacing = asyncio.Lock()
        self.next_request = -math.inf
        # Replaced in tests, to measure the spacing without waiting for it.
        self.clock: Callable[[], float] = time.monotonic
        self.sleep: Callable[[float], Awaitable[None]] = asyncio.sleep

    def require_directory(self) -> Path:
        if self.directory is None:
            raise images_unavailable()
        return self.directory

    async def image(self, name: str, size: ImageSize) -> bytes:
        """The name's JPEG, from disk or, the first time, from Scryfall while the request waits."""
        directory = self.require_directory()
        image = await run_in_threadpool(self.stored, directory, name, size)
        if image is not None:
            return image
        async with self.locked(name):
            # Another request may have fetched it while this one waited.
            image = await run_in_threadpool(self.stored, directory, name, size)
            return image if image is not None else await self.fetch(directory, name, size)

    async def info(self, name: str) -> CardImageInfo | None:
        self.require_directory()
        entry = await run_in_threadpool(lookup, self.database, name)
        if entry is None:
            return None
        return CardImageInfo(
            name=entry.name,
            status=cast(Literal["found", "missing"], entry.status),
            artist=entry.artist,
            set_code=entry.set_code,
            collector_number=entry.collector_number,
        )

    @asynccontextmanager
    async def locked(self, name: str) -> AsyncIterator[None]:
        lock = self.locks.setdefault(name, asyncio.Lock())
        self.waiting[name] += 1
        try:
            async with lock:
                yield
        finally:
            self.waiting[name] -= 1
            if not self.waiting[name]:
                del self.waiting[name], self.locks[name]

    def stored(self, directory: Path, name: str, size: ImageSize) -> bytes | None:
        """The cached image when the name's printing is known and this size is on disk. A name
        Scryfall did not know stays missing for a week."""
        entry = lookup(self.database, name)
        if entry is None:
            return None
        if entry.status == "missing" and utcnow() - entry.checked_at < MISSING_RETRY:
            raise missing()
        if entry.status != "found" or entry.scryfall_id is None:
            return None
        return read_image(directory / file_name(entry.scryfall_id, entry.face, size))

    async def fetch(self, directory: Path, name: str, size: ImageSize) -> bytes:
        card = await self.named(name)
        chosen = chosen_face(card, name) if card is not None else None
        url = image_url(chosen[1], size) if chosen is not None else None
        if card is None or chosen is None or url is None:
            # Scryfall knows no such card, or has no image of it.
            await run_in_threadpool(record, self.database, missing_entry(name))
            raise missing()
        try:
            scryfall_id = UUID(str(card["id"]))
        except (KeyError, ValueError) as error:
            raise unavailable("Scryfall's card has no valid id") from error
        face, source = chosen
        path = directory / file_name(scryfall_id, face, size)
        image = await run_in_threadpool(read_image, path)
        if image is None:
            image = await self.download(url)
            try:
                await run_in_threadpool(write_atomically, path, image)
            except OSError as error:
                raise unavailable(f"could not write {path.name}: {error}") from error
        await run_in_threadpool(
            record,
            self.database,
            CardImage(
                name=name,
                status="found",
                scryfall_id=scryfall_id,
                face=face,
                set_code=text_of(card, "set"),
                collector_number=text_of(card, "collector_number"),
                artist=text_of(source, "artist") or text_of(card, "artist"),
                checked_at=utcnow(),
            ),
        )
        return image

    async def pace(self) -> None:
        """Returns once the previous request to Scryfall's API started API_SPACING ago or more."""
        async with self.spacing:
            while (delay := self.next_request - self.clock()) > 0:
                await self.sleep(delay)
            self.next_request = self.clock() + API_SPACING

    async def named(self, name: str) -> dict[str, Any] | None:
        """Scryfall's card for the exact name, or None if Scryfall knows no such card."""
        await self.pace()
        try:
            response = await self.client.get(
                f"{self.api_url}/cards/named", params={"exact": name}, headers=API_HEADERS
            )
            body = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise unavailable(f"Scryfall's API: {type(error).__name__}") from error
        if not isinstance(body, dict):
            raise unavailable("Scryfall's API answered with something other than an object")
        if response.status_code == 404 and body.get("code") == "not_found":
            return None
        if response.status_code != 200 or body.get("object") != "card":
            raise unavailable(f"Scryfall's API answered {response.status_code}")
        return body

    async def download(self, url: str) -> bytes:
        """The JPEG from Scryfall's image host: at most MAX_IMAGE_BYTES, never a redirect."""
        try:
            async with self.client.stream("GET", url, headers=IMAGE_HEADERS) as response:
                kind = response.headers.get("content-type", "").split(";")[0].strip().lower()
                if response.status_code != 200 or kind != "image/jpeg":
                    raise unavailable(f"the image host answered {response.status_code} {kind}")
                image = bytearray()
                async for chunk in response.aiter_bytes():
                    image += chunk
                    if len(image) > MAX_IMAGE_BYTES:
                        raise unavailable("the image is larger than 2 MB")
        except httpx.HTTPError as error:
            raise unavailable(f"the image host: {type(error).__name__}") from error
        if not image.startswith(JPEG_MAGIC):
            raise unavailable("the image is not a JPEG")
        return bytes(image)


def cache_of(request: Request) -> CardImageCache:
    return cast(CardImageCache, request.app.state.card_images)


def rotated_cookie(response: Response) -> dict[str, str]:
    """A session rotated while signing this request in sets its new cookie on the request's
    response, which a returned Response or an error response would otherwise drop."""
    cookie = response.headers.get("set-cookie")
    return {"set-cookie": cookie} if cookie else {}


# Hidden information: these routes only map a name the client already knows to an image. Nothing
# here prefetches deck lists or other seats' cards; that would let a player probe the cache for
# another seat's deck.


@router.get(
    "/card-images",
    response_class=Response,
    responses={
        200: {
            "description": "The card's image.",
            "content": {"image/jpeg": {"schema": {"type": "string", "format": "binary"}}},
        }
    },
)
async def card_image(
    request: Request,
    response: Response,
    principal: Active,
    name: CardName,
    size: Annotated[ImageSize, Query()] = "normal",
) -> Response:
    """A card's image by its exact name, from Scryfall, cached on this server. The first request
    for a card waits while it is fetched. 404 card_image_missing for cards Scryfall does not
    know, such as tokens."""
    try:
        image = await cache_of(request).image(name, size)
    except ApiError as error:
        error.headers = (error.headers or {}) | rotated_cookie(response)
        raise
    headers = {"Cache-Control": IMAGE_CACHE_CONTROL} | rotated_cookie(response)
    return Response(image, media_type="image/jpeg", headers=headers)


@router.get("/card-images/info", response_model=CardImageInfo)
async def card_image_info(
    request: Request, response: Response, principal: Active, name: CardName
) -> CardImageInfo:
    """The printing and artist behind a name's cached image, to credit the artist and Scryfall.
    Never fetches: 404 until the image has been requested."""
    try:
        info = await cache_of(request).info(name)
        if info is None:
            raise ApiError(404, "card_image_unknown", "This card's image has not been looked up.")
    except ApiError as error:
        error.headers = (error.headers or {}) | rotated_cookie(response)
        raise
    return info
