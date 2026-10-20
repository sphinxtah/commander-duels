"""Sessions under load and across a rotation (AUTH03).

The principal dependency gives its pooled connection back before a route awaits anything, so a
burst of requests cannot deadlock the pool. A cookie rotated while signing a request in reaches
the browser on every response, errors included. Requests the browser sent before it read the
rotated cookie still go through for a moment, and never erase that cookie.
"""

import asyncio
import secrets
import time
from collections.abc import Iterator
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
from sqlalchemy import create_engine, func, select, update
from sqlalchemy.orm import Session
from sqlalchemy.pool import QueuePool
from test_games import SERVICE_TOKEN, FakeEngine
from test_identity import PASSWORD, Certs, Clock, browser, build, sign_in, start, sysop

from api import main
from api.cli import set_sysop_password
from api.config import Settings
from api.identity import ROTATION_GRACE, SignedIn, hash_token, utcnow
from api.models import User, UserSession

# The pool's capacity in these tests (no overflow), and how long a checkout waits.
POOL = 2
POOL_TIMEOUT = 3.0


@pytest.fixture
def database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    url = f"sqlite:///{tmp_path}/sessions.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    return url


# A burst of requests and a small pool.


@pytest.fixture
def small_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    def small(url: str, *args: Any, **kwargs: Any) -> Any:
        return create_engine(
            url, poolclass=QueuePool, pool_size=POOL, max_overflow=0, pool_timeout=POOL_TIMEOUT
        )

    monkeypatch.setattr(main, "build_engine", small)


class SlowEngine(FakeEngine):
    """Setting up a game takes the engine a moment, as XMage's does."""

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/v1/service/games"):
            await asyncio.sleep(0.3)
        return await super().__call__(request)


