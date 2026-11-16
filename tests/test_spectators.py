"""Spectators at a table (v1.0.0, api/spectators.py and api/watching.py): the host's setting,
the invitations of a table's players, the public view and nothing else over the game's socket,
the delay where anyone may watch, and removal (the owner's decisions of 2026-11-16). Behind the
gate spectators."""

import asyncio
import json
import time
import uuid
from collections.abc import Iterator
from contextlib import ExitStack
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketDisconnect
from test_games import Tab
from test_matches import end, ready
from test_matches import until as until_match
from test_tables import (
    Account,
    TableEngine,
    TableGame,
    client,
    content,
    deck,
    opened,
    until_finished,
    url,
)

from api import games

__all__ = ["client", "content", "url"]

CONTEXT = {
    "page": "#game",
    "app_version": "1.0.0",
    "viewport_width": 1280,
    "viewport_height": 800,
    "pixel_ratio": 1,
}

SECRET = "Secret of seat"


class WatchEngine(TableEngine):
    """The tables' engine, with the game's public view for its spectator token: every player
    under ``opponents``, no ``you``, no hand (docs/engine/commander-tables.md)."""

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        parts = request.url.path.removeprefix("/v1/service/").split("/")
        game = self.games.get(parts[1]) if len(parts) == 3 else None
        given = request.headers.get("authorization", "")
        if (
            isinstance(game, TableGame)
            and parts[2] == "view"
            and given == f"Bearer {game.spectator}"
        ):
            return await self.public_view(game, request.url.params)
        return await super().__call__(request)

    async def public_view(self, game: TableGame, params: httpx.QueryParams) -> httpx.Response:
        since = int(params.get("since", -1))
        deadline = time.monotonic() + min(int(params.get("wait_ms", 0)), 1000) / 1000
        log_from = int(params["log_from"]) if "log_from" in params else None
        while True:
            with self.lock:
                if game.revision > since or game.result or time.monotonic() >= deadline:
                    snapshot = game.snapshot(log_from)
                    snapshot["seat"] = None
                    snapshot["prompt"] = None
                    snapshot["status"] = "finished" if game.result else "spectating"
                    snapshot["view"] = {
                        "seat": None,
                        "turn": 1,
                        "hand": [],
                        "you": None,
                        "opponents": [
                            {"seat": seat, "name": f"Player {seat}", "life": 20}
                            for seat in range(len(game.body["seats"]))
                        ],
                    }
                    return httpx.Response(200, json=snapshot)
            await asyncio.sleep(0.01)


@pytest.fixture
def engine() -> WatchEngine:
    return WatchEngine()


@pytest.fixture
def matches_cleared(url: str) -> Iterator[None]:
    """A test that plays a match leaves none behind: asked for before the client, so that it
    clears after the client has."""
    yield
    database = create_engine(url)
    with Session(database) as db:
        for table in ("match_players", "matches"):
            db.execute(text(f"DELETE FROM {table}"))
        db.commit()
    database.dispose()


def staged(client: TestClient, stage: str = "on") -> Account:
    root = Account(client, "root-" + uuid.uuid4().hex[:8], kind="sysop")
    changed = root.send("PUT", "/api/v1/admin/rollout/spectators", {"stage": stage})
    assert changed.status_code == 200, changed.text
    return root


def people(client: TestClient, count: int) -> list[Account]:
    tag = uuid.uuid4().hex[:6]
    made = []
    for name in ("ada", "bob", "cy", "dee", "eve")[:count]:
        account = Account(client, f"{name}{tag}", admin=name in ("ada", "bob"))
        account.handle = f"{name}{tag}"
        made.append(account)
    return made


def befriend(one: Account, other: Account) -> None:
    assert one.send("PUT", f"/api/v1/friends/{other.id}").status_code == 200
    assert other.send("PUT", f"/api/v1/friends/{one.id}").json()["friendship"] == "friends"


def table(host: Account, client: TestClient, **extra: Any) -> Any:
    body = {"format": "legacy", "deck_id": deck(host, client)} | extra
    return host.send("POST", "/api/v1/tables", body)


