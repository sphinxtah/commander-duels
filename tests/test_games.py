"""Practice games through the API (v0.0.6), against a fake engine that speaks the service routes.

Covers seat ownership (T29's match case), the controller lease (AUTH07), a resent command running
once (T14), the WebSocket's refusals, results and restarts, SysOp's inspection and deck lists,
and the limits. No payload the API sends may carry an engine seat token or the service token.
"""

import asyncio
import json
import secrets
import threading
import time
import uuid
from collections.abc import Iterator
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketDisconnect

from api import games
from api.config import Settings
from api.decklists import parse_deck_list
from api.identity import ApiError, hash_token, utcnow
from api.main import create_app
from api.models import AuditEvent, Game, GameSeat, User, UserSession

SERVICE_TOKEN = "service-token-for-the-api-tests-0123456789"
SYSOP_ADDRESS = ("10.20.0.7", 50000)
ORIGIN = "http://localhost:5173"


class FakeGame:
    def __init__(self, body: dict[str, Any]) -> None:
        self.id = str(uuid.uuid4())
        self.body = body
        self.token = secrets.token_urlsafe(32)
        self.spectator = secrets.token_urlsafe(32)
        self.revision = 1
        self.prompt = str(uuid.uuid4())
        self.applied = 0
        self.actions: dict[str, tuple[str, tuple[int, dict[str, Any]]]] = {}
        self.result: dict[str, Any] | None = None
        self.log: list[str] = ["The game begins."]
        fixtures = games.FIXTURE_DECKS[body.get("format", "legacy")]
        self.decks = []
        for index, seat in enumerate(body["seats"]):
            deck = seat.get("deck") or ("custom" if "deck_list" in seat else None)
            self.decks.append(deck or fixtures[index % len(fixtures)])

    def snapshot(self, log_from: int | None) -> dict[str, Any]:
        start = max(0, len(self.log) - 20) if log_from is None else min(log_from, len(self.log))
        return {
            "game_id": self.id,
            "revision": self.revision,
            "status": "finished" if self.result else "your_prompt",
            "seat": 0,
            "settings": {"seats": [{"seat": 0, "player": "human", "deck": self.decks[0]}]},
            "prompt": None
            if self.result
            else {"id": self.prompt, "kind": "priority", "options": [{"id": "1"}]},
            "view": {"seat": 0, "turn": 1, "hand": []},
            "result": self.result,
            "log_count": len(self.log),
            "log_from": start,
            "log": [{"index": i, "text": text} for i, text in enumerate(self.log)][start:],
        }