def account(app: FastAPI, handle: str) -> dict[str, str]:
    """An active player's request headers: its session cookie and CSRF token."""
    now = utcnow()
    token = secrets.token_urlsafe(32)
    with Session(app.state.database) as db:
        user = User(
            handle=handle,
            normalized_handle=handle,
            display_name=handle,
            kind="player",
            status="active",
            onboarding="complete",
            created_at=now,
        )
        db.add(user)
        db.flush()
        session = UserSession(
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
        db.add(session)
        db.commit()
        return {"cookie": f"cd_session={token}", "x-csrf-token": session.csrf_token}


Call = tuple[str, str, dict[str, Any], float]  # method, path, options, delay


async def burst(app: FastAPI, requests: list[Call]) -> list[tuple[int, float]]:
    """Sends the requests together, each after its delay; answers (status, seconds taken)."""
    transport = httpx.ASGITransport(app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as client:

        async def send(method: str, path: str, options: dict[str, Any], delay: float) -> Any:
            await asyncio.sleep(delay)
            started = time.monotonic()
            response = await client.request(method, path, **options)
            return response.status_code, time.monotonic() - started

        return await asyncio.gather(*(send(*request) for request in requests))


def test_one_players_burst_of_new_games_cannot_deadlock_the_pool(
    database: str, small_pool: None
) -> None:
    """Each queued request used to hold a connection while it waited on the account's lock, and
    the lock holder gave its own back on commit and then needed one again."""
    app = main.create_app(
        Settings(
            database_url=database,
            engine_service_token=SERVICE_TOKEN,
            games_max=4,
            sysop_networks="10.20.0.0/24",
        )
    )
    app.state.engine_transport = httpx.MockTransport(SlowEngine())

    async def scenario() -> list[tuple[int, float]]:
        async with app.router.lifespan_context(app):
            mallory, bystander = account(app, "mallory"), account(app, "bystander")
            create: Call = ("POST", "/api/v1/practice-games", {"json": {}, "headers": mallory}, 0)
            # Another player's request arrives while the burst is under way.
            other: Call = ("GET", "/api/v1/me", {"headers": bystander}, 0.1)
            return await burst(app, [create] * (POOL + 3) + [other])

    *games, bystander = asyncio.run(scenario())
    statuses = [status for status, _ in games]
    assert statuses.count(201) == 1 and set(statuses) == {201, 409}, statuses
    assert bystander[0] == 200
    assert max(seconds for _, seconds in [*games, bystander]) < POOL_TIMEOUT


def test_a_burst_of_card_image_lookups_cannot_deadlock_the_pool(
    database: str, small_pool: None, tmp_path: Path
) -> None:
    """Each lookup opens its own Session, which used to need a second connection while the
    request's own was still held."""
    app = main.create_app(Settings(database_url=database, card_image_dir=str(tmp_path / "img")))

    async def scenario() -> list[tuple[int, float]]:
        async with app.router.lifespan_context(app):
            ada, bea = account(app, "ada"), account(app, "bea")
            lookups: list[Call] = [
                (
                    "GET",
                    "/api/v1/card-images/info",
                    {"params": {"name": f"Card {i}"}, "headers": ada},
                    0,
                )
                for i in range(POOL + 3)
            ]
            return await burst(app, [*lookups, ("GET", "/api/v1/me", {"headers": bea}, 0.1)])

    *lookups, bystander = asyncio.run(scenario())
    assert [status for status, _ in lookups] == [404] * (POOL + 3)
    assert bystander[0] == 200
    assert max(seconds for _, seconds in [*lookups, bystander]) < POOL_TIMEOUT


# Rotation.


@pytest.fixture
def app(database: str, tmp_path: Path) -> Iterator[FastAPI]:
    app = build(database, Certs(), card_image_dir=str(tmp_path / "img"))
    with TestClient(app, base_url="https://testserver"):
        start(app)
        yield app


def raise_privileges(app: FastAPI, user_id: str) -> None:
    """What a role or status change does to the account: its sessions are due for rotation."""
    with Session(app.state.database) as db:
        db.execute(
            update(User)
            .where(User.id == UUID(user_id))
            .values(privilege_version=User.privilege_version + 1)
        )
        db.commit()


def session_cookies(response: httpx.Response) -> list[str]:
    return [
        value
        for value in response.headers.get_list("set-cookie")
        if value.startswith("cd_session=")
    ]


def new_token(response: httpx.Response) -> str:
    """The session token a response hands the browser; exactly one, and not a clearing one."""
    cookies = session_cookies(response)
    assert len(cookies) == 1, cookies
    token = cookies[0].split(";")[0].removeprefix("cd_session=")
    assert token and token != '""' and "Max-Age=0" not in cookies[0]
    return token


def clears(response: httpx.Response) -> bool:
    cookies = session_cookies(response)
    return len(cookies) == 1 and cookies[0].startswith('cd_session=""')


def holding(app: FastAPI, token: str, csrf: str | None = None) -> TestClient:
    """A browser that presents this token, as one whose request left before a new cookie came."""
    client = browser(app)
    client.headers["cookie"] = f"cd_session={token}"
    if csrf:
        client.headers["x-csrf-token"] = csrf
    return client


def live_sessions(app: FastAPI) -> int:
    with Session(app.state.database) as db:
        return (
            db.scalar(
                select(func.count())
                .select_from(UserSession)
                .where(UserSession.revoked_at.is_(None))
            )
            or 0
        )


def test_a_rotated_cookie_reaches_the_browser_on_errors_and_returned_responses(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock(monkeypatch)
    laptop, phone = browser(app), browser(app)
    me = sign_in(laptop).json()
    phone_session = sign_in(phone).json()["session"]["id"]
    csrf = me["csrf_token"]
    token = laptop.cookies["cd_session"]
    attempts: list[tuple[str, str, dict[str, Any], int]] = [
        # An error raised by a dependency after the rotation.
        ("GET", "/api/v1/admin/users", {}, 403),
        # The CSRF check runs after the rotation too.
        ("PATCH", "/api/v1/me", {"json": {"locale": "en"}, "headers": {"x-csrf-token": ""}}, 403),
        # A body that fails validation.
        ("PATCH", "/api/v1/me", {"json": {"handle": 5}}, 422),
        # An error raised by the route.
        ("DELETE", f"/api/v1/me/sessions/{UUID(int=1)}", {}, 404),
        # The card-image routes once copied the cookie across themselves; still only one.
        ("GET", "/api/v1/card-images/info", {"params": {"name": "Lightning Bolt"}}, 404),
        # A route that returns its own Response.
        ("DELETE", f"/api/v1/me/sessions/{phone_session}", {}, 204),
    ]
    for method, path, options, status in attempts:
        raise_privileges(app, me["id"])
        client = holding(app, token, csrf)
        response = client.request(method, path, **options)
        assert response.status_code == status, (path, response.text)
        token = new_token(response)
        # Past the old token's grace, only the new cookie signs the browser in.
        clock.offset += ROTATION_GRACE * 2
        assert holding(app, token).get("/api/v1/me").status_code == 200, path
    assert phone.get("/api/v1/me").status_code == 401


def test_a_rotated_cookie_survives_an_unexpected_error(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A bug's 500 still carries the rotated cookie, the request ID and the error shape."""

    def broken(principal: SignedIn) -> None:
        raise RuntimeError("a bug")

    app.add_api_route("/api/v1/broken", broken)
    clock = Clock(monkeypatch)
    ada = browser(app)
    me = sign_in(ada).json()
    raise_privileges(app, me["id"])
    client = TestClient(app, base_url="https://testserver", raise_server_exceptions=False)
    client.headers["cookie"] = f"cd_session={ada.cookies['cd_session']}"
    response = client.get("/api/v1/broken")
    assert response.status_code == 500
    body = response.json()
    assert body["code"] == "internal_error" and "a bug" not in response.text
    assert body["request_id"] == response.headers["x-request-id"]
    assert response.headers["cache-control"] == "no-store"
    token = new_token(response)
    clock.offset += ROTATION_GRACE * 2
    assert holding(app, token).get("/api/v1/me").status_code == 200


def test_a_rotation_neither_doubles_a_cookie_nor_undoes_a_sign_out(
    app: FastAPI, database: str
) -> None:
    ada = browser(app)
    me = sign_in(ada).json()
    raise_privileges(app, me["id"])
    response = ada.get("/api/v1/me")
    assert response.status_code == 200 and new_token(response)

    # Signing out after a rotation clears the cookie; the rotated one is not added back.
    for path in ("/api/v1/auth/logout", "/api/v1/auth/logout-all"):
        me = sign_in(ada).json()
        raise_privileges(app, me["id"])
        response = ada.post(path)
        assert response.status_code == 204 and clears(response), response.headers
        assert ada.get("/api/v1/me").status_code == 401
    assert live_sessions(app) == 0

    # SysOp's password change sets its own new cookie, the only one that still works.
    set_sysop_password(database, PASSWORD)
    root = sysop(app)
    raise_privileges(app, root.get("/api/v1/me").json()["id"])
    changed = root.post(
        "/api/v1/sysop/password",
        json={"current_password": PASSWORD, "new_password": "a brand new passphrase"},
    )
    assert changed.status_code == 200, changed.text
    assert new_token(changed)
    assert root.get("/api/v1/me").json()["session"]["id"] == changed.json()["session"]["id"]
    assert live_sessions(app) == 1


def test_requests_sent_with_the_old_cookie_neither_fail_nor_erase_the_new_one(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock(monkeypatch)
    ada = browser(app)
    me = sign_in(ada).json()
    old, csrf = ada.cookies["cd_session"], me["csrf_token"]
    raise_privileges(app, me["id"])
    rotated = holding(app, old).get("/api/v1/me")
    new = new_token(rotated)
    current = rotated.json()["session"]["id"]
    assert current != me["session"]["id"]

    # Requests that left with the old cookie before the new one arrived: they are the new
    # session, and set no cookie at all, so the browser keeps the new one.
    late = holding(app, old, csrf)
    for response in (
        late.get("/api/v1/me"),
        late.get("/api/v1/me/sessions"),
        late.patch("/api/v1/me", json={"locale": "en"}),
    ):
        assert response.status_code == 200, response.text
        assert session_cookies(response) == []
    assert late.get("/api/v1/me").json()["session"]["id"] == current
    assert [item["id"] for item in late.get("/api/v1/me/sessions").json()] == [current]
    assert (
        late.patch("/api/v1/me", json={"locale": "en"}, headers={"x-csrf-token": ""}).json()["code"]
        == "csrf_failed"
    )
    assert live_sessions(app) == 1

    # Another privilege change inside the grace: the old cookie's request is still served as the
    # session it stands for, but never rotates it, so a stale token cannot take a fresh session.
    # The new cookie's next request rotates it, and the old cookie then stands for the newest.
    raise_privileges(app, me["id"])
    again = late.get("/api/v1/me")
    assert again.status_code == 200 and session_cookies(again) == []
    assert again.json()["session"]["id"] == current and live_sessions(app) == 1
    rerotated = holding(app, new).get("/api/v1/me")
    newest = new_token(rerotated)
    assert rerotated.json()["session"]["id"] != current and live_sessions(app) == 1
    assert late.get("/api/v1/me").json()["session"]["id"] == rerotated.json()["session"]["id"]

    # After the grace the old cookies are refused, still without erasing the newest.
    clock.offset = ROTATION_GRACE + timedelta(seconds=1)
    for token in (old, new):
        refused = holding(app, token).get("/api/v1/me")
        assert refused.status_code == 401 and session_cookies(refused) == []
    assert holding(app, newest).get("/api/v1/me").status_code == 200


def test_the_grace_ends_with_the_session_it_stands_for(
    app: FastAPI, database: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Signing out, signing out everywhere, an administrator's sign-out and a disabled account
    end the old token at once, as they always did."""
    set_sysop_password(database, PASSWORD)
    root = sysop(app)

    def rotate(client: TestClient, **claims: Any) -> tuple[str, str, dict[str, Any]]:
        me = sign_in(client, **claims).json()
        old = client.cookies["cd_session"]
        raise_privileges(app, me["id"])
        response = client.get("/api/v1/me")
        assert response.status_code == 200
        return old, new_token(response), me

    ada = browser(app)
    old, new, _ = rotate(ada)
    assert ada.post("/api/v1/auth/logout").status_code == 204
    assert holding(app, old).get("/api/v1/me").status_code == 401
    # A session revoked for any other reason still clears its cookie.
    assert clears(holding(app, new).get("/api/v1/me"))

    old, new, _ = rotate(ada)
    assert ada.post("/api/v1/auth/logout-all").status_code == 204
    assert holding(app, old).get("/api/v1/me").status_code == 401

    old, new, me = rotate(ada)
    assert root.post(f"/api/v1/admin/users/{me['id']}/sign-out").status_code == 200
    assert holding(app, old).get("/api/v1/me").status_code == 401
    assert clears(holding(app, new).get("/api/v1/me"))

    bea = browser(app)
    old, new, me = rotate(bea, sub="2002", email="bea@example.com")
    disabled = root.post(f"/api/v1/admin/users/{me['id']}/status", json={"status": "disabled"})
    assert disabled.status_code == 200, disabled.text
    assert holding(app, old).get("/api/v1/me").status_code == 401
    assert holding(app, new).get("/api/v1/me").status_code == 401
    assert live_sessions(app) == 1  # SysOp's own