def started(host: Account, guest: Account, client: TestClient, **extra: Any) -> tuple[str, str]:
    """A two-player Legacy table, started: its code and its game."""
    made = table(host, client, **extra)
    assert made.status_code == 201, made.text
    code = made.json()["code"]
    joined = guest.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": deck(guest, client)})
    assert joined.status_code == 200, joined.text
    assert guest.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True}).status_code == 200
    begun = host.send("POST", f"/api/v1/tables/{code}/start")
    assert begun.status_code == 200, begun.text
    return code, begun.json()["game_id"]


def watch(account: Account, game_id: str, seen: list[str], stack: ExitStack, **hello: Any) -> Tab:
    socket = stack.enter_context(account.socket(game_id))
    socket.send_json(account.hello(**hello))
    tab = Tab(socket, seen)
    return tab


def refusal(account: Account, game_id: str) -> int:
    """The code the game's socket closes with for an account it does not let in."""
    with ExitStack() as stack:
        tab = watch(account, game_id, [], stack)
        with pytest.raises(WebSocketDisconnect) as refused:
            for _ in range(5):
                tab.receive()
    return int(refused.value.code)


def test_the_host_sets_who_may_watch_and_players_invite_their_friends(client, engine):
    root = staged(client, "off")
    ada, bob, cy, dee, eve = people(client, 5)
    befriend(ada, cy)
    befriend(bob, dee)

    # Behind the gate: a table is not opened to spectators while it is closed, and one that
    # lets nobody watch is opened as ever.
    assert table(ada, client, visibility="private", spectators="invited").status_code == 404
    assert root.send("PUT", "/api/v1/admin/rollout/spectators", {"stage": "on"}).status_code == 200
    # Anyone watches only a public table.
    wrong = table(ada, client, visibility="private", spectators="anyone")
    assert (wrong.status_code, wrong.json()["code"]) == (422, "invalid_table")
    made = table(ada, client, visibility="private")
    assert made.status_code == 201 and made.json()["spectators"] == "nobody"
    code = made.json()["code"]
    assert (
        bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": deck(bob, client)}).status_code
        == 200
    )
    path = f"/api/v1/tables/{code}/spectators"

    # Nobody is invited while the host lets nobody watch; the host changes that, and no player
    # is made not ready by it.
    off = ada.send("POST", path, {"players": [str(cy.id)]})
    assert (off.status_code, off.json()["code"]) == (409, "spectators_off")
    assert bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True}).status_code == 200
    refused = bob.send("PATCH", f"/api/v1/tables/{code}", {"spectators": "invited"})
    assert (refused.status_code, refused.json()["code"]) == (403, "not_host")
    changed = ada.send("PATCH", f"/api/v1/tables/{code}", {"spectators": "invited"})
    assert changed.status_code == 200, changed.text
    assert (changed.json()["spectators"], changed.json()["spectator_delay"]) == ("invited", 0)
    assert changed.json()["can_start"] is True

    # Each seated player invites their own friends, and only those.
    stranger = ada.send("POST", path, {"players": [str(dee.id)]})
    assert (stranger.status_code, stranger.json()["code"]) == (422, "not_friend")
    outsider = cy.send("POST", path, {"players": [str(ada.id)]})
    assert outsider.status_code in (404, 409)
    assert ada.send("POST", path, {"players": [str(cy.id)]}).status_code == 200
    listed = bob.send("POST", path, {"players": [str(dee.id)]})
    assert listed.status_code == 200, listed.text
    spectators = listed.json()
    assert (spectators["setting"], spectators["can_invite"], spectators["can_remove"]) == (
        "invited",
        True,
        False,
    )
    assert [
        (s["player"]["handle"], s["invited_by"], s["yours"]) for s in spectators["invited"]
    ] == [
        (cy.handle, ada.handle, False),
        (dee.handle, bob.handle, True),
    ]
    # Invited again, nobody is told twice.
    assert ada.send("POST", path, {"players": [str(cy.id)]}).status_code == 200
    bell = [item for item in cy.get("/api/v1/notifications").json()["items"]]
    told = [item for item in bell if item["kind"] == "watch_invite"]
    assert len(told) == 1 and told[0]["actor"]["handle"] == ada.handle
    assert told[0]["table"]["code"] == code

    # The invited read the table, are told they may watch, and see who else is invited; a
    # stranger is told of no spectators.
    seen = cy.get(f"/api/v1/tables/{code}").json()
    assert (seen["watching"], seen["your_seat"], seen["game_id"]) == (True, None, None)
    assert cy.get(path).json()["invited"][0]["you"] is True
    assert eve.get(path).status_code == 404
    assert eve.get(f"/api/v1/tables/{code}").json()["watching"] is False
    waiting = cy.get("/api/v1/spectating").json()
    assert [(w["code"], w["game_id"], w["invited"], w["delay_seconds"]) for w in waiting] == [
        (code, None, True, 0)
    ]

    # The host removes any spectator; a player withdraws their own; nobody another's.
    assert bob.send("DELETE", f"{path}/{cy.id}").status_code == 403
    assert bob.send("DELETE", f"{path}/{dee.id}").status_code == 200
    assert ada.send("DELETE", f"{path}/{cy.id}").json()["invited"] == []
    assert cy.get(f"/api/v1/tables/{code}").json()["watching"] is False
    # A spectator leaves by themselves.
    assert ada.send("POST", path, {"players": [str(cy.id)]}).status_code == 200
    assert cy.send("DELETE", f"{path}/{cy.id}").status_code == 200
    assert cy.get(path).status_code == 404
    # Back to nobody: every invitation goes with it.
    assert ada.send("POST", path, {"players": [str(cy.id)]}).status_code == 200
    assert ada.send("PATCH", f"/api/v1/tables/{code}", {"spectators": "nobody"}).status_code == 200
    assert cy.get(f"/api/v1/tables/{code}").json()["watching"] is False
    assert ada.send("POST", f"/api/v1/tables/{code}/leave").status_code == 200


