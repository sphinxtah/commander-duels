"""Card images, fetched from Scryfall once, cached on disk and served from our own origin.

Since v0.2.0 the catalog names each printing's image: a printing's image comes straight from the
URL Scryfall returned for it (CAT10), downloaded from Scryfall's image host and never from its
API. The engine's card views carry only a card's name, which the catalog maps to the card and the
printing it shows by default, or the printing the player chose in the deck their seat plays.
Only the player's own seat counts: another seat's choice would tell what that deck holds.

A name the catalog does not know (before the first import, or a token) falls back to v0.1.0's
lookup: Scryfall's named-card search answers with the card's JSON, the API downloads the JPEG it
names, keeps it under CD_CARD_IMAGE_DIR and records the printing, face and artist in
card_images. Browsers only ever talk to this site. A name Scryfall does not know (tokens,
misspellings) is recorded as missing and asked about again after a week. Missing rows older than
that are deleted whenever another name is recorded as missing.

Scryfall allows its named-card search 2 requests a second, so this process spaces them at least
550 ms apart, and after a 429 asks nothing more for as long as Scryfall says (30 s at least);
downloads from its image host are not limited. Concurrent requests for one name fetch it once.
Each name waiting its turn delays every name behind it, so the names waiting are capped, per
account and in all; more are refused at once, and those cards keep their text frame.
"""

import asyncio
import logging
import math
import os
import tempfile
import time
from collections import Counter
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from datetime import timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Annotated, Any, Literal, cast
from uuid import UUID

import httpx
from fastapi import APIRouter, Query, Request, Response
from sqlalchemy import Engine, delete, or_, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api.auth import INPUT_ERRORS
from api.config import Settings
from api.identity import Active, ApiError, Db, Principal, utcnow
from api.models import (
    CardAlias,
    CardConcept,
    CardImage,
    CardPrinting,
    DeckEntryRow,
    GameSeat,
)
from api.schemas import Contract
from api.version import APP_VERSION
from catalog.text import normalize

log = logging.getLogger("api.card_images")
router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

# normal (488 x 680) and large (672 x 936) are JPEGs; png (745 x 1040), Scryfall's largest, is a
# PNG with transparent corners, asked for by the table's magnifier on large screens (v0.3.0).
ImageSize = Literal["normal", "large", "png"]
# A printing without a png is served at the next size down, and is never recorded as missing
# for want of one: the magnifier then shows the large image it already had.
SIZES_TO_TRY: dict[str, tuple[ImageSize, ...]] = {
    "png": ("png", "large", "normal"),
    "large": ("large",),
    "normal": ("normal",),
}
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

# Scryfall's rate limits page allows /cards/named 2 requests a second; the margin is for jitter.
API_SPACING = 0.55
# A 429 limits access for 30 s (the same page). A longer Retry-After is honoured, up to an hour.
RATE_LIMIT_PAUSE = 30.0
MAX_RATE_LIMIT_PAUSE = 3600.0
# Uncached names waiting on Scryfall's API, for one account and in all. One account's waiting
# names hold up everyone else's first look by up to LOOKUPS_PER_ACCOUNT * API_SPACING.
LOOKUPS_PER_ACCOUNT = 8
LOOKUPS_WAITING = 24
MISSING_RETRY = timedelta(days=7)
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_PNG_BYTES = 8 * 1024 * 1024
JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
IMAGE_HOST = "scryfall.io"
# The browser keeps an image for a week: a file name's content never changes.
IMAGE_CACHE_CONTROL = "private, max-age=604800, immutable"
USER_AGENT = f"CommanderDuels/{APP_VERSION}"
API_HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json"}
IMAGE_HEADERS = {"User-Agent": USER_AGENT, "Accept": "image/jpeg"}
PNG_HEADERS = {"User-Agent": USER_AGENT, "Accept": "image/png"}


def media_type(image: bytes) -> str:
    """What a served image is, by its own bytes: a png request answered with large is a JPEG."""
    return "image/png" if image.startswith(PNG_MAGIC) else "image/jpeg"


