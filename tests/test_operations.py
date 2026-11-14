"""What an operator reads (v0.9.13, api/operations.py and api/metrics.py; the specification's
section 15: metrics for authorization failures and settlement failures, and failures diagnosed
without exposing what is concealed).

The counts of settlements that waited or failed are with the games they happen to
(tests/test_games.py); a gate's and a grant's refusals with theirs (tests/test_rollout.py). Here:
who reads the numbers, what a refusal counts as, and what the route gathers.
"""

from datetime import timedelta
from typing import Any

import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from test_access import deck_of
from test_games import Account, FakeEngine, build, connect

from api import access, metrics, rollout
from api.database import migration_head
from api.identity import utcnow
from api.models import RoleGrant, ScheduledJob, SiteSetting, User
from api.version import APP_VERSION


class CountingEngine(FakeEngine):
    """The fake engine, with the two routes an operator's numbers come from."""

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/v1/service")
        if path == "/processes":
            return httpx.Response(
                200, json={"isolation": "process", "totals": {"processes_started": 3}}
            )
        if path == "/recordings":
            return httpx.Response(200, json={"on_disk": {"recordings": 2}})
        return await super().__call__(request)


@pytest.fixture
def client(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> Any:
    url = f"sqlite:///{tmp_path}/operations.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    metrics.COUNTERS.reset()
    with connect(build(url, CountingEngine())) as client:
        yield client


def session(client: TestClient) -> Session:
    return Session(client.app.state.database, expire_on_commit=False)  # type: ignore[attr-defined]


def counted(found: dict[str, Any], name: str, **labels: str) -> int:
    return sum(
        count["count"]
        for count in found["counts"]
        if count["name"] == name and labels.items() <= count["labels"].items()
    )


def test_staff_read_the_sites_numbers_and_a_refusal_is_counted_by_its_code(
    client: TestClient,
) -> None:
    ada, eve = Account(client, "ada"), Account(client, "eve")
    root = Account(client, "sysop", kind="sysop")
    with session(client) as db:
        db.add(RoleGrant(user_id=eve.id, role="administrator", granted_at=utcnow()))
        db.commit()
    # Three refusals: a player asking for the numbers, a request from another site, and one from
    # nobody.
    assert ada.get("/api/v1/admin/operations").status_code == 403
    cross = client.post("/api/v1/decks", json={}, headers={"origin": "https://elsewhere.example"})
    assert cross.status_code == 403 and cross.json()["code"] == "origin_refused"
    nobody = client.get("/api/v1/admin/operations")
    assert nobody.status_code == 401

    for reader in (eve, root):
        found = reader.get("/api/v1/admin/operations")
        assert found.status_code == 200, found.text
    numbers = found.json()
    assert numbers["version"] == APP_VERSION and numbers["migration"] == migration_head()
    assert counted(numbers, "access.refused", code="forbidden") == 1
    assert counted(numbers, "access.refused", code="origin_refused") == 1
    assert counted(numbers, "access.refused", code=nobody.json()["code"]) == 1
    assert counted(numbers, "access.refused") == 3
    # A label is a code, a status or a workflow: nothing of an account or a game.
    held = {str(ada.id), str(eve.id), str(root.id), "ada", "eve"}
    assert not held & {value for count in numbers["counts"] for value in count["labels"].values()}
    assert {workflow["stage"] for workflow in numbers["rollout"]["workflows"]} == {"off"}
    # The engine's own numbers, as it gives them.
    assert numbers["engine"] == {
        "processes": {"isolation": "process", "totals": {"processes_started": 3}},
        "recordings": {"on_disk": {"recordings": 2}},
    }


def test_the_numbers_follow_the_games_the_access_given_and_the_workers_jobs(
    client: TestClient,
) -> None:
    ada, bea = Account(client, "ada"), Account(client, "bea")
    root = Account(client, "sysop", kind="sysop")

    def numbers() -> dict[str, Any]:
        return root.get("/api/v1/admin/operations").json()  # type: ignore[no-any-return]

    assert numbers()["games"] == {
        "running": 0,
        "active": 0,
        "last_day": {"finished": 0, "interrupted": 0},
        "last_week": {"finished": 0, "interrupted": 0},
    }
    game_id = ada.post("/api/v1/practice-games", {}).json()["id"]
    assert numbers()["games"]["running"] == 1 and numbers()["games"]["active"] == 1
    # A socket from another site is a refusal too, counted apart from a request's.
    with pytest.raises(Exception):  # noqa: B017, PT011  (the client raises on a refused socket)
        with ada.socket(game_id, origin="https://elsewhere.example") as socket:
            socket.receive_json()
            socket.receive_json()
    assert ada.post(f"/api/v1/games/{game_id}/close").json()["status"] == "finished"
    after = numbers()
    assert after["games"]["active"] == 0
    assert (
        after["games"]["last_day"]
        == after["games"]["last_week"]
        == {
            "finished": 1,
            "interrupted": 0,
        }
    )
    assert counted(after, "settlement.recorded", status="finished") == 1
    assert counted(after, "settlement.failed") == 0
    assert counted(after, "access.refused", code="origin_refused", on="socket") == 1

    now = utcnow()
    with session(client) as db:
        db.add(SiteSetting(key=rollout.PREFIX + "deck_lending", value="on", updated_at=now))
        db.flush()
        a, b = db.get_one(User, ada.id), db.get_one(User, bea.id)
        deck = deck_of(db, a.id)
        access.answer(db, access.offer(db, a, b, "deck", deck.id), b, True)
        access.offer(db, a, b, "deck", deck.id, expires_at=now + timedelta(seconds=1))
        ended = access.offer(db, a, b, "deck", deck.id)
        access.revoke(db, ended, a)
        for kind, due, status, code in (
            ("account_cleanup", now - timedelta(days=1), "completed", "ok"),
            ("account_cleanup", now, "failed", "database_unavailable"),
            ("catalog_sync", now, "completed", "ok"),
        ):
            db.add(
                ScheduledJob(
                    kind=kind,
                    deduplication_key=f"{kind}:{due.isoformat()}",
                    status=status,
                    result_code=code,
                    due_at=due,
                )
            )
        db.commit()
    later = root.get("/api/v1/admin/operations").json()
    assert later["access"] == {
        "offered": 1,
        "accepted": 1,
        "given": 0,
        "declined": 0,
        "revoked": 1,
        "expired": 0,
    }
    assert [(job["kind"], job["status"], job["result_code"]) for job in later["jobs"]] == [
        ("account_cleanup", "failed", "database_unavailable"),
        ("catalog_sync", "completed", "ok"),
    ]
    assert {w["id"]: w["stage"] for w in later["rollout"]["workflows"]}["deck_lending"] == "on"


def test_the_numbers_are_there_without_an_engine(tmp_path: Any, monkeypatch: Any) -> None:
    url = f"sqlite:///{tmp_path}/alone.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    with connect(build(url, None)) as client:
        root = Account(client, "sysop", kind="sysop")
        found = root.get("/api/v1/admin/operations")
        assert found.status_code == 200 and found.json()["engine"] is None