class FakeEngine:
    """The engine's service routes, enough for the API: seat tokens, revisions, prompts, resends."""

    def __init__(self, cap: int = 8) -> None:
        self.lock = threading.Lock()
        self.games: dict[str, FakeGame] = {}
        self.cap = cap
        self.closed: list[str] = []
        self.created: list[dict[str, Any]] = []
        self.inspections = 0

    def game(self, game_id: str) -> FakeGame:
        return self.games[game_id]

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("x-service-token") != SERVICE_TOKEN:
            return httpx.Response(401, json={"code": "service_unauthorized"})
        parts = request.url.path.removeprefix("/v1/service/").split("/")
        body = json.loads(request.content) if request.content else None
        if parts == ["cards"]:
            return httpx.Response(200, json={"names": ["Lightning Bolt", "Lightning Helix"]})
        if parts == ["games"]:
            return self.create(body)
        game = self.games.get(parts[1])
        if game is None:
            return httpx.Response(404, json={"code": "not_found"})
        if parts[2] == "close":
            with self.lock:
                self.closed.append(game.id)
                if game.result is None:
                    game.result = closed()
                    game.revision += 1
            return httpx.Response(200, json={"status": "finished"})
        if parts[2] == "inspection":
            with self.lock:
                self.inspections += 1
                return httpx.Response(200, json=inspection(game))
        if request.headers.get("authorization") != f"Bearer {game.token}":
            return httpx.Response(404, json={"code": "not_found"})
        if parts[2] == "view":
            return await self.view(game, request.url.params)
        return self.command(game, body)

    def create(self, body: dict[str, Any]) -> httpx.Response:
        names = [
            entry["name"]
            for seat in body["seats"]
            for entry in seat.get("deck_list", {}).get("cards", [])
            if entry["name"].startswith("Unknown")
        ]
        if names:
            return httpx.Response(400, json={"code": "unknown_cards", "names": names})
        with self.lock:
            if sum(game.result is None for game in self.games.values()) >= self.cap:
                return httpx.Response(429, json={"code": "games_busy"})
            game = FakeGame(body)
            self.games[game.id] = game
            self.created.append(body)
        seats = [
            {"seat": i, "player": seat["player"], "seat_token": game.token if i == 0 else None}
            for i, seat in enumerate(body["seats"])
        ]
        settings = {
            "format": body["format"],
            "seats": [
                {"seat": i, "player": seat["player"], "deck": game.decks[i]}
                for i, seat in enumerate(body["seats"])
            ],
        }
        return httpx.Response(
            201,
            json={
                "game_id": game.id,
                "seats": seats,
                "spectator_token": game.spectator,
                "settings": settings,
            },
        )

    async def view(self, game: FakeGame, params: httpx.QueryParams) -> httpx.Response:
        since = int(params.get("since", -1))
        deadline = time.monotonic() + min(int(params.get("wait_ms", 0)), 1000) / 1000
        log_from = int(params["log_from"]) if "log_from" in params else None
        while True:
            with self.lock:
                if game.revision > since or game.result or time.monotonic() >= deadline:
                    return httpx.Response(200, json=game.snapshot(log_from))
            await asyncio.sleep(0.01)

    def command(self, game: FakeGame, body: dict[str, Any]) -> httpx.Response:
        fingerprint = json.dumps({k: v for k, v in body.items() if k != "action_id"})
        with self.lock:
            earlier = game.actions.get(body["action_id"])
            if earlier is not None:
                if earlier[0] != fingerprint:
                    return httpx.Response(409, json={"code": "action_id_reused"})
                return httpx.Response(earlier[1][0], json=earlier[1][1])
            if game.result is not None:
                return httpx.Response(409, json={"code": "game_over"})
            if body["type"] == "concede":
                game.result = {
                    "kind": "completed",
                    "winner_seat": 1,
                    "draw": False,
                    "turns": 2,
                    "conceded_seats": [0],
                    "error": None,
                }
            elif body.get("prompt_id") != game.prompt:
                return httpx.Response(409, json={"code": "stale_prompt"})
            elif body["expected_revision"] != game.revision:
                return httpx.Response(409, json={"code": "stale_revision"})
            game.applied += 1
            game.revision += 1
            game.prompt = str(uuid.uuid4())
            game.log.append(f"Answer {game.applied}")
            reply = {
                "status": "accepted",
                "action_id": body["action_id"],
                "revision": game.revision,
            }
            game.actions[body["action_id"]] = (fingerprint, (200, reply))
            return httpx.Response(200, json=reply)


def closed() -> dict[str, Any]:
    return {
        "kind": "closed",
        "winner_seat": None,
        "draw": False,
        "turns": 1,
        "conceded_seats": [],
        "error": None,
    }


def inspection(game: FakeGame) -> dict[str, Any]:
    return {
        "game_id": game.id,
        "version": game.revision,
        "status": "finished" if game.result else "live",
        "players": [
            {"seat": 0, "name": "Human 1", "hand": [{"name": "Mountain"}], "library": []},
            {"seat": 1, "name": "Bot 2", "hand": [{"name": "Forest"}], "library": []},
        ],
        "result": game.result,
    }


@pytest.fixture
def database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    url = f"sqlite:///{tmp_path}/games.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    return url


def build(database: str, engine: FakeEngine | None, **settings: Any) -> FastAPI:
    config = Settings(
        database_url=database,
        sysop_networks="10.20.0.0/24",
        engine_service_token=SERVICE_TOKEN if engine else "",
        games_max=4,
    )
    app = create_app(config.model_copy(update=settings))
    if engine is not None:
        app.state.engine_transport = httpx.MockTransport(engine)
    return app