@dataclass(frozen=True)
class Chosen:
    """A printing's image in the catalog: which face, and the object holding its image_uris."""

    scryfall_id: UUID
    face: int | None
    source: dict[str, Any]
    artist: str | None
    set_code: str
    collector_number: str


def chosen_printing(printing: CardPrinting, name: str | None) -> Chosen | None:
    """The image of a printing: the face named, else its own image, else its front face's."""
    card: dict[str, Any] = {"image_uris": printing.image_uris, "card_faces": printing.faces or []}
    picked = chosen_face(card, name or "")
    if picked is None:
        return None
    face, source = picked
    artist = source.get("artist") if face is not None else None
    return Chosen(
        scryfall_id=printing.scryfall_id,
        face=face,
        source=source,
        artist=str(artist) if artist else printing.artist,
        set_code=printing.set_code,
        collector_number=printing.collector_number,
    )


def own_printing(db: Session, user_id: UUID, game_id: UUID, name: str) -> CardPrinting | None:
    """The printing the user chose for this card in the deck their seat plays in the game."""
    revision = db.scalar(
        select(GameSeat.deck_revision_id).where(
            GameSeat.game_id == game_id, GameSeat.user_id == user_id
        )
    )
    if revision is None:
        return None
    wanted = normalize(name)
    return db.scalar(
        select(CardPrinting)
        .join(DeckEntryRow, DeckEntryRow.printing_id == CardPrinting.id)
        .join(CardConcept, CardConcept.id == DeckEntryRow.concept_id)
        .where(
            DeckEntryRow.revision_id == revision,
            or_(CardConcept.normalized_name == wanted, CardConcept.engine_name == name),
        )
        .limit(1)
    )


def catalog_printing(db: Session, name: str) -> CardPrinting | None:
    """The printing the catalog shows for a name: the card's own name, the engine's name for it,
    or one of its faces (the back of a double-faced card)."""
    wanted = normalize(name)
    printing_id = db.scalar(
        select(CardConcept.default_printing_id)
        .where(
            or_(CardConcept.normalized_name == wanted, CardConcept.engine_name == name),
            CardConcept.removed_revision.is_(None),
            CardConcept.default_printing_id.is_not(None),
        )
        .order_by(CardConcept.deck_card.desc())
        .limit(1)
    )
    if printing_id is None:
        printing_id = db.scalar(
            select(CardConcept.default_printing_id)
            .join(CardAlias, CardAlias.concept_id == CardConcept.id)
            .where(CardAlias.alias == wanted, CardAlias.kind == "face")
            .limit(1)
        )
    return db.get(CardPrinting, printing_id) if printing_id else None


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


def deferred(wait: float) -> ApiError:
    """Refused before Scryfall is asked: it asked us to wait, or too many lookups are waiting.
    Not logged; a burst of requests would repeat it for each."""
    return ApiError(
        503,
        "card_images_unavailable",
        "Card images are not available right now. Try again.",
        {"Retry-After": str(max(1, math.ceil(wait)))},
    )


def busy(wait: float) -> ApiError:
    return ApiError(
        429,
        "card_images_busy",
        "Your account is already waiting for many card images. Try again shortly.",
        {"Retry-After": str(max(1, math.ceil(wait)))},
    )


def retry_after(response: httpx.Response) -> float:
    """How long Scryfall asked us to wait after a 429: its Retry-After, in seconds or as a date,
    at least the 30 s its documentation names and at most an hour."""
    value = response.headers.get("retry-after", "").strip()
    if value.isascii() and value.isdigit():
        # More digits than a float holds reads as infinity: the longest pause, not an error.
        seconds = float(value)
    else:
        try:
            seconds = (parsedate_to_datetime(value) - utcnow()).total_seconds()
        except (TypeError, ValueError, OverflowError):
            seconds = 0.0
    return min(max(seconds, RATE_LIMIT_PAUSE), MAX_RATE_LIMIT_PAUSE)


def file_name(scryfall_id: UUID, face: int | None, size: ImageSize) -> str:
    """The image's file: Scryfall's card ID (a UUID, so never a path), its face and its size."""
    extension = "png" if size == "png" else "jpg"
    return f"{scryfall_id}{'' if face is None else f'-f{face}'}-{size}.{extension}"


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


