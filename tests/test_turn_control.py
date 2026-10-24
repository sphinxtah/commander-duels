"""Turn control through the API (v0.5.1, rule 723).

The engine routes a controlled player's decisions to the seat controlling their turn: that seat's
view carries the prompt, marked with the controlled seat (`for_seat`), and the controlled player's
hand while the control lasts; the controlled seat's own view says who controls its turn and holds
no prompt. The API relays each seat's views to that seat's connections only and forwards each
command with the sending seat's own token, so the controller's tab answers with its own lease, and
the controlled player's tab cannot answer for the controller. Results and payments are unchanged.
Also the scripted clients' leak checks (scripts/engine_human_game.py, used by
scripts/api_practice_game.py): the controller's view is allowed while the control lasts and is a
leak at any other time or to anyone else.
"""

import importlib.util
import json
import sys
import uuid
from contextlib import ExitStack
from pathlib import Path
from typing import Any

import httpx
import pytest
import test_progression
import test_tables
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_games import SERVICE_TOKEN, Tab
from test_tables import (
    Account,
    TableEngine,
    TableGame,
    concede,
    deck,
    opened,
    served,
    until_finished,
)

from api import economy
from api.models import TokenEntry

content = test_progression.content
url = test_tables.url


class ControlledGame(TableGame):
    """A two-player game in seat 1's turn, which seat 0 controls until it answers one prompt for
    seat 1: then seat 1's turn is its own again."""

    def __init__(self, body: dict[str, Any]) -> None:
        super().__init__(body)
        self.controlled = True
        self.answers: list[tuple[str, int]] = []

    def seat_snapshot(self, seat: int, log_from: int | None) -> dict[str, Any]:
        snapshot = super().seat_snapshot(seat, log_from)
        if self.result is not None or seat in self.out:
            return snapshot
        other = 1 - seat
        controller = 0 if self.controlled else None
        you = {"seat": seat, "controlled_by": controller if seat == 1 else None, "hand": None}
        opponent = {
            "seat": other,
            "controlled_by": controller if other == 1 else None,
            "hand": None,
        }
        if self.controlled and seat == 0:
            opponent["hand"] = [{"name": "Secret of seat 1"}]
        snapshot["view"].update(you=you, opponents=[opponent])
        if self.controlled:
            snapshot["status"] = "your_prompt" if seat == 0 else "waiting"
            snapshot["prompt"] = (
                {"id": self.prompt, "kind": "priority", "options": [{"id": "1"}], "for_seat": 1}
                if seat == 0
                else None
            )
        return snapshot


class ControlledEngine(TableEngine):
    """The engine's service routes for a game in which seat 0 controls seat 1's turn."""

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        parts = request.url.path.removeprefix("/v1/service/").split("/")
        game = self.games.get(parts[1]) if len(parts) > 2 else None
        if (
            isinstance(game, ControlledGame)
            and parts[2] == "commands"
            and request.headers.get("x-service-token") == SERVICE_TOKEN
        ):
            given = request.headers.get("authorization", "")
            seat = next(s for s, token in game.tokens.items() if given == f"Bearer {token}")
            command = json.loads(request.content)
            if command["type"] == "submit_choice":
                with self.lock:
                    # Only the seat holding the prompt may answer it: seat 1 holds none while
                    # seat 0 controls its turn, so its answer is stale.
                    if not game.controlled or seat != 0 or command["prompt_id"] != game.prompt:
                        return httpx.Response(409, json={"code": "stale_prompt"})
                    game.answers.append((given, 1))
                    game.controlled = False
                    game.revision += 1
                    game.prompt = str(uuid.uuid4())
                    return httpx.Response(
                        200, json={"status": "accepted", "revision": game.revision}
                    )
        return await super().__call__(request)

    def create(self, body: dict[str, Any]) -> httpx.Response:
        with self.lock:
            game = ControlledGame(body)
            self.games[game.id] = game
            self.created.append(body)
        return httpx.Response(
            201,
            json={
                "game_id": game.id,
                "seats": [
                    {"seat": i, "player": seat["player"], "seat_token": game.tokens.get(i)}
                    for i, seat in enumerate(body["seats"])
                ],
                "spectator_token": game.spectator,
                "settings": {
                    "format": body["format"],
                    "seats": [
                        {"seat": i, "player": seat["player"], "deck": game.decks[i]}
                        for i, seat in enumerate(body["seats"])
                    ],
                },
            },
        )


def submit(tab: Tab, game_id: str, snapshot: dict[str, Any], prompt_id: str) -> dict[str, Any]:
    tab.socket.send_json(
        {
            "type": "command",
            "command": {
                "v": 1,
                "game_id": game_id,
                "action_id": str(uuid.uuid4()),
                "expected_revision": snapshot["revision"],
                "prompt_id": prompt_id,
                "type": "submit_choice",
                "payload": {"option_id": "1"},
            },
        }
    )
    return tab.until("command_result")


