"""Statistics, daily quests and achievements (v0.5.0): the players' results recorded with a game's
end, the day's quests drawn once with one swap, quests and achievements paid once whatever
replays, a history from before v0.5.0 earning its achievements, the reset's fresh start, the
history's privacy, account deletion, and the migration on PostgreSQL when CD_TEST_POSTGRES_URL is
set. The progression tests' database, content and fake engine are shared here."""

import os
from collections.abc import Callable, Iterator
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
import test_progression
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_decks_api import ACCOUNT_TABLES
from test_games import SERVICE_TOKEN, SYSOP_ADDRESS
from test_progression import Account, card_id, completed

from api import achievements, awards, games, quest_pool, quests
from api.accounts import delete_account
from api.config import Settings
from api.identity import utcnow
from api.main import create_app
from api.models import (
    Auction,
    CardPrinting,
    DailyQuest,
    Deck,
    DeckEntryRow,
    DeckRevision,
    Friendship,
    Game,
    GameSeat,
    Notification,
    Pack,
    PackOpening,
    PlayerAchievement,
    PlayerResult,
    QuestBoard,
    ShopProduct,
    TokenEntry,
    User,
)

url = test_progression.url
content = test_progression.content
engine = test_progression.engine
TABLES = (
    "auctions",
    "packs",
    "quest_boards",
    "player_achievements",
    "daily_quests",
    "player_results",
    "notifications",
    "friendships",
    "pack_openings",
    "game_seats",
    "games",
    *ACCOUNT_TABLES,
)
RED = "commander-mono-red-raiders"


@pytest.fixture
def client(url: str, content: Path, engine) -> Iterator[TestClient]:
    app = create_app(
        Settings(
            database_url=url,
            content_dir=str(content),
            sysop_networks="10.20.0.0/24",
            engine_service_token=SERVICE_TOKEN,
        )
    )
    app.state.engine_transport = httpx.MockTransport(engine)
    with TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS) as client:
        yield client
        with Session(app.state.database) as db:
            for table in TABLES:
                db.execute(text(f"DELETE FROM {table}"))
            db.commit()


def database(client: TestClient) -> Session:
    return Session(client.app.state.database)  # type: ignore[attr-defined]


Seat = UUID | None | tuple[UUID | None, str]


def played(
    client: TestClient,
    seats: list[Seat],
    result: dict[str, Any],
    *,
    fmt: str = "commander",
    skill: int = 1,
    kind: str = "practice",
    revisions: dict[int, UUID] | None = None,
    left: dict[int, str] | None = None,
    passive: bool = False,
) -> UUID:
    """A game recorded as the API records an engine's result: per seat a player's account (or
    None for a bot), with its deck's name when given. `passive`: its bots were passive at some
    point (an administrator's testing switch), so its end counts for nothing."""
    game_id = uuid4()
    database_ = client.app.state.database  # type: ignore[attr-defined]
    owners = [seat[0] if isinstance(seat, tuple) else seat for seat in seats]
    with Session(database_) as db:
        db.add(
            Game(
                id=game_id,
                kind=kind,
                format=fmt,
                status="active",
                created_by=next(owner for owner in owners if owner is not None),
                created_at=utcnow() - timedelta(minutes=12),
                bot_skill=skill,
                turn_cap=60,
                passive_bots_used=passive,
            )
        )
        db.flush()
        for index, seat in enumerate(seats):
            owner, deck = seat if isinstance(seat, tuple) else (seat, "x")
            db.add(
                GameSeat(
                    game_id=game_id,
                    seat=index,
                    player="human" if owner else "bot",
                    user_id=owner,
                    deck=deck,
                    deck_revision_id=(revisions or {}).get(index),
                    left_at=utcnow() if (left or {}).get(index) else None,
                    left_reason=(left or {}).get(index),
                )
            )
        db.commit()
    games.record_end(database_, game_id, "finished", result)
    return game_id


def won(client: TestClient, user: Account, *, bots: int = 1, **options: Any) -> UUID:
    """A practice game the account won at seat 0, playing the red fixture deck."""
    return played(client, [(user.id, RED)] + [None] * bots, completed(0), **options)


def revision(client: TestClient, owner: UUID, fmt: str, cards: list[tuple[str, str]]) -> UUID:
    """A deck revision of the account's, holding the named cards at their locations."""
    now = utcnow()
    with database(client) as db:
        deck = Deck(
            owner_id=owner,
            title="Test deck",
            format=fmt,
            draft_hash="0" * 64,
            created_at=now,
            updated_at=now,
        )
        db.add(deck)
        db.flush()
        found = DeckRevision(
            deck_id=deck.id,
            number=3,
            format=fmt,
            title="Test deck",
            content_hash="0" * 64,
            legal=True,
            playable=True,
            created_at=now,
        )
        db.add(found)
        db.flush()
        for name, location in cards:
            db.add(
                DeckEntryRow(
                    revision_id=found.id,
                    concept_id=UUID(card_id(client, name)),
                    quantity=1,
                    location=location,
                )
            )
        db.commit()
        return found.id


def results(client: TestClient, game_id: UUID) -> list[tuple[int, str, str, int, int]]:
    with database(client) as db:
        return [
            (row.seat, row.outcome, row.colors, row.players, row.bots)
            for row in db.scalars(
                select(PlayerResult)
                .where(PlayerResult.game_id == game_id)
                .order_by(PlayerResult.seat)
            )
        ]


def entries(client: TestClient, user_id: UUID, kind: str) -> list[tuple[int, str, str | None]]:
    with database(client) as db:
        return [
            (row.amount, row.key, row.reason)
            for row in db.scalars(
                select(TokenEntry)
                .where(TokenEntry.user_id == user_id, TokenEntry.kind == kind)
                .order_by(TokenEntry.key)
            )
        ]


def earned(client: TestClient, user_id: UUID) -> set[str]:
    with database(client) as db:
        return set(
            db.scalars(
                select(PlayerAchievement.achievement).where(PlayerAchievement.user_id == user_id)
            )
        )


# Results and statistics.