def record_missing(database: Engine, name: str) -> None:
    """Records that Scryfall has no image for the name. Names it had none for a week ago or more
    count as never asked (see stored), so their rows go now: names come from clients, and each
    new one an account asks for would otherwise add a row for good."""
    entry = missing_entry(name)
    with Session(database) as db:
        db.execute(
            delete(CardImage).where(
                CardImage.status == "missing",
                CardImage.checked_at < entry.checked_at - MISSING_RETRY,
            )
        )
        db.merge(entry)
        db.commit()


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
        # Scryfall answered 429: nothing is asked of its API before this time.
        self.paused_until = -math.inf
        # Lookups waiting on Scryfall's API, by account; None is SysOp's, which are never refused.
        self.lookups: Counter[UUID | None] = Counter()
        # Replaced in tests, to measure the spacing without waiting for it.
        self.clock: Callable[[], float] = time.monotonic
        self.sleep: Callable[[float], Awaitable[None]] = asyncio.sleep

    def require_directory(self) -> Path:
        if self.directory is None:
            raise images_unavailable()
        return self.directory

    def choose(self, name: str, game: tuple[UUID, UUID] | None) -> Chosen | None:
        """The catalog's image for a name; with (user, game), the user's own printing first."""
        with Session(self.database) as db:
            printing = own_printing(db, game[0], game[1], name) if game else None
            printing = printing or catalog_printing(db, name)
            return chosen_printing(printing, name) if printing is not None else None

    async def printing(
        self, printing_id: UUID, face: int | None, size: ImageSize, account: UUID | None
    ) -> bytes:
        """A catalog printing's JPEG, or one of its faces'."""
        directory = self.require_directory()

        def find() -> Chosen | None:
            with Session(self.database) as db:
                printing = db.get(CardPrinting, printing_id)
                if printing is None:
                    return None
                faces = printing.faces or []
                name = faces[face].get("name") if face is not None and face < len(faces) else None
                return chosen_printing(printing, str(name) if name else None)

        chosen = await run_in_threadpool(find)
        if chosen is None:
            raise missing()
        return await self.catalog_image(directory, chosen, size, account)

    async def catalog_image(
        self, directory: Path, chosen: Chosen, size: ImageSize, account: UUID | None
    ) -> bytes:
        """A catalog image from disk, or downloaded once from Scryfall's image host. Downloads
        need no API request, but still count against the account's share of the queue. A png
        the printing lacks is served as its large image, then its normal one."""
        for each in SIZES_TO_TRY[size]:
            path = directory / file_name(chosen.scryfall_id, chosen.face, each)
            image = await run_in_threadpool(read_image, path)
            if image is not None:
                return image
            url = image_url(chosen.source, each)
            if url is None:
                continue
            async with self.locked(path.name):
                image = await run_in_threadpool(read_image, path)
                if image is not None:
                    return image
                with self.counted(account):
                    image = await self.download(url, each)
                try:
                    await run_in_threadpool(write_atomically, path, image)
                except OSError as error:
                    raise unavailable(f"could not write {path.name}: {error}") from error
                return image
        raise missing()

    async def image(
        self,
        name: str,
        size: ImageSize,
        account: UUID | None,
        game: tuple[UUID, UUID] | None = None,
    ) -> bytes:
        """The name's JPEG: the catalog's printing when it knows the name, else from disk or,
        the first time, from Scryfall's named-card search while the request waits. A lookup
        counts against the account's share of the queue (see counted)."""
        directory = self.require_directory()
        chosen = await run_in_threadpool(self.choose, name, game)
        if chosen is not None:
            return await self.catalog_image(directory, chosen, size, account)
        image = await run_in_threadpool(self.stored, directory, name, size)
        if image is not None:
            return image
        async with self.locked(name):
            # Another request may have fetched it while this one waited.
            image = await run_in_threadpool(self.stored, directory, name, size)
            if image is not None:
                return image
            with self.counted(account):
                return await self.fetch(directory, name, size)

    async def info(self, name: str, game: tuple[UUID, UUID] | None = None) -> CardImageInfo | None:
        self.require_directory()
        chosen = await run_in_threadpool(self.choose, name, game)
        if chosen is not None:
            return CardImageInfo(
                name=name,
                status="found",
                artist=chosen.artist,
                set_code=chosen.set_code,
                collector_number=chosen.collector_number,
            )
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

    @contextmanager
    def counted(self, account: UUID | None) -> Iterator[None]:
        """Counts a lookup that will wait its turn for Scryfall's API, or refuses it at once,
        before Scryfall is asked or a row recorded, when the account already has
        LOOKUPS_PER_ACCOUNT waiting or everyone LOOKUPS_WAITING. SysOp (None) is never refused."""
        if account is not None:
            if self.lookups[account] >= LOOKUPS_PER_ACCOUNT:
                raise busy(self.lookups[account] * API_SPACING)
            if self.lookups.total() >= LOOKUPS_WAITING:
                raise deferred(self.lookups.total() * API_SPACING)
        self.lookups[account] += 1
        try:
            yield
        finally:
            self.lookups[account] -= 1
            if not self.lookups[account]:
                del self.lookups[account]

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
        # The size asked for, or (for png) the next size down the printing has.
        served, url = next(
            (
                (each, address)
                for each in SIZES_TO_TRY[size]
                if chosen is not None and (address := image_url(chosen[1], each)) is not None
            ),
            (size, None),
        )
        if card is None or chosen is None or url is None:
            # Scryfall knows no such card, or has no image of it.
            await run_in_threadpool(record_missing, self.database, name)
            raise missing()
        try:
            scryfall_id = UUID(str(card["id"]))
        except (KeyError, ValueError) as error:
            raise unavailable("Scryfall's card has no valid id") from error
        face, source = chosen
        path = directory / file_name(scryfall_id, face, served)
        image = await run_in_threadpool(read_image, path)
        if image is None:
            image = await self.download(url, served)
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
        """Returns once the previous request to Scryfall's API started API_SPACING ago or more.
        While Scryfall has asked us to wait, refuses at once instead, requests already queued
        included: asking again while limited can get this site's address banned."""
        self.check_pause()
        async with self.spacing:
            while (delay := self.next_request - self.clock()) > 0:
                await self.sleep(delay)
            self.check_pause()
            self.next_request = self.clock() + API_SPACING

    def check_pause(self) -> None:
        if (wait := self.paused_until - self.clock()) > 0:
            raise deferred(wait)

    async def named(self, name: str) -> dict[str, Any] | None:
        """Scryfall's card for the exact name, or None if Scryfall knows no such card."""
        await self.pace()
        try:
            response = await self.client.get(
                f"{self.api_url}/cards/named", params={"exact": name}, headers=API_HEADERS
            )
        except httpx.HTTPError as error:
            raise unavailable(f"Scryfall's API: {type(error).__name__}") from error
        if response.status_code == 429:
            pause = retry_after(response)
            self.paused_until = max(self.paused_until, self.clock() + pause)
            log.warning("Scryfall's API answered 429: no lookups for %.0f s", pause)
            raise deferred(pause)
        try:
            body = response.json()
        except ValueError as error:
            raise unavailable(f"Scryfall's API: {type(error).__name__}") from error
        if not isinstance(body, dict):
            raise unavailable("Scryfall's API answered with something other than an object")
        if response.status_code == 404 and body.get("code") == "not_found":
            return None
        if response.status_code != 200 or body.get("object") != "card":
            raise unavailable(f"Scryfall's API answered {response.status_code}")
        return body

    async def download(self, url: str, size: ImageSize = "normal") -> bytes:
        """The image from Scryfall's image host, never a redirect: a JPEG of at most
        MAX_IMAGE_BYTES, or for png a PNG of at most MAX_PNG_BYTES."""
        png = size == "png"
        expected, magic, limit = (
            ("image/png", PNG_MAGIC, MAX_PNG_BYTES)
            if png
            else ("image/jpeg", JPEG_MAGIC, MAX_IMAGE_BYTES)
        )
        headers = PNG_HEADERS if png else IMAGE_HEADERS
        try:
            async with self.client.stream("GET", url, headers=headers) as response:
                kind = response.headers.get("content-type", "").split(";")[0].strip().lower()
                if response.status_code != 200 or kind != expected:
                    raise unavailable(f"the image host answered {response.status_code} {kind}")
                image = bytearray()
                async for chunk in response.aiter_bytes():
                    image += chunk
                    if len(image) > limit:
                        raise unavailable(f"the image is larger than {limit // 1024 // 1024} MB")
        except httpx.HTTPError as error:
            raise unavailable(f"the image host: {type(error).__name__}") from error
        if not image.startswith(magic):
            raise unavailable(f"the image is not a {'PNG' if png else 'JPEG'}")
        return bytes(image)