@pytest.fixture
def engine() -> FakeEngine:
    return FakeEngine()


@pytest.fixture
def client(database: str, engine: FakeEngine) -> Iterator[TestClient]:
    with connect(build(database, engine)) as client:
        yield client


@pytest.fixture
def app(client: TestClient) -> FastAPI:
    return client.app  # type: ignore[return-value]


def connect(app: FastAPI) -> TestClient:
    """One client for every account: its requests share the event loop the game tasks run on."""
    return TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS)


class Account:
    def __init__(self, client: TestClient, handle: str, kind: str = "player") -> None:
        app: FastAPI = client.app  # type: ignore[assignment]
        now = utcnow()
        self.token = secrets.token_urlsafe(32)
        with Session(app.state.database, expire_on_commit=False) as db:
            user = User(
                handle=handle,
                normalized_handle=handle.casefold(),
                display_name=handle,
                kind=kind,
                status="active",
                onboarding="complete",
                created_at=now,
            )
            db.add(user)
            db.flush()
            session = UserSession(
                token_hash=hash_token(self.token),
                user_id=user.id,
                kind="sysop" if kind == "sysop" else "google",
                csrf_token=secrets.token_urlsafe(32),
                privilege_version=0,
                created_at=now,
                authenticated_at=now,
                last_seen_at=now,
                idle_expires_at=now + timedelta(days=1),
                absolute_expires_at=now + timedelta(days=1),
            )
            db.add(session)
            db.commit()
            self.id, self.csrf, self.session_id = user.id, session.csrf_token, session.id
        self.http = client

    def get(self, path: str, **params: str) -> httpx.Response:
        return self.http.get(path, params=params, headers={"cookie": f"cd_session={self.token}"})

    def post(self, path: str, body: object = None, csrf: bool = True) -> httpx.Response:
        headers = {"cookie": f"cd_session={self.token}"}
        if csrf:
            headers["x-csrf-token"] = self.csrf
        return self.http.post(path, json=body, headers=headers)

    def socket(self, game_id: str, origin: str | None = ORIGIN) -> Any:
        headers = {"cookie": f"cd_session={self.token}"}
        if origin:
            headers["origin"] = origin
        return self.http.websocket_connect(f"/api/v1/games/{game_id}/events", headers=headers)

    def hello(self, **fields: Any) -> dict[str, Any]:
        return {"type": "hello", "csrf_token": self.csrf} | fields


class Tab:
    """One WebSocket, with every message it received, so nothing escapes the leak check."""

    def __init__(self, socket: Any, seen: list[str]) -> None:
        self.socket = socket
        self.seen = seen

    def receive(self) -> dict[str, Any]:
        message = self.socket.receive_json()
        self.seen.append(json.dumps(message))
        return message  # type: ignore[no-any-return]

    def until(self, kind: str, **match: Any) -> dict[str, Any]:
        for _ in range(50):
            message = self.receive()
            if message["type"] == kind and all(message.get(k) == v for k, v in match.items()):
                return message
        raise AssertionError(f"no {kind} message")

    def snapshot(self, revision: int) -> dict[str, Any]:
        for _ in range(50):
            message = self.receive()
            if message["type"] == "snapshot" and message["snapshot"]["revision"] >= revision:
                return message["snapshot"]  # type: ignore[no-any-return]
        raise AssertionError(f"no snapshot at revision {revision}")

    def command(self, snapshot: dict[str, Any], action_id: str | None = None) -> dict[str, Any]:
        envelope = {
            "v": 1,
            "game_id": snapshot["game_id"],
            "action_id": action_id or str(uuid.uuid4()),
            "expected_revision": snapshot["revision"],
            "prompt_id": snapshot["prompt"]["id"],
            "type": "submit_choice",
            "payload": {"option_id": "1"},
        }
        self.socket.send_json({"type": "command", "command": envelope})
        return envelope


