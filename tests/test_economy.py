"""Tokens (v0.4.0): what wins pay, the limits, SysOp's grants, spending, and the migration."""

import json
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
import test_progression
from alembic import command
from alembic.config import Config
from catalog_fixtures import bulk, engine_list, import_bulk
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session
from test_progression import Account, completed

from api import economy, games
from api.identity import ApiError, utcnow
from api.models import AuditEvent, Game, GameSeat, TokenEntry, User

# The progression tests' database, content, fake engine and app, shared here.
url = test_progression.url
content = test_progression.content
engine = test_progression.engine
client = test_progression.client
# What daily quests and achievements pay (v0.5.0).
REWARDS = ("quest", "achievement")


def played(
    client: TestClient,
    seats: list[UUID | None],
    result: dict[str, Any],
    skill: int = 4,
) -> UUID:
    """A game recorded as the API records an engine's result: a seat per entry, a player's account
    or None for a bot."""
    game_id = uuid4()
    database = client.app.state.database  # type: ignore[attr-defined]
    owner = next(seat for seat in seats if seat is not None)
    with Session(database) as db:
        db.add(
            Game(
                id=game_id,
                format="commander",
                status="active",
                created_by=owner,
                created_at=utcnow(),
                bot_skill=skill,
                turn_cap=60,
            )
        )
        db.flush()
        for index, user_id in enumerate(seats):
            db.add(
                GameSeat(
                    game_id=game_id,
                    seat=index,
                    player="human" if user_id else "bot",
                    user_id=user_id,
                    deck="x",
                )
            )
        db.commit()
    games.record_end(database, game_id, "finished", result)
    return game_id


def ledger(client: TestClient, user_id: UUID) -> list[tuple[str, int, str | None]]:
    """What wins paid. The achievements a win earns pay apart (v0.5.0, test_quests.py)."""
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return [
            (row.kind, row.amount, row.reason)
            for row in db.scalars(
                select(TokenEntry)
                .where(TokenEntry.user_id == user_id, TokenEntry.kind.not_in(REWARDS))
                .order_by(TokenEntry.created_at, TokenEntry.opponent_seat)
            )
        ]


def test_the_human_curve():
    assert [economy.human_tokens(wins) for wins in (0, 10, 50, 100, 1_000, 10_000)] == [
        50,
        144,
        204,
        230,
        320,
        410,
    ]
    assert economy.human_tokens(100_000) == economy.human_tokens(10**7) == 500
    # Arizona keeps one offset all year: 06:59 UTC is still the day before there.
    start, end = economy.arizona_day(datetime(2026, 7, 2, 6, 59, tzinfo=UTC))
    assert (start, end - start) == (datetime(2026, 7, 1, 7, tzinfo=UTC), timedelta(days=1))


def test_bot_wins_pay_per_bot_once(client):
    ada = Account(client, "ada")
    won = played(client, [ada.id, None, None, None], completed(0), skill=6)
    played(client, [ada.id, None], completed(1))  # a bot won
    played(client, [ada.id, None], {**completed(None), "kind": "turn_limit"})
    database = client.app.state.database
    # A replay of the end pays nothing more: the game is no longer active, and the keys are taken.
    games.record_end(database, won, "finished", completed(0))
    with Session(database) as db:
        economy.pay_game(db, db.get_one(Game, won))
        db.commit()
    assert ledger(client, ada.id) == [("bot_win", 20, None)] * 3
    tokens = ada.get("/api/v1/me/tokens").json()
    rewards = sum(line["amount"] for line in tokens["entries"] if line["kind"] in REWARDS)
    assert (tokens["balance"], tokens["earned"], tokens["given"], tokens["spent"]) == (
        60 + rewards,
        60 + rewards,
        0,
        0,
    )
    wins = [line for line in tokens["entries"] if line["kind"] not in REWARDS]
    assert {line["opponent"] for line in wins} == {"a skill-6 bot"}
    summary = ada.get(f"/api/v1/games/{won}").json()["game"]
    assert summary["tokens"] == 60


