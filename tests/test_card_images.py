"""Card images (v0.1.0): looked up on Scryfall by exact name, cached on disk and served from our
own origin. Scryfall's API and its image host are a fake behind httpx.MockTransport; no test
reaches the network, and the spacing between API requests is measured on a fake clock."""

import asyncio
import copy
import secrets
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager
from datetime import timedelta
from email.utils import format_datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, func, select, update
from sqlalchemy.orm import Session
from sqlalchemy.pool import QueuePool

from api import card_images
from api.card_images import (
    API_SPACING,
    IMAGE_CACHE_CONTROL,
    LOOKUPS_PER_ACCOUNT,
    LOOKUPS_WAITING,
    CardImageCache,
)
from api.config import Settings
from api.database import build_engine
from api.identity import ApiError, hash_token, utcnow
from api.main import create_app
from api.models import CardImage, User, UserSession
from api.version import APP_VERSION

IMAGES = "/api/v1/card-images"
INFO = "/api/v1/card-images/info"
SYSOP_NETWORK, SYSOP_ADDRESS = "10.20.0.0/24", ("10.20.0.5", 50000)
ACCOUNT = UUID("5d1f4a8e-0c2b-4f7e-9a63-2b8c7e1d4f00")
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF"
PNG = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
BOLT_ID = "77c6fa74-5543-42ac-9ead-0e890b188e99"
DELVER_ID = "11bf83bb-c95b-4b4f-9a56-ce7a1816307a"
FIRE_ICE_ID = "2f0b6ab0-7ad4-4a5c-8c4a-2b4b5c0a3e11"


def image_uris(stem: str) -> dict[str, str]:
    uris = {
        size: f"https://cards.scryfall.io/{size}/front/{stem}.jpg?1562"
        for size in ("small", "normal", "large")
    }
    return {**uris, "png": f"https://cards.scryfall.io/png/front/{stem}.png?1562"}


BOLT = {
    "object": "card",
    "id": BOLT_ID,
    "name": "Lightning Bolt",
    "set": "lea",
    "collector_number": "161",
    "artist": "Card Artist",
    "image_uris": image_uris("bolt"),
}
# A transform card: each face has its own image and artist; the card has no image of its own.
DELVER = {
    "object": "card",
    "id": DELVER_ID,
    "name": "Delver of Secrets // Insectile Aberration",
    "set": "isd",
    "collector_number": "51",
    "artist": "Card Artist",
    "card_faces": [
        {"name": "Delver of Secrets", "artist": "Front Artist", "image_uris": image_uris("delver")},
        {
            "name": "Insectile Aberration",
            "artist": "Back Artist",
            "image_uris": image_uris("aberration"),
        },
    ],
}
# A split card: its halves share the card's one image.
FIRE_ICE = {
    "object": "card",
    "id": FIRE_ICE_ID,
    "name": "Fire // Ice",
    "set": "mh2",
    "collector_number": "290",
    "artist": "Card Artist",
    "card_faces": [{"name": "Fire"}, {"name": "Ice"}],
    "image_uris": image_uris("fire-ice"),
}
NOT_FOUND = {"object": "error", "code": "not_found", "status": 404, "details": "No cards found."}


class FakeScryfall:
    """Scryfall's named-card search and its image host, recording every request. API requests
    also record the cache's clock, once a test gives it one."""

    def __init__(self) -> None:
        self.cards: dict[str, dict[str, Any]] = {
            "lightning bolt": copy.deepcopy(BOLT),
            "delver of secrets": copy.deepcopy(DELVER),
            "insectile aberration": copy.deepcopy(DELVER),
            "delver of secrets // insectile aberration": copy.deepcopy(DELVER),
            "fire": copy.deepcopy(FIRE_ICE),
        }
        self.api_calls: list[str] = []
        self.api_times: list[float] = []
        self.downloads: list[str] = []
        self.api_failure: httpx.Response | Exception | None = None
        self.image_failure: httpx.Response | None = None
        self.clock: Callable[[], float] | None = None
        # While set and closed, API requests wait for it: lookups stay in flight.
        self.gate: asyncio.Event | None = None

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.scryfall.com":
            assert request.url.path == "/cards/named"
            assert request.headers["user-agent"] == f"CommanderDuels/{APP_VERSION}"
            assert request.headers["accept"] == "application/json"
            name = request.url.params["exact"]
            self.api_calls.append(name)
            if self.clock is not None:
                self.api_times.append(self.clock())
            if self.gate is not None:
                await self.gate.wait()
            await asyncio.sleep(0.01)  # concurrent requests overlap here
            if isinstance(self.api_failure, Exception):
                raise self.api_failure
            if self.api_failure is not None:
                return self.api_failure
            card = self.cards.get(name.casefold())
            if card is None:
                return httpx.Response(404, json=NOT_FOUND)
            return httpx.Response(200, json=card)
        assert request.url.host == "cards.scryfall.io", request.url
        self.downloads.append(str(request.url))
        if self.image_failure is not None:
            return self.image_failure
        # Each image is its format's signature and its own path, so a test can tell which it got.
        if request.url.path.startswith("/png/"):
            assert request.headers["accept"] == "image/png"
            return httpx.Response(
                200, content=PNG + request.url.path.encode(), headers={"content-type": "image/png"}
            )
        assert request.headers["accept"] == "image/jpeg"
        return httpx.Response(
            200, content=JPEG + request.url.path.encode(), headers={"content-type": "image/jpeg"}
        )


