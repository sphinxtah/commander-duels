"""Public queues (v0.5.0) through the API, against the human tables' fake engine: joining with a
deck and the refusals, two players meeting, bots filling the empty seats after a minute (with an
injected clock), waiting for players only, leaving, places whose app stopped asking, every
player's limit of running games and deck checked again at the start, a player leaving as their
game starts, concurrent matches seating each player once, presence in a queue, and the migration
going back."""

import asyncio
import json
import os
import time
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import test_progression
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text, update
from sqlalchemy.orm import Session
from test_games import SERVICE_TOKEN
from test_tables import (
    Account,
    TableEngine,
    card,
    concede,
    deck,
    opened,
    served,
    until_finished,
    url,
)

from api import queues
from api.identity import utcnow
from api.models import Base, Deck, Game, GameSeat, GameTable, Match, QueueEntry, User

content = test_progression.content
__all__ = ["url"]
# Rows of the queues and rematches, removed before the tables' own cleanup removes the accounts.
QUEUE_TABLES = ("notifications", "rematch_players", "rematches", "queue_entries", "table_messages")


class QueueEngine(TableEngine):
    """The tables' fake engine, which may take a while to create a game."""

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/service/games" and self.create_delay:
            await asyncio.sleep(self.create_delay)
        return await super().__call__(request)


class Clock:
    """The queues' clock, moved by the test."""

    def __init__(self) -> None:
        self.now = utcnow()

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture(autouse=True)
def no_background_tick(monkeypatch: pytest.MonkeyPatch) -> None:
    """The tests run the tick themselves, at the moments they choose."""
    monkeypatch.setattr(queues, "TICK_SECONDS", 3600.0)


@contextmanager
def queued(
    url: str, content: Path, engine: TableEngine | None, **settings: Any
) -> Iterator[TestClient]:
    with served(url, content, engine, **({"games_max": 8} | settings)) as client:
        try:
            yield client
        finally:
            with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
                for table in QUEUE_TABLES:
                    db.execute(text(f"DELETE FROM {table}"))
                db.commit()


@pytest.fixture
def engine() -> QueueEngine:
    return QueueEngine()


@pytest.fixture
def client(url: str, content: Path, engine: QueueEngine) -> Iterator[TestClient]:
    with queued(url, content, engine) as client:
        yield client


@pytest.fixture
def clock(client: TestClient) -> Clock:
    found = Clock()
    hub(client).clock = found
    return found


def hub(client: TestClient) -> queues.QueueHub:
    return client.app.state.queues  # type: ignore[attr-defined,no-any-return]


def tick(client: TestClient) -> None:
    client.portal.call(hub(client).tick)  # type: ignore[union-attr]


def join(
    account: Account, deck_id: str, fmt: str = "legacy", seats: int = 2, humans_only: bool = False
) -> httpx.Response:
    return account.send(
        "POST",
        "/api/v1/queue",
        {"format": fmt, "seats": seats, "deck_id": deck_id, "humans_only": humans_only},
    )


def place(account: Account) -> dict[str, Any]:
    """The account's place, as its app asks for it (which keeps the place)."""
    answer = account.get("/api/v1/queue")
    assert answer.status_code == 200, answer.text
    return answer.json()  # type: ignore[no-any-return]


def seats_of(client: TestClient, game_id: str) -> list[GameSeat]:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return list(
            db.scalars(
                select(GameSeat)
                .where(GameSeat.game_id == uuid.UUID(game_id))
                .order_by(GameSeat.seat)
            )
        )


def table_of(client: TestClient, game_id: str) -> GameTable | None:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return db.scalar(select(GameTable).where(GameTable.game_id == uuid.UUID(game_id)))


