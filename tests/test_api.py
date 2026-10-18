from fastapi.testclient import TestClient
from sqlalchemy import text

from api.config import Settings
from api.database import migration_head
from api.main import create_app
from api.version import APP_VERSION


def test_framework_is_live_but_not_gameplay_ready(tmp_path):
    app = create_app(Settings(database_url=f"sqlite:///{tmp_path}/app.db"))
    with TestClient(app) as client:
        response = client.get("/api/v1/health")
        assert response.json() == {"status": "ok", "version": APP_VERSION}
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-request-id"]
        assert client.get("/api/v1/ready").status_code == 503
        bootstrap = client.get("/api/v1/bootstrap").json()
        assert bootstrap["collection_policy"] == "open_collection"
        assert all(not capability["available"] for capability in bootstrap["capabilities"])
        formats = client.get("/api/v1/formats").json()
        assert formats[0]["seats"] == [2, 3, 4]
        assert all(not item["available"] for item in formats)
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


def test_engine_failure_does_not_claim_playability(tmp_path):
    app = create_app(
        Settings(database_url=f"sqlite:///{tmp_path}/app.db", engine_url="http://127.0.0.1:1")
    )
    with TestClient(app) as client:
        assert client.get("/api/v1/engine/status").json() == {
            "status": "unavailable",
            "protocol_version": 1,
            "gameplay_available": False,
        }
