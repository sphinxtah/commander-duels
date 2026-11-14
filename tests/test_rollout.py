"""Rollout: the gates of the workflows that are not finished (v0.9.13, api/rollout.py; the
specification's section 15: "disabled workflows cannot be reached through unguarded endpoints").

Every workflow is off until SysOp sets it. Off, its routes answer as paths that do not exist, its
access is neither given nor of any use, and no game is made in its mode; at staff, SysOp and
administrators alone reach it; on, everyone. And no route under a path a workflow reserves is
without its gate, which is what keeps a route added later from being left open.
"""

from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_access import deck_of, game_of, refused
from test_games import Account, build, connect

from api import access, metrics, rollout
from api.identity import utcnow
from api.main import create_app
from api.models import AuditEvent, RoleGrant, SiteSetting, User


@pytest.fixture
def client(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> Any:
    url = f"sqlite:///{tmp_path}/rollout.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    with connect(build(url, None)) as client:
        yield client


def session(client: TestClient) -> Session:
    return Session(client.app.state.database, expire_on_commit=False)  # type: ignore[attr-defined]


def administrator(client: TestClient, handle: str) -> Account:
    account = Account(client, handle)
    with session(client) as db:
        db.add(RoleGrant(user_id=account.id, role="administrator", granted_at=utcnow()))
        db.commit()
    return account


def stages(found: Any) -> dict[str, str]:
    return {workflow["id"]: workflow["stage"] for workflow in found.json()["workflows"]}


def test_every_workflow_is_off_until_sysop_sets_it_and_each_change_is_audited(
    client: TestClient,
) -> None:
    ada, eve = Account(client, "ada"), administrator(client, "eve")
    root = Account(client, "sysop", kind="sysop")
    # A player is told what they may reach, and not the stages.
    assert ada.get("/api/v1/admin/rollout").status_code == 403
    reach = ada.get("/api/v1/rollout").json()["workflows"]
    assert [workflow["id"] for workflow in reach] == list(rollout.WORKFLOWS)
    assert not any(workflow["available"] for workflow in reach)
    # Staff read every stage; SysOp alone sets one.
    assert set(stages(eve.get("/api/v1/admin/rollout")).values()) == {"off"}
    assert eve.put("/api/v1/admin/rollout/sandbox", {"stage": "on"}).status_code == 403
    assert root.put("/api/v1/admin/rollout/leagues", {"stage": "on"}).status_code == 404
    assert root.put("/api/v1/admin/rollout/sandbox", {"stage": "sometimes"}).status_code == 422

    changed = root.put("/api/v1/admin/rollout/sandbox", {"stage": "staff"})
    assert changed.status_code == 200 and stages(changed)["sandbox"] == "staff"

    def reachable(account: Account) -> set[str]:
        found = account.get("/api/v1/rollout").json()["workflows"]
        return {workflow["id"] for workflow in found if workflow["available"]}

    assert reachable(ada) == set()
    assert reachable(eve) == reachable(root) == {"sandbox"}
    root.put("/api/v1/admin/rollout/sandbox", {"stage": "on"})
    assert reachable(ada) == {"sandbox"}
    # The same stage again changes nothing and records nothing.
    root.put("/api/v1/admin/rollout/sandbox", {"stage": "on"})
    with session(client) as db:
        changes = [
            event.details
            for event in db.scalars(
                select(AuditEvent)
                .where(AuditEvent.action == "rollout.stage_changed")
                .order_by(AuditEvent.occurred_at)
            )
        ]
        assert changes == [
            {"workflow": "sandbox", "from": "off", "to": "staff"},
            {"workflow": "sandbox", "from": "staff", "to": "on"},
        ]
        # A stage that is no stage (a setting written by hand) is off.
        db.add(SiteSetting(key="rollout.replays", value="maybe", updated_at=utcnow()))
        db.commit()
        assert rollout.stage_of(db, "replays") == "off"
        assert not rollout.available(db, "nothing", db.get_one(User, root.id))


def test_a_gated_route_is_a_missing_path_until_its_workflow_reaches_the_caller(
    client: TestClient,
) -> None:
    # A route made as v1.0.0's will be, on the workflow's router.
    gated = rollout.router("sandbox", prefix="/api/v1/sandbox")

    @gated.get("/decks")
    def sandbox_decks() -> dict[str, bool]:
        return {"reached": True}

    app: FastAPI = client.app  # type: ignore[assignment]
    app.include_router(gated)
    ada, eve = Account(client, "ada"), administrator(client, "eve")
    root = Account(client, "sysop", kind="sysop")
    metrics.COUNTERS.reset()

    def answers() -> list[int]:
        return [who.get("/api/v1/sandbox/decks").status_code for who in (ada, eve, root)]

    assert answers() == [404, 404, 404]
    # Off, it is told apart from no path at all by nothing a caller can see.
    assert ada.get("/api/v1/sandbox/decks").json()["code"] == "http_404"
    assert ada.get("/api/v1/sandbox/nothing").json()["code"] == "http_404"
    assert client.get("/api/v1/sandbox/decks").status_code == 401, "signed out: sign in first"
    root.put("/api/v1/admin/rollout/sandbox", {"stage": "staff"})
    assert answers() == [404, 200, 200]
    root.put("/api/v1/admin/rollout/sandbox", {"stage": "on"})
    assert answers() == [200, 200, 200]
    root.put("/api/v1/admin/rollout/sandbox", {"stage": "off"})
    assert answers() == [404, 404, 404]
    # Each refusal was counted, by the workflow and never by the account.
    assert metrics.COUNTERS.read("access.refused", code="not_rolled_out", workflow="sandbox") == 8


def test_access_of_a_workflow_that_is_off_is_neither_given_nor_of_use(client: TestClient) -> None:
    ada, bea, eve = Account(client, "ada"), Account(client, "bea"), administrator(client, "eve")
    root = Account(client, "sysop", kind="sysop")
    with session(client) as db:
        a, b, e, sysop = (db.get_one(User, account.id) for account in (ada, bea, eve, root))
        deck = deck_of(db, a.id)
        game = game_of(db, a.id)
        metrics.COUNTERS.reset()
        # Off: nothing of any kind is given.
        refused("not_available", lambda: access.offer(db, a, b, "deck", deck.id))
        refused("not_available", lambda: access.offer(db, a, b, "spectator", game))
        refused("not_available", lambda: access.offer(db, a, b, "hand", game, scope={"seat": 0}))
        refused("not_available", lambda: access.offer(db, a, b, "replay", game, scope={"seat": 0}))
        refused("not_available", lambda: access.offer(db, sysop, b, "sandbox", None))
        assert metrics.COUNTERS.read("access.refused", code="not_available") == 5
        assert metrics.COUNTERS.read("access.refused", giving="deck") == 1

        def stage(workflow: str, value: str) -> None:
            setting = db.get(SiteSetting, rollout.PREFIX + workflow) or SiteSetting(
                key=rollout.PREFIX + workflow
            )
            setting.value, setting.updated_at = value, utcnow()
            db.add(setting)
            db.flush()

        # At staff, between staff alone: a player is neither lent a deck nor lends one.
        stage("deck_lending", "staff")
        refused("not_available", lambda: access.offer(db, a, b, "deck", deck.id))
        refused("not_available", lambda: access.offer(db, a, e, "deck", deck.id))
        staff_deck = deck_of(db, e.id)
        refused("not_available", lambda: access.offer(db, e, a, "deck", staff_deck.id))
        lent = access.offer(db, e, sysop, "deck", staff_deck.id)
        access.answer(db, lent, sysop, True)
        assert access.deck_usable(db, sysop.id, staff_deck)

        # On, a player's loan works; switched off again it gives nothing, though the grant stands;
        # on again, it works again.
        stage("deck_lending", "on")
        grant = access.offer(db, a, b, "deck", deck.id)
        access.answer(db, grant, b, True)
        assert access.deck_usable(db, b.id, deck)
        stage("deck_lending", "off")
        assert not access.deck_usable(db, b.id, deck)
        assert not access.deck_usable(db, sysop.id, staff_deck)
        assert access.deck_usable(db, a.id, deck), "its owner's own deck needs no gate"
        stage("deck_lending", "on")
        assert access.deck_usable(db, b.id, deck)


def test_no_game_is_made_in_a_mode_whose_workflow_is_off(client: TestClient) -> None:
    ada, root = Account(client, "ada"), Account(client, "sysop", kind="sysop")
    with session(client) as db:
        player, sysop = db.get_one(User, ada.id), db.get_one(User, root.id)
        # The modes that exist are everyone's.
        for mode in ("practice", "table", "campaign", "testing"):
            assert rollout.mode_available(db, mode, player)
        assert not rollout.mode_available(db, "sandbox", player)
        assert not rollout.mode_available(db, "borrowed", sysop)
    root.put("/api/v1/admin/rollout/deck_lending", {"stage": "staff"})
    with session(client) as db:
        player, sysop = db.get_one(User, ada.id), db.get_one(User, root.id)
        assert rollout.mode_available(db, "borrowed", sysop)
        assert not rollout.mode_available(db, "borrowed", player)
        assert not rollout.mode_available(db, "sandbox", sysop)


def test_no_route_under_a_workflows_paths_is_without_its_gate() -> None:
    """Every route of the API as it is served: one under a path a workflow reserves is behind that
    workflow's gate. v1.0.0 makes its workflows' routes under these paths, and an app holding one
    without the gate does not start."""
    app = create_app()
    assert rollout.unguarded(app) == []
    # The check itself: a reserved path is seen whatever its parameters are called, a gated route
    # shows its gate through its router's include, and one beside it without a gate is caught.
    assert rollout.reserved_by("/api/v1/games/{id}/spectators/{spectator}") == "spectators"
    assert rollout.reserved_by("/api/v1/sandbox") == "sandbox"
    assert rollout.reserved_by("/api/v1/sandboxes") is None
    assert rollout.reserved_by("/api/v1/games/{game_id}/timeline") is None
    gated = rollout.router("replays", prefix="/replays")
    gated.add_api_route("/{replay_id}", lambda: None, methods=["GET"])
    forgotten = APIRouter(prefix="/replays")
    forgotten.add_api_route("/{replay_id}/notes", lambda: None, methods=["GET"])
    other = FastAPI()
    other.include_router(gated, prefix="/api/v1")
    assert rollout.unguarded(other) == []
    other.include_router(forgotten, prefix="/api/v1")
    other.add_api_route("/api/v1/sandbox/decks", lambda: None, methods=["GET"])
    assert rollout.unguarded(other) == [
        ("/api/v1/replays/{replay_id}/notes", "replays"),
        ("/api/v1/sandbox/decks", "sandbox"),
    ]
    with pytest.raises(ValueError, match="No such workflow"):
        rollout.router("leagues")
    # Every kind of access and every mode not yet made names a workflow that exists.
    assert set(rollout.ACCESS.values()) | set(rollout.MODES.values()) <= set(rollout.WORKFLOWS)
