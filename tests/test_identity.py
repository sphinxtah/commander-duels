"""Identity: Google sign-in (T01/T02), sessions (AUTH03), roles and administration (AUTH06,
T29), and SysOp's entrance. Google ID tokens are signed with a test key that the verifier's
certificate fetch returns, so google-auth's real checks run on every token."""

import base64
import hashlib
import json
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

import httpx
import pytest
from alembic import command
from alembic.config import Config
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient
from google.auth import crypt
from google.auth import jwt as google_jwt
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from starlette.datastructures import Headers

from api import admin, auth, identity
from api.cli import set_sysop_password
from api.config import Settings
from api.google import CachingTransport, GoogleVerifier
from api.main import create_app
from api.models import AuditEvent, RoleGrant, User, UserSession
from api.network import client_address

CLIENT_ID = "test-client.apps.googleusercontent.com"
SYSOP_ADDRESS = ("10.20.0.7", 50000)
OUTSIDE = ("203.0.113.5", 50000)
PROXY = ("172.30.0.10", 50000)
PASSWORD = "correct horse battery staple"


def private_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


KEY = private_key()
FORGER = private_key()


def pem(key: rsa.RSAPrivateKey) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


CERTS = {
    "test-key": KEY.public_key()
    .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    .decode()
}


def google_token(key: rsa.RSAPrivateKey = KEY, **claims: Any) -> str:
    now = int(time.time())
    payload = {
        "iss": "https://accounts.google.com",
        "aud": CLIENT_ID,
        "sub": "1001",
        "email": "ada@example.com",
        "email_verified": True,
        "name": "Ada",
        "iat": now,
        "exp": now + 600,
    } | claims
    signer = crypt.RSASigner.from_string(pem(key), "test-key")
    return google_jwt.encode(signer, payload).decode()


class Certs:
    """Google's certificate endpoint, as the verifier's transport sees it."""

    def __init__(self) -> None:
        self.calls = 0
        self.down = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.down:
            raise httpx.ConnectError("Google is unreachable")
        return httpx.Response(200, json=CERTS, headers={"cache-control": "max-age=3600"})


class Clock:
    """Moves the application's clock (not google-auth's) for expiry tests."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.offset = timedelta()
        real = identity.utcnow

        def now() -> datetime:
            return real() + self.offset

        for module in (identity, auth, admin):
            monkeypatch.setattr(module, "utcnow", now)


@pytest.fixture
def database(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> str:
    url = f"sqlite:///{tmp_path}/identity.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    return url


@pytest.fixture
def certs() -> Certs:
    return Certs()


def build(database: str, certs: Certs, **settings: Any) -> FastAPI:
    config = Settings(
        database_url=database,
        google_client_id=CLIENT_ID,
        sysop_networks="10.20.0.0/24",
        trusted_proxies="172.30.0.10/32",
    )
    app = create_app(config.model_copy(update=settings))
    app.state.certs = certs
    return app


def start(app: FastAPI) -> None:
    """Replace the lifespan's verifier with one whose certificate fetch returns the test key."""
    transport = httpx.Client(transport=httpx.MockTransport(app.state.certs))
    app.state.google_verifier = GoogleVerifier(CLIENT_ID, CachingTransport(transport))


@pytest.fixture
def app(database: str, certs: Certs) -> Iterator[FastAPI]:
    app = build(database, certs)
    with TestClient(app, base_url="https://testserver"):
        start(app)
        yield app


def browser(app: FastAPI, address: tuple[str, int] = OUTSIDE) -> TestClient:
    return TestClient(app, base_url="https://testserver", client=address)


def sign_in(client: TestClient, **claims: Any) -> httpx.Response:
    nonce = client.post("/api/v1/auth/google/start").json()["nonce"]
    response = client.post(
        "/api/v1/auth/google", json={"credential": google_token(nonce=nonce, **claims)}
    )
    if response.status_code == 200:
        client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
    return response


def sysop(app: FastAPI, address: tuple[str, int] = SYSOP_ADDRESS) -> TestClient:
    client = browser(app, address)
    response = client.post("/api/v1/sysop/login", json={"username": "sysop", "password": PASSWORD})
    assert response.status_code == 200, response.text
    client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
    return client


def count(app: FastAPI, model: Any, *where: Any) -> int:
    with Session(app.state.database) as db:
        return db.scalar(select(func.count()).select_from(model).where(*where)) or 0


def live_sessions(app: FastAPI) -> int:
    return count(app, UserSession, UserSession.revoked_at.is_(None))