def cache_of(request: Request) -> CardImageCache:
    return cast(CardImageCache, request.app.state.card_images)


async def release(db: Session) -> None:
    """Gives back the connection that signing the request in used. The cache opens a Session of
    its own; requests holding one connection while waiting for another (and for Scryfall) could
    take the whole pool, and every request in the API would then wait for it."""
    await run_in_threadpool(db.close)


def queue_account(principal: Principal) -> UUID | None:
    """Whose share of the Scryfall queue a lookup takes; SysOp's lookups are never refused."""
    return None if principal.user.kind == "sysop" else principal.user.id


# Hidden information: these routes only map a name the client already knows to an image. Nothing
# here prefetches deck lists or other seats' cards; that would let a player probe the cache for
# another seat's deck.


@router.get(
    "/card-images",
    response_class=Response,
    responses={
        200: {
            "description": "The card's image.",
            "content": {
                "image/jpeg": {"schema": {"type": "string", "format": "binary"}},
                "image/png": {"schema": {"type": "string", "format": "binary"}},
            },
        }
    },
)
async def card_image(
    request: Request,
    principal: Active,
    db: Db,
    name: CardName,
    size: Annotated[ImageSize, Query()] = "normal",
    game: UUID | None = None,
) -> Response:
    """A card's image by its exact name, from Scryfall, cached on this server. With game, the
    printing chosen in your own seat's deck. The first request for a card waits while it is
    fetched. 404 card_image_missing for cards Scryfall does not know, such as tokens. 429
    card_images_busy when the account already waits for many new cards, and 503 when everyone
    does or Scryfall asked us to wait; both carry Retry-After."""
    account = queue_account(principal)
    await release(db)
    seat = (principal.user.id, game) if game else None
    image = await cache_of(request).image(name, size, account, seat)
    # A game's own printing may differ from the card's default, so it is kept for an hour only.
    control = IMAGE_CACHE_CONTROL if game is None else "private, max-age=3600"
    return Response(image, media_type=media_type(image), headers={"Cache-Control": control})


