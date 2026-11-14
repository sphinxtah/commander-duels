"""The economy's foundations (v0.9.12, docs/economy.md): every policy off until SysOp sets it;
functional basic lands that mint nothing; the starter-staple pool's claims; the quest boards'
streak, catch-up and alternative policies; the farming signals and their hook; and the report
that measures a proposal by the game's own rules."""

import json
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
import test_quests
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from test_progression import Account, card_id, completed, entry
from test_quests import EASY_DAY, board_rows, daily, database, entries, played, won

from api import cli, economy_report, entitlements, farming, policies, quest_pool, quests
from api.identity import utcnow
from api.models import (
    AuditEvent,
    CampaignReward,
    CardConcept,
    CardPrinting,
    Entitlement,
    Game,
    LibraryGrant,
    QuestBoard,
    TokenEntry,
    User,
)

url = test_quests.url
content = test_quests.content
engine = test_quests.engine
client = test_quests.client
POOL = ["Sol Ring", "Counterspell", "Lightning Bolt", "No Such Card"]


@pytest.fixture
def pool(content: Path):
    """A starter-staple pool of cards the test catalog has, and one it lacks."""
    (content / entitlements.FILE).write_text(
        json.dumps({"policy": "staples-v1", "cards": POOL}), encoding="utf-8"
    )
    entitlements.pool_in.cache_clear()
    yield
    (content / entitlements.FILE).unlink()
    entitlements.pool_in.cache_clear()


def set_policy(root: Account, name: str, **value: Any) -> None:
    answer = root.send("PUT", f"/api/v1/admin/policies/{name}", value)
    assert answer.status_code == 200, answer.text


def grants(client: TestClient) -> int:
    with database(client) as db:
        return int(db.scalar(select(func.count()).select_from(LibraryGrant)) or 0)


def library(who: Account) -> dict[str, dict[str, Any]]:
    return {item["card"]["name"]: item for item in who.get("/api/v1/library").json()["cards"]}


def test_every_policy_is_off_until_sysop_sets_it(client):
    root, admin, ada = (
        Account(client, "sysop", kind="sysop"),
        Account(client, "admin", admin=True),
        Account(client, "ada"),
    )
    shown = admin.get("/api/v1/admin/policies").json()["policies"]
    assert [each["name"] for each in shown] == list(policies.POLICIES)
    assert not any(each["changed"] for each in shown)
    by_name = {each["name"]: each["value"] for each in shown}
    assert by_name["functional_basics"] == {"enabled": False}
    assert by_name["starter_staples"]["enabled"] is False
    assert by_name["quest_streaks"]["mode"] == "reset"
    assert by_name["quest_catch_up"]["enabled"] is False
    assert by_name["quest_alternatives"] == {"enabled": False}
    assert by_name["farming"]["enforce"] is False
    # Players do not see them; administrators see and cannot set them; SysOp sets them.
    assert ada.get("/api/v1/admin/policies").status_code == 403
    on = {"enabled": True}
    assert admin.send("PUT", "/api/v1/admin/policies/functional_basics", on).status_code == 403
    assert root.send("PUT", "/api/v1/admin/policies/no_such", on).status_code == 404
    wrong = root.send("PUT", "/api/v1/admin/policies/quest_streaks", {"mode": "generous"})
    assert (wrong.status_code, wrong.json()["code"]) == (422, "invalid_policy")
    unknown = root.send("PUT", "/api/v1/admin/policies/functional_basics", {"on": True})
    assert unknown.status_code == 422
    # A field left out takes its default; the change is audited with what it was and became.
    changed = root.send("PUT", "/api/v1/admin/policies/quest_streaks", {"mode": "forgiving"})
    streaks = {each["name"]: each for each in changed.json()["policies"]}["quest_streaks"]
    assert streaks["value"] == {"mode": "forgiving", "grace": 1, "penalty": 0}
    assert streaks["changed"] is True
    with database(client) as db:
        (event,) = db.scalars(
            select(AuditEvent).where(AuditEvent.action == "economy.policy_changed")
        )
        assert event.details == {
            "policy": "quest_streaks",
            "from": {"mode": "reset", "grace": 1, "penalty": 0},
            "to": {"mode": "forgiving", "grace": 1, "penalty": 0},
        }
        # Setting it to what it is writes nothing more.
        root.send("PUT", "/api/v1/admin/policies/quest_streaks", {"mode": "forgiving"})
        assert db.scalar(select(func.count()).select_from(AuditEvent)) == 1
        # A setting that cannot be read is the default, never an error.
        assert policies.read(db, policies.QuestCatchUp) == policies.QuestCatchUp()


