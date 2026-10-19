"""Card images (v0.1.0): looked up on Scryfall by exact name, cached on disk and served from our
own origin. Scryfall's API and its image host are a fake behind httpx.MockTransport; no test
reaches the network, and the spacing between API requests is measured on a fake clock."""

import asyncio
import copy
import secrets
from collections.abc import Callable, Iterator
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from api import card_images
from api.card_images import API_SPACING, IMAGE_CACHE_CONTROL, CardImageCache
from api.config import Settings
from api.database import build_engine
from api.identity import hash_token, utcnow
from api.main import create_app
from api.models import CardImage, User, UserSession
from api.version import APP_VERSION

IMAGES = "/api/v1/card-images"
INFO = "/api/v1/card-images/info"
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF"
BOLT_ID = "77c6fa74-5543-42ac-9ead-0e890b188e99"
DELVER_ID = "11bf83bb-c95b-4b4f-9a56-ce7a1816307a"
FIRE_ICE_ID = "2f0b6ab0-7ad4-4a5c-8c4a-2b4b5c0a3e11"


def image_uris(stem: str) -> dict[str, str]:
    return {
        size: f"https://cards.scryfall.io/{size}/front/{stem}.jpg?1562"
        for size in ("small", "normal", "large")
    }


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

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.scryfall.com":
            assert request.url.path == "/cards/named"
            assert request.headers["user-agent"] == f"CommanderDuels/{APP_VERSION}"
            assert request.headers["accept"] == "application/json"
            name = request.url.params["exact"]
            self.api_calls.append(name)
            if self.clock is not None:
                self.api_times.append(self.clock())
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
        # Each image is the JPEG signature and its own path, so a test can tell which it got.
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


def build(database: str, scryfall: FakeScryfall, directory: Path | None) -> FastAPI:
    app = create_app(
        Settings(database_url=database, card_image_dir=str(directory) if directory else "")
    )
    app.state.scryfall_transport = httpx.MockTransport(scryfall)
    return app


@pytest.fixture
def client(database: str, scryfall: FakeScryfall, directory: Path) -> Iterator[TestClient]:
    with TestClient(build(database, scryfall, directory), base_url="https://testserver") as client:
        yield client


@pytest.fixture
def app(client: TestClient) -> FastAPI:
    return client.app  # type: ignore[return-value]


def signed_in(app: FastAPI, status: str = "active") -> dict[str, str]:
    """Request headers carrying the session cookie of a new account."""
    now = utcnow()
    token = secrets.token_urlsafe(32)
    handle = f"player_{secrets.token_hex(4)}"
    with Session(app.state.database) as db:
        user = User(
            handle=handle,
            normalized_handle=handle,
            display_name=handle,
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
                kind="google",
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


def test_scryfall_failures_record_nothing(
    client: TestClient, app: FastAPI, scryfall: FakeScryfall, directory: Path
) -> None:
    ada = signed_in(app)
    failures: list[httpx.Response | Exception] = [
        httpx.Response(503, json={"object": "error", "code": "unavailable"}),
        httpx.Response(429, json={"object": "error", "code": "rate_limited"}),
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
    png = client.get(IMAGES, params={"name": "Lightning Bolt", "size": "png"}, headers=ada)
    assert png.status_code == 422
    assert scryfall.api_calls == []
    # Any other name of up to 200 characters is asked about.
    longest = client.get(IMAGES, params={"name": "Æ" * 200}, headers=ada)
    assert longest.json()["code"] == "card_image_missing"
    assert scryfall.api_calls == ["Æ" * 200]


def test_requests_to_scryfalls_api_are_spaced(
    client: TestClient, app: FastAPI, scryfall: FakeScryfall
) -> None:
    clock = FakeClock()
    cache: CardImageCache = app.state.card_images
    cache.clock, cache.sleep, scryfall.clock = clock, clock.sleep, clock
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
                images = await asyncio.gather(*(cache.image(name, "normal") for name in names))
                assert images == [served("bolt"), served("bolt"), served("aberration")] * 2
                assert not cache.locks and not cache.waiting
        finally:
            engine.dispose()

    asyncio.run(scenario())
    assert sorted(scryfall.api_calls) == ["Insectile Aberration", "Lightning Bolt"]
    assert len(scryfall.downloads) == 2
    first, second = scryfall.api_times
    assert second - first >= API_SPACING


def test_a_session_rotated_by_an_image_request_keeps_its_cookie(
    client: TestClient, app: FastAPI
) -> None:
    ada = signed_in(app)
    for name, status in (("Lightning Bolt", 200), ("Goblin Token", 404)):
        # A role change raises the account's privilege version; its next request rotates the
        # session, and the response must carry the new cookie or the player is signed out.
        with Session(app.state.database) as db:
            db.execute(update(User).values(privilege_version=User.privilege_version + 1))
            db.commit()
        response = client.get(IMAGES, params={"name": name}, headers=ada)
        assert response.status_code == status
        cookie = response.headers["set-cookie"]
        assert cookie.startswith("cd_session=")
        ada = {"cookie": cookie.split(";")[0]}
        assert client.get("/api/v1/me", headers=ada).status_code == 200