class FakeClock:
    """The cache's clock and sleep: sleeping moves the clock instead of waiting."""

    def __init__(self) -> None:
        self.now = 0.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, delay: float) -> None:
        self.slept.append(delay)
        self.now += delay
        await asyncio.sleep(0)


def served(stem: str, size: str = "normal") -> bytes:
    return JPEG + f"/{size}/front/{stem}.jpg".encode()


@pytest.fixture
def database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    url = f"sqlite:///{tmp_path}/images.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    return url


@pytest.fixture
def scryfall() -> FakeScryfall:
    return FakeScryfall()


@pytest.fixture
def directory(tmp_path: Path) -> Path:
    return tmp_path / "card-images"


def build(
    database: str, scryfall: FakeScryfall, directory: Path | None, **settings: Any
) -> FastAPI:
    app = create_app(
        Settings(
            database_url=database, card_image_dir=str(directory) if directory else "", **settings
        )
    )
    app.state.scryfall_transport = httpx.MockTransport(scryfall)
    return app


@asynccontextmanager
async def running(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    """The app with its lifespan, and a client whose requests run concurrently on this loop, as
    a browser's would over HTTP/2. A server error is answered with 500, as in production."""
    transport = httpx.ASGITransport(app, raise_app_exceptions=False, client=SYSOP_ADDRESS)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=transport, base_url="https://testserver") as client,
    ):
        yield client


async def eventually(condition: Callable[[], bool]) -> None:
    for _ in range(500):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("the condition never held")