def test_google_sign_in_creates_one_account_with_a_private_session(app: FastAPI) -> None:
    client = browser(app)
    bootstrap = client.get("/api/v1/bootstrap").json()
    assert bootstrap["auth"] == {"google_client_id": CLIENT_ID, "signup_policy": "open"}
    assert bootstrap["capabilities"][0] == {
        "id": "authentication",
        "name": "Google sign-in",
        "available": True,
        "milestone": "M1",
        "reason": "Google sign-in is available.",
    }
    assert client.get("/api/v1/me").status_code == 401

    response = sign_in(client)
    assert response.status_code == 200, response.text
    me = response.json()
    assert me["status"] == "active" and me["kind"] == "player"
    assert me["onboarding"] == "handle" and me["handle"] is None
    assert me["display_name"] == "Ada" and me["email"] == "ada@example.com"
    assert me["roles"] == ["player"]
    assert me["permissions"] == ["decks.edit", "games.play", "profile.edit"]
    assert "1001" not in response.text  # the Google subject is never returned
    cookie = next(
        value for value in response.headers.get_list("set-cookie") if "cd_session=" in value
    )
    assert "HttpOnly" in cookie and "Secure" in cookie and "SameSite=lax" in cookie
    assert "Path=/api" in cookie

    # State changes need the session's CSRF token.
    csrf = client.headers.pop("X-CSRF-Token")
    assert client.patch("/api/v1/me", json={"handle": "Ada"}).json()["code"] == "csrf_failed"
    client.headers["X-CSRF-Token"] = csrf
    assert client.patch("/api/v1/me", json={"handle": "ab!"}).json()["code"] == "invalid_handle"
    assert client.patch("/api/v1/me", json={"handle": "SysOp"}).status_code == 409
    profile = client.patch(
        "/api/v1/me",
        json={
            "handle": "Ada_L",
            "avatar": "flame",
            "preferences": {"large_text": True, "reduced_motion": False},
        },
    ).json()
    # Two starter decks are chosen next (v0.3.1).
    assert profile["handle"] == "Ada_L" and profile["onboarding"] == "starters"
    assert profile["avatar"] == "flame" and profile["preferences"]["large_text"] is True

    other = browser(app)
    assert sign_in(other, sub="2002", email="bea@example.com").status_code == 200
    taken = other.patch("/api/v1/me", json={"handle": "ada_l"})
    assert taken.status_code == 409 and taken.json()["code"] == "handle_taken"

    # Same Google subject with a changed email: the same account, and the old session ends.
    again = sign_in(client, email="ada@new.example").json()
    assert again["id"] == me["id"] and again["email"] == "ada@new.example"
    assert again["session"]["id"] != me["session"]["id"]
    assert count(app, User, User.kind == "player") == 2
    assert live_sessions(app) == 2


