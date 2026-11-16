"""Coaching (v1.0.0, api/coaching.py): a player lets one friend see what they see, their hand
included, against bots and at a private table; the coach acts on nothing; everyone at the game
is told the seat has a coach; a withdrawal stops the coach's next reading and closes their
connections (the owner's decision of 2026-11-16). Behind the gate coaching."""

import uuid
from contextlib import ExitStack
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from test_games import Tab
from test_spectators import WatchEngine, befriend, people, refusal, started, watch
from test_tables import Account, client, content, deck, opened, url

__all__ = ["client", "content", "url"]

SECRET = "Secret of seat"


@pytest.fixture
def engine() -> WatchEngine:
    return WatchEngine()


def staged(client: TestClient, *workflows: str, stage: str = "on") -> Account:
    root = Account(client, "root-" + uuid.uuid4().hex[:8], kind="sysop")
    for workflow in workflows or ("coaching",):
        changed = root.send("PUT", f"/api/v1/admin/rollout/{workflow}", {"stage": stage})
        assert changed.status_code == 200, changed.text
    return root


def practice(account: Account, client: TestClient) -> str:
    made = account.send(
        "POST",
        "/api/v1/practice-games",
        {"format": "legacy", "deck_id": deck(account, client), "bots": [{}]},
    )
    assert made.status_code == 201, made.text
    return str(made.json()["id"])


def playing(
    account: Account, game_id: str, seen: list[str], stack: ExitStack
) -> tuple[Tab, dict[str, Any]]:
    """The player's own tab, holding its seat, and the first view it was sent."""
    socket = stack.enter_context(account.socket(game_id))
    socket.send_json(account.hello(control=True))
    tab = Tab(socket, seen)
    tab.until("welcome")
    return tab, tab.snapshot(1)


def coach(player: Account, game_id: str, friend: Account) -> Any:
    return player.send("POST", f"/api/v1/games/{game_id}/coaches", {"player": str(friend.id)})


def test_a_friend_coaches_a_player_against_the_bots_and_acts_on_nothing(client, engine):
    staged(client)
    ada, bob, cy, dee = people(client, 4)
    befriend(ada, cy)
    befriend(ada, dee)
    game_id = practice(ada, client)
    path = f"/api/v1/games/{game_id}/coaches"
    # A game against the bots is one a player is coached in, by a friend alone.
    before = ada.get(path).json()
    assert (before["coaches"], before["can_invite"], before["reason"]) == ([], True, None)
    assert (coach(ada, game_id, bob).status_code, coach(ada, game_id, bob).json()["code"]) == (
        422,
        "not_friend",
    )
    assert cy.get(f"/api/v1/games/{game_id}").status_code == 404
    assert cy.get(path).status_code == 404

    ada_seen: list[str] = []
    cy_seen: list[str] = []
    with ExitStack() as stack:
        ada_tab, first = playing(ada, game_id, ada_seen, stack)
        given = coach(ada, game_id, cy)
        assert given.status_code == 200, given.text
        mine = given.json()
        assert [(c["seat"], c["coach"]["handle"], c["yours"]) for c in mine["coaches"]] == [
            (0, cy.handle, True)
        ]
        assert (mine["can_invite"], mine["reason"]) == (
            False,
            "You have a coach already: end that first.",
        )
        # Everyone at the game is told the seat has a coach; the coach by the bell.
        assert ada_tab.until("coaches")["coaches"] == [{"seat": 0, "handle": cy.handle}]
        note = cy.get("/api/v1/notifications").json()["items"][0]
        assert (note["kind"], note["game_id"], note["actor"]["handle"]) == (
            "coach_invite",
            game_id,
            ada.handle,
        )
        # One coach a seat.
        assert coach(ada, game_id, dee).json()["code"] == "coach_exists"

        # The coach reads the game as the seat does: its hand, no seat of their own.
        read = cy.get(f"/api/v1/games/{game_id}")
        assert read.status_code == 200, read.text
        state = read.json()
        assert (state["game"]["coaching"], state["game"]["your_seat"]) == (0, None)
        assert state["game"]["spectating"] is False
        assert state["snapshot"]["view"]["hand"] == [{"name": f"{SECRET} 0"}]
        theirs = cy.get(path).json()
        assert [(c["you"], c["yours"]) for c in theirs["coaches"]] == [(True, False)]
        assert theirs["can_invite"] is False and theirs["reason"] is None
        # A coach has no power over the game.
        assert cy.send("POST", f"/api/v1/games/{game_id}/close").status_code == 404

        tab = watch(cy, game_id, cy_seen, stack)
        welcome = tab.until("welcome")
        assert (welcome["role"], welcome["seat"], welcome["coached"]) == ("coach", None, 0)
        assert tab.snapshot(1)["view"]["hand"] == [{"name": f"{SECRET} 0"}]
        assert tab.until("coaches")["coaches"] == [{"seat": 0, "handle": cy.handle}]
        for message in (
            {"type": "take_control"},
            {"type": "command", "command": {"type": "concede"}},
            {"type": "chat", "channel": "table", "text": "hi", "client_id": str(uuid.uuid4())},
        ):
            tab.socket.send_json(message)
            assert tab.until("error")["code"] == "read_only"
        # What the player does reaches the coach.
        ada_tab.command(first)
        assert ada_tab.until("command_result")["status"] == 200
        tab.snapshot(2)

        # The player ends it: the coach's connection closes, and they read the game no more.
        ended = ada.send("DELETE", f"{path}/{cy.id}")
        assert ended.status_code == 200 and ended.json()["coaches"] == []
        assert ada_tab.until("coaches")["coaches"] == []
        with pytest.raises(WebSocketDisconnect) as closed:
            for _ in range(50):
                tab.receive()
        assert closed.value.code == 4403
    assert cy.get(f"/api/v1/games/{game_id}").status_code == 404
    assert refusal(cy, game_id) == 4404
    assert ada.get(path).json()["can_invite"] is True