@pytest.fixture
def small_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two database connections and a 2 s wait for one, so holding one while waiting for
    another shows as a timeout (a 500) within seconds."""

    def small(url: str) -> Engine:
        return create_engine(url, poolclass=QueuePool, pool_size=2, max_overflow=0, pool_timeout=2)

    monkeypatch.setattr("api.main.build_engine", small)


@pytest.fixture
def client(
    database: str, scryfall: FakeScryfall, directory: Path, clock: FakeClock
) -> Iterator[TestClient]:
    with TestClient(build(database, scryfall, directory), base_url="https://testserver") as client:
        # The spacing between Scryfall requests passes on the fake clock: no test waits for it.
        cache: CardImageCache = client.app.state.card_images  # type: ignore[attr-defined]
        cache.clock, cache.sleep = clock, clock.sleep
        yield client


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def app(client: TestClient) -> FastAPI:
    return client.app  # type: ignore[return-value]


def signed_in(app: FastAPI, status: str = "active", kind: str = "player") -> dict[str, str]:
    """Request headers carrying the session cookie of a new account."""
    now = utcnow()
    token = secrets.token_urlsafe(32)
    handle = f"{kind}_{secrets.token_hex(4)}"
    with Session(app.state.database) as db:
        user = User(
            handle=handle,
            normalized_handle=handle,
            display_name=handle,
            kind=kind,
            status=status,
            onboarding="complete",
            created_at=now,
        )
        db.add(user)
        db.flush()
        db.add(
            UserSession(
                token_hash=hash_token(token),
                user_id=user.id,
                kind="sysop" if kind == "sysop" else "google",
                csrf_token=secrets.token_urlsafe(32),
                privilege_version=0,
                created_at=now,
                authenticated_at=now,
                last_seen_at=now,
                idle_expires_at=now + timedelta(days=1),
                absolute_expires_at=now + timedelta(days=1),
            )
        )
        db.commit()
    return {"cookie": f"cd_session={token}"}


def entry(app: FastAPI, name: str) -> CardImage | None:
    with Session(app.state.database) as db:
        return db.get(CardImage, name)


def entries(app: FastAPI) -> int:
    with Session(app.state.database) as db:
        return db.scalar(select(func.count()).select_from(CardImage)) or 0


def files(directory: Path) -> list[str]:
    return sorted(path.name for path in directory.iterdir()) if directory.is_dir() else []


def test_an_image_is_fetched_once_then_served_from_disk(
    client: TestClient, app: FastAPI, scryfall: FakeScryfall, directory: Path
) -> None:
    ada = signed_in(app)
    first = client.get(IMAGES, params={"name": "Lightning Bolt"}, headers=ada)
    assert first.status_code == 200, first.text
    assert first.headers["content-type"] == "image/jpeg"
    assert first.headers["cache-control"] == IMAGE_CACHE_CONTROL
    assert first.headers["x-content-type-options"] == "nosniff"
    assert first.content == served("bolt")
    assert scryfall.api_calls == ["Lightning Bolt"]
    assert scryfall.downloads == ["https://cards.scryfall.io/normal/front/bolt.jpg?1562"]
    # Written whole under the printing's ID, with no temporary file left behind.
    assert files(directory) == [f"{BOLT_ID}-normal.jpg"]

    again = client.get(IMAGES, params={"name": "Lightning Bolt", "size": "normal"}, headers=ada)
    assert again.content == served("bolt")
    assert again.headers["cache-control"] == IMAGE_CACHE_CONTROL
    assert len(scryfall.api_calls) == 1 and len(scryfall.downloads) == 1

    found = entry(app, "Lightning Bolt")
    assert found is not None and found.status == "found"
    assert found.scryfall_id == UUID(BOLT_ID) and found.face is None
    info = client.get(INFO, params={"name": "Lightning Bolt"}, headers=ada)
    assert info.json() == {
        "name": "Lightning Bolt",
        "status": "found",
        "artist": "Card Artist",
        "set_code": "lea",
        "collector_number": "161",
    }
    # JSON routes, their errors included, are still never cached.
    assert info.headers["cache-control"] == "no-store"
    assert client.get("/api/v1/health").headers["cache-control"] == "no-store"
    unknown = client.get(INFO, params={"name": "Counterspell"}, headers=ada)
    assert unknown.status_code == 404 and unknown.json()["code"] == "card_image_unknown"
    assert unknown.headers["cache-control"] == "no-store"
    assert len(scryfall.api_calls) == 1  # info never fetches

    large = client.get(IMAGES, params={"name": "Lightning Bolt", "size": "large"}, headers=ada)
    assert large.status_code == 200 and large.content == served("bolt", "large")
    assert scryfall.downloads[-1] == "https://cards.scryfall.io/large/front/bolt.jpg?1562"
    assert files(directory) == [f"{BOLT_ID}-large.jpg", f"{BOLT_ID}-normal.jpg"]
    client.get(IMAGES, params={"name": "Lightning Bolt", "size": "large"}, headers=ada)
    assert len(scryfall.downloads) == 2


def test_a_double_faced_card_shows_the_named_face(
    client: TestClient, app: FastAPI, scryfall: FakeScryfall, directory: Path
) -> None:
    ada = signed_in(app)
    back = client.get(IMAGES, params={"name": "Insectile Aberration"}, headers=ada)
    assert back.content == served("aberration")
    front = client.get(IMAGES, params={"name": "delver of secrets"}, headers=ada)
    assert front.content == served("delver")
    assert files(directory) == [f"{DELVER_ID}-f0-normal.jpg", f"{DELVER_ID}-f1-normal.jpg"]
    assert client.get(INFO, params={"name": "Insectile Aberration"}, headers=ada).json() == {
        "name": "Insectile Aberration",
        "status": "found",
        "artist": "Back Artist",
        "set_code": "isd",
        "collector_number": "51",
    }
    assert client.get(INFO, params={"name": "delver of secrets"}, headers=ada).json()["artist"] == (
        "Front Artist"
    )
    # The card's full name matches no face: the front, already on disk under the same printing.
    whole = client.get(
        IMAGES, params={"name": "Delver of Secrets // Insectile Aberration"}, headers=ada
    )
    assert whole.content == served("delver") and len(scryfall.downloads) == 2
    assert entry(app, "Delver of Secrets // Insectile Aberration").face == 0  # type: ignore[union-attr]

    # A split card's halves share the card's own image.
    fire = client.get(IMAGES, params={"name": "Fire"}, headers=ada)
    assert fire.content == served("fire-ice")
    assert f"{FIRE_ICE_ID}-normal.jpg" in files(directory)
    assert entry(app, "Fire").face is None  # type: ignore[union-attr]


def test_cards_scryfall_does_not_know_stay_missing_for_a_week(
    client: TestClient,
    app: FastAPI,
    scryfall: FakeScryfall,
    directory: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ada = signed_in(app)
    for _ in range(2):
        token = client.get(IMAGES, params={"name": "Goblin Token"}, headers=ada)
        assert token.status_code == 404 and token.json()["code"] == "card_image_missing"
        assert token.headers["cache-control"] == "no-store"
    assert scryfall.api_calls == ["Goblin Token"] and scryfall.downloads == []
    assert client.get(INFO, params={"name": "Goblin Token"}, headers=ada).json() == {
        "name": "Goblin Token",
        "status": "missing",
        "artist": None,
        "set_code": None,
        "collector_number": None,
    }

    # A week later Scryfall is asked again, and now knows the card.
    real = card_images.utcnow
    monkeypatch.setattr(card_images, "utcnow", lambda: real() + timedelta(days=7, minutes=1))
    scryfall.cards["goblin token"] = copy.deepcopy(BOLT)
    assert client.get(IMAGES, params={"name": "Goblin Token"}, headers=ada).status_code == 200
    assert entry(app, "Goblin Token").status == "found"  # type: ignore[union-attr]
    assert len(scryfall.api_calls) == 2

    # A found card whose file is gone is looked up again; if Scryfall forgot it, it is missing.
    (directory / f"{BOLT_ID}-normal.jpg").unlink()
    del scryfall.cards["goblin token"]
    gone = client.get(IMAGES, params={"name": "Goblin Token"}, headers=ada)
    assert gone.json()["code"] == "card_image_missing"
    forgotten = entry(app, "Goblin Token")
    assert forgotten is not None and forgotten.status == "missing"
    assert forgotten.scryfall_id is None and forgotten.artist is None


def test_names_missing_for_over_a_week_leave_no_row(
    client: TestClient, app: FastAPI, scryfall: FakeScryfall, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Names come from clients: kept for good, each junk name an account asks for adds a row.
    ada = signed_in(app)
    real = card_images.utcnow
    days = 0
    monkeypatch.setattr(card_images, "utcnow", lambda: real() + timedelta(days=days))
    assert client.get(IMAGES, params={"name": "Junk 1"}, headers=ada).status_code == 404
    assert client.get(IMAGES, params={"name": "Lightning Bolt"}, headers=ada).status_code == 200
    days = 3
    assert client.get(IMAGES, params={"name": "Junk 2"}, headers=ada).status_code == 404
    assert entries(app) == 3

    days = 8
    assert client.get(IMAGES, params={"name": "Junk 3"}, headers=ada).status_code == 404
    assert entry(app, "Junk 1") is None
    assert [entry(app, name) is not None for name in ("Junk 2", "Junk 3")] == [True, True]
    assert entry(app, "Lightning Bolt").status == "found"  # type: ignore[union-attr]
    # A deleted name counts as never asked, as it did once its week was out.
    info = client.get(INFO, params={"name": "Junk 1"}, headers=ada)
    assert info.status_code == 404 and info.json()["code"] == "card_image_unknown"
    assert scryfall.api_calls == ["Junk 1", "Lightning Bolt", "Junk 2", "Junk 3"]


def test_scryfall_failures_record_nothing(
    client: TestClient, app: FastAPI, scryfall: FakeScryfall, directory: Path
) -> None:
    ada = signed_in(app)
    failures: list[httpx.Response | Exception] = [
        # A 429 also pauses every lookup: test_scryfalls_429_pauses_every_lookup.
        httpx.Response(503, json={"object": "error", "code": "unavailable"}),
        httpx.Response(500, text="<html>error</html>"),
        httpx.Response(404, text="not JSON"),
        httpx.Response(200, json={"object": "list", "data": []}),
        httpx.Response(200, json={**BOLT, "id": "../../etc/passwd"}),
        httpx.ReadTimeout("Scryfall is slow"),
        httpx.ConnectError("Scryfall is unreachable"),
    ]
    for failure in failures:
        scryfall.api_failure = failure
        response = client.get(IMAGES, params={"name": "Lightning Bolt"}, headers=ada)
        assert response.status_code == 503, failure
        assert response.json()["code"] == "card_images_unavailable"
        assert response.headers["cache-control"] == "no-store"
    scryfall.api_failure = None
    oversized = JPEG + b"0" * (2 * 1024 * 1024)
    for image_failure in [
        httpx.Response(404, json=NOT_FOUND),
        httpx.Response(200, text="<html>", headers={"content-type": "text/html"}),
        httpx.Response(200, content=b"GIF89a", headers={"content-type": "image/jpeg"}),
        httpx.Response(200, content=oversized, headers={"content-type": "image/jpeg"}),
        httpx.Response(302, headers={"location": "http://169.254.169.254/"}),
    ]:
        scryfall.image_failure = image_failure
        response = client.get(IMAGES, params={"name": "Lightning Bolt"}, headers=ada)
        assert response.status_code == 503, image_failure
    assert entries(app) == 0 and files(directory) == []
    assert len(scryfall.downloads) == 5  # the redirect was not followed

    scryfall.image_failure = None
    assert client.get(IMAGES, params={"name": "Lightning Bolt"}, headers=ada).status_code == 200


def test_the_png_size_is_a_png_and_falls_back_when_a_printing_has_none(
    client: TestClient, app: FastAPI, scryfall: FakeScryfall, directory: Path
) -> None:
    """The magnifier's png (v0.3.0): checked as a PNG, kept under its own name, up to 8 MB; a
    printing without one is served at the next size down and never recorded as missing."""
    ada = signed_in(app)
    png = client.get(IMAGES, params={"name": "Lightning Bolt", "size": "png"}, headers=ada)
    assert png.status_code == 200, png.text
    assert png.headers["content-type"] == "image/png"
    assert png.content == PNG + b"/png/front/bolt.png"
    assert files(directory) == [f"{BOLT_ID}-png.png"]
    # From disk the next time, and the JPEG sizes stay their own files.
    again = client.get(IMAGES, params={"name": "Lightning Bolt", "size": "png"}, headers=ada)
    assert again.content == png.content and len(scryfall.downloads) == 1
    normal = client.get(IMAGES, params={"name": "Lightning Bolt"}, headers=ada)
    assert normal.headers["content-type"] == "image/jpeg"
    assert files(directory) == [f"{BOLT_ID}-normal.jpg", f"{BOLT_ID}-png.png"]

    # Not a PNG, too large, or the wrong type: refused, and nothing is kept.
    big = PNG + b"0" * (8 * 1024 * 1024)
    for failure in [
        httpx.Response(200, content=JPEG + b"x", headers={"content-type": "image/png"}),
        httpx.Response(200, content=PNG + b"x", headers={"content-type": "image/jpeg"}),
        httpx.Response(200, content=big, headers={"content-type": "image/png"}),
    ]:
        scryfall.image_failure = failure
        refused = client.get(IMAGES, params={"name": "Fire", "size": "png"}, headers=ada)
        assert refused.status_code == 503, failure
    scryfall.image_failure = None
    assert not any("png" in name and FIRE_ICE_ID in name for name in files(directory))

    # A printing Scryfall has no png for: its large image, and the name is still found.
    del scryfall.cards["fire"]["image_uris"]["png"]
    fallback = client.get(IMAGES, params={"name": "Fire", "size": "png"}, headers=ada)
    assert fallback.status_code == 200, fallback.text
    assert fallback.headers["content-type"] == "image/jpeg"
    assert fallback.content == served("fire-ice", "large")
    found = entry(app, "Fire")
    assert found is not None and found.status == "found"
    assert client.get(IMAGES, params={"name": "Fire"}, headers=ada).status_code == 200


def test_image_addresses_off_scryfalls_image_host_are_refused(
    client: TestClient, app: FastAPI, scryfall: FakeScryfall, directory: Path
) -> None:
    ada = signed_in(app)
    for url in [
        "https://evil.example/normal/front/bolt.jpg",
        "http://cards.scryfall.io/normal/front/bolt.jpg",
        "https://cards.scryfall.io.evil.example/normal/front/bolt.jpg",
        "https://evilscryfall.io/normal/front/bolt.jpg",
        "https://cards.scryfall.io:8443/normal/front/bolt.jpg",
        "https://10.10.50.1/normal/front/bolt.jpg",
        "file:///etc/passwd",
    ]:
        scryfall.cards["lightning bolt"]["image_uris"]["normal"] = url
        response = client.get(IMAGES, params={"name": "Lightning Bolt"}, headers=ada)
        assert response.status_code == 503, url
        assert response.json()["code"] == "card_images_unavailable"
    assert scryfall.downloads == [] and entries(app) == 0 and files(directory) == []
    # The image host itself and its subdomains are fine.
    scryfall.cards["lightning bolt"]["image_uris"]["normal"] = "https://cards.scryfall.io/x.jpg"
    assert client.get(IMAGES, params={"name": "Lightning Bolt"}, headers=ada).status_code == 200


def test_images_need_an_active_account_and_a_folder(
    database: str, scryfall: FakeScryfall, directory: Path
) -> None:
    with TestClient(build(database, scryfall, directory), base_url="https://testserver") as client:
        app: FastAPI = client.app  # type: ignore[assignment]
        for path in (IMAGES, INFO):
            stranger = client.get(path, params={"name": "Lightning Bolt"})
            assert stranger.status_code == 401
            assert stranger.json()["code"] == "authentication_required"
            pending = client.get(
                path, params={"name": "Lightning Bolt"}, headers=signed_in(app, "pending")
            )
            assert pending.status_code == 403 and pending.json()["code"] == "account_pending"
    with TestClient(build(database, scryfall, None), base_url="https://testserver") as client:
        ada = signed_in(client.app)  # type: ignore[arg-type]
        for path in (IMAGES, INFO):
            off = client.get(path, params={"name": "Lightning Bolt"}, headers=ada)
            assert off.status_code == 404 and off.json()["code"] == "images_unavailable"
    assert scryfall.api_calls == [] and files(directory) == []


def test_names_are_validated(client: TestClient, app: FastAPI, scryfall: FakeScryfall) -> None:
    ada = signed_in(app)
    for params in [
        {},
        {"name": ""},
        {"name": "x" * 201},
        {"name": "Lightning\nBolt"},
        {"name": "Lightning\tBolt"},
        {"name": "Lightning Bolt\x00"},
        {"name": "Lightning\x7fBolt"},
        {"name": "Lightning\x85Bolt"},
    ]:
        for path in (IMAGES, INFO):
            response = client.get(path, params=params, headers=ada)
            assert response.status_code == 422, params
            assert response.json()["code"] == "invalid_request"
    # Only normal, large and png (since v0.3.0) are served.
    for size in ("small", "art_crop", "border_crop"):
        other = client.get(IMAGES, params={"name": "Lightning Bolt", "size": size}, headers=ada)
        assert other.status_code == 422, size
    assert scryfall.api_calls == []
    # Any other name of up to 200 characters is asked about.
    longest = client.get(IMAGES, params={"name": "Æ" * 200}, headers=ada)
    assert longest.json()["code"] == "card_image_missing"
    assert scryfall.api_calls == ["Æ" * 200]


def test_requests_to_scryfalls_api_are_spaced(
    client: TestClient, app: FastAPI, scryfall: FakeScryfall, clock: FakeClock
) -> None:
    # Scryfall's rate limits page allows its named-card search 2 requests a second.
    assert API_SPACING >= 0.5
    scryfall.clock = clock
    ada = signed_in(app)
    for name in ("Lightning Bolt", "Delver of Secrets"):
        assert client.get(IMAGES, params={"name": name}, headers=ada).status_code == 200
    first, second = scryfall.api_times
    assert second - first >= API_SPACING
    # One wait, before the second API request; downloads from the image host are not spaced.
    assert clock.slept == [pytest.approx(API_SPACING)]
    assert len(scryfall.downloads) == 2

    clock.now += 1
    assert client.get(IMAGES, params={"name": "Fire"}, headers=ada).status_code == 200
    assert len(clock.slept) == 1


def test_concurrent_requests_for_one_name_fetch_it_once(
    database: str, scryfall: FakeScryfall, directory: Path
) -> None:
    async def scenario() -> None:
        engine = build_engine(database)
        clock = FakeClock()
        scryfall.clock = clock
        try:
            async with httpx.AsyncClient(transport=httpx.MockTransport(scryfall)) as client:
                settings = Settings(database_url=database, card_image_dir=str(directory))
                cache = CardImageCache(settings, engine, client)
                cache.clock, cache.sleep = clock, clock.sleep
                names = ["Lightning Bolt", "Lightning Bolt", "Insectile Aberration"] * 2
                images = await asyncio.gather(
                    *(cache.image(name, "normal", ACCOUNT) for name in names)
                )
                assert images == [served("bolt"), served("bolt"), served("aberration")] * 2
                assert not cache.locks and not cache.waiting and not cache.lookups
        finally:
            engine.dispose()

    asyncio.run(scenario())
    assert sorted(scryfall.api_calls) == ["Insectile Aberration", "Lightning Bolt"]
    assert len(scryfall.downloads) == 2
    first, second = scryfall.api_times
    assert second - first >= API_SPACING


def test_a_session_rotated_by_an_image_request_keeps_its_cookie(
    client: TestClient, app: FastAPI, scryfall: FakeScryfall, clock: FakeClock
) -> None:
    """A role change raises the account's privilege version, and its next request rotates the
    session. Whatever these routes answer, errors with headers of their own included, carries
    the new cookie exactly once, or the player is signed out when the old token's grace ends.
    The routes once copied it across themselves; only the correlation middleware adds it now."""
    cache: CardImageCache = app.state.card_images
    token = signed_in(app)["cookie"].removeprefix("cd_session=")

    def session_of(secret: str) -> UserSession | None:
        with Session(app.state.database) as db:
            return db.scalar(
                select(UserSession).where(UserSession.token_hash == hash_token(secret))
            )

    first = session_of(token)
    assert first is not None
    account = first.user_id

    def rotated(path: str, name: str) -> httpx.Response:
        nonlocal token
        with Session(app.state.database) as db:
            db.execute(update(User).values(privilege_version=User.privilege_version + 1))
            db.commit()
        response = client.get(
            path, params={"name": name}, headers={"cookie": f"cd_session={token}"}
        )
        [cookie] = response.headers.get_list("set-cookie")
        pair, *attributes = (part.strip() for part in cookie.split(";"))
        key, _, new = pair.partition("=")
        assert key == "cd_session" and new and new != token
        assert {"path=/api", "httponly", "secure", "samesite=lax"} <= {
            attribute.lower() for attribute in attributes
        }
        # The cookie is the session the rotation issued, and the old one is over.
        old, current = session_of(token), session_of(new)
        assert old is not None and old.revoked_reason == "rotated"
        assert current is not None and current.revoked_at is None
        token = new
        return response

    image = rotated(IMAGES, "Lightning Bolt")
    assert image.status_code == 200 and image.content == served("bolt")
    assert image.headers["cache-control"] == IMAGE_CACHE_CONTROL
    for path, name, code in (
        (IMAGES, "Goblin Token", "card_image_missing"),
        (INFO, "Counterspell", "card_image_unknown"),
    ):
        response = rotated(path, name)
        assert response.status_code == 404 and response.json()["code"] == code
    # Scryfall fails.
    scryfall.api_failure = httpx.Response(500, text="<html>error</html>")
    failed = rotated(IMAGES, "Counterspell")
    assert failed.status_code == 503 and failed.json()["code"] == "card_images_unavailable"
    scryfall.api_failure = None
    # Errors with a Retry-After keep it beside the cookie: Scryfall asked us to wait, and the
    # account already waits for its share of lookups.
    cache.paused_until = clock() + 30
    paused = rotated(IMAGES, "Counterspell")
    assert paused.status_code == 503 and paused.headers["retry-after"] == "30"
    clock.now += 30
    cache.lookups[account] = LOOKUPS_PER_ACCOUNT
    busy = rotated(IMAGES, "Counterspell")
    assert busy.status_code == 429 and busy.json()["code"] == "card_images_busy"
    assert int(busy.headers["retry-after"]) >= 1
    del cache.lookups[account]
    assert scryfall.api_calls == ["Lightning Bolt", "Goblin Token", "Counterspell"]

    # The last cookie signs the player in, and sets nothing more.
    me = client.get("/api/v1/me", headers={"cookie": f"cd_session={token}"})
    assert me.status_code == 200 and "set-cookie" not in me.headers


@pytest.mark.usefixtures("small_pool")
def test_image_requests_never_hold_two_database_connections(
    database: str, scryfall: FakeScryfall, directory: Path
) -> None:
    """Signing a request in checks a connection out, and the cache opens its own: holding the
    first while waiting for the second, a burst of image requests used up the pool, and every
    request in the API waited for it, then failed."""

    async def scenario() -> None:
        app = build(database, scryfall, directory)
        async with running(app) as http:
            cache: CardImageCache = app.state.card_images
            clock = FakeClock()
            cache.clock, cache.sleep = clock, clock.sleep
            ada, bob = signed_in(app), signed_in(app)
            for name, status in (("Lightning Bolt", 200), ("Goblin Token", 404)):
                warm = await http.get(IMAGES, params={"name": name}, headers=ada)
                assert warm.status_code == status
            burst = (
                [(IMAGES, "Lightning Bolt", 200)] * 6
                + [(IMAGES, "Goblin Token", 404)] * 3
                + [(IMAGES, name, 200) for name in ("Fire", "Delver of Secrets")]
                + [(INFO, "Lightning Bolt", 200)] * 4
                + [(INFO, "Counterspell", 404)] * 2
            )
            responses = await asyncio.gather(
                *(http.get(path, params={"name": name}, headers=ada) for path, name, _ in burst),
                http.get("/api/v1/me", headers=bob),
            )
            assert [response.status_code for response in responses] == [
                status for _, _, status in burst
            ] + [200]
            assert app.state.database.pool.checkedout() == 0

    asyncio.run(scenario())


def test_lookups_waiting_on_scryfall_are_capped_per_account_and_in_all(
    database: str, scryfall: FakeScryfall, directory: Path
) -> None:
    """Every new name waits its turn for Scryfall, so one account's burst of made-up names held
    up every other player's first look at a card, and each left a row behind."""

    async def scenario() -> None:
        app = build(database, scryfall, directory, sysop_networks=SYSOP_NETWORK)
        async with running(app) as http:
            cache: CardImageCache = app.state.card_images
            clock = FakeClock()
            cache.clock, cache.sleep = clock, clock.sleep
            ada, bob = signed_in(app), signed_in(app)
            # Known names are not lookups, and are never refused.
            for name in ("Lightning Bolt", "Goblin Token"):
                await http.get(IMAGES, params={"name": name}, headers=ada)
            scryfall.gate = asyncio.Event()

            def look(who: dict[str, str], name: str) -> asyncio.Task[httpx.Response]:
                return asyncio.create_task(http.get(IMAGES, params={"name": name}, headers=who))

            held = [look(ada, f"Junk {index}") for index in range(LOOKUPS_PER_ACCOUNT)]
            await eventually(lambda: cache.lookups.total() == LOOKUPS_PER_ACCOUNT)
            refused = await http.get(IMAGES, params={"name": "Junk extra"}, headers=ada)
            assert refused.status_code == 429 and refused.json()["code"] == "card_images_busy"
            assert int(refused.headers["retry-after"]) >= 1
            cached = await http.get(IMAGES, params={"name": "Lightning Bolt"}, headers=ada)
            assert cached.status_code == 200
            token = await http.get(IMAGES, params={"name": "Goblin Token"}, headers=ada)
            assert token.json()["code"] == "card_image_missing"

            # Other accounts still get in line, until everyone's share is taken.
            others = [signed_in(app) for _ in range(LOOKUPS_WAITING // LOOKUPS_PER_ACCOUNT - 1)]
            held += [
                look(who, f"Card {index} of {number}")
                for number, who in enumerate(others)
                for index in range(LOOKUPS_PER_ACCOUNT)
            ]
            await eventually(lambda: cache.lookups.total() == LOOKUPS_WAITING)
            full = await http.get(IMAGES, params={"name": "Delver of Secrets"}, headers=bob)
            assert full.status_code == 503 and full.json()["code"] == "card_images_unavailable"
            assert int(full.headers["retry-after"]) >= 1
            # SysOp is never refused.
            root = signed_in(app, kind="sysop")
            sysop = look(root, "Delver of Secrets")
            await eventually(lambda: cache.lookups.total() == LOOKUPS_WAITING + 1)

            scryfall.gate.set()
            answers = await asyncio.gather(*held, sysop)
            assert [answer.status_code for answer in answers] == [404] * LOOKUPS_WAITING + [200]
            assert not cache.lookups
            # Refused names were never asked about and left no row.
            assert "Junk extra" not in scryfall.api_calls and entry(app, "Junk extra") is None
            assert entry(app, "Delver of Secrets") is not None
            assert entries(app) == 2 + LOOKUPS_WAITING + 1

    asyncio.run(scenario())


def test_scryfalls_429_pauses_every_lookup(
    client: TestClient, app: FastAPI, scryfall: FakeScryfall, clock: FakeClock, directory: Path
) -> None:
    """Scryfall limits a client that gets a 429, and may ban one that keeps asking."""
    ada = signed_in(app)
    scryfall.api_failure = httpx.Response(
        429, json={"object": "error", "code": "rate_limited"}, headers={"Retry-After": "90"}
    )
    limited = client.get(IMAGES, params={"name": "Lightning Bolt"}, headers=ada)
    assert limited.status_code == 503 and limited.json()["code"] == "card_images_unavailable"
    assert limited.headers["retry-after"] == "90"
    scryfall.api_failure = None

    # For the 90 s Scryfall asked for, no other name is asked about either.
    clock.now += 89
    paused = client.get(IMAGES, params={"name": "Delver of Secrets"}, headers=ada)
    assert paused.status_code == 503 and paused.json()["code"] == "card_images_unavailable"
    assert paused.headers["retry-after"] == "1"
    assert scryfall.api_calls == ["Lightning Bolt"]
    assert entries(app) == 0 and files(directory) == []
    clock.now += 1
    assert client.get(IMAGES, params={"name": "Delver of Secrets"}, headers=ada).status_code == 200

    scryfall.api_failure = httpx.Response(429, json={"object": "error", "code": "rate_limited"})
    assert client.get(IMAGES, params={"name": "Fire"}, headers=ada).status_code == 503
    scryfall.api_failure = None
    # Cached images are still served while lookups are paused.
    delver = client.get(IMAGES, params={"name": "Delver of Secrets"}, headers=ada)
    assert delver.status_code == 200

    # Without a Retry-After, or with a shorter one, the 30 s Scryfall's documentation names.
    clock.now += 29
    assert client.get(IMAGES, params={"name": "Fire"}, headers=ada).status_code == 503
    assert scryfall.api_calls == ["Lightning Bolt", "Delver of Secrets", "Fire"]
    clock.now += 1
    assert client.get(IMAGES, params={"name": "Fire"}, headers=ada).status_code == 200
    assert scryfall.api_calls[-1] == "Fire" and len(scryfall.api_calls) == 4


def test_lookups_queued_when_scryfall_answers_429_never_ask_it(
    database: str, scryfall: FakeScryfall, directory: Path
) -> None:
    """Names already waiting their turn when the 429 arrives are refused too: each asking in turn
    would be another request to Scryfall while it limits us."""
    names = [f"Junk {index}" for index in range(6)]
    scryfall.api_failure = httpx.Response(429, headers={"Retry-After": "60"})

    async def scenario() -> list[bytes | BaseException]:
        engine = build_engine(database)
        clock = FakeClock()
        try:
            async with httpx.AsyncClient(transport=httpx.MockTransport(scryfall)) as client:
                settings = Settings(database_url=database, card_image_dir=str(directory))
                cache = CardImageCache(settings, engine, client)

                async def sleep(delay: float) -> None:
                    # The 429 arrives while the next name waits out the spacing.
                    clock.now += delay
                    await eventually(lambda: cache.paused_until > clock())

                cache.clock, cache.sleep = clock, sleep
                scryfall.gate = asyncio.Event()
                lookups = asyncio.gather(
                    *(cache.image(name, "normal", ACCOUNT) for name in names),
                    return_exceptions=True,
                )
                # Every name is past the check made before queueing, and one is with Scryfall.
                await eventually(lambda: cache.lookups.total() == len(names))
                scryfall.gate.set()
                results = await lookups
                assert not cache.lookups
                with Session(engine) as db:
                    assert db.scalar(select(func.count()).select_from(CardImage)) == 0
                return results
        finally:
            engine.dispose()

    results = asyncio.run(scenario())
    assert len(scryfall.api_calls) == 1
    for result in results:
        assert isinstance(result, ApiError), result
        assert (result.status, result.code) == (503, "card_images_unavailable")
        assert result.headers is not None and int(result.headers["Retry-After"]) >= 1


def test_retry_after_is_read_as_seconds_or_a_date() -> None:
    def pause(value: str | None) -> float:
        headers = {"Retry-After": value} if value is not None else {}
        return card_images.retry_after(httpx.Response(429, headers=headers))

    assert pause("120") == 120
    assert pause(" 45 ") == 45
    later = format_datetime(utcnow() + timedelta(minutes=5), usegmt=True)
    assert pause(later) == pytest.approx(300, abs=5)
    for short in (
        None,
        "",
        "5",
        "-10",
        "soon",
        "nan",
        "1e9",
        "Mon, 01 Jan 2001 00:00:00 GMT",
        # Out of a date's range, not an error.
        "Mon, 01 Jan 99999999999 00:00:00 GMT",
        "Mon, 01 Jan 2001 00:00:00 +99999999999999999999",
    ):
        assert pause(short) == card_images.RATE_LIMIT_PAUSE, short
    # More digits than a float holds is still the longest pause, not an error.
    for long in ("86400", "9" * 400, "9" * 5000):
        assert pause(long) == card_images.MAX_RATE_LIMIT_PAUSE, long[:10]