def test_the_controller_answers_for_the_controlled_seat(url: str, content: Path) -> None:
    engine = ControlledEngine()
    with served(url, content, engine) as client:
        ada, bob = Account(client, "ada", admin=True), Account(client, "bob")
        code = ada.send(
            "POST", "/api/v1/tables", {"format": "legacy", "deck_id": deck(ada, client)}
        ).json()["code"]
        bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": deck(bob, client, title="B")})
        bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True})
        game_id = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
        fake = engine.games[game_id]
        assert isinstance(fake, ControlledGame)

        seen_ada: list[str] = []
        seen_bob: list[str] = []
        with ExitStack() as stack:
            ada_tab = opened(ada, game_id, seen_ada, stack)
            bob_tab = opened(bob, game_id, seen_bob, stack)
            controlling = ada_tab.snapshot(1)
            controlled = bob_tab.snapshot(1)
            # The controller's tab holds bob's decision, marked as bob's, and sees bob's hand.
            assert controlling["prompt"]["for_seat"] == 1
            assert controlling["view"]["opponents"][0]["controlled_by"] == 0
            assert controlling["view"]["opponents"][0]["hand"] == [{"name": "Secret of seat 1"}]
            # Bob's tab is told who controls his turn, and holds no prompt.
            assert controlled["prompt"] is None and controlled["status"] == "waiting"
            assert controlled["view"]["you"]["controlled_by"] == 0

            # Bob cannot answer the prompt ada holds: the engine refuses his seat's answer.
            refused = submit(bob_tab, game_id, controlled, controlling["prompt"]["id"])
            assert (refused["status"], refused["body"]["code"]) == (409, "stale_prompt")
            # Ada answers it with her own seat's token; the control then ends.
            answered = submit(ada_tab, game_id, controlling, controlling["prompt"]["id"])
            assert answered["status"] == 200, answered
            assert fake.answers == [(f"Bearer {fake.tokens[0]}", 1)]
            after = ada_tab.snapshot(2)
            assert after["view"]["opponents"][0]["hand"] is None
            assert after["view"]["opponents"][0]["controlled_by"] is None
            assert bob_tab.snapshot(2)["view"]["you"]["controlled_by"] is None

            # Bob still concedes for himself (723.6); ada's win is paid as any other.
            assert concede(bob_tab, game_id)["status"] == 200
            assert ada_tab.snapshot(3)["result"]["winner_seat"] == 0
        assert fake.conceded_by == [f"Bearer {fake.tokens[1]}"]
        # Bob's tabs never saw ada's hand; ada's saw bob's only while she controlled his turn.
        assert "Secret of seat 0" not in "\n".join(seen_bob)
        frames = [frame for frame in seen_ada if "Secret of seat 1" in frame]
        assert frames and all(
            '"for_seat": 1' in frame or '"for_seat":1' in frame for frame in frames
        )
        for text_seen in (seen_ada, seen_bob):
            joined = "\n".join(text_seen)
            assert all(token not in joined for token in fake.tokens.values())
            assert SERVICE_TOKEN not in joined
        won = until_finished(ada, game_id)
        assert won["result"]["winner_seat"] == 0 and won["tokens"] == economy.human_tokens(0)
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            paid = db.scalar(select(TokenEntry).where(TokenEntry.game_id == uuid.UUID(game_id)))
            assert paid is not None
            assert (paid.kind, paid.user_id, paid.opponent_id) == ("human_win", ada.id, bob.id)


def scripted_checks(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setattr(sys, "path", list(sys.path))
    spec = importlib.util.spec_from_file_location(
        "engine_human_game", Path("scripts/engine_human_game.py")
    )
    assert spec is not None and spec.loader is not None
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    return script.Checks(None)


def seat_snapshot(viewer: int, prompt: dict[str, Any] | None = None) -> dict[str, Any]:
    """A two-player snapshot of the viewer's seat, as the scripted clients read it."""
    decks = ["legacy-mono-red-burn", "legacy-mono-green-creatures"]
    return {
        "game_id": str(uuid.uuid4()),
        "seat": viewer,
        "settings": {
            "seats": [
                {"seat": seat, "player": "human", "deck": decks[seat] if seat == viewer else None}
                for seat in (0, 1)
            ]
        },
        "prompt": prompt,
        "view": {
            "seat": viewer,
            "you": {"seat": viewer, "hand_count": 0, "hand": None, "controlled_by": None},
            "opponents": [
                {"seat": 1 - viewer, "hand_count": 1, "hand": None, "controlled_by": None}
            ],
            "hand": [],
        },
    }


def test_the_scripted_clients_allow_the_controllers_view_only_while_it_lasts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    checks = scripted_checks(monkeypatch)
    prompt = {"id": str(uuid.uuid4()), "kind": "priority", "options": [], "for_seat": 1}
    controlling = seat_snapshot(0, prompt)
    controlling["view"]["opponents"][0].update(controlled_by=0, hand=[{"name": "Forest"}])
    checks.snapshot(0, controlling)
    controlled = seat_snapshot(1)
    controlled["view"]["you"]["controlled_by"] = 0
    checks.snapshot(1, controlled)
    assert checks.problems == []

    # The same hand once the control has ended, or with another controller, is a leak; so is a
    # prompt for a seat the viewer does not control, a seat asked for itself while a human seat
    # controls its turn, and any hand sent to a spectator.
    ended = seat_snapshot(0)
    ended["view"]["opponents"][0]["hand"] = [{"name": "Forest"}]
    checks.snapshot(0, ended)
    stolen = seat_snapshot(1)
    stolen["view"]["opponents"][0].update(controlled_by=0, hand=[{"name": "Mountain"}])
    checks.snapshot(1, stolen)
    checks.snapshot(0, seat_snapshot(0, prompt))
    asked = seat_snapshot(1, {"id": str(uuid.uuid4()), "for_seat": None})
    asked["view"]["you"]["controlled_by"] = 0
    checks.snapshot(1, asked)
    watched = seat_snapshot(0)
    watched["seat"] = None
    watched["view"].update(seat=None, you=None)
    watched["view"]["opponents"][0].update(controlled_by=1, hand=[{"name": "Forest"}])
    for entry in watched["settings"]["seats"]:
        entry["deck"] = None
    checks.spectator(watched)
    assert checks.problems == [
        "seat 1's hand contents reached seat 0",
        "seat 0's hand contents reached seat 1",
        "seat 0 was asked for seat 1, whose turn it does not control",
        "seat 1 was asked for itself while seat 0 controls its turn",
        "a spectator was sent a player's hand",
        "seat 1's hand contents reached seat None",
    ]