def test_human_wins_pay_by_the_curve_three_a_day(client):
    ada, bob = Account(client, "ada"), Account(client, "bob")
    root = Account(client, "sysop", kind="sysop")
    reason = {"wins": 100, "reason": "Testing the curve"}
    assert root.send("POST", f"/api/v1/admin/users/{bob.id}/wins", reason).status_code == 200
    # A table of two players and a skill-2 bot: ada beats both.
    for _ in range(4):
        played(client, [ada.id, bob.id, None], completed(0), skill=2)
    rows = ledger(client, ada.id)
    humans = [row for row in rows if row[0] == "human_win"]
    assert [amount for _, amount, _ in humans] == [230, 230, 230, 0]
    assert humans[-1][2] == "Only 3 wins a day over the same player pay tokens."
    assert [amount for kind, amount, _ in rows if kind == "bot_win"] == [8] * 4
    lines = ada.get("/api/v1/me/tokens").json()["entries"]
    assert "bob" in {line["opponent"] for line in lines}
    # The loser earns nothing; bob's own win over ada pays by ada's wins (4, so 113).
    played(client, [ada.id, bob.id], completed(1))
    assert ledger(client, bob.id) == [("human_win", economy.human_tokens(4), None)]


def test_sysop_caps_bot_tokens_a_day(client):
    ada = Account(client, "ada")
    root = Account(client, "sysop", kind="sysop")
    admin = Account(client, "admin", admin=True)
    assert admin.get("/api/v1/admin/economy").json() == {"bot_daily_cap": None}
    refused = admin.send("PUT", "/api/v1/admin/economy", {"bot_daily_cap": 20})
    assert refused.status_code == 403
    assert root.send("PUT", "/api/v1/admin/economy", {"bot_daily_cap": 0}).status_code == 422
    capped = root.send("PUT", "/api/v1/admin/economy", {"bot_daily_cap": 20})
    assert capped.json() == {"bot_daily_cap": 20}
    for _ in range(3):
        played(client, [ada.id, None], completed(0))
    assert [amount for _, amount, _ in ledger(client, ada.id)] == [14, 6, 0]
    assert ledger(client, ada.id)[1][2] == "Today's cap on tokens from bots is 20."
    root.send("PUT", "/api/v1/admin/economy", {"bot_daily_cap": None})
    played(client, [ada.id, None], completed(0))
    assert ledger(client, ada.id)[-1][1] == 14
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        changes = [
            event.details
            for event in db.scalars(
                select(AuditEvent).where(AuditEvent.action == "economy.settings_changed")
            )
        ]
    assert changes == [
        {"bot_daily_cap": {"from": None, "to": 20}},
        {"bot_daily_cap": {"from": 20, "to": None}},
    ]


def test_sysop_gives_tokens_and_spending_stops_at_zero(client):
    ada = Account(client, "ada")
    root = Account(client, "sysop", kind="sysop")
    admin = Account(client, "admin", admin=True)
    path = f"/api/v1/admin/users/{ada.id}/tokens"
    gift = {"amount": 500, "reason": "Testing the shop"}
    assert ada.send("POST", path, gift).status_code == 403
    assert admin.send("POST", path, gift).status_code == 403
    assert ada.get(path).status_code == 403
    assert root.send("POST", path, {"amount": 500}).status_code == 422
    assert root.send("POST", path, {"amount": 0, "reason": "nothing"}).status_code == 422
    given = root.send("POST", path, gift).json()
    assert (given["balance"], given["given"]) == (500, 500)
    assert admin.get(path).json()["balance"] == 500
    row = next(
        item
        for item in admin.get("/api/v1/admin/users").json()["items"]
        if item["id"] == str(ada.id)
    )
    assert row["tokens"] == 500
    taken = root.send("POST", path, {"amount": -600, "reason": "Too much"})
    assert (taken.status_code, taken.json()["code"]) == (409, "balance_negative")
    # SysOp's own account takes grants too.
    own = root.send("POST", f"/api/v1/admin/users/{root.id}/tokens", gift)
    assert own.json()["balance"] == 500
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        events = [
            (event.action, event.details)
            for event in db.scalars(
                select(AuditEvent).where(AuditEvent.action == "economy.tokens_granted")
            )
        ]
        assert events[0] == ("economy.tokens_granted", gift)
        with pytest.raises(ApiError) as short:
            economy.spend(db, ada.id, 501, "pack:test-1", "A pack")
        assert short.value.code == "not_enough_tokens"
        economy.spend(db, ada.id, 500, "pack:test-2", "A pack")
        db.commit()
    tokens = ada.get("/api/v1/me/tokens").json()
    assert (tokens["balance"], tokens["spent"]) == (0, 500)