def test_a_spectator_sees_the_public_view_and_nothing_else_and_acts_on_nothing(client, engine):
    staged(client)
    ada, bob, cy, eve = people(client, 4)
    befriend(ada, cy)
    code, game_id = started(ada, bob, client, visibility="private", spectators="invited")
    # Invited spectators watch live: the engine is told of no delay.
    assert "spectator_delay_seconds" not in engine.created[-1]
    path = f"/api/v1/tables/{code}/spectators"
    assert ada.send("POST", path, {"players": [str(cy.id)]}).status_code == 200

    # The game as its spectator reads it: no seat, no deck, and the public view drawn from
    # behind its first player. Nobody else is told of the game.
    read = cy.get(f"/api/v1/games/{game_id}")
    assert read.status_code == 200, read.text
    state = read.json()
    assert (state["game"]["spectating"], state["game"]["your_seat"]) == (True, None)
    assert state["game"]["spectator_delay"] == 0
    assert all(seat["deck"] is None for seat in state["game"]["seats"])
    view = state["snapshot"]["view"]
    assert (view["seat"], view["you"]["seat"], view["hand"]) == (0, 0, [])
    assert [player["seat"] for player in view["opponents"]] == [1]
    assert SECRET not in read.text
    assert eve.get(f"/api/v1/games/{game_id}").status_code == 404
    assert cy.get(f"/api/v1/tables/{code}").json()["game_id"] == game_id
    # A spectator has no power over the game.
    assert cy.send("POST", f"/api/v1/games/{game_id}/close").status_code == 404
    assert cy.send("POST", f"/api/v1/games/{game_id}/rematch").status_code == 404

    seen: list[str] = []
    with ExitStack() as stack:
        ada_tab = opened(ada, game_id, [], stack)
        tab = watch(cy, game_id, seen, stack)
        welcome = tab.until("welcome")
        assert (welcome["role"], welcome["seat"], welcome["controlled"]) == (
            "spectator",
            None,
            False,
        )
        first = tab.snapshot(1)
        # Drawn from behind the first player, as the reading was.
        assert (first["view"]["you"]["seat"], first["status"]) == (0, "spectating")
        assert [player["seat"] for player in first["view"]["opponents"]] == [1]

        # Nothing a spectator sends is acted on: no control, no command, no chat, no vote.
        for message in (
            {"type": "take_control"},
            {"type": "chat", "channel": "table", "text": "hello"},
            {"type": "command", "command": {"type": "concede"}},
            {"type": "vote", "seat": 0, "remove": True},
        ):
            tab.socket.send_json(message)
            assert tab.until("error")["code"] == "read_only"

        # The table's chat is its players'; the game's moves reach the spectator.
        ada_tab.socket.send_json(
            {
                "type": "chat",
                "channel": "table",
                "text": "for the table",
                "client_id": str(uuid.uuid4()),
            }
        )
        assert ada_tab.until("chat")["message"]["body"] == "for the table"
        with engine.lock:
            engine.games[game_id].revision += 1
            engine.games[game_id].log.append("A public move.")
        moved = tab.snapshot(2)
        assert "A public move." in json.dumps(moved["log"])

        # Removed by the host: the connection closes, and the game is read no more.
        assert ada.send("DELETE", f"{path}/{cy.id}").status_code == 200
        with pytest.raises(WebSocketDisconnect) as closed:
            for _ in range(50):
                tab.receive()
        assert closed.value.code == 4403
    assert cy.get(f"/api/v1/games/{game_id}").status_code == 404
    # Nothing a spectator was sent held a seat's secret or the table's chat.
    assert seen and not any(SECRET in message or "for the table" in message for message in seen)
    assert refusal(cy, game_id) == 4404