def test_functional_basic_lands_are_built_with_and_never_owned(client):
    root, ada = (
        Account(client, "sysop", kind="sysop"),
        Account(client, "ada", onboarding="starters"),
    )
    ada.send("POST", "/api/v1/me/starters", {"decks": ["starter_red_test", "starter_blue_test"]})
    burn = [entry(client, "Lightning Bolt", 1), entry(client, "Mountain", 99)]
    deck = ada.send(
        "POST", "/api/v1/decks", {"title": "Burn", "format": "legacy", "entries": burn}
    ).json()
    # As since v0.6.0: the library holds the 97 Mountains its starter deck gave, and no more.
    assert deck["collection_locked"] is True
    assert deck["cards"][card_id(client, "Mountain")]["owned"] == 97
    before = grants(client)
    mine = library(ada)
    assert mine["Mountain"]["sources"] == ["starter"] and mine["Mountain"]["sellable"] == 97
    assert "Forest" not in mine

    set_policy(root, "functional_basics", enabled=True)
    # The deck is checked again the next time it is listed, and plays.
    listed = {item["id"]: item for item in ada.get("/api/v1/decks").json()}
    assert listed[deck["id"]]["collection_locked"] is False
    mine = library(ada)
    assert mine["Mountain"]["sources"] == ["functional", "starter"]
    assert mine["Mountain"]["copies"] == 97 + 250
    # Nothing was minted: no grant, and what may be sold is what was granted.
    assert grants(client) == before
    assert mine["Mountain"]["sellable"] == 97
    assert mine["Forest"]["sources"] == ["functional"] and mine["Forest"]["sellable"] == 0
    forests = [entry(client, "Lightning Bolt", 1), entry(client, "Forest", 59)]
    green = ada.send(
        "POST", "/api/v1/decks", {"title": "Trees", "format": "legacy", "entries": forests}
    ).json()
    assert green["collection_locked"] is False and green["validation"]["playable"] is True
    # A functional copy is no copy to sell.
    with database(client) as db:
        forest = db.get_one(CardConcept, UUID(card_id(client, "Forest")))
        printing = db.get_one(CardPrinting, forest.default_printing_id)
    refused = ada.send(
        "POST",
        "/api/v1/auctions",
        {
            "printing_id": str(printing.id),
            "finish": "nonfoil",
            "starting_bid": 100,
            "buy_now": None,
            "duration": "1h",
            "quantity": 1,
            "key": "functional-forest",
        },
    )
    assert (refused.status_code, refused.json()["code"]) == (422, "not_sellable")
    assert "without owning" in refused.json()["message"]
    # Only the five basic lands, and only while the policy is on.
    assert set(mine) & {"Plains", "Island", "Swamp", "Mountain", "Forest"} == {
        "Plains",
        "Island",
        "Swamp",
        "Mountain",
        "Forest",
    }
    assert mine["Lightning Bolt"]["sources"] == ["starter"]
    set_policy(root, "functional_basics", enabled=False)
    listed = {item["id"]: item for item in ada.get("/api/v1/decks").json()}
    assert listed[deck["id"]]["collection_locked"] is True
    assert listed[green["id"]]["collection_locked"] is True
    assert "Forest" not in library(ada)
    assert grants(client) == before