def test_a_games_end_records_every_players_result(client):
    ada, bob = Account(client, "ada"), Account(client, "bob")
    table = played(client, [ada.id, bob.id, None], completed(0), kind="table", skill=3)
    assert results(client, table) == [(0, "win", "", 1, 1), (1, "loss", "", 1, 1)]
    # A replayed end writes nothing more: the game is no longer active.
    database_ = client.app.state.database  # type: ignore[attr-defined]
    games.record_end(database_, table, "finished", completed(0))
    with database(client) as db:
        awards.settle(db, db.get_one(Game, table))
        db.commit()
    assert len(results(client, table)) == 2
    turn_limit = {**completed(None), "kind": "turn_limit"}
    assert results(client, played(client, [ada.id, None], turn_limit))[0][1] == "no_result"
    assert results(client, played(client, [ada.id, None], {**turn_limit, "draw": True}))[0][1] == (
        "draw"
    )
    out = {**completed(None), "kind": "humans_eliminated"}
    assert results(client, played(client, [ada.id, None, None], out))[0][1] == "loss"
    # A seat that conceded while the table played on lost, however the game ended.
    left = played(client, [ada.id, bob.id], turn_limit, kind="table", left={1: "conceded"})
    assert [row[1] for row in results(client, left)] == ["no_result", "loss"]
    # The restart's sweep records its interrupted games with no result.
    with database(client) as db:
        db.add(
            Game(
                id=(stuck := uuid4()),
                format="legacy",
                status="active",
                created_by=ada.id,
                created_at=utcnow(),
                bot_skill=1,
                turn_cap=60,
            )
        )
        db.flush()
        db.add(GameSeat(game_id=stuck, seat=0, player="human", user_id=ada.id, deck="x"))
        db.add(GameSeat(game_id=stuck, seat=1, player="bot", deck="y"))
        db.commit()
    assert stuck in games.interrupt_active(database_)
    assert results(client, stuck) == [(0, "no_result", "", 0, 1)]

    stats = ada.get("/api/v1/me/stats").json()
    assert stats["totals"] == {
        "games": 6,
        "wins": 1,
        "losses": 1,
        "draws": 1,
        "no_result": 3,
    }
    assert [row["format"] for row in stats["formats"]] == ["commander", "legacy"]
    assert stats["formats"][1] == {
        "format": "legacy",
        "games": 1,
        "wins": 0,
        "losses": 0,
        "draws": 0,
        "no_result": 1,
    }
    assert stats["against_players"]["games"] == 2 and stats["against_bots"]["games"] == 4
    assert stats["history"] is True
    assert bob.get("/api/v1/me/stats").json()["totals"]["losses"] == 2


def test_a_decks_colours_are_the_ones_it_played(client):
    ada = Account(client, "ada")
    commander = revision(
        client,
        ada.id,
        "commander",
        [("Kenrith, the Returned King", "commander"), ("Lightning Bolt", "main")],
    )
    legacy = revision(
        client, ada.id, "legacy", [("Lightning Bolt", "main"), ("Counterspell", "main")]
    )
    game = played(client, [ada.id, None], completed(0), revisions={0: commander})
    assert results(client, game)[0][2] == "WUBRG"
    game = played(client, [ada.id, None], completed(0), fmt="legacy", revisions={0: legacy})
    assert results(client, game)[0][2] == "UR"
    game = played(client, [(ada.id, "legacy-mono-green-creatures"), None], completed(1))
    assert results(client, game)[0][1:3] == ("loss", "G")


def test_totals_are_public_and_the_history_is_its_players_and_sysops(client):
    ada, bob = Account(client, "ada"), Account(client, "bob")
    root = Account(client, "sysop", kind="sysop")
    deck = revision(client, ada.id, "commander", [("Kenrith, the Returned King", "commander")])
    first = played(
        client,
        [(ada.id, "Ada's secret"), (bob.id, "Bob's secret")],
        completed(1),
        kind="table",
        revisions={0: deck},
    )
    second = won(client, ada, bots=3, skill=5)

    seen = bob.get(f"/api/v1/players/{ada.id}/stats").json()
    assert seen["totals"]["games"] == 2 and seen["totals"]["wins"] == 1
    assert seen["history"] is False
    refused = bob.get(f"/api/v1/players/{ada.id}/history")
    assert (refused.status_code, refused.json()["code"]) == (403, "history_private")
    assert root.get(f"/api/v1/players/{ada.id}/stats").json()["history"] is True

    own = ada.get("/api/v1/me/history").json()
    assert [item["game_id"] for item in own["items"]] == [str(second), str(first)]
    assert own == root.get(f"/api/v1/players/{ada.id}/history").json()
    latest, earlier = own["items"]
    assert (latest["outcome"], latest["deck"], latest["colors"]) == ("win", RED, "R")
    assert [(seat["bot"], seat["bot_skill"]) for seat in latest["opponents"]] == [(True, 5)] * 3
    assert latest["seconds"] >= 12 * 60 and latest["turns"] == 9
    assert (earlier["outcome"], earlier["deck"], earlier["revision"]) == ("loss", "Ada's secret", 3)
    (opponent,) = earlier["opponents"]
    assert opponent["player"]["handle"] == "bob" and opponent["won"] is True
    # Another seat's deck is never named, to the player or to anyone.
    assert "Bob's secret" not in str(own) and "Ada's secret" not in str(
        bob.get("/api/v1/me/history").json()
    )
    # A page at a time.
    page = ada.get("/api/v1/me/history", limit=1).json()
    assert len(page["items"]) == 1 and page["next"]
    older = ada.get("/api/v1/me/history", limit=1, cursor=page["next"]).json()
    assert [item["game_id"] for item in older["items"]] == [str(first)] and older["next"] is None


# The quest boards (v0.9.5).


def daily(*ids: str) -> Callable[..., list[quest_pool.DailyQuest]]:
    """A daily draw of the named quests, one a step, in order, whatever the account's decks."""
    return lambda _user, _reach=None: [quest_pool.DAILY_BY_ID[found] for found in ids]


def weekly(*ids: str) -> Callable[[Any], list[quest_pool.WeeklyGoal]]:
    """A weekly draw of the named goals first, then other families' to make twenty."""
    named = [quest_pool.WEEKLY_BY_ID[found] for found in ids]

    def choose(available: Any) -> list[quest_pool.WeeklyGoal]:
        families = {goal.family for goal in named}
        rest = [
            goal
            for goal in quest_pool.WEEKLY
            if goal.family not in families
            and goal.tier == "hard"
            and goal.metric not in ("wins", "games", "table_games")
            and available(goal)
            and not families.add(goal.family)  # type: ignore[func-returns-value]
        ]
        return (named + rest)[: quest_pool.WEEKLY_GOALS]

    return choose


EASY_DAY = ("d1-win", "d2-mono", "d3-skill-4", "d4-skill-5", "d5-skill-6")
RED_DAY = ("d1-win", "d2-colour-red", "d3-skill-4", "d4-skill-5", "d5-skill-6")


def board_rows(client: TestClient, user_id: UUID, board: str) -> list[DailyQuest]:
    with database(client) as db:
        return list(
            db.scalars(
                select(DailyQuest)
                .where(DailyQuest.user_id == user_id, DailyQuest.board == board)
                .order_by(DailyQuest.day, DailyQuest.slot)
            )
        )