def closes_with(socket: Any, code: int) -> str:
    """The refusal's error code, after which the server closes with ``code``."""
    error = socket.receive_json()
    with pytest.raises(WebSocketDisconnect) as closed:
        socket.receive_json()
    assert closed.value.code == code
    return str(error["code"])


def until_status(account: Account, game_id: str, status: str) -> dict[str, Any]:
    for _ in range(200):
        state = account.get(f"/api/v1/games/{game_id}").json()
        if state["game"]["status"] == status:
            return state  # type: ignore[no-any-return]
        time.sleep(0.02)
    raise AssertionError(f"game {game_id} never became {status}")


def audit_actions(app: FastAPI) -> list[str]:
    with Session(app.state.database) as db:
        return list(db.scalars(select(AuditEvent.action).order_by(AuditEvent.occurred_at)))


def test_a_practice_game_belongs_to_its_owner(
    client: TestClient, app: FastAPI, engine: FakeEngine
) -> None:
    ada, bea = Account(client, "ada"), Account(client, "bea")
    options = ada.get("/api/v1/practice-games/options").json()
    assert options["deck_lists"] is False
    assert [f["id"] for f in options["formats"]] == ["legacy", "commander"]

    refused = ada.post("/api/v1/practice-games", {}, csrf=False)
    assert refused.json()["code"] == "csrf_failed"
    created = ada.post("/api/v1/practice-games", {"deck": "legacy-mono-red-burn"})
    assert created.status_code == 201, created.text
    summary = created.json()
    game_id = summary["id"]
    assert summary["status"] == "active" and summary["your_seat"] == 0
    assert summary["seats"][0] == {
        "seat": 0,
        "player": "human",
        "handle": "ada",
        "deck": "legacy-mono-red-burn",
    }
    assert summary["seats"][1]["player"] == "bot" and summary["seats"][1]["deck"] is None
    assert engine.created[0]["seats"] == [
        {"player": "human", "deck": "legacy-mono-red-burn"},
        {"player": "bot"},
    ]
    secret = engine.game(game_id).token
    assert secret not in created.text and SERVICE_TOKEN not in created.text

    limit = ada.post("/api/v1/practice-games", {})
    assert limit.status_code == 409 and limit.json()["code"] == "game_limit"
    for invalid in (
        {"deck": "commander-mono-blue-flyers"},
        {"format": "legacy", "bots": [{}, {}]},
        {"seat": 1},
    ):
        assert bea.post("/api/v1/practice-games", invalid).status_code == 422

    # Another account cannot read, watch, command or close the game (T29's match case).
    assert bea.get(f"/api/v1/games/{game_id}").status_code == 404
    assert bea.post(f"/api/v1/games/{game_id}/close").status_code == 404
    assert bea.get("/api/v1/games").json() == []
    with bea.socket(game_id) as socket:
        assert closes_with(socket, games.CLOSE_NOT_FOUND) == "not_found"
    assert bea.get(f"/api/v1/games/{game_id}/inspection").status_code == 403

    state = ada.get(f"/api/v1/games/{game_id}")
    assert state.status_code == 200 and secret not in state.text
    assert state.json()["snapshot"]["prompt"]["id"] == engine.game(game_id).prompt
    assert [game["id"] for game in ada.get("/api/v1/games").json()] == [game_id]