def test_joining_leaving_and_the_queues(client, clock):
    ada, bob = Account(client, "ada"), Account(client, "bob")
    ada_deck = deck(ada, client)
    assert place(ada) == {
        "status": "none",
        "format": None,
        "seats": None,
        "best_of": 1,
        "humans_only": False,
        "deck_id": None,
        "deck": None,
        "joined_at": None,
        "waited_seconds": 0,
        "position": None,
        "waiting": 0,
        "bots_in_seconds": None,
        "game_id": None,
        "reason": None,
        "message": None,
        "partner": None,
        "invites": [],
    }
    joined = join(ada, ada_deck, humans_only=True)
    assert joined.status_code == 201, joined.text
    waiting = joined.json()
    assert (waiting["status"], waiting["position"], waiting["waiting"]) == ("waiting", 1, 1)
    assert (waiting["deck"], waiting["deck_id"], waiting["humans_only"]) == ("Burn", ada_deck, True)
    assert waiting["bots_in_seconds"] is None and waiting["game_id"] is None
    listed = bob.get("/api/v1/queues").json()
    assert [(q["format"], q["seats"], q["best_of"], q["waiting"]) for q in listed] == [
        ("legacy", 2, 1, 1),
        ("legacy", 2, 3, 0),
        ("commander", 2, 1, 0),
        ("commander", 3, 1, 0),
        ("commander", 4, 1, 0),
        ("two_headed_giant", 4, 1, 0),
    ]
    assert listed[0]["name"] == "Legacy · 2 players"
    assert listed[5]["name"] == "Two-Headed Giant · two teams of two"
    assert listed[1]["name"] == "Legacy · 2 players · best of three"
    # No deck of anyone else's in any answer.
    assert ada_deck not in json.dumps(listed)

    clock.advance(42)
    assert place(ada)["waited_seconds"] == 42
    again = join(ada, ada_deck)
    assert (again.status_code, again.json()["code"]) == (409, "in_queue")

    left = ada.send("DELETE", "/api/v1/queue")
    assert left.status_code == 200 and left.json()["status"] == "left"
    assert left.json()["reason"] == "left"
    assert bob.get("/api/v1/queues").json()[0]["waiting"] == 0
    # Leaving twice changes nothing; joining again takes a new place.
    assert ada.send("DELETE", "/api/v1/queue").json()["status"] == "left"
    back = join(ada, ada_deck, fmt="legacy").json()
    assert back["status"] == "waiting" and back["waited_seconds"] == 0
    assert back["bots_in_seconds"] == 60


def test_joining_refuses_what_a_table_refuses(client):
    ada, bob = Account(client, "ada"), Account(client, "bob")
    ada_deck, bob_deck = deck(ada, client), deck(bob, client)
    no_queue = join(ada, ada_deck, seats=3)
    assert (no_queue.status_code, no_queue.json()["code"]) == (422, "invalid_queue")
    too_many = join(ada, ada_deck, fmt="commander", seats=5)
    assert too_many.status_code == 422
    for refused, code in (
        (join(ada, bob_deck), "invalid_deck"),
        (join(ada, ada_deck, fmt="commander"), "invalid_deck"),
    ):
        assert (refused.status_code, refused.json()["code"]) == (422, code), refused.text
    # A deck the library cannot play, as at a table.
    cara = Account(client, "cara")
    made = cara.send(
        "POST",
        "/api/v1/decks",
        {
            "title": "Bolts",
            "format": "legacy",
            "entries": [
                {"card_id": card(client, "Lightning Bolt"), "quantity": 4, "location": "main"},
                {"card_id": card(client, "Mountain"), "quantity": 56, "location": "main"},
            ],
        },
    ).json()
    locked = join(cara, str(made["id"]))
    assert (locked.status_code, locked.json()["code"]) == (422, "deck_not_playable")

    # A table and a queue never both take a player.
    created = bob.send("POST", "/api/v1/tables", {"format": "legacy", "deck_id": bob_deck})
    assert created.status_code == 201
    at_table = join(bob, bob_deck)
    assert (at_table.status_code, at_table.json()["code"]) == (409, "at_a_table")
    assert join(ada, ada_deck, humans_only=True).status_code == 201
    code = created.json()["code"]
    sitting = ada.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": ada_deck})
    assert (sitting.status_code, sitting.json()["code"]) == (409, "in_queue")
    opening = ada.send("POST", "/api/v1/tables", {"format": "legacy", "deck_id": ada_deck})
    assert (opening.status_code, opening.json()["code"]) == (409, "in_queue")