def test_every_account_is_welcomed_once(client):
    ada = Account(client, "ada")
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        user = db.get_one(User, ada.id)
        economy.welcome(db, user)
        db.flush()
        economy.welcome(db, user)
        db.commit()
    tokens = ada.get("/api/v1/me/tokens").json()
    assert (tokens["balance"], tokens["given"]) == (1_000, 1_000)
    assert [line["kind"] for line in tokens["entries"]] == ["welcome"]


def test_the_migration_welcomes_and_pays_back(tmp_path, monkeypatch):
    database_url = f"sqlite:///{tmp_path}/tokens.db"
    monkeypatch.setenv("CD_DATABASE_URL", database_url)
    config = Config("alembic.ini")
    command.upgrade(config, "0007_alliance")
    database = create_engine(database_url)
    import_bulk(database, tmp_path / "files", bulk(), engine_list())
    now = utcnow()
    ada, sysop = uuid4(), uuid4()
    won, lost = uuid4(), uuid4()
    with Session(database) as db:
        for user_id, kind, handle in ((ada, "player", "ada"), (sysop, "sysop", "sysop")):
            db.execute(
                text(
                    "INSERT INTO users (id, normalized_handle, handle, display_name, kind, "
                    "status, onboarding, avatar, locale, preferences, privilege_version, "
                    "created_at) VALUES (:id, :handle, :handle, :handle, :kind, 'active', "
                    "'complete', 'sigil', 'en', '{}', 0, :now)"
                ),
                {"id": user_id.hex, "handle": handle, "kind": kind, "now": now},
            )
        for game_id, winner, skill in ((won, 0, 5), (lost, 1, 3)):
            db.execute(
                text(
                    "INSERT INTO games (id, kind, format, status, created_by, created_at, "
                    "bot_skill, turn_cap, result) VALUES (:id, 'practice', 'commander', "
                    "'finished', :owner, :now, :skill, 60, :result)"
                ),
                {
                    "id": game_id.hex,
                    "owner": ada.hex,
                    "now": now,
                    "skill": skill,
                    "result": json.dumps(completed(winner)),
                },
            )
            for seat in range(3):
                db.execute(
                    text(
                        "INSERT INTO game_seats (id, game_id, seat, player, user_id, deck) VALUES "
                        "(:id, :game, :seat, :player, :owner, 'x')"
                    ),
                    {
                        "id": uuid4().hex,
                        "game": game_id.hex,
                        "seat": seat,
                        "player": "human" if seat == 0 else "bot",
                        "owner": ada.hex if seat == 0 else None,
                    },
                )
        db.commit()
    command.upgrade(config, "head")
    with Session(database) as db:
        rows = {
            (row.user_id, row.kind, row.amount, row.key) for row in db.scalars(select(TokenEntry))
        }
    assert rows == {
        (ada, "welcome", 1_000, f"welcome:{ada}"),
        (sysop, "welcome", 1_000, f"welcome:{sysop}"),
        (ada, "back_pay", 17, f"tokens:{won}:0:1"),
        (ada, "back_pay", 17, f"tokens:{won}:0:2"),
    }
    command.downgrade(config, "0007_alliance")
    database.dispose()