def test_the_boards_are_drawn_once_and_stay(client):
    ada = Account(client, "ada")
    first = ada.get("/api/v1/me/quests").json()
    day, week = first["daily"], first["weekly"]
    assert first["paid"] == 0
    assert [quest["step"] for quest in day["quests"]] == [1, 2, 3, 4, 5]
    assert [quest["tokens"] for quest in day["quests"]] == [150, 250, 350, 500, 750]
    families = {quest_pool.DAILY_BY_ID[quest["id"]].family for quest in day["quests"]}
    assert len(families) == 5 and all(quest["in_game"] for quest in day["quests"])
    assert len(week["quests"]) == 20 and [q["slot"] for q in week["quests"]] == list(range(20))
    goals = [quest_pool.WEEKLY_BY_ID[quest["id"]] for quest in week["quests"]]
    assert len({goal.family for goal in goals}) == 20
    assert sum(1 for goal in goals if goal.in_game) == 6
    tiers = [quest["tier"] for quest in week["quests"]]
    assert (tiers.count("easy"), tiers.count("medium"), tiers.count("hard")) == (6, 9, 5)
    assert {quest["tokens"] for quest in week["quests"]} == {250, 400, 650}
    assert day["streak"] == {"current": 0, "bonus": 400, "next_bonus": 500, "best": 0}
    assert week["streak"] == {"current": 0, "bonus": 2_000, "next_bonus": 2_200, "best": 0}
    assert ada.get("/api/v1/me/quests").json() == first
    resets = datetime.fromisoformat(day["resets_at"])
    assert resets.astimezone(quests.ARIZONA).time().isoformat() == "00:00:00"
    weekly_resets = datetime.fromisoformat(week["resets_at"]).astimezone(quests.ARIZONA)
    # Sunday's midnight, as the weekly sale's.
    assert weekly_resets.weekday() == 6 and weekly_resets.time().isoformat() == "00:00:00"
    assert date.fromisoformat(week["period"]).weekday() == 6
    # No swap any more.
    assert ada.send("POST", "/api/v1/me/quests/0/swap").status_code in (404, 405)


def test_the_pools_are_large_and_every_goal_is_for_one_player():
    assert len(quest_pool.DAILY) >= 50
    assert all(sum(1 for q in quest_pool.DAILY if q.step == step) >= 10 for step in range(1, 6))
    assert len(quest_pool.WEEKLY) >= 200
    # Nothing asks for another player at the table, a friend or a buyer.
    for quest in (*quest_pool.DAILY, *quest_pool.WEEKLY):
        assert not quest.rule.against_players and len(quest.id) <= 48
    assert {goal.metric for goal in quest_pool.WEEKLY} >= {
        "packs_bought",
        "listings",
        "auctions_won",
        "decks_built",
        "pulls",
        "campaign_wins",
        "sleeves",
    }
    in_game = {goal.family for goal in quest_pool.WEEKLY if goal.in_game}
    outside = {goal.family for goal in quest_pool.WEEKLY if not goal.in_game}
    assert len(in_game) >= 6 and len(outside) >= 14


def test_the_day_and_the_week_are_arizonas():
    # 06:59 UTC is still the day before in Arizona, which keeps one offset all year.
    assert quests.day_of(datetime(2026, 7, 2, 6, 59, tzinfo=UTC)) == date(2026, 7, 1)
    assert quests.day_of(datetime(2026, 7, 2, 7, 0, tzinfo=UTC)) == date(2026, 7, 2)
    # Sunday 2026-11-15 begins at 07:00 UTC.
    assert quests.period_of("weekly", datetime(2026, 11, 15, 6, 59, tzinfo=UTC))[0] == date(
        2026, 11, 8
    )
    assert quests.period_of("weekly", datetime(2026, 11, 15, 7, 0, tzinfo=UTC))[0] == date(
        2026, 11, 15
    )


def test_the_bonuses_grow_with_the_streak_to_their_caps():
    assert [quests.bonus_for("daily", n) for n in (1, 2, 7, 8, 30)] == [
        400,
        500,
        1_000,
        1_000,
        1_000,
    ]
    assert [quests.bonus_for("weekly", n) for n in (1, 2, 16, 17)] == [2_000, 2_200, 5_000, 5_000]


def test_a_win_completes_quests_and_pays_once(client, monkeypatch):
    monkeypatch.setattr(quests, "choose_daily", daily(*EASY_DAY))
    monkeypatch.setattr(quests, "choose_weekly", weekly("w-wins-3", "w-colour-red-2"))
    ada = Account(client, "ada")
    shown = ada.get("/api/v1/me/quests").json()
    assert [quest["id"] for quest in shown["daily"]["quests"]] == list(EASY_DAY)
    game = won(client, ada, skill=4)
    shown = ada.get("/api/v1/me/quests").json()
    assert shown["paid"] == 0
    assert [q["completed_at"] is not None for q in shown["daily"]["quests"]] == [
        True,
        True,
        True,
        False,
        False,
    ]
    day = shown["daily"]["period"]
    paid = entries(client, ada.id, "quest")
    assert (150, f"daily:{ada.id}:{day}:d1-win", "Win a game") in paid
    assert sum(amount for amount, _, _ in paid) == 150 + 250 + 350
    weekly_view = {q["id"]: q for q in shown["weekly"]["quests"]}
    assert weekly_view["w-wins-3"]["progress"] == 1
    assert weekly_view["w-colour-red-2"]["progress"] == 1
    # A replayed end, a second look or a second settling pays nothing more.
    database_ = client.app.state.database  # type: ignore[attr-defined]
    games.record_end(database_, game, "finished", completed(0))
    with database(client) as db:
        awards.settle(db, db.get_one(Game, game))
        db.commit()
    ada.get("/api/v1/me/quests")
    assert len(entries(client, ada.id, "quest")) == 3
    # The bell says so, with what each paid.
    bell = ada.get("/api/v1/notifications", limit=50).json()["items"]
    told = [item["award"] for item in bell if item["kind"] == "quest_completed"]
    assert {"id": "d1-win", "name": "Win a game", "tokens": 150} in told
    assert len(told) == 3


def test_a_full_board_pays_its_bonus_and_its_streak(client, monkeypatch):
    monkeypatch.setattr(quests, "choose_daily", daily(*EASY_DAY))
    ada = Account(client, "ada")
    now = utcnow()
    today = quests.day_of(now)
    # Yesterday's board finished with a streak of six: today's is the seventh, 1,000 tokens.
    with database(client) as db:
        db.add(
            QuestBoard(
                user_id=ada.id,
                board="daily",
                period=today - timedelta(days=1),
                key=f"board:{ada.id}:daily:old",
                streak=6,
                bonus=900,
                policy="quests-v2",
                completed_at=now - timedelta(days=1),
            )
        )
        db.commit()
    shown = ada.get("/api/v1/me/quests").json()["daily"]
    assert shown["streak"] == {"current": 6, "bonus": 1_000, "next_bonus": 1_000, "best": 6}
    won(client, ada, skill=6)
    shown = ada.get("/api/v1/me/quests").json()["daily"]
    assert shown["completed_at"] is not None
    assert shown["streak"]["current"] == 7 and shown["streak"]["bonus"] == 1_000
    bonus = [entry for entry in entries(client, ada.id, "quest") if entry[1].startswith("board:")]
    assert bonus == [
        (1_000, f"board:{ada.id}:daily:{today.isoformat()}", "Daily board complete (streak 7)")
    ]
    bell = ada.get("/api/v1/notifications", limit=50).json()["items"]
    assert {"id": "board-daily:1000", "name": "Daily board complete", "tokens": 1_000} in [
        item["award"] for item in bell if item["kind"] == "quest_completed"
    ]
    # Settling again pays nothing more; the board row is unique to its period.
    with database(client) as db:
        user = db.get_one(User, ada.id)
        rows = quests.assigned(db, user, "daily", today)
        assert quests.settle(db, user, "daily", rows, utcnow()) == 0
        db.commit()


