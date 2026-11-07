"""SysOp's grants for testing (v0.8.8, api/testing.py): wins by format that count towards quests and
achievements but never statistics, cards into a library, and campaign progress without spoils;
SysOp's own account first in Administration's list; only SysOp grants; every grant audited."""

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from catalog_fixtures import bulk, engine_list, import_bulk
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from test_games import Account, FakeEngine, build, connect

from api.identity import utcnow
from api.models import (
    AuditEvent,
    CampaignReward,
    CardConcept,
    LibraryGrant,
    PlayerResult,
    RoleGrant,
    TokenEntry,
)


@pytest.fixture
def database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    url = f"sqlite:///{tmp_path}/testing.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    return url


@pytest.fixture
def client(database: str) -> Iterator[TestClient]:
    with connect(build(database, FakeEngine())) as client:
        yield client


@pytest.fixture
def app(client: TestClient) -> FastAPI:
    return client.app  # type: ignore[return-value]


def audited(app: FastAPI, action: str) -> list[dict[str, Any]]:
    with Session(app.state.database) as db:
        return [
            event.details
            for event in db.scalars(select(AuditEvent).where(AuditEvent.action == action))
        ]


def administrator(app: FastAPI, client: TestClient, handle: str) -> Account:
    found = Account(client, handle)
    with Session(app.state.database) as db:
        db.add(RoleGrant(user_id=found.id, role="administrator", granted_at=utcnow()))
        db.commit()
    return found


def test_sysop_lists_its_own_account_first(client: TestClient, app: FastAPI) -> None:
    root = Account(client, "sysop", kind="sysop")
    ada = Account(client, "ada")
    admin = administrator(app, client, "admin")
    listed = root.get("/api/v1/admin/users").json()["items"]
    assert [item["id"] for item in listed][0] == str(root.id)
    assert {str(ada.id), str(admin.id)} <= {item["id"] for item in listed}
    assert listed[0]["roles"] == ["sysop"]
    # Searching finds it as any other; a filter it does not match leaves it out.
    assert root.get("/api/v1/admin/users", q="sysop").json()["items"][0]["id"] == str(root.id)
    pending = root.get("/api/v1/admin/users", status="pending").json()["items"]
    assert str(root.id) not in {item["id"] for item in pending}
    # Nobody else ever sees SysOp's account.
    seen = admin.get("/api/v1/admin/users").json()["items"]
    assert str(root.id) not in {item["id"] for item in seen}


def test_granted_wins_count_for_quests_and_achievements_not_statistics(
    client: TestClient, app: FastAPI
) -> None:
    root = Account(client, "sysop", kind="sysop")
    ada = Account(client, "ada")
    body = {
        "format": "commander",
        "count": 3,
        "colors": "R",
        "against": "bots",
        "bot_skill": 5,
        "reason": "Testing quests",
    }
    # Only SysOp grants, never an administrator or a player.
    admin = administrator(app, client, "admin")
    for other in (ada, admin):
        refused = other.post(f"/api/v1/admin/users/{ada.id}/results", body)
        assert refused.status_code == 403, refused.text
    granted = root.post(f"/api/v1/admin/users/{ada.id}/results", body)
    assert granted.status_code == 201, granted.text
    answer = granted.json()
    assert answer["granted"] == 3
    assert answer["progress"]["wins"] == 3 and answer["progress"]["set_wins"] == 3
    # The first win's achievement is earned and paid at once.
    assert answer["achievement_tokens"] >= 100
    shown = ada.get("/api/v1/me/achievements").json()["achievements"]
    earned = {badge["id"] for badge in shown if badge["earned_at"]}
    assert "first-win" in earned
    # Statistics and the history count played games only.
    stats = ada.get("/api/v1/me/stats").json()
    assert stats["totals"]["games"] == 0 and stats["formats"] == []
    assert ada.get("/api/v1/me/history").json()["items"] == []
    with Session(app.state.database) as db:
        rows = list(db.scalars(select(PlayerResult).where(PlayerResult.user_id == ada.id)))
        assert len(rows) == 3
        assert {(row.game_id, row.granted_by, row.format, row.colors) for row in rows} == {
            (None, root.id, "commander", "R")
        }
        assert {(row.bots, row.bot_skill, row.players) for row in rows} == {(1, 5, 0)}
        # No tokens for the wins themselves: only the achievements' rewards.
        kinds = set(db.scalars(select(TokenEntry.kind).where(TokenEntry.user_id == ada.id)))
        assert "win" not in kinds
    [details] = audited(app, "testing.results_granted")
    assert (details["count"], details["wins_from"], details["wins_to"]) == (3, 0, 3)
    # SysOp grants to itself as well.
    own = root.post(f"/api/v1/admin/users/{root.id}/results", {**body, "count": 1})
    assert own.status_code == 201, own.text


def test_team_formats_count_the_other_team_as_opponents(client: TestClient, app: FastAPI) -> None:
    root = Account(client, "sysop", kind="sysop")
    ada = Account(client, "ada")
    for fmt, seats, opponents in (("two_headed_giant", 4, 2), ("kings_table", 6, 3)):
        body = {"format": fmt, "count": 1, "against": "players", "reason": "Testing teams"}
        assert root.post(f"/api/v1/admin/users/{ada.id}/results", body).status_code == 201
        with Session(app.state.database) as db:
            row = db.scalars(select(PlayerResult).where(PlayerResult.format == fmt)).one()
            assert (row.seats, row.players, row.bots, row.bot_skill) == (seats, opponents, 0, None)
    bad = {"format": "commander", "count": 1, "colors": "RW", "reason": "Wrong order"}
    assert root.post(f"/api/v1/admin/users/{ada.id}/results", bad).status_code == 422


