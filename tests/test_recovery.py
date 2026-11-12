"""Games that outlive a restart (v0.9.9): the engine keeps a recording of every game, and the API
asks it for each game it still counts as running.

Against the fake engine of test_games, which here keeps recordings: a running game is given new
tokens, a game of an engine that died is taken up from its recording (its revisions far on), and a
game that is over is answered with its result. Covered: the engine's restart while the API follows
a game, the API's own restart (with the game still running in the engine, taken up by it, or over
meanwhile), an engine that is not ready yet, and what the engine cannot give back, which ends
interrupted as every running game did before.
"""

import time
import uuid
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from test_games import Account, FakeEngine, Tab, build, connect

from api import games
from api.models import Game


@pytest.fixture
def database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    url = f"sqlite:///{tmp_path}/recovery.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    return url


@pytest.fixture
def engine() -> FakeEngine:
    engine = FakeEngine()
    engine.recordings = True
    return engine


def hub_of(client: TestClient) -> games.GameHub:
    return client.app.state.games  # type: ignore[attr-defined, no-any-return]


def status_of(client: TestClient, game_id: str) -> tuple[str, dict[str, Any] | None]:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        game = db.get(Game, uuid.UUID(game_id))
        assert game is not None
        return game.status, game.result  # type: ignore[return-value]


def followed(client: TestClient, game_id: str, timeout: float = 5.0) -> None:
    """Waits until the API follows the game again."""
    deadline = time.monotonic() + timeout
    hub = hub_of(client)
    while uuid.UUID(game_id) not in hub.games or hub.reviving:
        assert time.monotonic() < deadline, f"game {game_id} is not followed: {hub.attached}"
        time.sleep(0.02)


def settled(
    client: TestClient, game_id: str, wanted: str, timeout: float = 5.0
) -> dict[str, Any] | None:
    deadline = time.monotonic() + timeout
    while True:
        status, result = status_of(client, game_id)
        if status == wanted:
            return result
        assert time.monotonic() < deadline, f"game {game_id} is {status}, not {wanted}"
        time.sleep(0.02)


def test_a_game_the_engine_lost_is_given_back_and_played_on(
    database: str, engine: FakeEngine
) -> None:
    """The engine dies under a game a player is in, and comes back with its recording. The API's
    follower finds the game unknown, asks for it again and follows on: the tab, which never
    disconnected, gets the game's view again and plays on with the engine's new token."""
    with connect(build(database, engine)) as client:
        ada = Account(client, "ada")
        game_id = ada.post("/api/v1/practice-games", {}).json()["id"]
        old_token = engine.game(game_id).token
        seen: list[str] = []
        with ada.socket(game_id) as socket:
            socket.send_json(ada.hello(control=True))
            tab = Tab(socket, seen)
            first = tab.snapshot(1)
            tab.command(first)
            assert tab.until("command_result")["status"] == 200
            before = tab.snapshot(2)

            engine.restart()

            again = tab.snapshot(1_000_000)
            assert again["game_id"] == game_id
            assert again["prompt"] is not None
            assert engine.attaches == [game_id]
            assert engine.game(game_id).token != old_token
            assert hub_of(client).attached["recovered"] == 1
            # The log is the game's, with what was played before the engine died.
            assert again["log_count"] == before["log_count"]
            # Played on, through the token the engine gave back.
            tab.command(again)
            assert tab.until("command_result")["status"] == 200
            tab.snapshot(again["revision"] + 1)
            assert status_of(client, game_id)[0] == "active"
            # No seat token ever reached the tab.
            for token in (old_token, engine.game(game_id).token):
                assert all(token not in message for message in seen)
        closed = ada.post(f"/api/v1/games/{game_id}/close")
        assert closed.status_code == 200 and closed.json()["status"] == "finished"


def test_a_game_the_engine_cannot_give_back_ends_interrupted(database: str) -> None:
    """An engine that keeps no recordings (or one before v0.9.9, which has no such route) loses
    the game for good: it ends interrupted, as it always did."""
    engine = FakeEngine()
    with connect(build(database, engine)) as client:
        ada = Account(client, "ada")
        game_id = ada.post("/api/v1/practice-games", {}).json()["id"]
        with ada.socket(game_id) as socket:
            socket.send_json(ada.hello(control=True))
            tab = Tab(socket, [])
            tab.snapshot(1)
            engine.restart()
            assert tab.until("interrupted")["game_id"] == game_id
        assert settled(client, game_id, "interrupted") is None
        assert engine.attaches == [game_id]
        # Its player may start another.
        assert ada.post("/api/v1/practice-games", {}).status_code == 201