def test_the_starter_staple_pool_is_claimed_with_picks_once(client, pool):
    root, ada = Account(client, "sysop", kind="sysop"), Account(client, "ada")
    ring, spell, bolt = (card_id(client, name) for name in POOL[:3])
    # Off: out of reach, as a missing page is.
    assert ada.get("/api/v1/me/staples").status_code == 404
    assert ada.send("POST", f"/api/v1/me/staples/{ring}").status_code == 404
    set_policy(root, "starter_staples", enabled=True, initial=1, per_ward=2, per_weekly_board=1)
    shown = ada.get("/api/v1/me/staples").json()
    assert shown["picks"] == {"earned": 1, "used": 0, "left": 1}
    # The pool in its own order; a name the catalog lacks is left out.
    assert [item["card"]["name"] for item in shown["cards"]] == POOL[:3]
    before = grants(client)
    deck = ada.send(
        "POST",
        "/api/v1/decks",
        {"title": "Ring", "format": "legacy", "entries": [entry(client, "Sol Ring", 1)]},
    ).json()
    assert deck["collection_locked"] is True

    claimed = ada.send("POST", f"/api/v1/me/staples/{ring}")
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["picks"] == {"earned": 1, "used": 1, "left": 0}
    assert [item["claimed"] for item in claimed.json()["cards"]] == [True, False, False]
    # The claim again is the claim as it stands; another card needs another pick.
    again = ada.send("POST", f"/api/v1/me/staples/{ring}")
    assert again.status_code == 200 and again.json()["picks"]["used"] == 1
    none = ada.send("POST", f"/api/v1/me/staples/{bolt}")
    assert (none.status_code, none.json()["code"]) == (409, "no_picks")
    outside = ada.send("POST", f"/api/v1/me/staples/{card_id(client, 'Grizzly Bears')}")
    assert (outside.status_code, outside.json()["code"]) == (404, "not_a_staple")
    with database(client) as db:
        (held,) = db.scalars(select(Entitlement))
        assert (held.kind, held.copies, held.policy) == ("staple", 1, "staples-v1")
        assert held.key == f"staple:{ada.id}:{ring}"
    # Built with, never owned: one copy in the library, no grant, nothing to sell.
    mine = library(ada)
    assert mine["Sol Ring"]["sources"] == ["staple"]
    assert (mine["Sol Ring"]["copies"], mine["Sol Ring"]["sellable"]) == (1, 0)
    assert grants(client) == before
    listed = {item["id"]: item for item in ada.get("/api/v1/decks").json()}
    assert listed[deck["id"]]["collection_locked"] is False

    # Picks come from records that already exist: a ward's seal, a weekly board finished.
    with database(client) as db:
        db.add(
            CampaignReward(
                user_id=ada.id,
                campaign_id="test",
                key=f"test:{ada.id}:seal:01",
                reward="seal:01",
                created_at=utcnow(),
            )
        )
        db.add(
            QuestBoard(
                user_id=ada.id,
                board="weekly",
                period=quests.day_of(utcnow()) - timedelta(days=7),
                key=f"board:{ada.id}:weekly:test",
                streak=1,
                bonus=2_000,
                policy="quests-v2",
                completed_at=utcnow(),
            )
        )
        db.commit()
    assert ada.get("/api/v1/me/staples").json()["picks"] == {"earned": 4, "used": 1, "left": 3}
    assert ada.send("POST", f"/api/v1/me/staples/{bolt}").status_code == 200

    # SysOp ends one: the library no longer holds it, and the deck says so.
    with database(client) as db:
        first = db.scalar(select(Entitlement.id).where(Entitlement.card_id == UUID(ring)))
    ended = root.send("DELETE", f"/api/v1/admin/users/{ada.id}/entitlements/{first}")
    assert ended.status_code == 200, ended.text
    assert [each["name"] for each in ended.json()["entitlements"]] == ["Lightning Bolt"]
    assert "Sol Ring" not in library(ada)
    listed = {item["id"]: item for item in ada.get("/api/v1/decks").json()}
    assert listed[deck["id"]]["collection_locked"] is True
    # Claimed again, it is a new fact with a pick of its own.
    assert ada.send("POST", f"/api/v1/me/staples/{ring}").status_code == 200
    assert ada.get("/api/v1/me/staples").json()["picks"] == {"earned": 4, "used": 2, "left": 2}
    # SysOp gives functional access for testing, audited; turning the pool off takes nothing.
    given = root.send(
        "POST",
        f"/api/v1/admin/users/{ada.id}/entitlements",
        {"card_id": spell, "copies": 2, "reason": "Testing a counter deck"},
    )
    assert given.status_code == 200, given.text
    set_policy(root, "starter_staples", enabled=False)
    assert ada.get("/api/v1/me/staples").status_code == 404
    mine = library(ada)
    assert mine["Counterspell"]["copies"] == 2 and mine["Sol Ring"]["copies"] == 1
    assert grants(client) == before
    with database(client) as db:
        actions = set(db.scalars(select(AuditEvent.action)))
        assert {"economy.entitlement_given", "economy.entitlement_ended"} <= actions
        # After a reset the entitlements made before it no longer count.
        user = db.get_one(User, ada.id)
        user.reset_at = utcnow()
        db.commit()
    assert not {"Sol Ring", "Counterspell", "Lightning Bolt"} & set(library(ada))