def test_two_players_meet_at_a_table(client, engine, clock):
    ada, bob = Account(client, "ada"), Account(client, "bob")
    ada_deck, bob_deck = deck(ada, client), deck(bob, client, title="Mountains")
    assert join(ada, ada_deck).json()["status"] == "waiting"
    clock.advance(5)
    found = join(bob, bob_deck)
    assert found.status_code == 201, found.text
    game_id = found.json()["game_id"]
    assert found.json()["status"] == "matched" and game_id
    assert place(ada)["status"] == "matched" and place(ada)["game_id"] == game_id
    assert bob.get("/api/v1/queues").json()[0]["waiting"] == 0

    # One table's game, through the human tables' path: casual, never listed, every player first.
    body = engine.created[-1]
    assert [seat["player"] for seat in body["seats"]] == ["human", "human"]
    assert (body["skill"], body["turn_cap"], body["idle_timeout_seconds"]) == (4, 60, 3600)
    table = table_of(client, game_id)
    assert table is not None and table.queued and table.visibility == "private"
    assert (table.status, table.allow_banned, table.allow_not_legal) == ("started", True, True)
    assert (table.host_id, table.seats, table.bots) == (ada.id, 2, 0)
    assert bob.get("/api/v1/tables").json() == []
    summary = bob.get(f"/api/v1/games/{game_id}").json()["game"]
    assert summary["kind"] == "table" and summary["your_seat"] == 1
    assert [seat["handle"] for seat in summary["seats"]] == ["ada", "bob"]
    assert [seat["deck"] for seat in summary["seats"]] == [None, "Mountains"]

    # Each plays their own seat, with the table's chat; a concession, a win and its 50 tokens.
    fake = engine.games[game_id]
    seen_ada: list[str] = []
    seen_bob: list[str] = []
    with ExitStack() as stack:
        ada_tab = opened(ada, game_id, seen_ada, stack)
        bob_tab = opened(bob, game_id, seen_bob, stack)
        assert ada_tab.until("chat_history")["messages"] == []
        assert concede(bob_tab, game_id)["status"] == 200
        assert ada_tab.snapshot(2)["result"]["winner_seat"] == 0
    for text_seen, other in ((seen_ada, 1), (seen_bob, 0)):
        joined_text = "\n".join(text_seen)
        assert f"Secret of seat {other}" not in joined_text
        assert all(token not in joined_text for token in fake.tokens.values())
        assert SERVICE_TOKEN not in joined_text
    assert until_finished(ada, game_id)["tokens"] == 50
    assert ada.get("/api/v1/me/progress").json()["counted_wins"] == 1
    # The finished wait still names its game, until the next one.
    assert place(bob)["game_id"] == game_id


def test_legacy_best_of_three_is_a_queue_of_its_own(client, engine, clock):
    """v0.5.0: Legacy's best-of-three queue seats its players at a best-of-three table, whose game
    is the first of a match; best-of-one players never meet them, and Commander has no such queue.
    A rematch waits for the match's end."""
    ada, bob, cara = Account(client, "ada"), Account(client, "bob"), Account(client, "cara")
    ada_deck, bob_deck = deck(ada, client), deck(bob, client, title="Mountains")
    commander = ada.send(
        "POST",
        "/api/v1/queue",
        {"format": "commander", "seats": 4, "deck_id": ada_deck, "best_of": 3},
    )
    assert (commander.status_code, commander.json()["code"]) == (422, "invalid_queue")

    waiting = ada.send(
        "POST", "/api/v1/queue", {"format": "legacy", "deck_id": ada_deck, "best_of": 3}
    ).json()
    assert (waiting["status"], waiting["best_of"]) == ("waiting", 3)
    # A best-of-one player waits in the other queue.
    assert join(cara, deck(cara, client), humans_only=True).json()["status"] == "waiting"
    listed = {(q["best_of"], q["waiting"]) for q in bob.get("/api/v1/queues").json()[:2]}
    assert listed == {(1, 1), (3, 1)}
    found = bob.send(
        "POST", "/api/v1/queue", {"format": "legacy", "deck_id": bob_deck, "best_of": 3}
    ).json()
    assert found["status"] == "matched", found
    game_id = found["game_id"]
    assert place(cara)["status"] == "waiting"
    table = table_of(client, game_id)
    assert table is not None and table.queued and table.best_of == 3
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        game = db.get(Game, uuid.UUID(game_id))
        assert game is not None and game.match_id is not None and game.match_game == 1
        match = db.get(Match, game.match_id)
        assert match is not None and (match.kind, match.best_of) == ("table", 3)

    # Game 1 ends with a concession: the match goes on, so no rematch yet.
    with ExitStack() as stack:
        opened(ada, game_id, [], stack)
        bob_tab = opened(bob, game_id, [], stack)
        assert concede(bob_tab, game_id)["status"] == 200
    until_finished(ada, game_id)
    view = ada.get(f"/api/v1/games/{game_id}/rematch").json()
    assert view["can_offer"] is False
    early = ada.send("POST", f"/api/v1/games/{game_id}/rematch")
    assert (early.status_code, early.json()["code"]) == (409, "match_running")


