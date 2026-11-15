"""A private table's game suspended by its players together, and played on (v1.0.0, api/saves.py).

Against the fake engine of test_tables, which gives every player's seat a token and a view, and
keeps recordings and saved games. Covered: the vote (a proposal, a decline, everyone present
agreeing; a player away for long who does not vote, before and during a proposal; a player out
of the game); what may be suspended and by whom; the save being the host's; the table shown as
suspended to each player; playing on once everyone still in the game is back and ready; a
player with another game running; and the host's discard.
"""

import time
import uuid
from collections.abc import Iterator
from contextlib import ExitStack
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketDisconnect
from test_games import Tab
from test_tables import (  # noqa: F401
    Account,
    TableEngine,
    client,
    commander_table,
    concede,
    content,
    deck,
    opened,
    presence,
    url,
)

from api import games, saves
from api.identity import utcnow
from api.models import Game, GameSave, SiteSetting

SAVES = "/api/v1/saves"


@pytest.fixture
def engine() -> TableEngine:
    engine = TableEngine()
    engine.recordings = True
    return engine


@pytest.fixture
def table(client: TestClient) -> Iterator[TestClient]:  # noqa: F811
    """Save and resume open to everyone; its rows gone before the module's tables are emptied."""
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.add(SiteSetting(key="rollout.save_resume", value="on", updated_at=utcnow()))
        db.commit()
    yield client
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(text("DELETE FROM game_saves"))
        db.execute(text("DELETE FROM site_settings"))
        db.commit()


def players(table: TestClient, *names: str) -> list[Account]:
    return [Account(table, name, admin=True) for name in names]


def started(
    table: TestClient, host: Account, guests: list[Account], **extra: Any
) -> tuple[str, str]:
    """A private Commander table with one bot, started: its code and its game."""
    code = commander_table(table, host, guests, bots=1, **({"visibility": "private"} | extra))
    answer = host.send("POST", f"/api/v1/tables/{code}/start")
    assert answer.status_code == 200, answer.text
    return code, str(answer.json()["game_id"])


def agree(account: Account, code: str) -> Any:
    return account.send("POST", f"/api/v1/tables/{code}/suspension")


def ready(account: Account, code: str) -> Any:
    return account.send("POST", f"/api/v1/tables/{code}/suspension/ready")


def status_of(table: TestClient, game_id: str) -> str:
    with Session(table.app.state.database) as db:  # type: ignore[attr-defined]
        game = db.get(Game, uuid.UUID(game_id))
        assert game is not None
        return game.status


def save_of(table: TestClient, game_id: str) -> GameSave:
    with Session(table.app.state.database, expire_on_commit=False) as db:  # type: ignore[attr-defined]
        found = db.scalars(
            select(GameSave)
            .where(GameSave.game_id == uuid.UUID(game_id))
            .order_by(GameSave.saved_at.desc())
        ).first()
        assert found is not None
        return found


def told_saved(tab: Tab, game_id: str, code: str) -> dict[str, Any]:
    """The tab is told the game is saved, with its table, and is let go."""
    told = tab.until("saved")
    assert (told["game_id"], told["table"]) == (game_id, code)
    with pytest.raises(WebSocketDisconnect):
        while True:
            tab.receive()
    return told