def test_the_shipped_pool_holds_no_reserved_card():
    folder = str(Path(__file__).resolve().parents[1] / "content")
    entitlements.pool_in.cache_clear()
    names = entitlements.pool_in(folder)
    reserved = json.loads((Path(folder) / "reserved-list.json").read_text(encoding="utf-8"))
    assert len(names) == 40 and len(set(names)) == 40
    assert not set(names) & set(reserved["cards"])
    assert not set(names) & {"Plains", "Island", "Swamp", "Mountain", "Forest"}


def board(db: Session, user_id: UUID, period: Any, streak: int, kind: str = "daily") -> None:
    db.add(
        QuestBoard(
            user_id=user_id,
            board=kind,
            period=period,
            key=f"board:{user_id}:{kind}:{period.isoformat()}",
            streak=streak,
            bonus=quests.bonus_for(kind, streak),  # type: ignore[arg-type]
            policy="quests-v2",
            completed_at=utcnow(),
        )
    )


def test_a_forgiving_streak_keeps_what_a_missed_period_would_reset(client, monkeypatch):
    monkeypatch.setattr(quests, "choose_daily", daily(*EASY_DAY))
    root, ada = Account(client, "sysop", kind="sysop"), Account(client, "ada")
    today = quests.day_of(utcnow())
    with database(client) as db:
        board(db, ada.id, today - timedelta(days=2), 5)
        db.commit()
    # As it is: the day missed yesterday starts the streak again.
    assert ada.get("/api/v1/me/quests").json()["daily"]["streak"]["current"] == 0
    set_policy(root, "quest_streaks", mode="forgiving", grace=1, penalty=0)
    shown = ada.get("/api/v1/me/quests").json()["daily"]["streak"]
    assert shown == {"current": 5, "bonus": 900, "next_bonus": 1_000, "best": 5}
    # A penalty takes steps off for each missed period.
    set_policy(root, "quest_streaks", mode="forgiving", grace=1, penalty=2)
    assert ada.get("/api/v1/me/quests").json()["daily"]["streak"]["current"] == 3
    won(client, ada, skill=6)
    done = ada.get("/api/v1/me/quests").json()["daily"]
    assert done["streak"]["current"] == 4 and done["streak"]["bonus"] == 700
    bonus = [row for row in entries(client, ada.id, "quest") if row[1].startswith("board:")]
    assert [(row[0], row[2]) for row in bonus] == [(700, "Daily board complete (streak 4)")]
    # More missed in a row than the grace: it starts again, under either policy.
    bea = Account(client, "bea")
    with database(client) as db:
        board(db, bea.id, today - timedelta(days=3), 9)
        db.commit()
    assert bea.get("/api/v1/me/quests").json()["daily"]["streak"]["current"] == 0
    # The rule by itself, as the report uses it.
    forgiving = policies.QuestStreaks(mode="forgiving", grace=2, penalty=1)
    assert [quests.carried_streak(forgiving, 6, missed) for missed in range(4)] == [6, 5, 4, 0]
    assert [quests.carried_streak(policies.QuestStreaks(), 6, m) for m in range(3)] == [6, 0, 0]