def test_bots_fill_the_empty_seats_after_a_minute(client, engine, clock):
    ada = Account(client, "ada", admin=True)
    waiting = join(ada, deck(ada, client, "commander", "Kenrith"), "commander", 4).json()
    assert (waiting["status"], waiting["bots_in_seconds"]) == ("waiting", 60)
    clock.advance(30)
    tick(client)
    assert place(ada)["bots_in_seconds"] == 30
    clock.advance(31)
    assert place(ada)["status"] == "waiting"
    tick(client)
    found = place(ada)
    assert found["status"] == "matched", found
    game_id = found["game_id"]

    # Alone with bots: a practice game, which records its request for a rematch.
    body = engine.created[-1]
    assert [seat["player"] for seat in body["seats"]] == ["human", "bot", "bot", "bot"]
    assert body["skill"] == queues.BOT_SKILL == 4 and "idle_timeout_seconds" not in body
    summary = ada.get(f"/api/v1/games/{game_id}").json()["game"]
    assert summary["kind"] == "practice" and summary["bot_skill"] == 4
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        game = db.get(Game, uuid.UUID(game_id))
        assert game is not None and game.settings is not None
        assert game.settings["format"] == "commander"
        assert game.settings["bots"] == [{"deck": None, "deck_id": None, "deck_list": None}] * 3
        assert game.settings["rules"] == {"banned": True, "not_legal": True}
    assert table_of(client, game_id) is None

    # Two players who take bots, after the minute: a table, with bots in the other seats.
    bob, cara = Account(client, "bob", admin=True), Account(client, "cara", admin=True)
    join(bob, deck(bob, client, "commander", "Bob's"), "commander", 4)
    clock.advance(20)
    join(cara, deck(cara, client, "commander", "Cara's"), "commander", 4)
    clock.advance(41)
    place(bob), place(cara)
    tick(client)
    game_id = place(cara)["game_id"]
    assert place(bob)["game_id"] == game_id
    assert [s["player"] for s in engine.created[-1]["seats"]] == ["human", "human", "bot", "bot"]
    table = table_of(client, game_id)
    assert table is not None and (table.seats, table.bots, table.host_id) == (4, 2, bob.id)
    assert [seat.user_id for seat in seats_of(client, game_id)] == [bob.id, cara.id, None, None]


def test_players_only_wait_for_players(client, engine, clock):
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    cara = Account(client, "cara", admin=True)
    ada_deck = deck(ada, client, "commander", "Ada's")
    assert join(ada, ada_deck, "commander", 3, humans_only=True).json()["bots_in_seconds"] is None
    clock.advance(10)
    join(bob, deck(bob, client, "commander", "Bob's"), "commander", 3)
    # A minute on, the player who takes bots gets them; the one who waits for players waits on.
    clock.advance(61)
    place(ada), place(bob)
    tick(client)
    assert place(bob)["status"] == "matched"
    assert [s["player"] for s in engine.created[-1]["seats"]] == ["human", "bot", "bot"]
    clock.advance(600)
    assert place(ada)["status"] == "waiting"
    tick(client)
    assert place(ada)["status"] == "waiting" and place(ada)["waited_seconds"] == 671
    assert len(engine.created) == 1
    # Players enough: a table of players at once, the one who waited for players first.
    dana = Account(client, "dana", admin=True)
    join(cara, deck(cara, client, "commander", "Cara's"), "commander", 3, humans_only=True)
    clock.advance(1)
    place(ada)
    found = join(dana, deck(dana, client, "commander", "Dana's"), "commander", 3).json()
    assert found["status"] == "matched"
    assert [s["player"] for s in engine.created[-1]["seats"]] == ["human"] * 3
    assert [seat.user_id for seat in seats_of(client, found["game_id"])] == [
        ada.id,
        cara.id,
        dana.id,
    ]