def test_a_coach_at_a_private_table_is_known_to_the_table_and_sees_one_seat(client, engine):
    staged(client)
    ada, bob, cy, dee = people(client, 4)
    befriend(ada, bob)
    befriend(ada, cy)
    befriend(bob, cy)
    befriend(bob, dee)
    # Never at a public table.
    _, public = started(ada, bob, client, visibility="public")
    refused = coach(ada, public, cy)
    assert (refused.status_code, refused.json()["code"]) == (409, "not_coachable")
    assert ada.get(f"/api/v1/games/{public}/coaches").json()["reason"] == (
        "A player is coached against bots and at a private table only."
    )
    with engine.lock:
        engine.games[public].concede(1)

    _, game_id = started(cy, dee, client, visibility="private")
    with engine.lock:
        engine.games[game_id].concede(1)
    _, game_id = started(ada, bob, client, visibility="private")
    path = f"/api/v1/games/{game_id}/coaches"
    # A player of the game coaches nobody in it.
    assert coach(ada, game_id, bob).json()["code"] == "already_seated"
    cy_seen: list[str] = []
    with ExitStack() as stack:
        bob_tab = opened(bob, game_id, [], stack)
        assert coach(ada, game_id, cy).status_code == 200
        # The other player is told, and reads who coaches whom.
        assert bob_tab.until("coaches")["coaches"] == [{"seat": 0, "handle": cy.handle}]
        listed = bob.get(path).json()
        assert [(c["seat"], c["player"], c["yours"]) for c in listed["coaches"]] == [
            (0, ada.handle, False)
        ]
        # Nobody sees two hands: the coach of one seat is not another's.
        assert coach(bob, game_id, cy).json()["code"] == "already_coaching"
        assert coach(bob, game_id, dee).status_code == 200
        tab = watch(cy, game_id, cy_seen, stack)
        assert tab.until("welcome")["coached"] == 0
        tab.snapshot(1)
        # The table's chat is its players': a coach advises in the friends' chat.
        bob_tab.socket.send_json(
            {
                "type": "chat",
                "channel": "table",
                "text": "for the table",
                "client_id": str(uuid.uuid4()),
            }
        )
        assert bob_tab.until("chat")["message"]["body"] == "for the table"
        with engine.lock:
            engine.games[game_id].revision += 1
        tab.snapshot(2)
        # The coach leaves by themselves.
        left = cy.send("DELETE", f"{path}/{cy.id}")
        assert left.status_code == 200 and left.json()["coaches"] == []
        # Another's coach is not theirs to end, nor a stranger's to read.
        assert cy.send("DELETE", f"{path}/{dee.id}").status_code == 404
        assert ada.send("DELETE", f"{path}/{dee.id}").status_code == 404
    assert cy_seen and not any(
        f"{SECRET} 1" in message or "for the table" in message for message in cy_seen
    )
    assert any(f"{SECRET} 0" in message for message in cy_seen)
    assert [c["coach"]["handle"] for c in bob.get(path).json()["coaches"]] == [dee.handle]


def test_coaching_is_behind_its_gate(client, engine):
    root = staged(client)
    ada, _, cy = people(client, 3)
    befriend(ada, cy)
    game_id = practice(ada, client)
    assert coach(ada, game_id, cy).status_code == 200
    assert cy.get(f"/api/v1/games/{game_id}").status_code == 200
    # Switched off again, it stops at once: the routes are gone, and the grant gives nothing.
    off = root.send("PUT", "/api/v1/admin/rollout/coaching", {"stage": "off"})
    assert off.status_code == 200, off.text
    assert ada.get(f"/api/v1/games/{game_id}/coaches").status_code == 404
    assert coach(ada, game_id, cy).status_code == 404
    assert cy.get(f"/api/v1/games/{game_id}").status_code == 404
    assert refusal(cy, game_id) == 4404