def test_the_players_of_a_private_table_suspend_its_game_together_and_play_it_on(
    table: TestClient, engine: TableEngine
) -> None:
    ada, bob, cara = players(table, "ada", "bob", "cara")
    code, game_id = started(table, ada, [bob, cara])
    summary = bob.get(f"/api/v1/games/{game_id}").json()["game"]
    assert summary["table"] == {"code": code, "suspendable": True}
    old = dict(engine.games[game_id].tokens)
    ada_seen: list[str] = []
    bob_seen: list[str] = []
    with ExitStack() as stack:
        ada_tab = opened(ada, game_id, ada_seen, stack)
        bob_tab = opened(bob, game_id, bob_seen, stack)
        cara_tab = opened(cara, game_id, [], stack)
        presence(ada_tab, **{"2": {"connected": True}})

        # Bob proposes: everyone present must agree, and the whole table is told.
        proposed = agree(bob, code)
        assert proposed.status_code == 200, proposed.text
        assert proposed.json() == {
            "status": "voting",
            "proposed_by": 1,
            "agreed": [1],
            "needed": [0, 1, 2],
            "save_id": None,
        }
        asked = ada_tab.until("suspension")
        assert (asked["proposed_by"], asked["agreed"], asked["needed"]) == (1, [1], [0, 1, 2])
        # Cara declines: the proposal is over for everyone, and the game plays on.
        assert cara.send("DELETE", f"/api/v1/tables/{code}/suspension").status_code == 204
        over = ada_tab.until("suspension", declined_by=2)
        assert (over["proposed_by"], over["agreed"]) == (None, [])
        assert status_of(table, game_id) == "active" and engine.saves == []

        # Proposed again, and agreed to by one after another: the last agreement suspends it.
        assert agree(bob, code).json()["agreed"] == [1]
        assert agree(ada, code).json() == {
            "status": "voting",
            "proposed_by": 1,
            "agreed": [0, 1],
            "needed": [0, 1, 2],
            "save_id": None,
        }
        done = agree(cara, code)
        assert done.status_code == 200, done.text
        assert done.json()["status"] == "suspended"
        save_id = done.json()["save_id"]
        for tab in (ada_tab, bob_tab, cara_tab):
            assert told_saved(tab, game_id, code)["save_id"] == save_id

    # The engine holds the game, nothing follows it, and it is nobody's running game.
    assert game_id in engine.saved and game_id not in engine.games
    assert status_of(table, game_id) == "saved"
    assert uuid.UUID(game_id) not in table.app.state.games.games  # type: ignore[attr-defined]
    with Session(table.app.state.database) as db:  # type: ignore[attr-defined]
        assert [games.active_games_of(db, who.id) for who in (ada, bob, cara)] == [0, 0, 0]
    # The save is the host's: one of ada's five, kept the thirty days.
    save = save_of(table, game_id)
    assert (save.user_id, str(save.id)) == (ada.id, save_id)
    assert (save.expires_at - save.saved_at).days == 30
    listed = ada.get(SAVES).json()
    assert (listed["held"], listed["saves"]) == (1, [])
    assert [(found["code"], found["you_host"]) for found in listed["tables"]] == [(code, True)]
    guest = bob.get(SAVES).json()
    assert (guest["held"], guest["saves"]) == (0, [])
    assert [(found["code"], found["you_host"]) for found in guest["tables"]] == [(code, False)]
    # A table's game is played on at its table, not by its host alone.
    alone = ada.send("POST", f"{SAVES}/{save_id}/resume")
    assert alone.status_code == 409 and alone.json()["code"] == "table_save"

    # Each player sees the table suspended, and who is ready to play on.
    view = bob.get(f"/api/v1/tables/{code}").json()
    assert view["status"] == "suspended" and view["game_id"] == game_id
    assert view["suspended"]["save_id"] == save_id and view["suspended"]["host"] == "ada"
    assert [
        (found["handle"], found["needed"], found["ready"]) for found in view["suspended"]["players"]
    ] == [
        ("ada", True, False),
        ("bob", True, False),
        ("cara", True, False),
    ]
    # Someone who does not sit there is shown no more than of any started table.
    dan = Account(table, "dan", admin=True)
    assert dan.get(f"/api/v1/tables/{code}").json()["suspended"] is None
    assert ready(dan, code).json()["code"] == "not_in_game"

    # Back one after another: the game is played on only when the last of them is ready.
    after_bob = ready(bob, code).json()
    assert after_bob["status"] == "suspended"
    assert [found["ready"] for found in after_bob["suspended"]["players"]] == [False, True, False]
    unready = bob.send("DELETE", f"/api/v1/tables/{code}/suspension/ready").json()
    assert [found["ready"] for found in unready["suspended"]["players"]] == [False, False, False]
    assert ready(bob, code).json()["status"] == "suspended"
    assert ready(cara, code).json()["status"] == "suspended"
    assert engine.attaches == []
    played_on = ready(ada, code)
    assert played_on.status_code == 200, played_on.text
    assert (played_on.json()["status"], played_on.json()["game_id"]) == ("started", game_id)
    assert played_on.json()["suspended"] is None
    assert engine.attaches == [game_id]
    assert status_of(table, game_id) == "active"
    assert save_of(table, game_id).ended_reason == "resumed"
    assert ada.get(SAVES).json()["tables"] == []
    fake = engine.games[game_id]
    assert all(fake.tokens[seat] != old[seat] for seat in old)
    with ExitStack() as stack:
        ada_tab = opened(ada, game_id, ada_seen, stack)
        bob_tab = opened(bob, game_id, bob_seen, stack)
        assert ada_tab.snapshot(1_000_000)["view"]["hand"] == [{"name": "Secret of seat 0"}]
        assert bob_tab.snapshot(1_000_000)["view"]["hand"] == [{"name": "Secret of seat 1"}]
        # It is a running table's game again: a seat concedes, and the others play on.
        assert concede(bob_tab, game_id)["status"] == 200
        presence(ada_tab, **{"1": {"left": "conceded"}})
    # No tab was shown another seat's cards, before the suspension or after, or any token.
    assert all(f"Secret of seat {seat}" not in "\n".join(ada_seen) for seat in (1, 2))
    assert all(f"Secret of seat {seat}" not in "\n".join(bob_seen) for seat in (0, 2))
    for token in (*old.values(), *fake.tokens.values()):
        assert token not in "\n".join(ada_seen + bob_seen)