def test_a_place_nobody_asks_about_goes(client, clock):
    ada = Account(client, "ada")
    join(ada, deck(ada, client), humans_only=True)
    clock.advance(queues.STALE_AFTER.total_seconds() - 10)
    tick(client)
    assert place(ada)["status"] == "waiting"
    clock.advance(queues.STALE_AFTER.total_seconds() + 1)
    tick(client)
    gone = ada.get("/api/v1/queue").json()
    assert (gone["status"], gone["reason"]) == ("left", "gone")
    assert gone["message"] == queues.GONE


def test_the_tick_runs_on_its_own(url, content, engine, monkeypatch):
    monkeypatch.setattr(queues, "TICK_SECONDS", 0.05)
    monkeypatch.setattr(queues, "BOT_WAIT", timedelta(seconds=0.2))
    with queued(url, content, engine) as client:
        ada = Account(client, "ada")
        join(ada, deck(ada, client))
        for _ in range(100):
            if place(ada)["status"] == "matched":
                break
            time.sleep(0.05)
        assert place(ada)["status"] == "matched"
        assert [s["player"] for s in engine.created[-1]["seats"]] == ["human", "bot"]


def test_every_limit_and_deck_is_checked_again_at_the_start(client, engine, clock):
    ada, bob, cara = Account(client, "ada"), Account(client, "bob"), Account(client, "cara")
    root = Account(client, "sysop", kind="sysop")
    ada_deck, bob_deck, cara_deck = (deck(who, client) for who in (ada, bob, cara))
    # A running game: no room under the limit to join.
    practice = ada.send("POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": ada_deck})
    assert practice.status_code == 201, practice.text
    full = join(ada, ada_deck)
    assert (full.status_code, full.json()["code"]) == (409, "game_limit")
    ada.send("POST", f"/api/v1/games/{practice.json()['id']}/close")

    # Bob waits, then starts a practice game: the match takes him out, and Cara waits on.
    assert join(bob, bob_deck, humans_only=True).json()["status"] == "waiting"
    other = bob.send("POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": bob_deck})
    assert other.status_code == 201
    created = len(engine.created)
    assert join(cara, cara_deck, humans_only=True).json()["status"] == "waiting"
    assert len(engine.created) == created
    out = place(bob)
    assert (out["status"], out["reason"]) == ("refused", "game_limit")
    assert out["message"].startswith("You started another game")
    assert place(cara)["status"] == "waiting" and place(cara)["position"] == 1

    # A deck trashed while it waits stops its player alone.
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(update(Deck).where(Deck.id == uuid.UUID(cara_deck)).values(deleted_at=utcnow()))
        db.commit()
    assert join(ada, ada_deck, humans_only=True).json()["status"] == "waiting"
    refused = place(cara)
    assert (refused["status"], refused["reason"]) == ("refused", "invalid_deck")
    assert place(ada)["status"] == "waiting"

    # SysOp has no limit: with a game running, it still joins and plays.
    root_deck = deck(root, client)
    running = root.send(
        "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": root_deck}
    )
    assert running.status_code == 201
    met = join(root, root_deck)
    assert met.status_code == 201 and met.json()["status"] == "matched", met.text
    assert place(ada)["game_id"] == met.json()["game_id"]


def test_a_player_leaving_as_the_game_starts_leaves_the_others_waiting(client, engine, clock):
    ada, bob = Account(client, "ada"), Account(client, "bob")
    ada_deck, bob_deck = deck(ada, client), deck(bob, client)
    join(ada, ada_deck, humans_only=True)
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        # Bob's place, written as a join would, but not yet matched.
        db.add(
            QueueEntry(
                user_id=bob.id,
                format="legacy",
                seats=2,
                deck_id=uuid.UUID(bob_deck),
                humans_only=True,
                status="waiting",
                joined_at=clock.now,
                seen_at=clock.now,
            )
        )
        db.commit()
    engine.create_delay = 0.5
    started = client.portal.start_task_soon(hub(client).tick)  # type: ignore[union-attr]
    for _ in range(200):
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            found = db.scalar(select(QueueEntry.status).where(QueueEntry.user_id == bob.id))
        if found == "starting":
            break
        time.sleep(0.01)
    # Bob leaves while the engine makes the game.
    assert bob.send("DELETE", "/api/v1/queue").json()["status"] == "left"
    started.result(timeout=10)
    engine.create_delay = 0
    assert len(engine.created) == 1 and engine.closed == list(engine.games)
    assert place(ada)["status"] == "waiting" and place(ada)["game_id"] is None
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        assert db.scalar(select(func.count()).select_from(Game)) == 0