def test_the_apis_restart_keeps_a_game_that_is_still_running(
    database: str, engine: FakeEngine
) -> None:
    """The API restarts under a game the engine is still running. The new process asks for the
    game, is given new tokens (the old ones were the old process's alone, and stop working), and
    follows it: its player connects again and plays on, and the game still counts as theirs."""
    with connect(build(database, engine)) as first:
        ada = Account(first, "ada")
        game_id = ada.post("/api/v1/practice-games", {}).json()["id"]
        with ada.socket(game_id) as socket:
            socket.send_json(ada.hello(control=True))
            tab = Tab(socket, [])
            tab.command(tab.snapshot(1))
            assert tab.until("command_result")["status"] == 200
        old_token = engine.game(game_id).token

    with connect(build(database, engine)) as restarted:
        ada.http = restarted
        followed(restarted, game_id)
        assert engine.attaches == [game_id]
        assert engine.game(game_id).token != old_token
        assert hub_of(restarted).attached == {
            "attached": 1,
            "recovered": 0,
            "finished": 0,
            "interrupted": 0,
        }
        assert status_of(restarted, game_id)[0] == "active"
        assert game_id not in engine.closed
        # Still its player's one game.
        assert ada.post("/api/v1/practice-games", {}).json()["code"] == "game_limit"
        with ada.socket(game_id) as socket:
            socket.send_json(ada.hello(control=True))
            tab = Tab(socket, [])
            snapshot = tab.snapshot(2)
            assert snapshot["log_count"] == 2
            tab.command(snapshot)
            assert tab.until("command_result")["status"] == 200
            tab.snapshot(3)
        closed = ada.post(f"/api/v1/games/{game_id}/close")
        assert closed.status_code == 200 and closed.json()["status"] == "finished"
        assert ada.post("/api/v1/practice-games", {}).status_code == 201


def test_both_restart_and_the_game_is_taken_up(database: str, engine: FakeEngine) -> None:
    """The whole stack goes down (the host restarts): the engine comes back with its recordings
    and the API asks for the game, which is taken up where it stood."""
    with connect(build(database, engine)) as first:
        ada = Account(first, "ada")
        game_id = ada.post("/api/v1/practice-games", {}).json()["id"]
    engine.restart()
    with connect(build(database, engine)) as restarted:
        ada.http = restarted
        followed(restarted, game_id)
        assert hub_of(restarted).attached["recovered"] == 1
        with ada.socket(game_id) as socket:
            socket.send_json(ada.hello(control=True))
            tab = Tab(socket, [])
            snapshot = tab.snapshot(1_000_000)
            tab.command(snapshot)
            assert tab.until("command_result")["status"] == 200


def test_a_game_that_ended_while_the_api_was_away_is_recorded_with_its_result(
    database: str, engine: FakeEngine
) -> None:
    """The game is won while no API process follows it. The next process asks for it, is told
    its result and records it as a follower would have: finished, with the win, once."""
    with connect(build(database, engine)) as first:
        ada = Account(first, "ada")
        game_id = ada.post("/api/v1/practice-games", {}).json()["id"]
    won = {
        "kind": "completed",
        "winner_seat": 0,
        "winner_seats": [0],
        "draw": False,
        "turns": 7,
        "conceded_seats": [],
        "error": None,
    }
    engine.game(game_id).result = won
    engine.game(game_id).revision += 1

    with connect(build(database, engine)) as restarted:
        ada.http = restarted
        result = settled(restarted, game_id, "finished")
        assert result is not None and result["winner_seat"] == 0 and result["turns"] == 7
        assert hub_of(restarted).attached["finished"] == 1
        assert uuid.UUID(game_id) not in hub_of(restarted).games
        assert game_id not in engine.closed
        mine = ada.get("/api/v1/games").json()
        assert [game["status"] for game in mine if game["id"] == game_id] == ["finished"]
        assert ada.post("/api/v1/practice-games", {}).status_code == 201

    # A third process finds nothing left to ask for: the end is recorded once.
    attaches = len(engine.attaches)
    with connect(build(database, engine)) as third:
        time.sleep(0.2)
        assert status_of(third, game_id)[0] == "finished"
        assert [each for each in engine.attaches[attaches:] if each == game_id] == []


def test_an_engine_that_is_still_starting_is_asked_again(
    database: str, engine: FakeEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The API and the engine start together and the engine is still loading its cards: the game
    is asked for again until the engine answers, and tabs that connect meanwhile are told to try
    again, not that the game is gone."""
    monkeypatch.setattr(games, "RETRY_SECONDS", 0.3)
    with connect(build(database, engine)) as first:
        ada = Account(first, "ada")
        game_id = ada.post("/api/v1/practice-games", {}).json()["id"]
    engine.restart()
    engine.attach_failures = 3
    with connect(build(database, engine)) as restarted:
        ada.http = restarted
        assert uuid.UUID(game_id) in hub_of(restarted).reviving
        with ada.socket(game_id) as socket:
            error = socket.receive_json()
            assert error == {"type": "error", "code": "game_recovering"}
            with pytest.raises(Exception) as closed:
                socket.receive_json()
            assert getattr(closed.value, "code", None) == games.CLOSE_RECOVERING
        followed(restarted, game_id)
        assert engine.attaches.count(game_id) == 4
        with ada.socket(game_id) as socket:
            socket.send_json(ada.hello(control=True))
            Tab(socket, []).snapshot(1_000_000)


def test_an_engine_that_never_answers_gives_the_game_up(
    database: str, engine: FakeEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Asked for longer than REATTACH_SECONDS with no answer, the game ends interrupted and is
    closed in the engine should it come back with it."""
    monkeypatch.setattr(games, "RETRY_SECONDS", 0.1)
    monkeypatch.setattr(games, "REATTACH_SECONDS", 0.5)
    with connect(build(database, engine)) as first:
        ada = Account(first, "ada")
        game_id = ada.post("/api/v1/practice-games", {}).json()["id"]
    engine.attach_failures = 10_000
    with connect(build(database, engine)) as restarted:
        ada.http = restarted
        assert settled(restarted, game_id, "interrupted") is None
        deadline = time.monotonic() + 5
        while game_id not in engine.closed:
            assert time.monotonic() < deadline
            time.sleep(0.02)
        assert hub_of(restarted).attached["interrupted"] == 1
        assert ada.post("/api/v1/practice-games", {}).status_code == 201