def test_one_tab_controls_the_seat_and_resends_run_once(
    client: TestClient, app: FastAPI, engine: FakeEngine
) -> None:
    ada = Account(client, "ada")
    game_id = ada.post("/api/v1/practice-games", {}).json()["id"]
    fake = engine.game(game_id)
    seen: list[str] = []
    with ada.socket(game_id) as first_socket, ada.socket(game_id) as second_socket:
        first, second = Tab(first_socket, seen), Tab(second_socket, seen)
        first_socket.send_json(ada.hello(control=True))
        assert first.until("welcome")["seat"] == 0
        assert first.until("lease")["role"] == "controller"
        opening = first.snapshot(1)
        second_socket.send_json(ada.hello())
        welcome = second.until("welcome")
        assert welcome["role"] == "observer" and welcome["controlled"] is True
        second.snapshot(1)

        # The observer cannot command; the controller can, and both tabs see the result.
        second.command(opening)
        refused = second.until("command_result")
        assert refused["status"] == 409 and refused["body"]["code"] == "not_controller"
        sent = first.command(opening)
        accepted = first.until("command_result", action_id=sent["action_id"])
        assert accepted["status"] == 200 and accepted["body"]["status"] == "accepted"
        after = first.snapshot(2)
        assert second.snapshot(2)["revision"] == after["revision"]
        assert fake.applied == 1

        # Taking control moves the lease; the old tab is refused from then on.
        second_socket.send_json({"type": "take_control"})
        assert second.until("lease")["role"] == "controller"
        lost = first.until("lease")
        assert lost["role"] == "observer" and lost["reason"] == "taken_over"
        first.command(after)
        assert first.until("command_result")["body"]["code"] == "not_controller"

        # A resend of an applied command returns its first result and runs nothing (T14).
        second.command(opening, action_id=sent["action_id"])
        again = second.until("command_result", action_id=sent["action_id"])
        assert again == accepted and fake.applied == 1

        # A command whose tab drops without acting on the reply is applied once, however often
        # it is resent. The tab closes only after the server has answered: closing mid-command
        # makes Starlette's test client cancel the handler and, rarely, fail its own teardown
        # (uvicorn never cancels a WebSocket handler on disconnect).
        lost_action = str(uuid.uuid4())
        second.command(after, action_id=lost_action)
        second.until("command_result", action_id=lost_action)
        assert fake.applied == 2
    with ada.socket(game_id) as third_socket:
        third = Tab(third_socket, seen)
        third_socket.send_json(ada.hello(control=True, since=after["revision"]))
        assert third.until("lease")["role"] == "controller"
        latest = third.snapshot(3)
        third.command(after, action_id=lost_action)
        resent = third.until("command_result", action_id=lost_action)
        assert resent["status"] == 200 and fake.applied == 2
        third.command(latest)
        assert third.until("command_result")["status"] == 200 and fake.applied == 3
        third_socket.send_json({"type": "ping"})
        assert third.until("pong")
    text = "\n".join(seen)
    assert fake.token not in text and SERVICE_TOKEN not in text


def test_the_websocket_refuses_strangers(
    client: TestClient, app: FastAPI, engine: FakeEngine
) -> None:
    ada = Account(client, "ada")
    game_id = ada.post("/api/v1/practice-games", {}).json()["id"]
    with ada.socket(game_id, origin="https://evil.example") as socket:
        assert closes_with(socket, games.CLOSE_FORBIDDEN) == "origin_refused"
    with client.websocket_connect(f"/api/v1/games/{game_id}/events") as socket:
        assert closes_with(socket, games.CLOSE_UNAUTHENTICATED) == "authentication_required"
    with ada.socket(game_id) as socket:
        socket.send_json({"type": "hello", "csrf_token": "wrong"})
        assert closes_with(socket, games.CLOSE_FORBIDDEN) == "csrf_failed"
    with ada.socket(game_id) as socket:
        socket.send_json({"type": "command"})
        assert closes_with(socket, games.CLOSE_BAD_MESSAGE) == "hello_required"
    with ada.socket(game_id) as socket:
        socket.send_json(ada.hello(inspect=True))
        assert closes_with(socket, games.CLOSE_FORBIDDEN) == "forbidden"
    with ada.socket(str(uuid.uuid4())) as socket:
        assert closes_with(socket, games.CLOSE_NOT_FOUND) == "not_found"

    # Signing out everywhere ends the connection at its next command.
    with ada.socket(game_id) as socket:
        tab = Tab(socket, [])
        socket.send_json(ada.hello(control=True))
        opening = tab.snapshot(1)
        assert ada.post("/api/v1/auth/logout-all").status_code == 204
        tab.command(opening)
        with pytest.raises(WebSocketDisconnect) as ended:
            for _ in range(10):
                tab.receive()
        assert ended.value.code == games.CLOSE_UNAUTHENTICATED
    assert engine.game(game_id).applied == 0