def test_a_broken_streak_starts_over(client, monkeypatch):
    monkeypatch.setattr(quests, "choose_daily", daily(*EASY_DAY))
    ada = Account(client, "ada")
    now = utcnow()
    today = quests.day_of(now)
    with database(client) as db:
        # Two days ago, not yesterday.
        db.add(
            QuestBoard(
                user_id=ada.id,
                board="daily",
                period=today - timedelta(days=2),
                key=f"board:{ada.id}:daily:older",
                streak=5,
                bonus=800,
                policy="quests-v2",
                completed_at=now - timedelta(days=2),
            )
        )
        db.commit()
    won(client, ada, skill=6)
    shown = ada.get("/api/v1/me/quests").json()["daily"]
    assert shown["streak"] == {"current": 1, "bonus": 400, "next_bonus": 500, "best": 5}


def test_a_loss_counts_for_games_played(client, monkeypatch):
    monkeypatch.setattr(
        quests, "choose_daily", daily("d1-play-2", "d2-win-2", "d3-win-3", "d4-win-4", "d5-win-5")
    )
    ada = Account(client, "ada")
    ada.get("/api/v1/me/quests")
    played(client, [ada.id, None], completed(1))
    played(client, [ada.id, None], completed(1))
    shown = ada.get("/api/v1/me/quests").json()["daily"]["quests"]
    assert shown[0]["completed_at"] is not None and shown[1]["progress"] == 0


OWNERS_DAY = (
    "d1-colour-black",
    "d2-two-headed",
    "d3-play-5",
    "d4-commander-3",
    "d5-four-players",
)


def test_the_days_quests_complete_in_any_order(client, monkeypatch):
    """The owner's report (v0.9.7): the day's five are no steps to climb. The hardest completes
    and pays while the four before it are open, and an easier one completes after it."""
    monkeypatch.setattr(quests, "choose_daily", daily(*OWNERS_DAY))
    ada = Account(client, "ada")
    day = ada.get("/api/v1/me/quests").json()["daily"]["period"]
    won(client, ada, bots=3, skill=6)
    shown = ada.get("/api/v1/me/quests").json()["daily"]
    assert [quest["completed_at"] is not None for quest in shown["quests"]] == [
        False,
        False,
        False,
        False,
        True,
    ]
    assert [quest["progress"] for quest in shown["quests"]] == [0, 0, 1, 1, 1]
    assert shown["completed_at"] is None
    name = "Win a four-player Commander game against skill-6 bots"
    # The day's payments alone: the week's board is drawn at random, and may count the game too.
    paid = [entry for entry in entries(client, ada.id, "quest") if entry[1].startswith("daily:")]
    assert paid == [(750, f"daily:{ada.id}:{day}:d5-four-players", name)]
    # The third after the fifth, the second and the first still open.
    for _ in range(4):
        played(client, [ada.id, None], completed(1))
    shown = ada.get("/api/v1/me/quests").json()["daily"]["quests"]
    assert [quest["completed_at"] is not None for quest in shown] == [
        False,
        False,
        True,
        False,
        True,
    ]


def test_a_game_with_passive_bots_counts_for_no_quest_and_says_so(client, monkeypatch):
    """What the owner met (v0.9.7): a game whose bots were passive, an administrator's testing
    switch, gives no result, so it completes no quest; the game says it is not counted, to its
    own player only."""
    monkeypatch.setattr(quests, "choose_daily", daily(*OWNERS_DAY))
    ada, bob = Account(client, "ada"), Account(client, "bob")
    ada.get("/api/v1/me/quests")
    game = won(client, ada, bots=3, skill=6, passive=True)
    assert results(client, game) == []
    shown = ada.get("/api/v1/me/quests").json()
    assert shown["paid"] == 0
    assert [quest["progress"] for quest in shown["daily"]["quests"]] == [0, 0, 0, 0, 0]
    assert entries(client, ada.id, "quest") == []
    assert ada.get(f"/api/v1/games/{game}").json()["game"]["uncounted"] is True
    # The same game without the switch counts, and says nothing.
    counted = won(client, ada, bots=3, skill=6)
    assert ada.get(f"/api/v1/games/{counted}").json()["game"]["uncounted"] is False
    assert ada.get("/api/v1/me/quests").json()["daily"]["quests"][4]["completed_at"] is not None
    # Another player is told nothing about a game that is not theirs to see.
    assert bob.get(f"/api/v1/games/{game}").status_code in (403, 404)


def test_the_old_quests_stay_and_the_board_replaces_them(client):
    ada = Account(client, "ada")
    now = utcnow()
    today = quests.day_of(now)
    with database(client) as db:
        db.add(
            DailyQuest(
                user_id=ada.id,
                day=today,
                board="daily",
                slot=0,
                key=f"quest-slot:{ada.id}:{today.isoformat()}:0",
                quest="win",
                tokens=100,
                target=1,
                counts_from=now,
                policy="quests-v1",
                created_at=now,
                completed_at=now,
            )
        )
        db.commit()
    shown = ada.get("/api/v1/me/quests").json()["daily"]
    assert len(shown["quests"]) == 5
    assert len(board_rows(client, ada.id, "daily")) == 6


def pack_product(client: TestClient, released: date = date(2025, 1, 1)) -> UUID:
    with database(client) as db:
        product = ShopProduct(
            set_code=f"Q{uuid4().hex[:6]}",
            booster="play",
            set_name="Quest Set",
            name="Quest Set Play Booster",
            released=released,
            origin="price_list",
            data_status="ready",
            collation_id=uuid4(),
            created_at=utcnow(),
            updated_at=utcnow(),
        )
        db.add(product)
        db.commit()
        return product.id