def malformed(header: dict[str, Any], **claims: Any) -> str:
    """A token whose header google-auth must read before it can check any signature."""

    def part(value: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()

    payload = {"iss": "https://accounts.google.com", "aud": CLIENT_ID, "sub": "1001"} | claims
    return f"{part(header)}.{part(payload)}.c2ln"


def test_forged_expired_and_replayed_sign_ins_create_no_session(app: FastAPI, certs: Certs) -> None:
    client = browser(app)
    now = int(time.time())
    attempts: dict[str, Callable[[str], str]] = {
        "expired": lambda nonce: google_token(nonce=nonce, iat=now - 7200, exp=now - 3600),
        "wrong audience": lambda nonce: google_token(
            nonce=nonce, aud="someone-else.apps.googleusercontent.com"
        ),
        "wrong issuer": lambda nonce: google_token(nonce=nonce, iss="https://accounts.example.com"),
        "forged": lambda nonce: google_token(FORGER, nonce=nonce),
        "other nonce": lambda nonce: google_token(nonce="0" * 64),
        "no nonce": lambda nonce: google_token(),
        "garbage": lambda nonce: "not.a.token",
        "list kid": lambda nonce: malformed({"alg": "RS256", "kid": ["x"]}, nonce=nonce),
        "list alg": lambda nonce: malformed({"alg": ["RS256"], "kid": "test-key"}, nonce=nonce),
    }
    for name, credential in attempts.items():
        # Every attempt spends its challenge, so each one asks for a new one, as the page does.
        nonce = client.post("/api/v1/auth/google/start").json()["nonce"]
        response = client.post("/api/v1/auth/google", json={"credential": credential(nonce)})
        assert response.status_code == 401, name
        assert response.json()["code"] == "invalid_sign_in", name
    # Without the challenge cookie, even a valid token is refused.
    nonce = client.post("/api/v1/auth/google/start").json()["nonce"]
    stranger = browser(app)
    token = google_token(nonce=nonce)
    assert stranger.post("/api/v1/auth/google", json={"credential": token}).status_code == 401
    assert count(app, User) == 0 and count(app, UserSession) == 0

    # Replay: the same token and cookie after a successful sign-in.
    secret = client.cookies.get("cd_google")
    assert client.post("/api/v1/auth/google", json={"credential": token}).status_code == 200
    replay = browser(app).post(
        "/api/v1/auth/google", json={"credential": token}, headers={"cookie": f"cd_google={secret}"}
    )
    assert replay.status_code == 401
    assert count(app, UserSession) == 1
    reasons = [
        event.details["reason"]
        for event in Session(app.state.database).scalars(
            select(AuditEvent).where(AuditEvent.action == "auth.google_login_failed")
        )
    ]
    assert reasons.count("invalid_token") == 7
    assert reasons.count("nonce_mismatch") == 2 and reasons.count("challenge_used_or_expired") == 1

    # Certificates are cached, and a Google outage is reported as one, even to this address,
    # which has used up its ten audited failures: an outage is not the client's failure.
    assert certs.calls == 1
    app.state.google_verifier._request._cache.clear()
    certs.down = True
    outage = sign_in(browser(app))
    assert outage.status_code == 503 and outage.json()["code"] == "provider_unavailable"


def test_a_bot_cannot_fill_the_audit_trail_with_failed_sign_ins(app: FastAPI) -> None:
    def failures() -> int:
        return count(app, AuditEvent, AuditEvent.action == "auth.google_login_failed")

    junk = {"credential": "not.a.token"}
    # A made-up challenge cookie is no challenge: refused, and not audited.
    forger = browser(app)
    for _ in range(20):
        refused = forger.post(
            "/api/v1/auth/google", json=junk, headers={"cookie": "cd_google=anything"}
        )
        assert refused.status_code == 401
    # Nor is it one when Google signed its nonce: the server never issued that challenge.
    token = google_token(nonce=hashlib.sha256(b"anything").hexdigest())
    refused = forger.post(
        "/api/v1/auth/google", json={"credential": token}, headers={"cookie": "cd_google=anything"}
    )
    assert refused.status_code == 401 and count(app, UserSession) == 0
    assert failures() == 0

    # One challenge buys one audited failure: the first attempt spends it.
    bot = browser(app)
    bot.post("/api/v1/auth/google/start")
    for _ in range(20):
        assert bot.post("/api/v1/auth/google", json=junk).json()["code"] == "invalid_sign_in"
    assert failures() == 1

    # New challenges buy at most ten audited failures per address in 15 minutes.
    for _ in range(9):
        bot.post("/api/v1/auth/google/start")
        assert bot.post("/api/v1/auth/google", json=junk).status_code == 401
    bot.post("/api/v1/auth/google/start")
    throttled = bot.post("/api/v1/auth/google", json=junk)
    assert throttled.status_code == 429 and throttled.json()["code"] == "too_many_attempts"
    assert failures() == 10
    # A genuine sign-in from that address still works, and other addresses are not affected.
    assert sign_in(browser(app)).status_code == 200
    other = browser(app, ("198.51.100.7", 50000))
    other.post("/api/v1/auth/google/start")
    assert other.post("/api/v1/auth/google", json=junk).status_code == 401
    assert failures() == 11


def test_without_a_client_id_google_sign_in_is_unavailable(database: str, certs: Certs) -> None:
    app = build(database, certs, google_client_id="")
    with TestClient(app, base_url="https://testserver") as client:
        assert client.get("/api/v1/bootstrap").json()["auth"]["google_client_id"] is None
        response = client.post("/api/v1/auth/google/start")
        assert response.status_code == 503 and response.json()["code"] == "sign_in_unavailable"


def test_sessions_end_on_sign_out_expiry_and_revocation(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock(monkeypatch)
    laptop, phone = browser(app), browser(app)
    sign_in(laptop)
    sign_in(phone)
    sessions = laptop.get("/api/v1/me/sessions").json()
    assert len(sessions) == 2 and sum(item["current"] for item in sessions) == 1
    phone_session = next(item["id"] for item in sessions if not item["current"])
    assert laptop.delete(f"/api/v1/me/sessions/{phone_session}").status_code == 204
    assert phone.get("/api/v1/me").status_code == 401
    assert laptop.delete(f"/api/v1/me/sessions/{phone_session}").status_code == 404

    assert laptop.post("/api/v1/auth/logout").status_code == 204
    assert laptop.get("/api/v1/me").status_code == 401

    sign_in(laptop)
    sign_in(phone)
    assert phone.post("/api/v1/auth/logout-all").status_code == 204
    assert laptop.get("/api/v1/me").status_code == 401

    # Idle expiry, and the absolute limit even for a session in constant use.
    sign_in(laptop)
    clock.offset = timedelta(days=15)
    stale = laptop.get("/api/v1/me")
    assert stale.status_code == 401 and 'cd_session=""' in stale.headers["set-cookie"]
    clock.offset = timedelta()
    sign_in(laptop)
    for day in range(1, 31):
        clock.offset = timedelta(days=day)
        status = laptop.get("/api/v1/me").status_code
        assert status == (200 if day < 30 else 401), day


def test_approval_mode_keeps_new_accounts_pending(database: str, certs: Certs) -> None:
    app = build(database, certs, signup_policy="approval")
    set_sysop_password(database, PASSWORD)
    with TestClient(app, base_url="https://testserver"):
        start(app)
        client = browser(app)
        me = sign_in(client).json()
        assert me["status"] == "pending" and me["roles"] == [] and me["permissions"] == []
        assert client.patch("/api/v1/me", json={"handle": "Waiting"}).status_code == 200
        refused = client.get("/api/v1/admin/users")
        assert refused.status_code == 403 and refused.json()["code"] == "account_pending"

        root = sysop(app)
        pending = root.get("/api/v1/admin/users", params={"status": "pending"}).json()["items"]
        assert [user["handle"] for user in pending] == ["Waiting"]
        approved = root.post(
            f"/api/v1/admin/users/{me['id']}/status", json={"status": "active"}
        ).json()
        assert approved["status"] == "active" and approved["roles"] == ["player"]
        # The approved account's next request rotates its session identifier.
        rotated = client.get("/api/v1/me")
        assert rotated.json()["status"] == "active"
        assert rotated.json()["session"]["id"] != me["session"]["id"]
        assert "cd_session=" in rotated.headers["set-cookie"]
        assert client.get("/api/v1/me").status_code == 200

        denied = sign_in(browser(app), sub="3003").json()
        root.post(f"/api/v1/admin/users/{denied['id']}/status", json={"status": "denied"})
        assert sign_in(browser(app), sub="3003").json()["status"] == "denied"
        again = root.post(f"/api/v1/admin/users/{me['id']}/status", json={"status": "denied"})
        assert again.json()["code"] == "invalid_transition"


def test_sysop_entrance_exists_only_on_its_network(app: FastAPI, database: str) -> None:
    missing = browser(app).get("/api/v1/no-such-path").json()
    for address, forwarded in [
        (OUTSIDE, None),
        (OUTSIDE, "10.20.0.7"),  # an untrusted peer cannot claim the network
        (PROXY, "203.0.113.5"),
        (PROXY, "10.20.0.7, 203.0.113.5"),
        (PROXY, "not-an-address"),
    ]:
        client = browser(app, address)
        headers = {"X-Forwarded-For": forwarded} if forwarded else {}
        entrance = client.get("/api/v1/sysop/entrance", headers=headers)
        assert entrance.status_code == 404, (address, forwarded)
        assert {**entrance.json(), "request_id": ""} == {**missing, "request_id": ""}
        login = client.post(
            "/api/v1/sysop/login",
            json={"username": "sysop", "password": PASSWORD},
            headers=headers,
        )
        assert login.status_code == 404
    proxied = browser(app, PROXY).get(
        "/api/v1/sysop/entrance", headers={"X-Forwarded-For": "203.0.113.5, 10.20.0.7"}
    )
    assert proxied.status_code == 204
    assert browser(app, SYSOP_ADDRESS).get("/api/v1/sysop/entrance").status_code == 204
    assert "/api/v1/sysop/login" not in json.dumps(app.openapi())

    # No SysOp yet: the entrance exists, but nobody can sign in.
    client = browser(app, SYSOP_ADDRESS)
    body = {"username": "sysop", "password": PASSWORD}
    assert client.post("/api/v1/sysop/login", json=body).status_code == 401
    assert set_sysop_password(database, PASSWORD) is True
    assert set_sysop_password(database, PASSWORD) is False

    wrong = {"username": "sysop", "password": "wrong password!"}
    for _ in range(5):
        assert client.post("/api/v1/sysop/login", json=wrong).status_code == 401
    # Five failures from this address in 15 minutes lock it, even for the right password. (The
    # failure before SysOp existed does not count: the console's password set lifts the lockout.)
    assert client.post("/api/v1/sysop/login", json=body).status_code == 429
    assert count(app, AuditEvent, AuditEvent.action == "auth.sysop_login_failed") == 6

    root = sysop(app, ("10.20.0.8", 50000))
    me = root.get("/api/v1/me").json()
    assert me["kind"] == "sysop" and me["roles"] == ["sysop"] and me["email"] is None
    assert {"games.view_concealed", "cards.any", "admin.roles.administrator"} <= set(
        me["permissions"]
    )
    assert me["session"]["kind"] == "sysop"
    assert root.patch("/api/v1/me", json={"handle": "root2"}).json()["code"] == "handle_fixed"

    # A SysOp session carried off the network is not signed in there.
    elsewhere = browser(app)
    elsewhere.cookies = root.cookies
    assert elsewhere.get("/api/v1/me").status_code == 401

    change = {"current_password": "not it", "new_password": "a brand new passphrase"}
    assert root.post("/api/v1/sysop/password", json=change).status_code == 401
    change["current_password"] = PASSWORD
    changed = root.post("/api/v1/sysop/password", json=change)
    assert changed.status_code == 200
    root.headers["X-CSRF-Token"] = changed.json()["csrf_token"]
    assert root.patch("/api/v1/me", json={"avatar": "crown"}).status_code == 200
    fresh = browser(app, ("10.20.0.9", 50000))
    assert fresh.post("/api/v1/sysop/login", json=body).status_code == 401
    body["password"] = "a brand new passphrase"
    assert fresh.post("/api/v1/sysop/login", json=body).status_code == 200
    with pytest.raises(ValueError):
        set_sysop_password(database, "too short")


def test_sysop_lockout_holds_for_parallel_guesses_and_password_changes(
    app: FastAPI, database: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    set_sysop_password(database, PASSWORD)
    real = auth.verify_password

    def slow(stored: str | None, password: str) -> bool:
        time.sleep(0.05)  # widens the gap between the lockout check and the recorded failure
        return real(stored, password)

    monkeypatch.setattr(auth, "verify_password", slow)
    neighbour = ("10.20.0.8", 50000)
    wrong = {"username": "sysop", "password": "wrong password!"}

    def login(address: tuple[str, int], password: str) -> httpx.Response:
        body = {"username": "sysop", "password": password}
        return browser(app, address).post("/api/v1/sysop/login", json=body)

    # The current password on the Profile page is a guess like any other.
    root = sysop(app)
    change = {"current_password": "not the password", "new_password": "a brand new passphrase"}
    for _ in range(5):
        assert root.post("/api/v1/sysop/password", json=change).status_code == 401
    change["current_password"] = PASSWORD
    locked = root.post("/api/v1/sysop/password", json=change)
    assert locked.status_code == 429 and locked.json()["code"] == "too_many_attempts"
    assert login(SYSOP_ADDRESS, PASSWORD).status_code == 429

    # A burst of parallel guesses gets five password checks, not one per request.
    def guess(_: int) -> int:
        return browser(app, neighbour).post("/api/v1/sysop/login", json=wrong).status_code

    with ThreadPoolExecutor(max_workers=20) as pool:
        statuses = list(pool.map(guess, range(20)))
    assert sorted(statuses) == [401] * 5 + [429] * 15
    assert count(app, AuditEvent, AuditEvent.action == "auth.sysop_login_failed") == 10

    # A new password set from the server console lifts every address's lockout, as the 429
    # message says.
    set_sysop_password(database, "a console passphrase")
    assert login(neighbour, PASSWORD).status_code == 401
    root = browser(app, SYSOP_ADDRESS)
    signed_in = root.post(
        "/api/v1/sysop/login", json={"username": "sysop", "password": "a console passphrase"}
    )
    assert signed_in.status_code == 200
    root.headers["X-CSRF-Token"] = signed_in.json()["csrf_token"]

    # A password change on the Profile page is a success for its own address only.
    for _ in range(4):
        assert login(neighbour, "wrong password!").status_code == 401
    change = {"current_password": "a console passphrase", "new_password": PASSWORD}
    assert root.post("/api/v1/sysop/password", json=change).status_code == 200
    assert login(neighbour, PASSWORD).status_code == 429


def test_roles_follow_least_privilege_and_players_cannot_administer(
    app: FastAPI, database: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock(monkeypatch)
    set_sysop_password(database, PASSWORD)
    ada, bea = browser(app), browser(app)
    ada_id = sign_in(ada).json()["id"]
    ada.patch("/api/v1/me", json={"handle": "ada"})
    bea_id = sign_in(bea, sub="2002", email="bea@example.com").json()["id"]
    bea.patch("/api/v1/me", json={"handle": "bea"})
    root = sysop(app)
    sysop_id = root.get("/api/v1/me").json()["id"]

    # T29: every administrative operation is refused to a player.
    for method, path in [
        ("GET", "/api/v1/admin/users"),
        ("GET", "/api/v1/admin/audit"),
        ("POST", f"/api/v1/admin/users/{bea_id}/sign-out"),
        ("PUT", f"/api/v1/admin/users/{bea_id}/roles/moderator"),
        ("DELETE", f"/api/v1/admin/users/{bea_id}/roles/moderator"),
    ]:
        assert ada.request(method, path).status_code == 403, path
    status = ada.post(f"/api/v1/admin/users/{bea_id}/status", json={"status": "disabled"})
    assert status.status_code == 403
    sysop_session = root.get("/api/v1/me").json()["session"]["id"]
    assert ada.delete(f"/api/v1/me/sessions/{sysop_session}").status_code == 404

    users = root.get("/api/v1/admin/users").json()["items"]
    assert {user["handle"] for user in users} == {"ada", "bea"}  # SysOp is never listed
    assert root.put(f"/api/v1/admin/users/{sysop_id}/roles/moderator").status_code == 404
    granted = root.put(f"/api/v1/admin/users/{ada_id}/roles/administrator").json()
    assert granted["roles"] == ["player", "administrator"]
    promoted = ada.get("/api/v1/me")
    assert "cd_session=" in promoted.headers["set-cookie"]  # rotated on the privilege change
    assert "admin.users.manage" in promoted.json()["permissions"]
    assert "games.view_concealed" not in promoted.json()["permissions"]

    # An administrator manages players and the lesser roles, but not administrators, SysOp or
    # their own account.
    assert ada.put(f"/api/v1/admin/users/{bea_id}/roles/moderator").status_code == 200
    assert ada.put(f"/api/v1/admin/users/{bea_id}/roles/administrator").status_code == 403
    assert ada.post(f"/api/v1/admin/users/{sysop_id}/sign-out").status_code == 404
    own = ada.post(f"/api/v1/admin/users/{ada_id}/status", json={"status": "disabled"})
    assert own.json()["code"] == "self_change"
    page = ada.get("/api/v1/admin/users", params={"limit": 1}).json()
    second = ada.get(
        "/api/v1/admin/users", params={"limit": 1, "cursor": page["next_cursor"]}
    ).json()
    assert len(page["items"]) == 1 and len(second["items"]) == 1
    assert page["items"][0]["id"] != second["items"][0]["id"] and second["next_cursor"] is None
    found = ada.get("/api/v1/admin/users", params={"q": "BEA@"}).json()["items"]
    assert [(user["id"], user["email"]) for user in found] == [(bea_id, "bea@example.com")]

    # A moderator reads the account list, but approves nothing: no private email addresses, and
    # no searching by them.
    listed = bea.get("/api/v1/admin/users").json()["items"]
    assert len(listed) == 2 and all(user["email"] is None for user in listed)
    assert bea.get("/api/v1/admin/users", params={"q": "ada@"}).json()["items"] == []
    named = bea.get("/api/v1/admin/users", params={"q": "ADA"}).json()["items"]
    assert {user["id"] for user in named} == {ada_id, bea_id}  # both are named Ada by Google

    disabled = ada.post(
        f"/api/v1/admin/users/{bea_id}/status", json={"status": "disabled", "reason": "test"}
    )
    assert disabled.json()["status"] == "disabled" and disabled.json()["roles"] == ["moderator"]
    assert bea.get("/api/v1/me").status_code == 401
    assert sign_in(bea, sub="2002").json()["code"] == "account_disabled"
    restored = ada.post(f"/api/v1/admin/users/{bea_id}/status", json={"status": "active"})
    assert restored.json()["status"] == "active" and "moderator" in restored.json()["roles"]

    # Others see SysOp as the site administrator, without its addresses or sign-in trail.
    entries = ada.get("/api/v1/admin/audit").json()["items"]
    grant = next(entry for entry in entries if entry["details"].get("role") == "administrator")
    assert grant["actor"] == {"id": None, "label": "Site administrator"}
    assert grant["source_address"] is None
    assert not [entry for entry in entries if "sysop" in entry["action"]]
    assert "SysOp" not in json.dumps(entries)
    own_view = root.get("/api/v1/admin/audit", params={"action": "auth.sysop"}).json()["items"]
    assert own_view[0]["action"] == "auth.sysop_login" and own_view[0]["actor"]["label"] == "SysOp"
    assert own_view[0]["source_address"] == "10.20.0.7"

    # Role and status changes need a recent sign-in.
    clock.offset = timedelta(hours=13)
    late = ada.put(f"/api/v1/admin/users/{bea_id}/roles/content_editor")
    assert late.status_code == 401 and late.json()["code"] == "reauthentication_required"


def test_only_sysop_restores_a_disabled_administrator(app: FastAPI, database: str) -> None:
    set_sysop_password(database, PASSWORD)
    root = sysop(app)
    ada, bea = browser(app), browser(app)
    ada_id = sign_in(ada).json()["id"]
    bea_id = sign_in(bea, sub="2002", email="bea@example.com").json()["id"]
    grants = [(ada_id, "administrator"), (bea_id, "moderator"), (bea_id, "administrator")]
    for user_id, role in grants:
        assert root.put(f"/api/v1/admin/users/{user_id}/roles/{role}").status_code == 200
    disabled = root.post(f"/api/v1/admin/users/{bea_id}/status", json={"status": "disabled"})
    # A disabled account keeps its grants, and shows them, so the Admin page locks its row.
    assert disabled.json()["roles"] == ["moderator", "administrator"]
    listed = ada.get("/api/v1/admin/users", params={"status": "disabled"}).json()["items"]
    assert [user["roles"] for user in listed] == [["moderator", "administrator"]]

    base = f"/api/v1/admin/users/{bea_id}"
    for method, path, body in [
        ("POST", f"{base}/status", {"status": "active"}),
        ("POST", f"{base}/sign-out", None),
        ("DELETE", f"{base}/roles/moderator", None),
        ("PUT", f"{base}/roles/content_editor", None),
    ]:
        refused = ada.request(method, path, json=body)
        assert refused.status_code == 403 and refused.json()["code"] == "forbidden", path
    assert sign_in(bea, sub="2002").json()["code"] == "account_disabled"
    restored = root.post(f"{base}/status", json={"status": "active"}).json()
    assert restored["status"] == "active"
    assert restored["roles"] == ["player", "moderator", "administrator"]


def test_audit_labels_never_pass_for_the_site_administrator_or_another_player(
    app: FastAPI, database: str
) -> None:
    set_sysop_password(database, PASSWORD)
    root = sysop(app)
    ada, bea = browser(app), browser(app)
    ada_id = sign_in(ada).json()["id"]
    root.put(f"/api/v1/admin/users/{ada_id}/roles/administrator")
    sign_in(bea, sub="2002", email="bea@example.com")
    bea.patch("/api/v1/me", json={"handle": "bea"})
    # Two accounts without a handle, named to pass for SysOp and for bea.
    mimic, copy = browser(app), browser(app)
    mimic_id = sign_in(mimic, sub="3003", name="Site administrator").json()["id"]
    copy_id = sign_in(copy, sub="4004").json()["id"]
    assert copy.patch("/api/v1/me", json={"display_name": "bea"}).status_code == 200
    reserved = copy.patch("/api/v1/me", json={"handle": "Site_Administrator"})
    assert reserved.status_code == 409 and reserved.json()["code"] == "handle_unavailable"

    entries = ada.get("/api/v1/admin/audit").json()["items"]
    labels = {entry["actor"]["id"]: entry["actor"]["label"] for entry in entries if entry["actor"]}
    assert labels[mimic_id] == f"Site administrator (no handle, {mimic_id[:8]})"
    assert labels[copy_id] == f"bea (no handle, {copy_id[:8]})"
    assert list(labels.values()).count("bea") == 1  # the real bea
    # Only SysOp's events carry the site administrator's label, and they carry no id.
    assert {key for key, label in labels.items() if label == "Site administrator"} == {None}


def test_a_lost_race_for_a_handle_a_role_or_a_first_sign_in_is_no_crash(
    app: FastAPI, database: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    set_sysop_password(database, PASSWORD)
    ada, bea = browser(app), browser(app)
    sign_in(ada)
    bea_id = UUID(sign_in(bea, sub="2002", email="bea@example.com").json()["id"])

    def meanwhile(module: Any, action: str, change: Callable[[Session], None]) -> None:
        """Commits a competing change from another connection as `action` is audited: after the
        route's own check, before its commit."""
        real = module.audit

        def audit(db: Session, request: Any, name: str, **details: Any) -> None:
            if name == action:
                with Session(app.state.database) as other:
                    change(other)
                    other.commit()
            real(db, request, name, **details)

        monkeypatch.setattr(module, "audit", audit)

    # Two players claim one handle at once.
    def claim(db: Session) -> None:
        user = db.get_one(User, bea_id)
        user.handle, user.normalized_handle = "Zed", "zed"

    meanwhile(auth, "profile.updated", claim)
    lost = ada.patch("/api/v1/me", json={"handle": "zed"})
    assert lost.status_code == 409 and lost.json()["code"] == "handle_taken"
    assert ada.get("/api/v1/me").json()["handle"] is None

    # Two grants of one role at once: the role is granted either way.
    def grant(db: Session) -> None:
        db.add(RoleGrant(user_id=bea_id, role="moderator", granted_at=identity.utcnow()))

    meanwhile(admin, "admin.role_granted", grant)
    granted = sysop(app).put(f"/api/v1/admin/users/{bea_id}/roles/moderator")
    assert granted.status_code == 200 and granted.json()["roles"] == ["player", "moderator"]

    # Two first sign-ins of one Google account at once: the other one's account is written first.
    first_sign_in = auth.new_account

    def racing(db: Session, *args: Any) -> tuple[User, Any]:
        first_sign_in(db, *args)
        return first_sign_in(db, *args)

    monkeypatch.setattr(auth, "new_account", racing)
    cy = browser(app)
    conflict = sign_in(cy, sub="5005", email="cy@example.com")
    assert conflict.status_code == 409 and conflict.json()["code"] == "sign_in_conflict"
    assert count(app, User, User.kind == "player") == 2
    monkeypatch.setattr(auth, "new_account", first_sign_in)
    assert sign_in(cy, sub="5005", email="cy@example.com").status_code == 200


def test_text_the_database_cannot_store_is_refused(app: FastAPI, database: str) -> None:
    client = browser(app)
    me = sign_in(client).json()
    refused = client.patch("/api/v1/me", json={"display_name": "Ada\u0000"})
    assert refused.status_code == 422 and refused.json()["code"] == "invalid_request"
    named = client.patch("/api/v1/me", json={"display_name": "Ada \U0001f469‍\U0001f4bb"})
    assert named.status_code == 200

    set_sysop_password(database, PASSWORD)
    root = sysop(app)
    reason = root.post(
        f"/api/v1/admin/users/{me['id']}/status", json={"status": "disabled", "reason": "x\u0000"}
    )
    assert reason.status_code == 422
    assert client.get("/api/v1/me").json()["status"] == "active"
    for path, params in [
        ("/api/v1/admin/users", {"q": "a\u0000"}),
        ("/api/v1/admin/audit", {"action": "a\u0000"}),
    ]:
        assert root.get(path, params=params).status_code == 422, path


def test_account_search_matches_text_as_written(app: FastAPI, database: str) -> None:
    ids = {}
    for sub, name in (("5005", "Weiß"), ("6006", "Σίσυφος"), ("7007", "a\\b"), ("8008", "axc")):
        signed_in = sign_in(browser(app), sub=sub, email=f"p{sub}@example.com", name=name)
        ids[name] = signed_in.json()["id"]
    set_sysop_password(database, PASSWORD)
    root = sysop(app)

    def found(q: str) -> list[str]:
        users = root.get("/api/v1/admin/users", params={"q": q}).json()["items"]
        return [user["id"] for user in users]

    assert found("Weiß") == [ids["Weiß"]] and found("WEIß") == [ids["Weiß"]]
    assert found("Σίσυφος") == [ids["Σίσυφος"]]
    assert found("a_c") == [] and found("%") == []  # _ and % are not wildcards
    assert found("a\\") == [ids["a\\b"]]
    assert found("P8008@EXAMPLE") == [ids["axc"]]
    assert root.get("/api/v1/admin/audit", params={"action": "AUTH.GOOGLE_"}).json()["items"]


def test_other_sites_cannot_send_state_changes(app: FastAPI) -> None:
    client = browser(app)
    sign_in(client)
    for headers in ({"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}):
        refused = client.post("/api/v1/auth/logout", headers=headers)
        assert refused.status_code == 403 and refused.json()["code"] == "origin_refused"
    for origin in ("http://localhost:5173", "http://127.0.0.1:5173"):
        assert client.get("/api/v1/me", headers={"Origin": "https://evil.example"}).is_success
        accepted = client.post(
            "/api/v1/auth/google/start", headers={"Origin": origin, "Sec-Fetch-Site": "same-origin"}
        )
        assert accepted.status_code == 200
    assert client.post("/api/v1/auth/logout").status_code == 204


def test_forwarded_addresses_are_believed_only_from_trusted_proxies() -> None:
    proxies = Settings(trusted_proxies="172.30.0.10/32, 10.0.0.0/8").trusted_proxy_list

    class Fake:
        def __init__(self, peer: str, *forwarded: str) -> None:
            self.client = type("Client", (), {"host": peer})()
            self.headers = Headers(
                raw=[(b"x-forwarded-for", value.encode()) for value in forwarded]
            )

    def address(peer: str, *forwarded: str) -> str | None:
        found = client_address(Fake(peer, *forwarded), proxies)  # type: ignore[arg-type]
        return str(found) if found else None

    assert address("198.51.100.1", "10.20.0.7") == "198.51.100.1"
    assert address("172.30.0.10", "198.51.100.9, 10.1.2.3") == "198.51.100.9"
    assert address("172.30.0.10", "1.1.1.1", "198.51.100.9") == "198.51.100.9"
    assert address("172.30.0.10") == "172.30.0.10"
    assert address("172.30.0.10", "10.1.1.1") == "10.1.1.1"
    assert address("172.30.0.10", "junk") is None
    assert address("::ffff:198.51.100.2") == "198.51.100.2"
    assert address("testclient") is None
    with pytest.raises(ValueError, match="overlaps trusted proxy"):
        Settings(sysop_networks="172.30.0.0/24", trusted_proxies="172.30.0.10")
