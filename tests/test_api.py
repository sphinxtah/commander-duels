import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from api.config import Settings
from api.database import migration_head
from api.main import create_app
from api.version import APP_VERSION


def test_framework_is_live_and_only_practice_play_is_available(tmp_path):
    app = create_app(Settings(database_url=f"sqlite:///{tmp_path}/app.db"))
    with TestClient(app) as client:
        response = client.get("/api/v1/health")
        assert response.json() == {"status": "ok", "version": APP_VERSION}
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-request-id"]
        assert client.get("/api/v1/ready").status_code == 503
        bootstrap = client.get("/api/v1/bootstrap").json()
        assert bootstrap["collection_policy"] == "open_collection"
        # Practice games against bots are playable since v0.1.0; the rest is still planned.
        available = {item["id"] for item in bootstrap["capabilities"] if item["available"]}
        assert available == {"gameplay"}
        gameplay = next(item for item in bootstrap["capabilities"] if item["id"] == "gameplay")
        assert gameplay["name"] == "Practice play" and "playable" in gameplay["reason"]
        formats = client.get("/api/v1/formats").json()
        assert formats[0]["seats"] == [2, 3, 4]
        playable = {item["id"] for item in formats if item["available"]}
        assert playable == {"commander", "legacy"}
        assert client.get("/api/v1/me").status_code == 401
        missing = client.get("/api/v1/missing")
        assert missing.status_code == 404
        assert missing.json()["request_id"] == missing.headers["x-request-id"]
        with app.state.database.begin() as connection:
            connection.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(32))"))
            connection.execute(text("INSERT INTO alembic_version VALUES ('0000_stale')"))
        stale = client.get("/api/v1/ready")
        assert stale.status_code == 503
        assert stale.json() == {"status": "not_ready", "database": "migration_required"}
        with app.state.database.begin() as connection:
            connection.execute(
                text("UPDATE alembic_version SET version_num = :head"), {"head": migration_head()}
            )
        assert client.get("/api/v1/ready").json() == {"status": "ready", "database": "ready"}


UNAVAILABLE = {
    "status": "unavailable",
    "protocol_version": 1,
    "gameplay_available": False,
    "xmage": None,
    "cards": None,
    "bot_match_enabled": False,
    "service_games_enabled": False,
    "implementations": None,
}

ENGINE_READY = {
    "status": "ready",
    "protocol_version": 1,
    "gameplay_available": False,
    "xmage": {
        "version": "1.4.62",
        "tag": "xmage_1.4.62V1",
        "commit": "eb69d05b88142b5c4eec4869bcb23a0fec13c091",
        "commit_date": "2026-10-03T20:33:40Z",
    },
    "cards": {"printings": 93992, "distinct_names": 32739},
    "bot_match_enabled": True,
    "service_games_enabled": True,
    "implementations": {"build": "1.4.62-eb69d05b-7909ff1a7bd0", "cards": 32486, "passed": 32486},
}


def engine_status_for(tmp_path, payload: object, status_code: int = 200) -> object:
    app = create_app(Settings(database_url=f"sqlite:///{tmp_path}/app.db"))
    with TestClient(app) as client:
        app.state.http = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(status_code, json=payload))
        )
        return client.get("/api/v1/engine/status").json()


def test_engine_failure_does_not_claim_playability(tmp_path):
    app = create_app(
        Settings(database_url=f"sqlite:///{tmp_path}/app.db", engine_url="http://127.0.0.1:1")
    )
    with TestClient(app) as client:
        assert client.get("/api/v1/engine/status").json() == UNAVAILABLE


def test_engine_status_passes_real_engine_health_through(tmp_path):
    assert engine_status_for(tmp_path, ENGINE_READY) == ENGINE_READY
    loading = {**ENGINE_READY, "status": "loading", "cards": None, "bot_match_enabled": False}
    assert engine_status_for(tmp_path, loading) == loading
    # An engine that serves games to players says so, and the status passes that through.
    playable = {**ENGINE_READY, "gameplay_available": True}
    assert engine_status_for(tmp_path, playable) == playable


def test_engine_status_rejects_unknown_shapes(tmp_path):
    for payload in (
        {**ENGINE_READY, "gameplay_available": None},
        {**ENGINE_READY, "status": "scaffold"},
        {**ENGINE_READY, "unexpected": 1},
        {**ENGINE_READY, "cards": {"printings": 1}},
        ["not", "an", "object"],
    ):
        assert engine_status_for(tmp_path, payload) == UNAVAILABLE
    assert engine_status_for(tmp_path, ENGINE_READY, status_code=503) == UNAVAILABLE


PRODUCTION = {
    "environment": "production",
    "database_url": "postgresql+psycopg://commander:Jd8s0aZq3Lw91XyTkV2m@db:5432/commander",
    "public_url": "https://duels.example.org",
    "engine_service_token": "s" * 32,
    "google_client_id": "client.apps.googleusercontent.com",
    "trusted_proxies": "10.10.50.2/32,172.30.233.10/32",
    "sysop_networks": "10.10.1.0/24",
}


def test_production_starts_only_hardened():
    assert Settings(**PRODUCTION).environment == "production"
    refused = {
        "public_url": "http://duels.example.org",
        "cookie_secure": False,
        "database_url": "postgresql+psycopg://commander:commander@db:5432/commander",
        "engine_service_token": "",
        "google_client_id": "",
        "trusted_proxies": "",
        "sysop_networks": "::/0",
    }
    for field, value in refused.items():
        with pytest.raises(ValueError, match="Production settings refused"):
            Settings(**{**PRODUCTION, field: value})
    # The same values are fine for development.
    assert Settings(**{**PRODUCTION, **refused, "environment": "development"})