def test_concurrent_matches_seat_each_player_once(client, engine, clock):
    players = [Account(client, f"p{index}") for index in range(5)]
    decks = [deck(player, client) for player in players]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        for index, (player, deck_id) in enumerate(zip(players, decks, strict=True)):
            db.add(
                QueueEntry(
                    user_id=player.id,
                    format="legacy",
                    seats=2,
                    deck_id=uuid.UUID(deck_id),
                    humans_only=True,
                    status="waiting",
                    joined_at=clock.now + timedelta(seconds=index),
                    seen_at=clock.now,
                )
            )
        db.commit()

    async def at_once() -> None:
        key = queues.QueueKey("legacy", 2)
        await asyncio.gather(*(hub(client).tick() for _ in range(4)), hub(client).match(key))

    client.portal.call(at_once)  # type: ignore[union-attr]
    assert len(engine.created) == 2
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        seated = list(db.scalars(select(GameSeat.user_id).where(GameSeat.user_id.is_not(None))))
    assert sorted(seated, key=str) == sorted((p.id for p in players[:4]), key=str)
    assert [place(player)["status"] for player in players] == ["matched"] * 4 + ["waiting"]
    # In the order they joined.
    assert place(players[0])["game_id"] == place(players[1])["game_id"]
    assert place(players[2])["game_id"] == place(players[3])["game_id"]


def test_with_every_game_slot_busy_the_players_wait_on(url, content, engine):
    with queued(url, content, engine, games_max=1) as client:
        ada, bob, cara = Account(client, "ada"), Account(client, "bob"), Account(client, "cara")
        running = ada.send(
            "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck(ada, client)}
        )
        assert running.status_code == 201
        join(bob, deck(bob, client), humans_only=True)
        busy = join(cara, deck(cara, client), humans_only=True).json()
        assert (busy["status"], busy["reason"], busy["message"]) == (
            "waiting",
            "games_busy",
            queues.BUSY,
        )
        assert place(bob)["position"] == 1 and len(engine.created) == 1
        # A slot frees up: the next tick starts their game.
        ada.send("POST", f"/api/v1/games/{running.json()['id']}/close")
        tick(client)
        assert place(cara)["status"] == "matched"
        assert place(bob)["game_id"] == place(cara)["game_id"]


def test_without_games_players_wait(url, content):
    with queued(url, content, None) as client:
        ada, bob = Account(client, "ada"), Account(client, "bob")
        assert join(ada, deck(ada, client)).json()["status"] == "waiting"
        assert join(bob, deck(bob, client)).json()["status"] == "waiting"
        tick(client)
        assert place(ada)["status"] == "waiting"
        assert ada.send("DELETE", "/api/v1/queue").json()["status"] == "left"


def test_presence_says_in_a_queue(client):
    ada, bob = Account(client, "ada"), Account(client, "bob")
    bob.send("PATCH", "/api/v1/me/privacy", {"presence_visibility": "everyone"})
    bob.send("POST", "/api/v1/presence", {})
    join(bob, deck(bob, client), humans_only=True)
    seen = ada.get(f"/api/v1/players/{bob.id}").json()["presence"]
    assert (seen["state"], seen["game_format"]) == ("in_queue", "legacy")
    bob.send("DELETE", "/api/v1/queue")
    assert ada.get(f"/api/v1/players/{bob.id}").json()["presence"]["state"] == "online"