@router.get(
    "/card-images/printings/{printing_id}",
    response_class=Response,
    responses={
        200: {
            "description": "The printing's image.",
            "content": {
                "image/jpeg": {"schema": {"type": "string", "format": "binary"}},
                "image/png": {"schema": {"type": "string", "format": "binary"}},
            },
        }
    },
)
async def printing_image(
    request: Request,
    principal: Active,
    db: Db,
    printing_id: UUID,
    face: Annotated[int | None, Query(ge=0, le=7)] = None,
    size: Annotated[ImageSize, Query()] = "normal",
) -> Response:
    """A catalog printing's image (one face's, for double-faced cards), cached on this server."""
    account = queue_account(principal)
    await release(db)
    image = await cache_of(request).printing(printing_id, face, size, account)
    return Response(
        image, media_type=media_type(image), headers={"Cache-Control": IMAGE_CACHE_CONTROL}
    )


@router.get("/card-images/info", response_model=CardImageInfo)
async def card_image_info(
    request: Request, principal: Active, db: Db, name: CardName, game: UUID | None = None
) -> CardImageInfo:
    """The printing and artist behind a name's image, to credit the artist and Scryfall. Never
    fetches: 404 until the image has been requested, unless the catalog names the printing."""
    await release(db)
    info = await cache_of(request).info(name, (principal.user.id, game) if game else None)
    if info is None:
        raise ApiError(404, "card_image_unknown", "This card's image has not been looked up.")
    return info