def test_weekly_goals_count_what_the_server_records(client, monkeypatch):
    monkeypatch.setattr(
        quests,
        "choose_weekly",
        weekly(
            "w-buy-packs-3",
            "w-sale-packs-1",
            "w-list-3",
            "w-win-auctions-1",
            "w-decks-1",
            "w-spend-500",
        ),
    )
    ada, bob = Account(client, "ada"), Account(client, "bob")
    ada.get("/api/v1/me/quests")
    product = pack_product(client)
    printing, concept = card_printing(client)
    now = utcnow()
    with database(client) as db:
        for index in range(3):
            db.add(
                Pack(
                    user_id=ada.id,
                    product_id=product,
                    source="purchase",
                    tokens=200,
                    request_key=f"k{index}",
                    sale=index == 0,
                    created_at=now,
                )
            )
            db.add(
                TokenEntry(
                    user_id=ada.id,
                    kind="pack",
                    amount=-200,
                    key=f"pack:test:{index}",
                    policy="test",
                    created_at=now,
                )
            )
        # A pack given counts for nothing.
        db.add(
            Pack(
                user_id=ada.id,
                product_id=product,
                source="grant",
                tokens=0,
                actor_id=bob.id,
                created_at=now,
            )
        )

        def listing(seller: UUID, **kw: Any) -> Auction:
            values: dict[str, Any] = {
                "seller_id": seller,
                "concept_id": concept,
                "printing_id": printing,
                "finish": "nonfoil",
                "starting_bid": 100,
                "duration": "24h",
                "request_key": uuid4().hex,
                "created_at": now - timedelta(hours=2),
                "ends_at": now + timedelta(hours=22),
            } | kw
            auction = Auction(**values)
            db.add(auction)
            return auction

        # Up two hours: counts. Withdrawn after ten minutes: not. Sold at once: counts.
        listing(ada.id)
        listing(
            ada.id,
            status="withdrawn",
            created_at=now - timedelta(minutes=30),
            ended_at=now - timedelta(minutes=20),
        )
        listing(
            ada.id,
            status="sold",
            buyer_id=bob.id,
            sold_price=100,
            created_at=now - timedelta(minutes=5),
            ended_at=now - timedelta(minutes=4),
        )
        # Won from Bob above the minimum.
        listing(
            bob.id,
            status="sold",
            buyer_id=ada.id,
            sold_price=60,
            created_at=now - timedelta(hours=3),
            ended_at=now - timedelta(minutes=1),
        )
        # A deck legal and complete, made two days ago: it lasted a day, this week.
        made = now - timedelta(days=1, minutes=5)
        week_start = quests.period_of("weekly", now)[1]
        db.add(
            Deck(
                owner_id=ada.id,
                title="Made",
                format="legacy",
                draft={},
                draft_hash="",
                card_count=60,
                legal=True,
                created_at=max(made, week_start - timedelta(days=1)),
                updated_at=now,
            )
        )
        db.commit()
    shown = {q["id"]: q for q in ada.get("/api/v1/me/quests").json()["weekly"]["quests"]}
    assert shown["w-buy-packs-3"]["completed_at"] is not None
    assert shown["w-sale-packs-1"]["completed_at"] is not None
    assert shown["w-spend-500"]["completed_at"] is not None
    assert shown["w-list-3"]["progress"] == 2
    assert shown["w-win-auctions-1"]["completed_at"] is not None
    assert shown["w-decks-1"]["completed_at"] is not None
    keys = [key for _, key, _ in entries(client, ada.id, "quest")]
    week = quests.period_of("weekly", now)[0].isoformat()
    assert f"weekly:{ada.id}:{week}:w-buy-packs-3" in keys


def own_deck(client: TestClient, owner: UUID, fmt: str, identity: str, **kw: Any) -> None:
    """A deck of the account's, playable unless told otherwise, of the format and colours."""
    now = utcnow()
    values: dict[str, Any] = {
        "owner_id": owner,
        "title": f"{identity} {fmt}",
        "format": fmt,
        "draft": {},
        "draft_hash": "",
        "card_count": 100 if fmt == "commander" else 60,
        "legal": True,
        "playable": True,
        "identity": identity,
        "created_at": now,
        "updated_at": now,
    } | kw
    with database(client) as db:
        db.add(Deck(**values))
        db.commit()


def test_quests_ask_only_for_wins_the_accounts_own_decks_can_bring(client):
    """v0.9.7: players play their own decks alone, so a quest for a win with a red deck, or in
    Legacy, is drawn only for an account with a playable deck of it. The owner's board asked
    for a win with a red deck of an account whose every game was a black deck's."""
    rule = quests.Rule
    ada, root = Account(client, "ada"), Account(client, "sysop", kind="sysop")
    with database(client) as db:
        # No playable deck yet: nothing says what the account will build, so anything is asked.
        reach = quests.reach_of(db, db.get_one(User, ada.id))
        assert reach(rule(color="R")) and reach(rule(format="legacy", colors_at_least=5))
    own_deck(client, ada.id, "commander", "B")
    # Decks that cannot be played, or are put away, open nothing.
    own_deck(client, ada.id, "legacy", "RG", playable=False)
    own_deck(client, ada.id, "legacy", "WU", deleted_at=utcnow())
    own_deck(client, ada.id, "legacy", "WUBRG", archived_at=utcnow())
    within = [
        rule(),
        rule(skill_at_least=6),
        rule(color="B"),
        rule(mono=True),
        rule(format="commander", color="B"),
        rule(format="commander", seats=4, skill_at_least=6),
        rule(format="kings_table", skill_at_least=5),
    ]
    beyond = [
        rule(color="R"),
        rule(format="legacy"),
        rule(format="two_headed_giant"),
        rule(format="legacy", color="B"),
        rule(colors_at_least=2),
        rule(colors_at_least=5),
    ]
    with database(client) as db:
        user = db.get_one(User, ada.id)
        reach = quests.reach_of(db, user)
        assert all(reach(found) for found in within)
        assert not any(reach(found) for found in beyond)
        available = quests.weekly_available(db, user, utcnow())
        seen: set[str] = set()
        for _ in range(80):
            day = quests.choose_daily(user, reach)
            assert [quest.step for quest in day] == [1, 2, 3, 4, 5]
            assert len({quest.family for quest in day}) == 5
            assert all(reach(quest.rule) for quest in day)
            week = quests.choose_weekly(available)
            assert len({goal.family for goal in week}) == quest_pool.WEEKLY_GOALS
            assert sum(goal.in_game for goal in week) == quest_pool.WEEKLY_IN_GAME
            assert all(reach(goal.rule) for goal in week if goal.metric == "wins")
            seen |= {quest.family for quest in day} | {goal.family for goal in week}
        # The black deck's own quests are still drawn, and the games' goals of any deck.
        assert {"colour-black", "mono", "commander", "kings-table", "tables"} <= seen
        assert not seen & {"colour-red", "legacy", "two-headed", "five-colours", "multicolour"}
        # SysOp plays any deck: the fixture decks and deck lists are its own.
        assert quests.reach_of(db, db.get_one(User, root.id))(rule(colors_at_least=5))
    # A red and green Legacy deck opens Legacy, Two-Headed Giant and both colours.
    own_deck(client, ada.id, "legacy", "RG")
    with database(client) as db:
        reach = quests.reach_of(db, db.get_one(User, ada.id))
        assert all(
            reach(found)
            for found in (
                rule(color="R"),
                rule(format="two_headed_giant", skill_at_least=4),
                rule(format="legacy", color="G"),
                rule(colors_at_least=2),
            )
        )
        assert not reach(rule(colors_at_least=3))
        assert not reach(rule(format="commander", color="R"))
    # The route draws the day's board from them.
    shown = ada.get("/api/v1/me/quests").json()
    with database(client) as db:
        reach = quests.reach_of(db, db.get_one(User, ada.id))
        for quest in shown["daily"]["quests"]:
            assert reach(quest_pool.DAILY_BY_ID[quest["id"]].rule), quest