def test_results_are_recorded_and_restarts_interrupt(
    database: str, engine: FakeEngine, client: TestClient
) -> None:
    ada = Account(client, "ada")
    first = ada.post("/api/v1/practice-games", {"format": "commander"}).json()
    assert len(first["seats"]) == 4
    with ada.socket(first["id"]) as socket:
        tab = Tab(socket, [])
        socket.send_json(ada.hello(control=True))
        opening = tab.snapshot(1)
        socket.send_json(
            {
                "type": "command",
                "command": {
                    "v": 1,
                    "game_id": opening["game_id"],
                    "action_id": str(uuid.uuid4()),
                    "expected_revision": opening["revision"],
                    "type": "concede",
                    "payload": {},
                },
            }
        )
        assert tab.until("command_result")["status"] == 200
        assert tab.snapshot(2)["result"]["kind"] == "completed"
    finished = until_status(ada, first["id"], "finished")["game"]
    assert finished["result"] == {
        "kind": "completed",
        "winner_seat": 1,
        "draw": False,
        "turns": 2,
        "conceded_seats": [0],
    }
    assert finished["finished_at"] is not None

    second = ada.post("/api/v1/practice-games", {}).json()
    closed_now = ada.post(f"/api/v1/games/{second['id']}/close")
    assert closed_now.status_code == 200
    assert until_status(ada, second["id"], "finished")["game"]["result"]["kind"] == "closed"

    third = ada.post("/api/v1/practice-games", {}).json()
    # A new API process cannot play the game: its seat token died with the old one.
    with connect(build(database, engine)) as restarted:
        assert third["id"] in engine.closed
        with Session(restarted.app.state.database) as db:  # type: ignore[attr-defined]
            assert db.get(Game, uuid.UUID(third["id"])).status == "interrupted"  # type: ignore[union-attr]


def test_sysop_inspects_observes_and_plays_any_card(
    client: TestClient, app: FastAPI, engine: FakeEngine
) -> None:
    ada, root = Account(client, "ada"), Account(client, "sysop", kind="sysop")
    listed = ada.post("/api/v1/practice-games", {"deck_list": "4 Lightning Bolt"})
    assert listed.status_code == 403
    assert ada.get("/api/v1/cards", q="bolt").status_code == 403
    assert root.get("/api/v1/cards", q="bolt").json()["names"][0] == ("Lightning Bolt")
    assert root.get("/api/v1/practice-games/options").json()["deck_lists"] is True

    unknown = root.post(
        "/api/v1/practice-games",
        {"deck_list": "20 Mountain\n4 Unknown Card\n1 Unknown Other"},
    )
    assert unknown.status_code == 422, unknown.text
    assert unknown.json()["names"] == ["Unknown Card", "Unknown Other"]
    deck = "Commander\n1 Krenko, Mob Boss\n\nDeck\n4x Goblin Guide (ZEN) 126\n36 Mountain\n"
    created = root.post(
        "/api/v1/practice-games",
        {
            "format": "commander",
            "deck_list": deck,
            "bots": [{"deck_list": "Commander: Isamaru, Hound of Konda\n40 Plains"}],
        },
    )
    assert created.status_code == 201, created.text
    own = created.json()
    assert own["seats"][0]["deck"] == "custom" and own["seats"][1]["deck"] == "custom"
    assert engine.created[-1]["seats"][0]["deck_list"] == {
        "cards": [{"name": "Goblin Guide", "count": 4}, {"name": "Mountain", "count": 36}],
        "commanders": ["Krenko, Mob Boss"],
    }
    # SysOp has no per-account limit.
    second = root.post("/api/v1/practice-games", {})
    assert second.status_code == 201
    assert "game.deck_lists_used" in audit_actions(app)

    theirs = ada.post("/api/v1/practice-games", {}).json()["id"]
    every = root.get("/api/v1/games", scope="all").json()
    assert {game["id"] for game in every} == {own["id"], second.json()["id"], theirs}
    assert ada.get("/api/v1/games", scope="all").status_code == 403
    observed = root.get(f"/api/v1/games/{theirs}")
    assert observed.status_code == 200
    assert observed.json()["game"]["your_seat"] is None
    assert observed.json()["game"]["seats"][1]["deck"] is not None, "SysOp sees every deck"
    inspected = root.get(f"/api/v1/games/{theirs}/inspection")
    assert inspected.status_code == 200
    assert inspected.json()["players"][1]["hand"] == [{"name": "Forest"}]
    actions = audit_actions(app)
    assert "game.observed" in actions and "game.inspection_opened" in actions

    with root.socket(theirs) as socket:
        tab = Tab(socket, [])
        socket.send_json(root.hello(control=True, inspect=True))
        welcome = tab.until("welcome")
        assert welcome["seat"] is None
        assert tab.until("error")["code"] == "not_owner"
        assert tab.until("inspection")["inspection"]["players"][0]["hand"]
    assert root.post(f"/api/v1/games/{theirs}/close").status_code == 200
    assert "game.closed" in audit_actions(app)