def test_a_finished_daily_board_catches_up_a_day_missed_that_week(client, monkeypatch):
    monkeypatch.setattr(quests, "choose_daily", daily(*EASY_DAY))
    root, ada = Account(client, "sysop", kind="sysop"), Account(client, "ada")
    today = quests.day_of(utcnow())
    sunday = today - timedelta(days=(today.weekday() + 1) % 7)
    with database(client) as db:
        user = db.get_one(User, ada.id)
        user.created_at = utcnow() - timedelta(days=30)
        db.commit()
        # Off: nothing more than the board.
        assert quests.catch_up(db, user, sunday + timedelta(days=3)) == 0
    set_policy(root, "quest_catch_up", enabled=True, tokens=400, days=2)
    with database(client) as db:
        user = db.get_one(User, ada.id)
        wednesday = sunday + timedelta(days=3)
        # Sunday was finished; Monday and Tuesday were missed: the earliest is paid, once.
        board(db, ada.id, sunday, 1)
        db.flush()
        assert quests.catch_up(db, user, wednesday) == 400
        assert quests.catch_up(db, user, wednesday + timedelta(days=1)) == 400
        # Two a week, by the policy: Wednesday's own miss is not paid on Friday.
        assert quests.catch_up(db, user, wednesday + timedelta(days=2)) == 0
        db.commit()
        keys = sorted(db.scalars(select(TokenEntry.key).where(TokenEntry.key.like("catch-up:%"))))
        monday, tuesday = sunday + timedelta(days=1), sunday + timedelta(days=2)
        assert keys == [f"catch-up:{ada.id}:{day.isoformat()}" for day in (monday, tuesday)]
        paid = db.scalars(select(TokenEntry).where(TokenEntry.key.like("catch-up:%"))).all()
        assert {(row.kind, row.amount, row.policy) for row in paid} == {
            ("quest", 400, "quest-catch-up-v1")
        }
        assert paid[0].reason == f"Catch-up for {monday:%A}'s daily board"
        # A day before the account's first is no day missed.
        bea = Account(client, "bea")
        new = db.get_one(User, bea.id)
        new.created_at = utcnow()
        assert quests.catch_up(db, new, quests.day_of(utcnow())) == 0
    # Through a game: the board's end pays it in the same transaction, when a day was missed.
    cal = Account(client, "cal")
    with database(client) as db:
        user = db.get_one(User, cal.id)
        user.created_at = utcnow() - timedelta(days=30)
        db.commit()
    assert cal.get("/api/v1/me/quests").status_code == 200
    won(client, cal, skill=6)
    caught = [row for row in entries(client, cal.id, "quest") if row[1].startswith("catch-up:")]
    assert len(caught) == (1 if today != sunday else 0)


def test_a_daily_quest_drawn_with_an_alternative_completes_by_either(client, monkeypatch):
    monkeypatch.setattr(quests, "choose_daily", daily(*EASY_DAY))
    root, ada = Account(client, "sysop", kind="sysop"), Account(client, "ada")
    # Off: a board has none.
    assert all(
        quest["alternative"] is None
        for quest in ada.get("/api/v1/me/quests").json()["daily"]["quests"]
    )
    set_policy(root, "quest_alternatives", enabled=True)
    bea = Account(client, "bea")
    shown = bea.get("/api/v1/me/quests").json()["daily"]["quests"]
    rows = board_rows(client, bea.id, "daily")
    families = [quest_pool.DAILY_BY_ID[row.quest].family for row in rows]
    for row, quest in zip(rows, shown, strict=True):
        main = quest_pool.DAILY_BY_ID[row.quest]
        assert row.alternative is not None and quest["alternative"] is not None
        other = quest_pool.DAILY_BY_ID[str(row.alternative["quest"])]
        # Its own step, so as hard and as well paid; a family no other quest of the board has.
        assert other.step == main.step and other.id != main.id
        families.append(other.family)
        assert quest["alternative"] == {
            "id": other.id,
            "name": other.name,
            "target": other.target,
            "progress": 0,
        }
    assert len(families) == len(set(families)) == 10
    # The first slot's quest is a win; give it games played as its alternative. Two games lost
    # are no win, and complete the slot by its alternative alone.
    with database(client) as db:
        first = rows[0]
        row = db.get_one(type(first), first.id)
        row.alternative = {"quest": "d1-play-2", "target": 2}
        db.commit()
    played(client, [(bea.id, "x"), None], completed(1))
    half = bea.get("/api/v1/me/quests").json()["daily"]["quests"][0]
    assert half["completed_at"] is None and half["alternative"]["progress"] == 1
    played(client, [(bea.id, "x"), None], completed(1))
    after = bea.get("/api/v1/me/quests").json()["daily"]["quests"][0]
    # A completed slot shows its quest as done, whichever of the two completed it.
    assert after["completed_at"] is not None and after["progress"] == after["target"] == 1
    assert after["alternative"]["progress"] == 2
    paid = [row for row in entries(client, bea.id, "quest") if row[1].startswith("daily:")]
    assert [(row[0], row[1].rsplit(":", 1)[1]) for row in paid] == [(150, rows[0].quest)]