def test_auction_goals_are_drawn_only_while_the_market_can_supply_them(client):
    """v0.9.7: every weekly goal is one player's to finish, so a goal that needs other accounts'
    auctions is left out of the draw while the market does not hold twice what it asks for. The
    live site's board asked for three bids with not one auction to bid on."""
    ada, bob = Account(client, "ada"), Account(client, "bob")
    printing, concept = card_printing(client)
    now = utcnow()
    goals = quest_pool.WEEKLY_BY_ID

    def open_to(*ids: str) -> list[bool]:
        with database(client) as db:
            available = quests.weekly_available(db, db.get_one(User, ada.id), now)
            return [available(goals[found]) for found in ids]

    def listing(seller: UUID, **kw: Any) -> None:
        values: dict[str, Any] = {
            "seller_id": seller,
            "concept_id": concept,
            "printing_id": printing,
            "finish": "nonfoil",
            "starting_bid": 100,
            "duration": "3d",
            "request_key": uuid4().hex,
            "created_at": now,
            "ends_at": now + timedelta(days=3),
        } | kw
        with database(client) as db:
            db.add(Auction(**values))
            db.commit()

    def unlimited(seller: UUID, price: int) -> None:
        listing(seller, duration="unlimited", ends_at=None, buy_now=price, starting_bid=price)

    wanted = ("w-win-auctions-1", "w-win-auctions-2", "w-bids-1", "w-bids-3")
    # An empty market, and one holding only the account's own auctions: none of them.
    assert open_to(*wanted, "w-wins-3", "w-sleeve-1") == [False] * 4 + [True, True]
    for _ in range(6):
        listing(ada.id)
    assert open_to(*wanted) == [False, False, False, False]
    # One listing to buy is not twice one; a Buy Now under 50 tokens never counts as won.
    unlimited(bob.id, 300)
    unlimited(bob.id, 20)
    assert open_to(*wanted) == [False, False, False, False]
    # A second to win, which is also the first to bid on.
    listing(bob.id)
    assert open_to(*wanted) == [True, False, False, False]
    # One about to end is no auction to plan a week's bids on; one over the weekend is.
    listing(bob.id, duration="1h", ends_at=now + timedelta(hours=1))
    assert open_to(*wanted) == [True, False, False, False]
    listing(bob.id)
    assert open_to(*wanted) == [True, True, True, False]
    # An ended auction, sold or still waiting to be settled, is no part of the market.
    listing(bob.id, ends_at=now - timedelta(minutes=1), created_at=now - timedelta(days=3))
    listing(bob.id, status="withdrawn", ended_at=now)
    assert open_to(*wanted) == [True, True, True, False]

    # With an empty market no draw asks for either, and the board is still twenty of twenty
    # families at its tiers.
    with database(client) as db:
        db.execute(text("DELETE FROM auctions"))
        db.commit()
        available = quests.weekly_available(db, db.get_one(User, ada.id), now)
        for _ in range(60):
            chosen = quests.choose_weekly(available)
            assert not {goal.metric for goal in chosen} & {"auctions_won", "bids"}
            assert len({goal.family for goal in chosen}) == quest_pool.WEEKLY_GOALS
            assert sum(goal.in_game for goal in chosen) == quest_pool.WEEKLY_IN_GAME


def card_printing(client: TestClient) -> tuple[UUID, UUID]:
    with database(client) as db:
        found = db.execute(select(CardPrinting.id, CardPrinting.concept_id).limit(1)).first()
    if found is None:
        pytest.skip("No catalog loaded")
    return found[0], found[1]


def test_the_back_pay_raises_earned_achievements_once(tmp_path, monkeypatch):
    """Migration 0041 pays the difference for achievements earned before v0.9.5, once."""
    database_url = f"sqlite:///{tmp_path}/raise.db"
    monkeypatch.setenv("CD_DATABASE_URL", database_url)
    config = Config("alembic.ini")
    command.upgrade(config, "0040_decks_purged")
    database_ = create_engine(database_url)
    ada, cleo = uuid4(), uuid4()
    with database_.begin() as connection:
        for user, handle, reset in ((ada, "ada", None), (cleo, "cleo", "2026-10-05 00:00:00")):
            connection.execute(
                text(
                    "INSERT INTO users (id, normalized_handle, handle, display_name, kind, "
                    "status, onboarding, avatar, locale, preferences, privilege_version, "
                    "created_at, presence_visibility, appear_offline, email_searchable, reset_at) "
                    "VALUES (:id, :h, :h, :h, 'player', 'active', 'complete', 'sigil', 'en', "
                    "'{}', 0, :now, 'friends', 0, 1, :reset)"
                ),
                {"id": user.hex, "h": handle, "now": "2026-10-01 00:00:00", "reset": reset},
            )
        for user, achievement, tokens in (
            (ada, "first-win", 100),
            (ada, "wins-10", 200),
            (cleo, "first-win", 100),
        ):
            connection.execute(
                text(
                    "INSERT INTO player_achievements (id, user_id, achievement, version, key, "
                    "tokens, earned_at) VALUES (:id, :user, :a, 1, :key, :tokens, :at)"
                ),
                {
                    "id": uuid4().hex,
                    "user": user.hex,
                    "a": achievement,
                    "key": f"achievement:{user}:{achievement}",
                    "tokens": tokens,
                    "at": "2026-10-02 00:00:00",
                },
            )
    command.upgrade(config, "head")
    with database_.connect() as connection:
        rows = connection.execute(
            text("SELECT user_id, amount, key, reason FROM token_ledger ORDER BY amount")
        ).all()
    # Cleo's was earned before her reset: it no longer counts, so it is not raised.
    assert [(row[1], row[2], row[3]) for row in rows] == [
        (
            300,
            f"achievement-raise:achievement:{ada}:first-win",
            "First Victory: reward raised to 400 tokens",
        ),
        (
            600,
            f"achievement-raise:achievement:{ada}:wins-10",
            "Seasoned Planeswalker: reward raised to 800 tokens",
        ),
    ]
    command.downgrade(config, "0040_decks_purged")
    command.upgrade(config, "head")
    with database_.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM token_ledger")).scalar() == 2
    database_.dispose()


# Achievements.