def test_a_player_away_for_long_does_not_vote(
    table: TestClient, engine: TableEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The owner's rule: a table can pause when someone drops. A proposal waiting on a player
    who then stays away is carried out once they have been away long enough; and a player
    already away that long is not asked at all."""
    monkeypatch.setattr(games, "AWAY_SECONDS", 0.6)
    ada, bob = players(table, "ada", "bob")
    code, game_id = started(table, ada, [bob])
    seen: list[str] = []
    with ExitStack() as stack:
        ada_tab = opened(ada, game_id, seen, stack)
        with bob.socket(game_id) as bob_socket:
            bob_socket.send_json(bob.hello())
            Tab(bob_socket, []).until("welcome")
            presence(ada_tab, **{"1": {"connected": True}})
            # Bob is there, so his agreement is needed.
            assert agree(ada, code).json() == {
                "status": "voting",
                "proposed_by": 0,
                "agreed": [0],
                "needed": [0, 1],
                "save_id": None,
            }
        # His tab closes. Once he has been away long enough, everyone left has agreed.
        told_saved(ada_tab, game_id, code)
    assert status_of(table, game_id) == "saved"
    assert save_of(table, game_id).user_id == ada.id

    # Both are still in the game, so both must be back for it to be played on.
    assert ready(ada, code).json()["status"] == "suspended"
    assert ready(bob, code).json()["status"] == "started"
    # Bob opens no tab: away from the start, and after a while not asked.
    with ExitStack() as stack:
        ada_tab = opened(ada, game_id, seen, stack)
        presence(ada_tab, **{"1": {"connected": False, "removable": True}})
        alone = agree(ada, code)
        assert alone.status_code == 200, alone.text
        assert (alone.json()["status"], alone.json()["needed"]) == ("suspended", [0])
        told_saved(ada_tab, game_id, code)
    assert status_of(table, game_id) == "saved"


def test_what_is_suspended_and_by_whom(
    table: TestClient, engine: TableEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    ada, bob, cara, dan = players(table, "ada", "bob", "cara", "dan")
    # A public table's game is not suspended by its players.
    public, public_game = started(table, ada, [bob], visibility="public")
    assert bob.get(f"/api/v1/games/{public_game}").json()["game"]["table"]["suspendable"] is False
    refused = agree(ada, public)
    assert refused.status_code == 409 and refused.json()["code"] == "not_private"
    assert ada.send("POST", f"/api/v1/games/{public_game}/save").json()["code"] == "not_solo"
    for who in (ada, bob):
        with who.socket(public_game) as socket:
            socket.send_json(who.hello())
            concede(Tab(socket, []), public_game)

    code, game_id = started(table, cara, [dan, ada])
    # Someone who does not play it has no say, and one player's own save is refused.
    assert agree(bob, code).json()["code"] == "not_in_game"
    assert bob.send("DELETE", f"/api/v1/tables/{code}/suspension").json()["code"] == "not_in_game"
    assert cara.send("POST", f"/api/v1/games/{game_id}/save").json()["code"] == "not_solo"
    with ExitStack() as stack:
        cara_tab, dan_tab, ada_tab = (opened(who, game_id, [], stack) for who in (cara, dan, ada))
        presence(cara_tab, **{"2": {"connected": True}})
        # A player out of the game no longer votes: the others' agreement is enough.
        assert concede(ada_tab, game_id)["status"] == 200
        presence(cara_tab, **{"2": {"left": "conceded"}})
        assert agree(ada, code).json()["code"] == "not_in_game"
        # The host holds as many saves as an account may: said before anyone is asked.
        monkeypatch.setattr(saves, "SAVE_LIMIT", 0)
        full = agree(dan, code)
        assert full.status_code == 409 and full.json()["code"] == "save_limit"
        monkeypatch.setattr(saves, "SAVE_LIMIT", 5)
        assert agree(dan, code).json()["needed"] == [0, 1]
        # The engine cannot save it: the proposal is over, the table is told why, the game goes on.
        engine.save_refusal = (409, {"code": "not_recorded"})
        failed = agree(cara, code)
        assert failed.status_code == 409 and failed.json()["code"] == "save_unavailable"
        told = dan_tab.until("suspension", proposed_by=None)
        assert "keeps no recording" in told["refused"]
        assert status_of(table, game_id) == "active"
        # Followed again: what the game does next reaches the table.
        fake = engine.games[game_id]
        with engine.lock:
            fake.revision += 1
            moved = fake.revision
        assert dan_tab.snapshot(moved)["game_id"] == game_id
        # And suspended when it can be.
        assert agree(dan, code).json()["status"] == "voting"
        assert agree(cara, code).json()["status"] == "suspended"
    # The player who conceded is shown the table, and is not needed to play on.
    seats = ada.get(f"/api/v1/tables/{code}").json()["suspended"]["players"]
    assert [(found["handle"], found["needed"]) for found in seats] == [
        ("cara", True),
        ("dan", True),
        ("ada", False),
    ]
    assert ready(ada, code).json()["code"] == "not_in_game"


def test_a_workflow_that_is_off_suspends_nothing(client: TestClient, engine: TableEngine) -> None:  # noqa: F811
    ada, bob = (Account(client, name, admin=True) for name in ("ada", "bob"))
    code = commander_table(client, ada, [bob], bots=1, visibility="private")
    game_id = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
    for method, path in (
        ("POST", f"/api/v1/tables/{code}/suspension"),
        ("DELETE", f"/api/v1/tables/{code}/suspension"),
        ("POST", f"/api/v1/tables/{code}/suspension/ready"),
        ("DELETE", f"/api/v1/tables/{code}/suspension/ready"),
    ):
        assert ada.send(method, path).status_code == 404
    assert ada.get(f"/api/v1/tables/{code}").json()["status"] == "started"
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        assert db.get(Game, uuid.UUID(game_id)).status == "active"  # type: ignore[union-attr]


def test_a_player_with_another_game_running_is_not_ready(
    table: TestClient, engine: TableEngine
) -> None:
    ada, bob = players(table, "ada", "bob")
    code, game_id = started(table, ada, [bob])
    with ExitStack() as stack:
        ada_tab, bob_tab = (opened(who, game_id, [], stack) for who in (ada, bob))
        presence(ada_tab, **{"1": {"connected": True}})
        assert agree(ada, code).json()["status"] == "voting"
        assert agree(bob, code).json()["status"] == "suspended"
    # Suspended, the game is nobody's running game: bob plays another meanwhile.
    other = bob.send(
        "POST",
        "/api/v1/practice-games",
        {"format": "commander", "deck_id": deck(bob, table, "commander", "Another")},
    )
    assert other.status_code == 201, other.text
    busy = ready(bob, code)
    assert busy.status_code == 409 and busy.json()["code"] == "game_limit"
    assert ready(ada, code).json()["status"] == "suspended"
    assert bob.send("POST", f"/api/v1/games/{other.json()['id']}/close").status_code == 200
    assert ready(bob, code).json()["status"] == "started"
    assert status_of(table, game_id) == "active"


def test_the_host_alone_discards_a_suspended_game(table: TestClient, engine: TableEngine) -> None:
    ada, bob = players(table, "ada", "bob")
    code, game_id = started(table, ada, [bob])
    with ExitStack() as stack:
        ada_tab, bob_tab = (opened(who, game_id, [], stack) for who in (ada, bob))
        presence(ada_tab, **{"1": {"connected": True}})
        agree(bob, code)
        save_id = agree(ada, code).json()["save_id"]
    assert bob.send("DELETE", f"{SAVES}/{save_id}").status_code == 404
    assert status_of(table, game_id) == "saved"
    assert ada.send("DELETE", f"{SAVES}/{save_id}").status_code == 204
    assert engine.discarded == [game_id]
    assert status_of(table, game_id) == "interrupted"
    # The table is no longer suspended, and nobody gets ready for a game that is over.
    view = bob.get(f"/api/v1/tables/{code}").json()
    assert (view["status"], view["suspended"]) == ("started", None)
    assert ready(bob, code).json()["code"] == "not_suspended"
    assert bob.get(SAVES).json()["tables"] == []
    deadline = time.monotonic() + 2
    while bob.get(f"/api/v1/games/{game_id}").json()["game"]["status"] != "interrupted":
        assert time.monotonic() < deadline
