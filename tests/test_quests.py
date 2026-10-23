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

from api import achievements, awards, games, quests
from api.accounts import delete_account
from api.config import Settings
from api.identity import utcnow
from api.main import create_app
from api.models import (
    DailyQuest,
    Deck,
    DeckEntryRow,
    DeckRevision,
    Friendship,
    Game,
    GameSeat,
    Notification,
    PackOpening,
    PlayerAchievement,
    PlayerResult,
    TokenEntry,
    User,
)
from api.quests import Quest

url = test_progression.url
content = test_progression.content
engine = test_progression.engine
TABLES = (
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
) -> UUID:
    """A game recorded as the API records an engine's result: per seat a player's account (or
    None for a bot), with its deck's name when given."""
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


def prefer(*ids: str) -> Callable[[list[Quest], int], list[Quest]]:
    """A draw that takes the named quests first, in order, as far as the candidates allow."""

    def choose(candidates: list[Quest], count: int) -> list[Quest]:
        ranked = sorted(
            candidates, key=lambda quest: ids.index(quest.id) if quest.id in ids else len(ids)
        )
        return ranked[:count]

    return choose


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


# Daily quests.


def test_the_days_quests_are_drawn_once_and_stay(client):
    ada = Account(client, "ada")
    first = ada.get("/api/v1/me/quests").json()
    assert len(first["quests"]) == 3 and first["can_swap"] is True and first["paid"] == 0
    assert [quest["slot"] for quest in first["quests"]] == [0, 1, 2]
    groups = {quests.BY_ID[quest["id"]].group for quest in first["quests"]}
    assert len(groups) == 3
    assert all(100 <= quest["tokens"] <= 250 for quest in first["quests"])
    assert ada.get("/api/v1/me/quests").json() == first
    resets = datetime.fromisoformat(first["resets_at"])
    assert resets.astimezone(quests.ARIZONA).time().isoformat() == "00:00:00"
    assert date.fromisoformat(first["day"]) == quests.day_of(resets - timedelta(seconds=1))
    # Every quest in the pool pays 100 to 250 tokens, and the groups give three a day.
    assert all(100 <= quest.tokens <= 250 for quest in quests.QUESTS)
    assert len({quest.group for quest in quests.QUESTS}) >= 5


def test_the_day_is_arizonas(client):
    # 06:59 UTC is still the day before in Arizona, which keeps one offset all year.
    assert quests.day_of(datetime(2026, 7, 2, 6, 59, tzinfo=UTC)) == date(2026, 7, 1)
    assert quests.day_of(datetime(2026, 7, 2, 7, 0, tzinfo=UTC)) == date(2026, 7, 2)


def test_a_win_completes_quests_and_pays_once(client, monkeypatch):
    monkeypatch.setattr(quests, "choose", prefer("win-3", "win-red", "beat-skill-6"))
    ada = Account(client, "ada")
    assert [quest["id"] for quest in ada.get("/api/v1/me/quests").json()["quests"]] == [
        "win-3",
        "win-red",
        "beat-skill-6",
    ]
    game = won(client, ada, skill=6)
    shown = ada.get("/api/v1/me/quests").json()
    assert shown["paid"] == 0
    assert [
        (quest["progress"], quest["completed_at"] is not None) for quest in shown["quests"]
    ] == [
        (1, False),
        (1, True),
        (1, True),
    ]
    day = shown["day"]
    assert entries(client, ada.id, "quest") == [
        (250, f"quest:{ada.id}:{day}:beat-skill-6", "Beat a skill-6 bot"),
        (150, f"quest:{ada.id}:{day}:win-red", "Win with a red deck"),
    ]
    # A replayed end, a second look or a second settling pays nothing more.
    database_ = client.app.state.database  # type: ignore[attr-defined]
    games.record_end(database_, game, "finished", completed(0))
    with database(client) as db:
        awards.settle(db, db.get_one(Game, game))
        db.commit()
    ada.get("/api/v1/me/quests")
    assert len(entries(client, ada.id, "quest")) == 2
    # Wins over several games count: the third completes the last quest.
    won(client, ada)
    played(client, [ada.id, None], completed(1))
    won(client, ada)
    assert ada.get("/api/v1/me/quests").json()["quests"][0]["completed_at"] is not None
    assert len(entries(client, ada.id, "quest")) == 3
    # The bell says so, with what each paid.
    bell = ada.get("/api/v1/notifications", limit=50).json()["items"]
    told = [item["award"] for item in bell if item["kind"] == "quest_completed"]
    assert {"id": "win-red", "name": "Win with a red deck", "tokens": 150} in told
    assert len(told) == 3 and all(item["actor"] is None for item in bell)
    tokens = ada.get("/api/v1/me/tokens").json()
    lines = [line for line in tokens["entries"] if line["kind"] == "quest"]
    assert {line["reason"] for line in lines} == {
        "Win three games",
        "Win with a red deck",
        "Beat a skill-6 bot",
    }