def test_achievements_are_earned_once_and_paid_once(client):
    ada = Account(client, "ada")
    game = won(client, ada, bots=3, skill=6)
    expected = {
        "first-win",
        "commander-win",
        "commander-four",
        "win-red",
        "beat-skill-4",
        "beat-skill-6",
    }
    assert earned(client, ada.id) == expected
    paid = entries(client, ada.id, "achievement")
    assert sum(amount for amount, _, _ in paid) == sum(
        achievements.BY_ID[found].tokens for found in expected
    )
    assert (400, f"achievement:{ada.id}:first-win", "First Victory") in paid
    database_ = client.app.state.database  # type: ignore[attr-defined]
    games.record_end(database_, game, "finished", completed(0))
    with database(client) as db:
        awards.settle(db, db.get_one(Game, game))
        achievements.catch_up(db, db.get_one(User, ada.id), utcnow())
        db.commit()
    shown = ada.get("/api/v1/me/achievements").json()
    assert shown["paid"] == 0 and shown["earned"] == len(expected)
    assert len(entries(client, ada.id, "achievement")) == len(expected)
    views = {item["id"]: item for item in shown["achievements"]}
    assert len(views) == len(achievements.ACHIEVEMENTS)
    assert views["wins-10"]["progress"] == 1 and views["wins-10"]["earned_at"] is None
    assert views["commander-four"]["addition"] is True and views["first-win"]["addition"] is False
    bell = ada.get("/api/v1/notifications", limit=50).json()["items"]
    assert {item["award"]["id"] for item in bell if item["kind"] == "achievement_earned"} == (
        expected
    )
    # Losing earns nothing.
    bob = Account(client, "bob")
    played(client, [bob.id, None], completed(1))
    assert earned(client, bob.id) == set()


def test_every_achievement_is_reachable_and_modest():
    assert 30 <= len(achievements.ACHIEVEMENTS) <= 40
    assert len(achievements.BY_ID) == len(achievements.ACHIEVEMENTS)
    # Four times v0.5.0's rewards since v0.9.5 (the owner's word): First Victory 400.
    assert achievements.BY_ID["first-win"].tokens == 400
    assert achievements.BY_ID["wins-10"].tokens == 800
    for found in achievements.ACHIEVEMENTS:
        assert 400 <= found.tokens <= 4_000 and found.target >= 1 and found.version >= 1
        assert len(found.id) <= 48
    additions = {found.group for found in achievements.ACHIEVEMENTS if found.addition}
    assert additions == {"commander", "legacy"}


def test_badges_are_pinned_and_shown_on_the_profile(client):
    ada, bob = Account(client, "ada"), Account(client, "bob")
    won(client, ada, bots=3, skill=6)
    pins = {"achievements": ["beat-skill-6", "first-win"]}
    pinned = ada.send("PUT", "/api/v1/me/achievements/pinned", pins).json()
    assert {item["id"]: item["pin"] for item in pinned["achievements"] if item["pin"]} == {
        "beat-skill-6": 1,
        "first-win": 2,
    }
    profile = bob.get(f"/api/v1/players/{ada.id}/achievements").json()
    assert [badge["id"] for badge in profile["pinned"]] == ["beat-skill-6", "first-win"]
    assert len(profile["earned"]) == 6 and profile["total"] == len(achievements.ACHIEVEMENTS)
    # Pinning again replaces the pins; nothing unpins all.
    ada.send("PUT", "/api/v1/me/achievements/pinned", {"achievements": ["win-red"]})
    assert [
        badge["id"] for badge in ada.get(f"/api/v1/players/{ada.id}/achievements").json()["pinned"]
    ] == ["win-red"]
    for body, code in (
        ({"achievements": ["wins-1000"]}, "not_earned"),
        ({"achievements": ["first-win", "first-win"]}, "invalid_request"),
        ({"achievements": ["first-win", "win-red", "beat-skill-4", "beat-skill-6"]}, None),
    ):
        refused = ada.send("PUT", "/api/v1/me/achievements/pinned", body)
        assert refused.status_code == 422
        if code:
            assert refused.json()["code"] == code
    ada.send("PUT", "/api/v1/me/achievements/pinned", {"achievements": []})
    assert bob.get(f"/api/v1/players/{ada.id}/achievements").json()["pinned"] == []


def test_packs_quests_and_friends_count_at_the_next_look(client, monkeypatch):
    monkeypatch.setattr(quests, "choose_daily", daily(*EASY_DAY))
    ada, bob = Account(client, "ada"), Account(client, "bob")
    now = utcnow()
    with database(client) as db:
        low, high = sorted((ada.id, bob.id))
        db.add(
            Friendship(
                user_low=low,
                user_high=high,
                requested_by=ada.id,
                status="accepted",
                created_at=now,
                accepted_at=now,
            )
        )
        db.add(
            PackOpening(
                pack_id=uuid4(),
                user_id=ada.id,
                product_id=uuid4(),
                collation_id=uuid4(),
                layout=0,
                created_at=now,
            )
        )
        db.commit()
    ada.get("/api/v1/me/quests")
    won(client, ada)
    assert {"friend-1", "pack-1", "quest-1", "first-win"} <= earned(client, ada.id)
    # Bob made a friend too: he earns it when he looks.
    assert earned(client, bob.id) == set()
    assert bob.get("/api/v1/me/achievements").json()["paid"] == 400
    assert earned(client, bob.id) == {"friend-1"}