def test_limits_and_configuration(database: str) -> None:
    engine = FakeEngine(cap=8)
    with connect(build(database, engine, games_max=1)) as client:
        ada, bea = Account(client, "ada"), Account(client, "bea")
        assert ada.post("/api/v1/practice-games", {}).status_code == 201
        busy = bea.post("/api/v1/practice-games", {})
        assert busy.status_code == 429 and busy.headers["retry-after"] == "30"
    with connect(build(database, None)) as client:
        cara = Account(client, "cara")
        off = cara.post("/api/v1/practice-games", {})
        assert off.status_code == 503 and off.json()["code"] == "games_unavailable"
    with pytest.raises(ValueError, match="32 characters"):
        Settings(engine_service_token="short")


def test_fixture_decks_are_the_engines() -> None:
    files = {path.stem for path in Path("engine/decks").glob("*.txt")}
    assert {deck for decks in games.FIXTURE_DECKS.values() for deck in decks} == files


def test_deck_list_text() -> None:
    deck = parse_deck_list(
        "# a comment\n4 Lightning Bolt\n2x lightning bolt\nMountain\n"
        "1 Fire // Ice (MH2) 290 *F*\n\nSideboard\n3 Pyroblast\n",
        "legacy",
    )
    assert deck == {
        "cards": [
            {"name": "Lightning Bolt", "count": 6},
            {"name": "Mountain", "count": 1},
            {"name": "Fire // Ice", "count": 1},
        ]
    }
    commander = parse_deck_list("Commander: Krenko, Mob Boss\n99 Mountain", "commander")
    assert commander["commanders"] == ["Krenko, Mob Boss"]
    for text, game_format in (
        ("", "legacy"),
        ("# nothing", "legacy"),
        ("251 Mountain", "legacy"),
        ("200 Mountain\n60 mountain", "legacy"),
        ("Commander: Krenko, Mob Boss\n20 Mountain", "legacy"),
        ("60 Mountain", "commander"),
        ("Commander\n2 Krenko, Mob Boss\n10 Mountain", "commander"),
        ("\n".join(f"1 Card {n}" for n in range(251)), "legacy"),
    ):
        with pytest.raises(ApiError) as refused:
            parse_deck_list(text, game_format)
        assert refused.value.code == "invalid_deck_list", text


def test_seats_record_their_owner(client: TestClient, app: FastAPI, engine: FakeEngine) -> None:
    ada = Account(client, "ada")
    game_id = ada.post("/api/v1/practice-games", {"format": "commander", "bots": [{}]})
    assert game_id.status_code == 201
    with Session(app.state.database) as db:
        seats = list(db.scalars(select(GameSeat).order_by(GameSeat.seat)))
    assert [(seat.player, seat.user_id) for seat in seats] == [("human", ada.id), ("bot", None)]
    assert seats[0].deck == "commander-mono-white-soldiers"