def test_wins_before_the_days_first_look_count(client, monkeypatch):
    monkeypatch.setattr(quests, "choose", prefer("win", "win-commander", "beat-skill-4"))
    ada = Account(client, "ada")
    won(client, ada, skill=2)
    # The win came before the quests were drawn: nothing was paid then.
    assert entries(client, ada.id, "quest") == []
    shown = ada.get("/api/v1/me/quests").json()
    assert shown["paid"] == 225
    assert [quest["completed_at"] is not None for quest in shown["quests"]] == [True, True, False]
    assert ada.get("/api/v1/me/quests").json()["paid"] == 0


def test_one_swap_a_day(client, monkeypatch):
    monkeypatch.setattr(
        quests, "choose", prefer("win", "win-legacy", "beat-skill-6", "win-commander")
    )
    ada = Account(client, "ada")
    ada.get("/api/v1/me/quests")
    won(client, ada)
    done = ada.send("POST", "/api/v1/me/quests/0/swap")
    assert (done.status_code, done.json()["code"]) == (409, "quest_completed")
    swapped = ada.send("POST", "/api/v1/me/quests/1/swap")
    assert swapped.status_code == 200, swapped.text
    body = swapped.json()
    assert body["can_swap"] is False
    new = body["quests"][1]
    # From a group the other two do not hold; the win before the swap does not count for it.
    assert (new["id"], new["swapped"], new["progress"]) == ("win-commander", True, 0)
    won(client, ada)
    assert ada.get("/api/v1/me/quests").json()["quests"][1]["completed_at"] is not None
    again = ada.send("POST", "/api/v1/me/quests/2/swap")
    assert (again.status_code, again.json()["code"]) == (409, "swap_used")
    assert ada.send("POST", "/api/v1/me/quests/3/swap").status_code == 422
    with database(client) as db:
        rows = list(db.scalars(select(DailyQuest).where(DailyQuest.user_id == ada.id)))
    assert len(rows) == 3 and sum(1 for row in rows if row.swapped_at) == 1


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
    assert (100, f"achievement:{ada.id}:first-win", "First Victory") in paid
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
    assert 20 <= len(achievements.ACHIEVEMENTS) <= 30
    assert len(achievements.BY_ID) == len(achievements.ACHIEVEMENTS)
    for found in achievements.ACHIEVEMENTS:
        assert 100 <= found.tokens <= 1_000 and found.target >= 1 and found.version >= 1
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
    monkeypatch.setattr(quests, "choose", prefer("win", "win-commander", "beat-skill-4"))
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
    assert bob.get("/api/v1/me/achievements").json()["paid"] == 100
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
    monkeypatch.setattr(quests, "choose", prefer("win", "win-red", "beat-skill-6"))
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
    assert all(quest["completed_at"] is None for quest in fresh["quests"])
    assert ada.get("/api/v1/me/achievements").json()["earned"] == 0
    # The same day's quests and the first win pay again, under keys of their own.
    won(client, ada)
    assert (
        sum(1 for quest in ada.get("/api/v1/me/quests").json()["quests"] if quest["completed_at"])
        == 2
    )
    keys = [key for _, key, _ in entries(client, ada.id, "achievement") if "first-win" in key]
    assert len(keys) == 2 and keys[0] != keys[1]
    assert len([key for _, key, _ in entries(client, ada.id, "quest") if "win-red" in key]) == 2
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
            monkeypatch.setattr(quests, "choose", prefer("win", "win-red", "beat-skill-6"))
            assert ada.get("/api/v1/me/quests").status_code == 200
            played(http, [(ada.id, RED), bob.id], completed(0), kind="table")
            assert ada.get("/api/v1/me/quests").json()["quests"][0]["completed_at"]
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