def test_sysop_grants_cards_to_a_library(
    client: TestClient, app: FastAPI, database: str, tmp_path: Path
) -> None:
    import_bulk(create_engine(database), tmp_path / "files", bulk(), engine_list())
    root = Account(client, "sysop", kind="sysop")
    ada = Account(client, "ada")
    with Session(app.state.database) as db:
        bolt = db.scalars(select(CardConcept).where(CardConcept.name == "Lightning Bolt")).one()
    body = {"card_id": str(bolt.id), "quantity": 4, "reason": "Testing the auction house"}
    assert ada.post(f"/api/v1/admin/users/{ada.id}/cards", body).status_code == 403
    granted = root.post(f"/api/v1/admin/users/{ada.id}/cards", body)
    assert granted.status_code == 201, granted.text
    assert (granted.json()["name"], granted.json()["quantity"]) == ("Lightning Bolt", 4)
    library = ada.get("/api/v1/library").json()
    held = [item for item in library["cards"] if item["card"]["name"] == "Lightning Bolt"]
    assert sum(item["copies"] for item in held) == 4 and held[0]["sources"] == ["grant"]
    with Session(app.state.database) as db:
        grant = db.scalars(select(LibraryGrant).where(LibraryGrant.user_id == ada.id)).one()
        assert grant.source == "grant" and grant.grant_key.startswith("grant:")
    # A finish the edition does not come in is refused.
    etched = root.post(f"/api/v1/admin/users/{ada.id}/cards", {**body, "finish": "etched"})
    assert etched.status_code == 422
    [details] = audited(app, "testing.cards_granted")
    assert (details["name"], details["quantity"]) == ("Lightning Bolt", 4)


def test_sysop_sets_campaign_progress_without_spoils(client: TestClient, app: FastAPI) -> None:
    root = Account(client, "sysop", kind="sysop")
    ada = Account(client, "ada")
    body = {"won_through": 4, "reason": "Testing the silver ward"}
    assert ada.post(f"/api/v1/admin/users/{ada.id}/campaign", body).status_code == 403
    set_ = root.post(f"/api/v1/admin/users/{ada.id}/campaign", body)
    assert set_.status_code == 200, set_.text
    answer = set_.json()
    assert answer["completed"] == [1, 2, 3, 4] and answer["highest_unlocked"] == 5
    assert "card_back:broken-writ" in answer["rewards"]
    assert {f"seal:{number:02d}" for number in (1, 2, 3, 4)} <= set(answer["rewards"])
    assert not [reward for reward in answer["rewards"] if reward.startswith("spoils:")]
    seen = ada.get("/api/v1/campaign").json()
    assert seen["progress"]["completed"] == [1, 2, 3, 4]
    assert seen["chapters"][0]["rewards"][0]["earned"] is True
    with Session(app.state.database) as db:
        assert not db.scalars(select(LibraryGrant).where(LibraryGrant.user_id == ada.id)).all()
        kinds = set(db.scalars(select(TokenEntry.kind).where(TokenEntry.user_id == ada.id)))
        assert "campaign" not in kinds
    # Fewer than won starts again; 0 starts the campaign over.
    back = root.post(
        f"/api/v1/admin/users/{ada.id}/campaign", {"won_through": 0, "reason": "Start over"}
    ).json()
    assert (back["completed"], back["highest_unlocked"], back["rewards"]) == ([], 1, [])
    with Session(app.state.database) as db:
        # The old epoch's rewards stay recorded; the new one starts empty.
        assert db.scalar(select(func.count()).select_from(CampaignReward)) >= 5
    assert len(audited(app, "testing.campaign_set")) == 2


def test_campaign_cosmetics_are_chosen_once_earned_and_shown(
    client: TestClient, app: FastAPI
) -> None:
    root = Account(client, "sysop", kind="sysop")
    ada = Account(client, "ada")
    bea = Account(client, "bea")
    before = ada.get("/api/v1/me/cosmetics").json()
    assert (before["card_back"], before["title"]) == (None, None)
    backs = {item["id"]: item for item in before["card_backs"]}
    assert set(backs) == {"broken-writ", "unclaimed-world", "broken-throne", "fractured-throne"}
    assert backs["broken-writ"] == {"id": "broken-writ", "name": "Broken Writ", "earned": False}
    assert {item["id"] for item in before["titles"]} == {
        "unbowed",
        "witness-of-the-unbound",
        "concordance-breaker",
    }
    # Not earned yet: refused.
    refused = ada.put("/api/v1/me/cosmetics", {"card_back": "broken-writ", "title": None})
    assert (refused.status_code, refused.json()["code"]) == (409, "not_earned")
    # The gold ward's chapter (encounters 9 and 10) gives the Unbowed title.
    root.post(f"/api/v1/admin/users/{ada.id}/campaign", {"won_through": 10, "reason": "Rewards"})
    chosen = ada.put("/api/v1/me/cosmetics", {"card_back": "broken-writ", "title": "unbowed"})
    assert chosen.status_code == 200, chosen.text
    assert (chosen.json()["card_back"], chosen.json()["title_name"]) == ("broken-writ", "Unbowed")
    assert bea.get(f"/api/v1/players/{ada.id}").json()["title"] == "Unbowed"
    # Starting the campaign over takes them away with the rewards.
    root.post(f"/api/v1/admin/users/{ada.id}/campaign", {"won_through": 0, "reason": "Again"})
    after = ada.get("/api/v1/me/cosmetics").json()
    assert (after["card_back"], after["title"]) == (None, None)
    assert bea.get(f"/api/v1/players/{ada.id}").json()["title"] is None