def test_spectators_talk_among_themselves_and_no_player_reads_them(client, engine):
    staged(client)
    ada, bob, cy, dee = people(client, 4)
    befriend(ada, cy)
    befriend(bob, dee)
    code, game_id = started(ada, bob, client, visibility="private", spectators="invited")
    path = f"/api/v1/tables/{code}/spectators"
    assert ada.send("POST", path, {"players": [str(cy.id)]}).status_code == 200
    assert bob.send("POST", path, {"players": [str(dee.id)]}).status_code == 200

    def said(text: str, channel: str = "spectators") -> dict[str, str]:
        return {"type": "chat", "channel": channel, "text": text, "client_id": str(uuid.uuid4())}

    ada_seen: list[str] = []
    cy_seen: list[str] = []
    with ExitStack() as stack:
        ada_tab = opened(ada, game_id, ada_seen, stack)
        cy_tab = watch(cy, game_id, cy_seen, stack)
        dee_tab = watch(dee, game_id, [], stack)
        # A spectator's history is the spectators' own, and it is told of no alliance.
        assert cy_tab.until("chat_history")["messages"] == []
        dee_tab.until("chat_history")
        mine = said("among the watchers")
        cy_tab.socket.send_json(mine)
        line = dee_tab.until("chat")["message"]
        assert (line["channel"], line["body"], line["seat"]) == (
            "spectators",
            "among the watchers",
            None,
        )
        assert line["sender"]["handle"] == cy.handle
        assert cy_tab.until("chat")["message"]["client_id"] == mine["client_id"]

        # A player neither writes there nor reads it; the table's chat stays the players'.
        ada_tab.socket.send_json(said("let me in"))
        assert ada_tab.until("error")["code"] == "invalid_message"
        cy_tab.socket.send_json(said("to the players", "table"))
        assert cy_tab.until("error")["code"] == "read_only"
        ada_tab.socket.send_json(said("for the table", "table"))
        assert ada_tab.until("chat")["message"]["body"] == "for the table"

        # One who connects later is given what the spectators said, and nothing of the table's.
        late = watch(dee, game_id, cy_seen, stack)
        bodies = [each["body"] for each in late.until("chat_history")["messages"]]
        assert bodies == ["among the watchers"]

        # Another spectator reports the line; for a player it does not exist.
        report = {
            "summary": "A spectator",
            "description": "Rude.",
            "context": CONTEXT,
            "message": {"kind": "table", "id": line["id"]},
        }
        assert cy.send("POST", "/api/v1/reports", report).json()["code"] == "own_message"
        assert bob.send("POST", "/api/v1/reports", report).status_code == 404
        filed = dee.send("POST", "/api/v1/reports", report)
        assert filed.status_code == 201, filed.text
    assert not any("among the watchers" in message for message in ada_seen)
    assert not any("for the table" in message for message in cy_seen)


