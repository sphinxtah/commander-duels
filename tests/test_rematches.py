"""Rematches (v0.5.0) through the API, against the human tables' fake engine: a practice game
played again with the same settings, once; a table's rematch offered, told through the bell and
accepted by every player still there, with the same seats, decks and rules; a decline, an offer
that lapses, a removed player's seat taken by a bot, decks checked again at the start, every
player's limit, and a queue's game going back to the queue."""

import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import test_progression
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session
from test_queues import QueueEngine, join, place, queued
from test_tables import Account, commander_table, deck, until_finished, url

from api import queues, rematches
from api.identity import utcnow
from api.models import Deck, Game, GameSeat, GameTable

content = test_progression.content
__all__ = ["url"]


@pytest.fixture(autouse=True)
def no_background_tick(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(queues, "TICK_SECONDS", 3600.0)


@pytest.fixture
def engine() -> QueueEngine:
    return QueueEngine()


@pytest.fixture
def client(url: str, content: Path, engine: QueueEngine) -> Iterator[TestClient]:
    with queued(url, content, engine) as client:
        yield client


def finish(engine: QueueEngine, game_id: str, *seats: int) -> None:
    """The seats concede in the engine; the last one standing wins."""
    fake = engine.games[game_id]
    with engine.lock:
        for seat in seats:
            fake.concede(seat)


def lobby_game(
    client: TestClient, engine: QueueEngine, ada: Account, bob: Account, **extra: Any
) -> str:
    """A finished two-player Commander table: Bob conceded, Ada won."""
    code = commander_table(client, ada, [bob], **extra)
    started = ada.send("POST", f"/api/v1/tables/{code}/start")
    assert started.status_code == 200, started.text
    game_id = str(started.json()["game_id"])
    finish(engine, game_id, 1)
    until_finished(ada, game_id)
    return game_id


def rematch(account: Account, game_id: str) -> Any:
    return account.send("POST", f"/api/v1/games/{game_id}/rematch")


def view(account: Account, game_id: str) -> dict[str, Any]:
    answer = account.get(f"/api/v1/games/{game_id}/rematch")
    assert answer.status_code == 200, answer.text
    return answer.json()  # type: ignore[no-any-return]


def table_of(client: TestClient, game_id: str) -> GameTable:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        found = db.scalar(select(GameTable).where(GameTable.game_id == uuid.UUID(game_id)))
    assert found is not None
    return found


def test_a_practice_game_plays_again_with_the_same_settings(client, engine):
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob")
    body = {
        "format": "commander",
        "deck_id": deck(ada, client, "commander", "Kenrith"),
        "bots": [{}, {}],
        "bot_skill": 2,
        "turn_cap": 40,
        "rules": {"banned": False, "not_legal": True},
    }
    first = ada.send("POST", "/api/v1/practice-games", body)
    assert first.status_code == 201, first.text
    game_id = first.json()["id"]
    running = rematch(ada, game_id)
    assert (running.status_code, running.json()["code"]) == (409, "game_running")
    assert view(ada, game_id) | {"players": []} == {
        "status": "none",
        "kind": "practice",
        "origin": "practice",
        "can_offer": False,
        "players": [],
        "your_answer": None,
        "expires_at": None,
        "expires_in": None,
        "game_id": None,
        "declined_by": None,
        "message": None,
    }
    ada.send("POST", f"/api/v1/games/{game_id}/close")
    assert view(ada, game_id)["can_offer"] is True
    assert bob.get(f"/api/v1/games/{game_id}/rematch").status_code == 404
    assert rematch(bob, game_id).status_code == 404

    again = rematch(ada, game_id)
    assert again.status_code == 200, again.text
    replay = again.json()
    assert replay["status"] == "started" and replay["game_id"] not in (None, game_id)
    # The same request: deck, bots, skill, turn cap and rules.
    assert engine.created[-1] == engine.created[-2]
    assert engine.created[-1]["skill"] == 2 and len(engine.created[-1]["seats"]) == 3
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        old, new = (db.get(Game, uuid.UUID(found)) for found in (game_id, replay["game_id"]))
        assert old is not None and new is not None and old.settings == new.settings
    # Once only: asking again answers with the first.
    assert rematch(ada, game_id).json()["game_id"] == replay["game_id"]
    assert len(engine.created) == 2
    assert view(ada, game_id)["can_offer"] is False

    # A practice game from before rematches has no request to replay.
    ada.send("POST", f"/api/v1/games/{replay['game_id']}/close")
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(
            update(Game).where(Game.id == uuid.UUID(replay["game_id"])).values(settings=None)
        )
        db.commit()
    assert view(ada, replay["game_id"])["can_offer"] is False
    old = rematch(ada, replay["game_id"])
    assert (old.status_code, old.json()["code"]) == (409, "rematch_unavailable")


def test_a_tables_players_accept_a_rematch(client, engine):
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    tournament = {"banned": False, "not_legal": False}
    game_id = lobby_game(client, engine, ada, bob, rules=tournament, visibility="private")
    before = engine.created[-1]
    assert view(bob, game_id)["can_offer"] is True

    offered = rematch(ada, game_id)
    assert offered.status_code == 200, offered.text
    offer = offered.json()
    assert (offer["status"], offer["kind"], offer["origin"]) == ("open", "table", "lobby")
    assert [(p["handle"], p["answer"], p["you"]) for p in offer["players"]] == [
        ("ada", "yes", True),
        ("bob", None, False),
    ]
    assert offer["your_answer"] == "yes" and 0 < offer["expires_in"] <= 120
    assert offer["can_offer"] is False

    # Bob hears of it through the bell, with the game whose result screen holds it.
    note = bob.get("/api/v1/notifications").json()["items"][0]
    assert (note["kind"], note["game_id"], note["request_pending"]) == ("rematch", game_id, True)
    assert note["actor"]["handle"] == "ada"
    assert view(bob, game_id)["your_answer"] is None

    accepted = rematch(bob, game_id)
    assert accepted.status_code == 200, accepted.text
    new_id = accepted.json()["game_id"]
    assert accepted.json()["status"] == "started" and new_id not in (None, game_id)
    assert view(ada, game_id)["game_id"] == new_id
    # The same seats and decks, the table's rules and visibility; a table's game as any other.
    after = engine.created[-1]
    assert [seat["deck_list"] for seat in after["seats"]] == [
        seat["deck_list"] for seat in before["seats"]
    ]
    assert after["idle_timeout_seconds"] == 3600
    table = table_of(client, new_id)
    assert (table.visibility, table.allow_banned, table.allow_not_legal) == (
        "private",
        False,
        False,
    )
    assert (table.status, table.seats, table.bots, table.queued) == ("started", 2, 0, False)
    assert table.host_id == ada.id
    summary = bob.get(f"/api/v1/games/{new_id}").json()["game"]
    assert summary["kind"] == "table" and summary["your_seat"] == 1
    note = bob.get("/api/v1/notifications").json()["items"][0]
    assert (note["request_pending"], note["read"]) == (False, True)
    # Once only.
    assert rematch(ada, game_id).json()["game_id"] == new_id
    assert len(engine.created) == 2


def test_a_decline_or_the_time_ends_the_offer(client, engine, monkeypatch):
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    game_id = lobby_game(client, engine, ada, bob)
    rematch(ada, game_id)
    declined = bob.send("POST", f"/api/v1/games/{game_id}/rematch/decline")
    assert declined.status_code == 200
    assert (declined.json()["status"], declined.json()["declined_by"]) == ("declined", "bob")
    late = rematch(ada, game_id)
    assert (late.status_code, late.json()["code"]) == (409, "rematch_closed")
    assert view(ada, game_id)["status"] == "declined"
    assert bob.get("/api/v1/notifications").json()["items"][0]["request_pending"] is False

    # An offer nobody finishes answering in time lapses.
    monkeypatch.setattr(rematches, "OFFER_SECONDS", 0)
    cara, dana = Account(client, "cara", admin=True), Account(client, "dana", admin=True)
    other = lobby_game(client, engine, cara, dana)
    assert rematch(cara, other).json()["status"] == "lapsed"
    too_late = rematch(dana, other)
    assert (too_late.status_code, too_late.json()["code"]) == (409, "rematch_closed")
    assert len(engine.created) == 2


def test_a_removed_players_seat_goes_to_a_bot(client, engine):
    ada, bob, cara = (Account(client, name, admin=True) for name in ("ada", "bob", "cara"))
    code = commander_table(client, ada, [bob, cara])
    game_id = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(
            update(GameSeat)
            .where(GameSeat.game_id == uuid.UUID(game_id), GameSeat.user_id == cara.id)
            .values(left_reason="removed", left_at=utcnow())
        )
        db.commit()
    finish(engine, game_id, 1, 2)
    until_finished(ada, game_id)
    assert view(cara, game_id)["can_offer"] is False
    offer = rematch(ada, game_id).json()
    assert [p["handle"] for p in offer["players"]] == ["ada", "bob"]
    refused = rematch(cara, game_id)
    assert (refused.status_code, refused.json()["code"]) == (409, "not_asked")
    new_id = rematch(bob, game_id).json()["game_id"]
    assert [seat["player"] for seat in engine.created[-1]["seats"]] == ["human", "human", "bot"]
    table = table_of(client, new_id)
    assert (table.seats, table.bots) == (3, 1)


def test_decks_and_limits_are_checked_again_at_the_start(client, engine):
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    game_id = lobby_game(client, engine, ada, bob)
    # Ada's deck went to the trash since: the rematch fails, naming whose deck, not what it holds.
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(update(Deck).where(Deck.owner_id == ada.id).values(deleted_at=utcnow()))
        db.commit()
    rematch(ada, game_id)
    failed = rematch(bob, game_id)
    assert (failed.status_code, failed.json()["code"]) == (409, "deck_not_playable")
    assert failed.json()["message"] == "ada's deck cannot be played now."
    seen = view(ada, game_id)
    assert (seen["status"], seen["message"]) == ("failed", "ada's deck cannot be played now.")
    assert len(engine.created) == 1

    # A player who started another game since: their limit stops the rematch, named.
    cara, dana = Account(client, "cara", admin=True), Account(client, "dana", admin=True)
    other = lobby_game(client, engine, cara, dana)
    rematch(cara, other)
    practice = cara.send(
        "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck(cara, client)}
    )
    assert practice.status_code == 201
    busy = rematch(dana, other)
    assert (busy.status_code, busy.json()["code"]) == (409, "game_limit")
    assert busy.json()["message"].startswith("cara has a game")
    assert view(dana, other)["status"] == "failed"
    # The one answering must be free to play: no running game, table or queue of their own.
    erin, finn = Account(client, "erin", admin=True), Account(client, "finn", admin=True)
    third = lobby_game(client, engine, erin, finn)
    assert join(finn, deck(finn, client), humans_only=True).json()["status"] == "waiting"
    queued_now = rematch(finn, third)
    assert (queued_now.status_code, queued_now.json()["code"]) == (409, "in_queue")
    assert view(finn, third)["status"] == "none"


def test_a_queue_games_rematch_goes_back_to_the_queue(client, engine):
    ada, bob = Account(client, "ada"), Account(client, "bob")
    join(ada, deck(ada, client))
    game_id = join(bob, deck(bob, client, title="Mountains")).json()["game_id"]
    finish(engine, game_id, 0)
    until_finished(bob, game_id)
    offer = rematch(bob, game_id).json()
    assert (offer["origin"], offer["status"]) == ("queue", "open")
    new_id = rematch(ada, game_id).json()["game_id"]
    table = table_of(client, new_id)
    assert table.queued and (table.allow_banned, table.allow_not_legal) == (True, True)
    # The queue's own place still names the first game.
    assert place(ada)["game_id"] == game_id


def test_sysop_watching_reads_the_rematch_but_does_not_play_it(client, engine):
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    root = Account(client, "sysop", kind="sysop")
    game_id = lobby_game(client, engine, ada, bob)
    rematch(ada, game_id)
    watched = view(root, game_id)
    assert watched["status"] == "open" and watched["can_offer"] is False
    assert not any(player["you"] for player in watched["players"])
    refused = rematch(root, game_id)
    assert (refused.status_code, refused.json()["code"]) == (403, "not_a_player")