def test_deleting_or_resetting_an_account_takes_it_out(client):
    from api.accounts import delete_account
    from api.resets import reset_account
    from api.roster import load

    ada, bob = Account(client, "ada"), Account(client, "bob")
    root = Account(client, "sysop", kind="sysop")
    join(ada, deck(ada, client), humans_only=True)
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        user = db.get(User, ada.id)
        assert user is not None
        delete_account(db, user, utcnow())
        db.commit()
        assert db.get(QueueEntry, ada.id) is None
    assert join(bob, deck(bob, client), humans_only=True).json()["status"] == "waiting"
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        user, actor = db.get(User, bob.id), db.get(User, root.id)
        assert user is not None and actor is not None
        reset_account(db, user, actor, load(client.app.state.settings.content_dir))  # type: ignore[attr-defined]
        db.commit()
        assert db.get(QueueEntry, bob.id) is None


def test_the_migration_goes_back(tmp_path, monkeypatch):
    database = f"sqlite:///{tmp_path}/queues.db"
    monkeypatch.setenv("CD_DATABASE_URL", database)
    config = Config("alembic.ini")
    command.upgrade(config, "head")
    engine = create_engine(database)
    user, game = uuid.uuid4(), uuid.uuid4()
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO users (id, display_name, kind, status, onboarding, avatar, locale, "
                "preferences, privilege_version, created_at) VALUES (:id, 'Ada', 'player', "
                "'active', 'complete', 'sigil', 'en', '{}', 0, CURRENT_TIMESTAMP)"
            ),
            {"id": user.hex},
        )
        connection.execute(
            text(
                "INSERT INTO games (id, kind, format, status, created_by, created_at, bot_skill, "
                "turn_cap, settings) VALUES (:id, 'table', 'legacy', 'finished', :user, "
                "CURRENT_TIMESTAMP, 4, 60, '{}')"
            ),
            {"id": game.hex, "user": user.hex},
        )
        connection.execute(
            text(
                "INSERT INTO notifications (id, user_id, kind, actor_id, created_at, game_id) "
                "VALUES (:id, :user, 'rematch', :user, CURRENT_TIMESTAMP, :game)"
            ),
            {"id": uuid.uuid4().hex, "user": user.hex, "game": game.hex},
        )
    command.downgrade(config, "0020_account_reset")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM notifications")).scalar() == 0
        assert connection.execute(text("SELECT kind FROM games")).scalar() == "table"
    command.upgrade(config, "head")
    engine.dispose()


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_parallel_claims_on_postgresql_seat_each_player_once():
    """Matches in parallel connections, as two processes or ticks would run them: the row locks
    make each wait for the other, so no player is claimed twice."""
    url = os.environ["CD_TEST_POSTGRES_URL"]
    schema = f"test_{uuid.uuid4().hex}"
    admin = create_engine(url, connect_args={"connect_timeout": 3})
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    database = create_engine(
        url,
        connect_args={"options": f"-csearch_path={schema}", "connect_timeout": 3},
        pool_size=10,
    )
    try:
        Base.metadata.create_all(database)
        now = utcnow()
        with Session(database) as db:
            for index in range(9):
                user = User(display_name=f"Player {index}", created_at=now)
                db.add(user)
                db.flush()
                owned = Deck(
                    owner_id=user.id,
                    title="Burn",
                    format="legacy",
                    draft_hash="",
                    created_at=now,
                    updated_at=now,
                )
                db.add(owned)
                db.flush()
                db.add(
                    QueueEntry(
                        user_id=user.id,
                        format="legacy",
                        seats=2,
                        deck_id=owned.id,
                        humans_only=True,
                        status="waiting",
                        joined_at=now + timedelta(seconds=index),
                        seen_at=now,
                    )
                )
            db.commit()
        key = queues.QueueKey("legacy", 2)
        with ThreadPoolExecutor(max_workers=8) as workers:
            claims = list(workers.map(lambda _: queues.claim(database, key, now), range(8)))
        groups = [group for group in claims if group is not None]
        claimed = [user for group in groups for user in group.users]
        assert len(groups) == 4 and all(len(group.users) == 2 for group in groups)
        assert len(set(claimed)) == len(claimed) == 8
        with Session(database) as db:
            statuses = list(db.scalars(select(QueueEntry.status)))
        assert sorted(statuses) == ["starting"] * 8 + ["waiting"]
    finally:
        database.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