def test_a_rematch_is_watched_by_those_who_watched_the_game(client, engine):
    staged(client)
    ada, bob, cy = people(client, 3)
    befriend(ada, cy)
    code, game_id = started(ada, bob, client, visibility="public", spectators="anyone")
    path = f"/api/v1/tables/{code}/spectators"
    assert ada.send("POST", path, {"players": [str(cy.id)]}).status_code == 200
    with engine.lock:
        engine.games[game_id].concede(1)
    until_finished(ada, game_id)
    # Its spectator still reads how it ended, and has no say in a rematch.
    assert cy.get(f"/api/v1/games/{game_id}").json()["game"]["status"] == "finished"
    assert cy.send("POST", f"/api/v1/games/{game_id}/rematch").status_code == 404

    assert ada.send("POST", f"/api/v1/games/{game_id}/rematch").status_code == 200
    again = bob.send("POST", f"/api/v1/games/{game_id}/rematch")
    assert again.status_code == 200, again.text
    new_id = again.json()["game_id"]
    assert new_id not in (None, game_id)
    # The new table lets the same people watch, as far behind: the engine is told again.
    assert engine.created[-1]["spectator_delay_seconds"] == 60
    listed = {found["game_id"]: found for found in cy.get("/api/v1/spectating").json()}
    assert listed[new_id]["invited"] is True and listed[new_id]["code"] != code
    kept = ada.get(f"/api/v1/tables/{listed[new_id]['code']}/spectators").json()
    assert kept["setting"] == "anyone"
    assert [found["player"]["handle"] for found in kept["invited"]] == [cy.handle]
    assert cy.get("/api/v1/notifications").json()["items"][0]["table"]["code"] == code
    with ExitStack() as stack:
        tab = watch(cy, new_id, [], stack)
        assert tab.until("welcome")["role"] == "spectator"
        assert tab.snapshot(1)["status"] == "spectating"


def test_every_game_of_a_match_is_watched_as_its_first(matches_cleared, client, engine):
    staged(client)
    ada, bob, cy = people(client, 3)
    code, first = started(ada, bob, client, visibility="public", spectators="anyone", best_of=3)
    assert engine.created[-1]["spectator_delay_seconds"] == 60
    match_id = bob.get(f"/api/v1/games/{first}").json()["game"]["match"]["id"]
    end(engine, first, 0)
    until_match(bob, match_id, status="sideboarding")
    ready(bob, match_id, play_first=False)
    second = ready(ada, match_id)["game_id"]
    assert second not in (None, first)
    # The table keeps its first game: the later ones are watched through it, a minute behind.
    assert engine.created[-1]["spectator_delay_seconds"] == 60
    read = cy.get(f"/api/v1/games/{second}")
    assert read.status_code == 200, read.text
    assert read.json()["game"]["spectating"] is True
    assert read.json()["game"]["spectator_delay"] == 60
    assert [found["game_id"] for found in cy.get("/api/v1/spectating").json()] == [second]
    assert cy.get(f"/api/v1/tables/{code}").json()["game_id"] == second
    assert bob.get(f"/api/v1/tables/{code}").json()["game_id"] == first
    with ExitStack() as stack:
        tab = watch(cy, second, [], stack)
        assert tab.until("welcome")["role"] == "spectator"
        assert tab.snapshot(1)["status"] == "spectating"