def table_game(client: TestClient, one: Account, other: Account, result: dict[str, Any]) -> UUID:
    return played(client, [(one.id, "x"), (other.id, "y")], result, kind="table")


def conceded(winner: int, turns: int) -> dict[str, Any]:
    return completed(winner) | {"turns": turns, "conceded_seats": [1 - winner]}


def signals(client: TestClient, game_id: UUID) -> dict[str, Any]:
    with database(client) as db:
        return dict(db.get_one(Game, game_id).eligibility or {})


def tokens(client: TestClient, game_id: UUID) -> int:
    with database(client) as db:
        return int(
            db.scalar(
                select(func.coalesce(func.sum(TokenEntry.amount), 0)).where(
                    TokenEntry.game_id == game_id
                )
            )
            or 0
        )


def test_farming_signals_are_kept_and_withhold_only_when_enforced(client, monkeypatch):
    monkeypatch.setattr(quests, "choose_daily", daily(*EASY_DAY))
    root, ada, bea = (
        Account(client, "sysop", kind="sysop"),
        Account(client, "ada"),
        Account(client, "bea"),
    )
    for who in (ada, bea):
        assert who.get("/api/v1/me/quests").status_code == 200
    # A game played out carries no signal, and its record is the mode's alone.
    plain = table_game(client, ada, bea, completed(0))
    assert "signals" not in signals(client, plain) and tokens(client, plain) > 0
    # Seen, not enforced: the signals are kept and the game pays as before.
    early = table_game(client, ada, bea, conceded(0, 1))
    kept = signals(client, early)
    assert kept["signals"] == {"0": ["opponent_conceded_early"], "1": ["conceded_early"]}
    assert "seats" not in kept and kept["earns"][0] == "tokens"
    assert tokens(client, early) > 0
    # A concession late in a game is no signal; a short game with none is seen only.
    late = table_game(client, ada, bea, conceded(0, 9))
    assert "signals" not in signals(client, late)
    short = table_game(client, ada, bea, completed(0) | {"turns": 2})
    assert signals(client, short)["signals"] == {"0": ["short_game"], "1": ["short_game"]}

    set_policy(root, "farming", enforce=True, short_turns=3, repeat_results=6)
    cal, dee = Account(client, "cal"), Account(client, "dee")
    for who in (cal, dee):
        assert who.get("/api/v1/me/quests").status_code == 200
    held = table_game(client, cal, dee, conceded(0, 1))
    kept = signals(client, held)
    assert kept["seats"] == {
        "0": {"tokens": "farming_opponent_conceded_early"},
        "1": {"quests": "farming_conceded_early"},
    }
    # The win's tokens are withheld; the conceding seat's quest boards do not count the game.
    assert tokens(client, held) == 0
    assert dee.get("/api/v1/me/quests").json()["daily"]["quests"][0]["progress"] == 0
    # The same two accounts over and over: from the sixth result together that day on.
    for _ in range(4):
        table_game(client, cal, dee, completed(0))
    sixth = table_game(client, cal, dee, completed(0))
    kept = signals(client, sixth)
    assert kept["signals"] == {"0": ["repeat_opponent"], "1": ["repeat_opponent"]}
    assert kept["seats"]["0"] == {
        "tokens": "farming_repeat_opponent",
        "quests": "farming_repeat_opponent",
    }
    assert tokens(client, sixth) == 0
    # Idle: a seat that sent no command in a game the API followed to its end.
    with database(client) as db:
        game = db.get_one(Game, plain)
        game.result = completed(0)
        seen = farming.observe(db, game, {0: 14, 1: 0})
        assert seen.signals[1] == ["idle"] and seen.withheld[1] == {"quests": "farming_idle"}
        assert 0 not in seen.signals or "idle" not in seen.signals[0]
        # With no count kept (an end recorded after a restart) there is no idle signal.
        assert "idle" not in sum(farming.observe(db, game, None).signals.values(), [])
    # A game against bots alone cannot be conceded to, or repeated with another account.
    alone = won(client, cal, skill=6)
    assert "signals" not in signals(client, alone) and tokens(client, alone) > 0