def test_a_history_from_before_achievements_earns_them_at_the_first_look(tmp_path, monkeypatch):
    """Migration 0021 enters the games already played as results and pays nothing; the first
    check earns what they qualify for. Going back keeps what was paid, as grants."""
    database_url = f"sqlite:///{tmp_path}/history.db"
    monkeypatch.setenv("CD_DATABASE_URL", database_url)
    config = Config("alembic.ini")
    command.upgrade(config, "0020_account_reset")
    database_ = create_engine(database_url)
    ada, game_id = uuid4(), uuid4()
    with database_.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO users (id, normalized_handle, handle, display_name, kind, status, "
                "onboarding, avatar, locale, preferences, privilege_version, created_at, "
                "presence_visibility, appear_offline, email_searchable) VALUES (:id, 'ada', "
                "'ada', 'Ada', 'player', 'active', 'complete', 'sigil', 'en', '{}', 0, :now, "
                "'friends', 0, 1)"
            ),
            {"id": ada.hex, "now": "2026-10-01 00:00:00.000000"},
        )
        connection.execute(
            text(
                "INSERT INTO games (id, kind, format, status, created_by, created_at, "
                "finished_at, bot_skill, turn_cap, result) VALUES (:id, 'practice', 'legacy', "
                "'finished', :owner, :start, :end, 4, 60, :result)"
            ),
            {
                "id": game_id.hex,
                "owner": ada.hex,
                "start": "2026-10-01 12:00:00.000000",
                "end": "2026-10-01 12:20:00.000000",
                "result": '{"kind": "completed", "winner_seat": 0, "draw": false, "turns": 7, '
                '"conceded_seats": []}',
            },
        )
        for seat, player, owner, deck in (
            (0, "human", ada.hex, "legacy-mono-red-burn"),
            (1, "bot", None, "legacy-mono-green-creatures"),
        ):
            connection.execute(
                text(
                    "INSERT INTO game_seats (id, game_id, seat, player, user_id, deck) VALUES "
                    "(:id, :game, :seat, :player, :owner, :deck)"
                ),
                {
                    "id": uuid4().hex,
                    "game": game_id.hex,
                    "seat": seat,
                    "player": player,
                    "owner": owner,
                    "deck": deck,
                },
            )
    command.upgrade(config, "head")
    with Session(database_) as db:
        (row,) = db.scalars(select(PlayerResult))
        assert (row.user_id, row.outcome, row.format, row.colors, row.turns) == (
            ada,
            "win",
            "legacy",
            "R",
            7,
        )
        assert (row.bots, row.bot_skill, row.players, row.policy) == (1, 4, 0, "results-v1")
        assert db.scalars(select(TokenEntry.kind)).all() == []
        paid = achievements.catch_up(db, db.get_one(User, ada), utcnow())
        db.commit()
        assert paid == sum(
            achievements.BY_ID[found].tokens
            for found in ("first-win", "legacy-win", "win-red", "beat-skill-4")
        )
        assert db.scalar(select(Notification.subject).limit(1)) is not None
    command.downgrade(config, "0020_account_reset")
    with database_.connect() as connection:
        kinds = connection.execute(text("SELECT DISTINCT kind FROM token_ledger")).scalars()
        assert set(kinds) == {"grant"}
    command.upgrade(config, "head")
    with Session(database_) as db:
        # Earned again after going back and up, but paid once: the ledger keeps the keys.
        assert achievements.catch_up(db, db.get_one(User, ada), utcnow()) == 0
        db.commit()
    database_.dispose()


# The reset and deletion.


def test_a_reset_starts_quests_achievements_and_statistics_again(client, monkeypatch):
    monkeypatch.setattr(quests, "choose_daily", daily(*RED_DAY))
    ada = Account(client, "ada")
    root = Account(client, "sysop", kind="sysop")
    ada.get("/api/v1/me/quests")
    won(client, ada)
    pins = {"achievements": ["first-win"]}
    assert ada.send("PUT", "/api/v1/me/achievements/pinned", pins).status_code == 200
    reset = root.send("POST", f"/api/v1/admin/users/{ada.id}/reset")
    assert reset.status_code == 200, reset.text
    assert ada.get("/api/v1/me/stats").json()["totals"]["games"] == 0
    assert ada.get("/api/v1/me/history").json()["items"] == []
    # Once the new handle is chosen, the profile shows no badge from before.
    assert ada.send("PATCH", "/api/v1/me", {"handle": "ada2"}).status_code == 200
    profile = root.get(f"/api/v1/players/{ada.id}/achievements").json()
    assert (profile["pinned"], profile["earned"]) == ([], [])
    fresh = ada.get("/api/v1/me/quests").json()
    assert all(quest["completed_at"] is None for quest in fresh["daily"]["quests"])
    assert ada.get("/api/v1/me/achievements").json()["earned"] == 0
    # The same day's quests and the first win pay again, under keys of their own.
    won(client, ada)
    assert (
        sum(
            1
            for quest in ada.get("/api/v1/me/quests").json()["daily"]["quests"]
            if quest["completed_at"]
        )
        == 2
    )
    keys = [key for _, key, _ in entries(client, ada.id, "achievement") if "first-win" in key]
    assert len(keys) == 2 and keys[0] != keys[1]
    assert (
        len([key for _, key, _ in entries(client, ada.id, "quest") if "d2-colour-red" in key]) == 2
    )
    assert ada.get("/api/v1/me/stats").json()["totals"]["wins"] == 1


def test_deleting_an_account_keeps_its_results_and_ends_its_notifications(client):
    ada, bob = Account(client, "ada"), Account(client, "bob")
    ada.get("/api/v1/me/quests")
    played(client, [ada.id, bob.id], completed(0), kind="table")
    with database(client) as db:
        delete_account(db, db.get_one(User, ada.id), utcnow())
        db.commit()
        assert db.scalar(select(PlayerResult.id).where(PlayerResult.user_id == ada.id))
        assert db.scalar(select(PlayerAchievement.id).where(PlayerAchievement.user_id == ada.id))
        assert db.scalar(select(Notification.id).where(Notification.user_id == ada.id)) is None
    assert bob.get(f"/api/v1/players/{ada.id}/stats").status_code == 404
    history = bob.get("/api/v1/me/history").json()["items"]
    assert history[0]["outcome"] == "loss" and history[0]["opponents"][0]["player"] is None


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_results_are_append_only_on_postgresql(monkeypatch, content):
    base = os.environ["CD_TEST_POSTGRES_URL"]
    schema = f"test_{uuid4().hex}"
    admin = create_engine(base, connect_args={"connect_timeout": 3})
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    scoped = (
        make_url(base)
        .update_query_dict({"options": f"-csearch_path={schema}"})
        .render_as_string(hide_password=False)
    )
    monkeypatch.setenv("CD_DATABASE_URL", scoped)
    config = Config("alembic.ini")
    database_ = create_engine(scoped, connect_args={"connect_timeout": 3})
    try:
        command.upgrade(config, "head")
        app = create_app(
            Settings(database_url=scoped, content_dir=str(content), sysop_networks="10.20.0.0/24")
        )
        with TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS) as http:
            ada, bob = Account(http, "ada"), Account(http, "bob")
            monkeypatch.setattr(quests, "choose_daily", daily(*RED_DAY))
            assert ada.get("/api/v1/me/quests").status_code == 200
            played(http, [(ada.id, RED), bob.id], completed(0), kind="table")
            assert ada.get("/api/v1/me/quests").json()["daily"]["quests"][0]["completed_at"]
            assert ada.get("/api/v1/me/achievements").json()["earned"] >= 3
            assert ada.get("/api/v1/me/history").json()["items"][0]["outcome"] == "win"
            for statement in (
                "UPDATE player_results SET outcome = 'loss'",
                "DELETE FROM player_results",
            ):
                with (
                    pytest.raises(DBAPIError, match="append-only"),
                    database_.begin() as connection,
                ):
                    connection.execute(text(statement))
            with Session(database_) as db:
                delete_account(db, db.get_one(User, bob.id), utcnow())
                db.commit()
        command.downgrade(config, "0020_account_reset")
        with database_.connect() as connection:
            kinds = set(connection.execute(text("SELECT kind FROM token_ledger")).scalars())
            assert "grant" in kinds and not kinds & {"quest", "achievement"}
        command.upgrade(config, "head")
    finally:
        database_.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