def test_a_game_followed_again_after_a_restart_is_still_watched(client, engine):
    staged(client)
    ada, bob, cy, dee = people(client, 4)
    _, watched = started(ada, bob, client, visibility="private", spectators="invited")
    _, unwatched = started(cy, dee, client, visibility="private")
    database = client.app.state.database
    tokens = {0: "seat-0", 1: "seat-1"}
    # The engine hands every game a new spectator token as it is asked for again: it is
    # followed only where the game's table lets anyone watch.
    again = games.revived(database, uuid.UUID(watched), tokens, "watch-again")
    assert again is not None and again.public is not None
    assert (again.public.seat, again.public.token) == (games.SPECTATOR_SEAT, "watch-again")
    alone = games.revived(database, uuid.UUID(unwatched), tokens, "watch-again")
    assert alone is not None and alone.public is None
    assert games.revived(database, uuid.UUID(watched), tokens).public is None  # type: ignore[union-attr]


def test_anyone_watches_a_public_table_a_minute_behind(client, engine):
    staged(client)
    ada, bob, cy = people(client, 3)
    code, game_id = started(ada, bob, client, visibility="public", spectators="anyone")
    # The engine is told the delay as the game starts.
    assert engine.created[-1]["spectator_delay_seconds"] == 60
    assert ada.get(f"/api/v1/tables/{code}").json()["spectator_delay"] == 60

    # A stranger finds the game among those to watch, and watches it.
    listed = cy.get("/api/v1/spectating").json()
    found = next(entry for entry in listed if entry["code"] == code)
    assert (found["game_id"], found["invited"], found["delay_seconds"]) == (game_id, False, 60)
    assert found["players"] == [ada.handle, bob.handle]
    state = cy.get(f"/api/v1/games/{game_id}").json()
    assert (state["game"]["spectating"], state["game"]["spectator_delay"]) == (True, 60)
    seen: list[str] = []
    with ExitStack() as stack:
        tab = watch(cy, game_id, seen, stack)
        assert tab.until("welcome")["role"] == "spectator"
        assert tab.snapshot(1)["view"]["you"]["seat"] == 0
    assert not any(SECRET in message for message in seen)
    # Its players are no spectators of it, and a player who blocks the stranger keeps them out.
    assert ada.get(f"/api/v1/tables/{code}").json()["watching"] is False
    assert bob.send("PUT", f"/api/v1/blocks/{cy.id}").status_code == 200
    assert cy.get(f"/api/v1/games/{game_id}").status_code == 404
    assert all(entry["code"] != code for entry in cy.get("/api/v1/spectating").json())


def test_a_game_nobody_may_watch_has_no_spectators(client, engine):
    root = staged(client)
    ada, bob, cy = people(client, 3)
    befriend(ada, cy)
    code, game_id = started(ada, bob, client, visibility="public")
    assert "spectator_delay_seconds" not in engine.created[-1]
    assert cy.get(f"/api/v1/games/{game_id}").status_code == 404
    assert refusal(cy, game_id) == 4404
    late = ada.send("POST", f"/api/v1/tables/{code}/spectators", {"players": [str(cy.id)]})
    assert (late.status_code, late.json()["code"]) == (409, "spectators_off")
    with engine.lock:
        engine.games[game_id].concede(1)
    until_finished(ada, game_id)

    # With the gate closed again, a table that let spectators in is watched by nobody.
    code, game_id = started(ada, bob, client, visibility="private", spectators="invited")
    path = f"/api/v1/tables/{code}/spectators"
    assert ada.send("POST", path, {"players": [str(cy.id)]}).status_code == 200
    assert cy.get(f"/api/v1/games/{game_id}").status_code == 200
    assert root.send("PUT", "/api/v1/admin/rollout/spectators", {"stage": "off"}).status_code == 200
    assert cy.get(f"/api/v1/games/{game_id}").status_code == 404
    assert cy.get(path).status_code == 404
    assert root.send("PUT", "/api/v1/admin/rollout/spectators", {"stage": "on"}).status_code == 200
