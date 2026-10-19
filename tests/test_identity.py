"""Identity: Google sign-in (T01/T02), sessions (AUTH03), roles and administration (AUTH06,
T29), and SysOp's entrance. Google ID tokens are signed with a test key that the verifier's
certificate fetch returns, so google-auth's real checks run on every token."""

import json
import time
from collections.abc import Iterator
from datetime import datetime, timedelta
from typing import Any

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
from api.models import AuditEvent, User, UserSession
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
    assert me["permissions"] == ["games.play", "profile.edit"]
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
    assert profile["handle"] == "Ada_L" and profile["onboarding"] == "complete"
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


def test_forged_expired_and_replayed_sign_ins_create_no_session(app: FastAPI, certs: Certs) -> None:
    client = browser(app)
    nonce = client.post("/api/v1/auth/google/start").json()["nonce"]
    now = int(time.time())
    attempts = {
        "expired": google_token(nonce=nonce, iat=now - 7200, exp=now - 3600),
        "wrong audience": google_token(nonce=nonce, aud="someone-else.apps.googleusercontent.com"),
        "wrong issuer": google_token(nonce=nonce, iss="https://accounts.example.com"),
        "forged": google_token(FORGER, nonce=nonce),
        "other nonce": google_token(nonce="0" * 64),
        "no nonce": google_token(),
        "garbage": "not.a.token",
    }
    for name, credential in attempts.items():
        response = client.post("/api/v1/auth/google", json={"credential": credential})
        assert response.status_code == 401, name
        assert response.json()["code"] == "invalid_sign_in", name
    # Without the challenge cookie, even a valid token is refused.
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
    assert reasons.count("invalid_token") == 5
    assert "nonce_mismatch" in reasons and "challenge_used_or_expired" in reasons

    # Certificates are cached, and a Google outage is reported as one.
    assert certs.calls == 1
    app.state.google_verifier._request._cache.clear()
    certs.down = True
    outage = sign_in(browser(app))
    assert outage.status_code == 503 and outage.json()["code"] == "provider_unavailable"


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
    for _ in range(4):
        assert client.post("/api/v1/sysop/login", json=wrong).status_code == 401
    # Five failures from this address in 15 minutes lock it, even for the right password.
    assert client.post("/api/v1/sysop/login", json=body).status_code == 429
    assert count(app, AuditEvent, AuditEvent.action == "auth.sysop_login_failed") == 5

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
    assert ada.get("/api/v1/admin/users", params={"q": "BEA@"}).json()["items"][0]["id"] == bea_id

    disabled = ada.post(
        f"/api/v1/admin/users/{bea_id}/status", json={"status": "disabled", "reason": "test"}
    )
    assert disabled.json()["status"] == "disabled"
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