def test_the_report_measures_a_proposal_by_the_games_own_rules(client, pool):
    ada = Account(client, "ada")
    Account(client, "sysop", kind="sysop")
    won(client, ada, skill=6)
    with database(client) as db:
        found = economy_report.report(db, str(Path(__file__).resolve().parents[1] / "content"))
    book = found["ledger"]
    # SysOp's balance is its own grants, and left out.
    assert book["accounts"] == 1 and book["total"] == book["median"] == book["largest"] > 0
    assert book["by_kind"]["bot_win"]["entries"] == 1
    assert found["land_packs"] == {"packs": 0, "tokens": 0, "accounts": 0}
    assert found["farming"]["games"] == 1 and found["farming"]["flagged"] == 0
    assert [ward["tokens"] for ward in found["campaign"]][:3] == [1_000, 2_000, 4_000]
    assert found["campaign"][-1]["cumulative"] == 32_767_000
    assert found["quests"]["daily_quests"] == 2_000 and found["quests"]["daily_bonus"] == [
        400,
        1_000,
    ]
    as_is, forgiving, catch_up, both = found["simulation"]["daily_boards"]
    weekdays = "weekdays"
    # Five days a week, as it is: 400 to 800 on five boards of 2,000, every week the same.
    assert as_is["players"][weekdays]["settled_week"] == 5 * 2_000 + 400 + 500 + 600 + 700 + 800
    # Forgiven the weekend, the streak reaches its cap: 1,000 a board.
    assert forgiving["players"][weekdays]["settled_week"] == 5 * 3_000
    # The catch-up pays one missed day for each board finished after it: a weekday player has
    # missed only Sunday when Monday's is finished.
    assert catch_up["players"][weekdays]["settled_week"] == 13_000 + 400
    assert both["players"][weekdays]["settled_week"] == 15_000 + 400
    # A player who never misses earns the same under every proposal.
    daily_totals = {
        board["players"]["every day"]["total"] for board in found["simulation"]["daily_boards"]
    }
    assert len(daily_totals) == 1
    assert found["staples"]["pool"] == 40 and found["staples"]["picks_after_the_campaign"] == 40
    text = economy_report.as_text(found)
    assert "Balances" in text and "The starter-staple pool" in text
    # Without a database it still measures the proposals.
    assert "ledger" not in economy_report.report(None, "content")


def test_the_console_lists_and_sets_policies_and_prints_the_report(
    client, url, content, monkeypatch, capsys
):
    monkeypatch.setenv("CD_DATABASE_URL", url)
    monkeypatch.setenv("CD_CONTENT_DIR", str(content))
    cli.main(["economy-policy"])
    listed = capsys.readouterr().out.splitlines()
    assert len(listed) == len(policies.POLICIES)
    assert listed[0].split() == ["functional_basics", "default", '{"enabled":', "false}"]
    cli.main(["economy-policy", "functional_basics", '{"enabled": true}'])
    assert capsys.readouterr().out.split() == [
        "functional_basics",
        "changed",
        '{"enabled":',
        "true}",
    ]
    with database(client) as db:
        assert policies.read(db, policies.FunctionalBasics).enabled is True
        (event,) = db.scalars(
            select(AuditEvent).where(AuditEvent.action == "economy.policy_changed")
        )
        assert event.actor_id is None and event.details["source"] == "console"
        assert event.details["from"] == {"enabled": False}
    with pytest.raises(SystemExit) as refused:
        cli.main(["economy-policy", "functional_basics", '{"on": true}'])
    assert "Not set" in str(refused.value)
    with pytest.raises(SystemExit):
        cli.main(["economy-policy", "no_such_policy", "{}"])
    cli.main(["economy-report", "--weeks", "4"])
    text = capsys.readouterr().out
    assert "Balances" in text and "over 4 weeks" in text and "functional_basics" in text
    cli.main(["economy-report", "--json"])
    assert json.loads(capsys.readouterr().out)["simulation"]["weeks"] == 8
