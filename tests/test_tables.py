"""Human tables (v0.4.0) through the API, against a fake engine with a token and a view for every
player's seat: the lobby and invite links, seats and decks, starting a table's game, each player
seeing only their own seat, concessions, the vote to remove an away player, results that count
the winner's win and pay their tokens, and the limits. No payload the API sends may carry an
engine seat token, the service token, or another player's hidden cards or deck."""

import asyncio
import json
import secrets
import time
import uuid
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import test_progression
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from catalog_fixtures import bulk, engine_list, import_bulk
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session
from test_decks_api import ACCOUNT_TABLES
from test_games import ORIGIN, SERVICE_TOKEN, SYSOP_ADDRESS, FakeEngine, FakeGame, Tab, closed

from api import economy, games
from api.config import Settings
from api.main import create_app
from api.models import AuditEvent, CardConcept, GameSeat, GameTable, TokenEntry

content = test_progression.content
TABLES = ("table_seats", "game_tables", "token_ledger", "progress_ledger", "game_seats", "games")


class Account(test_progression.Account):
    def socket(self, game_id: str) -> Any:
        headers = {"cookie": f"cd_session={self.token}", "origin": ORIGIN}
        return self.http.websocket_connect(f"/api/v1/games/{game_id}/events", headers=headers)

    def hello(self, **fields: Any) -> dict[str, Any]:
        return {"type": "hello", "csrf_token": self.csrf, "control": True} | fields


class TableGame(FakeGame):
    """A game with a token and a view for each player's seat. Each seat's view holds a card only
    that seat may see. A seat's concession puts it out; the last seat standing wins."""

    def __init__(self, body: dict[str, Any]) -> None:
        super().__init__(body)
        self.tokens = {
            index: secrets.token_urlsafe(32)
            for index, seat in enumerate(body["seats"])
            if seat["player"] == "human"
        }
        self.out: list[int] = []
        self.conceded_by: list[str] = []

    def seat_snapshot(self, seat: int, log_from: int | None) -> dict[str, Any]:
        snapshot = self.snapshot(log_from)
        out = seat in self.out
        snapshot["seat"] = seat
        snapshot["view"] = {"seat": seat, "turn": 1, "hand": [{"name": f"Secret of seat {seat}"}]}
        snapshot["status"] = "finished" if self.result else "eliminated" if out else "your_prompt"
        if out:
            snapshot["prompt"] = None
        return snapshot

    def concede(self, seat: int) -> None:
        self.out.append(seat)
        standing = [index for index in range(len(self.body["seats"])) if index not in self.out]
        if len(standing) == 1 or not any(index in self.tokens for index in standing):
            self.result = {
                "kind": "completed" if len(standing) == 1 else "humans_eliminated",
                "winner_seat": standing[0] if len(standing) == 1 else None,
                "draw": False,
                "turns": 3,
                "conceded_seats": list(self.out),
                "error": None,
            }
        self.revision += 1
        self.log.append(f"Seat {seat} concedes.")


class TableEngine(FakeEngine):
    """The engine's service routes for games with several human seats."""

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("x-service-token") != SERVICE_TOKEN:
            return httpx.Response(401, json={"code": "service_unauthorized"})
        parts = request.url.path.removeprefix("/v1/service/").split("/")
        if parts == ["games"]:
            return self.create(json.loads(request.content))
        game = self.games.get(parts[1])
        if not isinstance(game, TableGame) or parts[2] in ("close", "inspection"):
            return await super().__call__(request)
        given = request.headers.get("authorization", "")
        seat = next((s for s, token in game.tokens.items() if given == f"Bearer {token}"), None)
        if seat is None:
            return httpx.Response(404, json={"code": "not_found"})
        if parts[2] == "view":
            return await self.seat_view(game, seat, request.url.params)
        body = json.loads(request.content)
        with self.lock:
            if game.result is not None:
                return httpx.Response(409, json={"code": "game_over"})
            if body["type"] != "concede":
                game.revision += 1
                return httpx.Response(200, json={"status": "accepted", "revision": game.revision})
            if seat in game.out:
                return httpx.Response(409, json={"code": "eliminated"})
            game.conceded_by.append(given)
            game.concede(seat)
            return httpx.Response(200, json={"status": "accepted", "revision": game.revision})

    def create(self, body: dict[str, Any]) -> httpx.Response:
        with self.lock:
            game = TableGame(body)
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

    async def seat_view(
        self, game: TableGame, seat: int, params: httpx.QueryParams
    ) -> httpx.Response:
        since = int(params.get("since", -1))
        deadline = time.monotonic() + min(int(params.get("wait_ms", 0)), 1000) / 1000
        log_from = int(params["log_from"]) if "log_from" in params else None
        while True:
            with self.lock:
                if game.revision > since or game.result or time.monotonic() >= deadline:
                    return httpx.Response(200, json=game.seat_snapshot(seat, log_from))
            await asyncio.sleep(0.01)


@pytest.fixture(scope="module")
def url(tmp_path_factory) -> str:
    folder = tmp_path_factory.mktemp("tables")
    url = f"sqlite:///{folder}/tables.db"
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("CD_DATABASE_URL", url)
        command.upgrade(Config("alembic.ini"), "head")
    engine = create_engine(url)
    import_bulk(engine, folder / "files", bulk(), engine_list())
    engine.dispose()
    return url


@pytest.fixture
def engine() -> TableEngine:
    return TableEngine()


@contextmanager
def served(
    url: str, content: Path, engine: TableEngine | None, **settings: Any
) -> Iterator[TestClient]:
    """The API on the module's database, emptied of accounts and games afterwards."""
    app = create_app(
        Settings(
            database_url=url,
            content_dir=str(content),
            sysop_networks="10.20.0.0/24",
            engine_service_token=SERVICE_TOKEN if engine else "",
            bot_decks="fixtures",
            **settings,
        )
    )
    if engine is not None:
        app.state.engine_transport = httpx.MockTransport(engine)
    try:
        with TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS) as client:
            yield client
    finally:
        database = create_engine(url)
        with Session(database) as db:
            for table in (*TABLES, *ACCOUNT_TABLES):
                db.execute(text(f"DELETE FROM {table}"))
            db.commit()
        database.dispose()


@pytest.fixture
def client(url: str, content: Path, engine: TableEngine) -> Iterator[TestClient]:
    with served(url, content, engine) as client:
        yield client


def card(client: TestClient, name: str) -> str:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return str(
            db.scalar(select(CardConcept.id).where(CardConcept.name == name, CardConcept.deck_card))
        )


def entries(client: TestClient, fmt: str) -> list[dict[str, object]]:
    if fmt == "commander":
        leader = card(client, "Kenrith, the Returned King")
        return [
            {"card_id": leader, "quantity": 1, "location": "commander"},
            {"card_id": card(client, "Wastes"), "quantity": 99, "location": "main"},
        ]
    return [{"card_id": card(client, "Mountain"), "quantity": 60, "location": "main"}]


def deck(account: Account, client: TestClient, fmt: str = "legacy", title: str = "Burn") -> str:
    """A playable deck of the account's own. Players' libraries hold basic lands without limit;
    administrators build from the whole catalog."""
    made = account.send(
        "POST", "/api/v1/decks", {"title": title, "format": fmt, "entries": entries(client, fmt)}
    ).json()
    assert made["playable"] is True, made
    return str(made["id"])


def lotus(client: TestClient) -> list[dict[str, object]]:
    """A Legacy deck holding a card banned in Legacy."""
    return [
        {"card_id": card(client, "Black Lotus"), "quantity": 1, "location": "main"},
        {"card_id": card(client, "Mountain"), "quantity": 59, "location": "main"},
    ]


def banned_deck(account: Account, client: TestClient) -> str:
    """A playable Legacy deck that only tables allowing banned cards take."""
    made = account.send(
        "POST", "/api/v1/decks", {"title": "Lotus", "format": "legacy", "entries": lotus(client)}
    ).json()
    assert (made["playable"], made["needs"]) == (True, ["banned"]), made
    return str(made["id"])


def commander_table(
    client: TestClient,
    host: Account,
    guests: list[Account],
    *,
    bots: int = 0,
    free: int = 0,
    **extra: Any,
) -> str:
    """A Commander table: the host, the guests seated and ready, free seats, then bots."""
    made = host.send(
        "POST",
        "/api/v1/tables",
        {
            "format": "commander",
            "seats": 1 + len(guests) + free + bots,
            "bots": bots,
            "bot_skill": 2,
            "deck_id": deck(host, client, "commander", "Kenrith"),
        }
        | extra,
    )
    assert made.status_code == 201, made.text
    code = str(made.json()["code"])
    for guest in guests:
        mine = deck(guest, client, "commander", f"{guest.id}")
        joined = guest.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": mine})
        assert joined.status_code == 200, joined.text
        guest.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True})
    return code


def matches(message: dict[str, Any], match: dict[str, dict[str, Any]]) -> bool:
    """Whether a presence message's seats match, by seat: {"2": {field: value}}."""
    seats = {str(entry["seat"]): entry for entry in message["seats"]}
    return all(
        all(seats[seat].get(k) == v for k, v in wanted.items()) for seat, wanted in match.items()
    )


def presence(tab: Tab, **match: dict[str, Any]) -> dict[str, Any]:
    """The next presence message whose seats match, by seat: {"2": {field: value}}."""
    for _ in range(100):
        message = tab.until("presence")
        if matches(message, match):
            return message
    raise AssertionError(f"no presence matching {match}")


def snapshot_and_presence(
    tab: Tab, revision: int, **match: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """A snapshot at the revision or later and a matching presence, in whichever order they come.
    The server sends a connection the snapshot it holds, then the presence, and a newer snapshot
    after them when the game has moved on: waiting for the snapshot first could read past the
    presence and then wait for it forever (CI run #90 hung so)."""
    snapshot: dict[str, Any] | None = None
    found: dict[str, Any] | None = None
    for _ in range(200):
        message = tab.receive()
        if message["type"] == "snapshot" and message["snapshot"]["revision"] >= revision:
            snapshot = snapshot or message["snapshot"]
        elif message["type"] == "presence" and matches(message, match):
            found = found or message
        if snapshot is not None and found is not None:
            return snapshot, found
    raise AssertionError(f"no snapshot at revision {revision} and presence matching {match}")


def opened(account: Account, game_id: str, seen: list[str], stack: ExitStack) -> Tab:
    socket = stack.enter_context(account.socket(game_id))
    socket.send_json(account.hello())
    tab = Tab(socket, seen)
    tab.until("welcome")
    return tab


def concede(tab: Tab, game_id: str) -> dict[str, Any]:
    tab.socket.send_json(
        {
            "type": "command",
            "command": {
                "v": 1,
                "game_id": game_id,
                "action_id": str(uuid.uuid4()),
                "expected_revision": 1,
                "type": "concede",
                "payload": {},
            },
        }
    )
    return tab.until("command_result")


def until_finished(account: Account, game_id: str) -> dict[str, Any]:
    for _ in range(200):
        state = account.get(f"/api/v1/games/{game_id}").json()
        if state["game"]["status"] == "finished":
            return state["game"]  # type: ignore[no-any-return]
        time.sleep(0.02)
    raise AssertionError(f"game {game_id} never finished")


def left_reason(client: TestClient, account: Account) -> str | None:
    for _ in range(100):
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            found = db.scalar(select(GameSeat.left_reason).where(GameSeat.user_id == account.id))
        if found is not None:
            return found
        time.sleep(0.02)
    return None


def actions(client: TestClient) -> list[str]:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return list(db.scalars(select(AuditEvent.action)))


def test_a_table_from_the_lobby_to_the_result(client, engine):
    ada = Account(client, "ada", admin=True)
    bob, cara = Account(client, "bob"), Account(client, "cara")
    ada_deck, bob_deck = deck(ada, client), deck(bob, client, title="Mountains")

    # The host opens a public Legacy table; others find it in the lobby, without its decks.
    created = ada.send("POST", "/api/v1/tables", {"format": "legacy", "deck_id": ada_deck})
    assert created.status_code == 201, created.text
    table = created.json()
    code = table["code"]
    assert len(code) >= 16 and table["status"] == "open" and table["your_seat"] == 0
    assert table["rules"] == {"banned": True, "not_legal": True}
    assert table["players"][0] == {
        "seat": 0,
        "player": "human",
        "taken": True,
        "handle": "ada",
        "portrait": None,
        "host": True,
        "ready": True,
        "you": True,
        "deck": "Burn",
        "deck_id": ada_deck,
        "team": None,
    }
    assert table["players"][1]["taken"] is False and table["can_start"] is False
    listed = bob.get("/api/v1/tables").json()
    assert [found["code"] for found in listed] == [code]
    assert listed[0]["players"][0]["deck"] is None and listed[0]["your_seat"] is None
    assert ada_deck not in json.dumps(listed)

    # Bob sits down with a deck of his own, then is ready; the host starts.
    refused = bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": ada_deck})
    assert (refused.status_code, refused.json()["code"]) == (422, "invalid_deck")
    joined = bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": bob_deck}).json()
    assert joined["your_seat"] == 1 and joined["players"][1]["deck"] == "Mountains"
    assert joined["players"][0]["deck"] is None and joined["players"][0]["deck_id"] is None
    full = cara.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": deck(cara, client)})
    assert (full.status_code, full.json()["code"]) == (409, "table_full")
    early = ada.send("POST", f"/api/v1/tables/{code}/start")
    assert (early.status_code, early.json()["code"]) == (409, "not_ready")
    assert bob.send("POST", f"/api/v1/tables/{code}/start").json()["code"] == "not_host"
    ready = bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True}).json()
    assert ready["players"][1]["ready"] is True
    assert ada.get(f"/api/v1/tables/{code}").json()["can_start"] is True
    started = ada.send("POST", f"/api/v1/tables/{code}/start")
    assert started.status_code == 200, started.text
    game_id = started.json()["game_id"]
    assert started.json()["status"] == "started" and game_id
    assert bob.get(f"/api/v1/tables/{code}").json()["game_id"] == game_id
    assert cara.get(f"/api/v1/tables/{code}").json()["game_id"] is None
    assert bob.get("/api/v1/tables").json() == []

    # One engine game with both players' decks, and an idle timeout no thinking player meets.
    body = engine.created[-1]
    assert [seat["player"] for seat in body["seats"]] == ["human", "human"]
    assert body["seats"][1]["deck_list"]["cards"] == [{"name": "Mountain", "count": 60}]
    assert body["idle_timeout_seconds"] == games.TABLE_IDLE_SECONDS == 3600
    fake = engine.games[game_id]
    summary = bob.get(f"/api/v1/games/{game_id}").json()
    assert summary["game"]["kind"] == "table" and summary["game"]["your_seat"] == 1
    assert [seat["handle"] for seat in summary["game"]["seats"]] == ["ada", "bob"]
    assert [seat["deck"] for seat in summary["game"]["seats"]] == [None, "Mountains"]
    assert summary["snapshot"]["seat"] == 1
    assert cara.get(f"/api/v1/games/{game_id}").status_code == 404

    # Each player's tabs see their own seat only, and play it.
    seen_ada: list[str] = []
    seen_bob: list[str] = []
    with ExitStack() as stack:
        ada_tab = opened(ada, game_id, seen_ada, stack)
        bob_tab = opened(bob, game_id, seen_bob, stack)
        assert ada_tab.until("lease")["role"] == "controller"
        assert bob_tab.until("lease")["role"] == "controller"
        both = {"0": {"connected": True}, "1": {"connected": True}}
        assert snapshot_and_presence(ada_tab, 1, **both)[0]["seat"] == 0
        assert bob_tab.snapshot(1)["seat"] == 1
        # A player's close does not end the game for the other: they concede instead.
        closing = bob.send("POST", f"/api/v1/games/{game_id}/close")
        assert (closing.status_code, closing.json()["code"]) == (409, "table_game")
        assert concede(bob_tab, game_id)["status"] == 200
        assert ada_tab.snapshot(2)["result"]["winner_seat"] == 0
        assert bob_tab.snapshot(2)["result"]["winner_seat"] == 0
    assert fake.conceded_by == [f"Bearer {fake.tokens[1]}"]
    for text_seen, other in ((seen_ada, 1), (seen_bob, 0)):
        joined_text = "\n".join(text_seen)
        assert f"Secret of seat {other}" not in joined_text
        assert all(token not in joined_text for token in fake.tokens.values())
        assert SERVICE_TOKEN not in joined_text

    # The winner's win counts, and the win over a player with no wins pays 50 tokens.
    won = until_finished(ada, game_id)
    assert won["result"]["winner_seat"] == 0 and won["tokens"] == economy.human_tokens(0) == 50
    assert until_finished(bob, game_id)["tokens"] == 0
    assert ada.get("/api/v1/me/progress").json()["counted_wins"] == 1
    with Session(client.app.state.database) as db:
        paid = db.scalar(select(TokenEntry).where(TokenEntry.game_id == uuid.UUID(game_id)))
        assert paid is not None
        assert (paid.kind, paid.user_id, paid.opponent_id) == ("human_win", ada.id, bob.id)


def test_away_players_are_voted_out(client, engine, monkeypatch):
    monkeypatch.setattr(games, "AWAY_SECONDS", 1.0)
    ada, bob, cara = (Account(client, name, admin=True) for name in ("ada", "bob", "cara"))
    code = commander_table(client, ada, [bob, cara], bots=1)
    game_id = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
    assert [seat["player"] for seat in engine.created[-1]["seats"]] == ["human"] * 3 + ["bot"]
    assert engine.created[-1]["skill"] == 2
    fake = engine.games[game_id]
    seen: list[str] = []
    with ExitStack() as stack:
        ada_tab = opened(ada, game_id, seen, stack)
        bob_tab = opened(bob, game_id, seen, stack)
        with cara.socket(game_id) as cara_socket:
            cara_socket.send_json(cara.hello())
            Tab(cara_socket, []).until("welcome")
            presence(ada_tab, **{"2": {"connected": True}})
        # Cara's only tab closed: she is away, but not yet for long enough to vote on.
        away = presence(ada_tab, **{"2": {"connected": False, "removable": False}})
        assert away["away_after"] == 1
        ada_tab.socket.send_json({"type": "vote", "seat": 2, "remove": True})
        refusal = ada_tab.until("error")
        assert (refusal["code"], refusal["seat"]) == ("not_removable", 2)
        presence(ada_tab, **{"2": {"removable": True, "needed": 2}})
        # A majority of the other players still in the game: both of them.
        ada_tab.socket.send_json({"type": "vote", "seat": 2, "remove": True})
        presence(bob_tab, **{"2": {"yes": [0]}})
        bob_tab.socket.send_json({"type": "vote", "seat": 2, "remove": False})
        presence(ada_tab, **{"2": {"yes": [0], "no": [1]}})
        bob_tab.socket.send_json({"type": "vote", "seat": 2, "remove": True})
        presence(ada_tab, **{"2": {"left": "removed", "removable": False}})
        # The engine conceded her seat with her own token; the game goes on.
        assert fake.conceded_by == [f"Bearer {fake.tokens[2]}"] and fake.result is None
        # Coming back, she is shown that she is out.
        with cara.socket(game_id) as cara_socket:
            cara_socket.send_json(cara.hello())
            back, _ = snapshot_and_presence(
                Tab(cara_socket, []),
                fake.revision,
                **{"2": {"left": "removed", "connected": True}},
            )
            assert back["status"] == "eliminated"
    assert "Secret of seat 2" not in "\n".join(seen)
    with Session(client.app.state.database) as db:
        removed = db.scalar(select(AuditEvent).where(AuditEvent.action == "table.player_removed"))
        assert removed is not None
        assert (removed.target_user_id, removed.actor_id) == (cara.id, bob.id)
        assert removed.details["seat"] == 2
        assert set(removed.details["voters"]) == {str(ada.id), str(bob.id)}  # type: ignore[arg-type]
        assert games.active_games_of(db, cara.id) == 0
        assert games.active_games_of(db, ada.id) == 1
    assert left_reason(client, cara) == "removed"
    summary = cara.get(f"/api/v1/games/{game_id}").json()["game"]
    assert summary["seats"][2]["left"] == "removed" and summary["status"] == "active"
    assert ada.send("POST", f"/api/v1/games/{game_id}/close").status_code == 409


def test_in_a_two_player_game_the_opponent_alone_removes(client, engine, monkeypatch):
    monkeypatch.setattr(games, "AWAY_SECONDS", 0.2)
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    code = commander_table(client, ada, [bob])
    game_id = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
    with ExitStack() as stack:
        ada_tab = opened(ada, game_id, [], stack)
        # Bob never came: away from the start.
        presence(ada_tab, **{"1": {"removable": True, "needed": 1}})
        ada_tab.socket.send_json({"type": "vote", "seat": 0, "remove": True})
        assert ada_tab.until("error")["code"] == "invalid_vote"
        ada_tab.socket.send_json({"type": "vote", "seat": 1, "remove": True})
        result = ada_tab.snapshot(2)["result"]
        assert (result["kind"], result["winner_seat"]) == ("completed", 0)
    assert until_finished(ada, game_id)["tokens"] == 50
    assert "table.player_removed" in actions(client)


def test_seats_limits_and_privacy(client, engine):
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    cara, root = Account(client, "cara"), Account(client, "sysop", kind="sysop")

    # A private table is reached by its link alone; SysOp sees every table.
    private = commander_table(client, ada, [], free=1, visibility="private")
    assert bob.get("/api/v1/tables").json() == []
    assert [found["code"] for found in root.get("/api/v1/tables").json()] == [private]
    assert bob.get(f"/api/v1/tables/{private}").json()["visibility"] == "private"
    assert bob.get("/api/v1/tables/no-such-table-code").status_code == 404
    for invalid in (
        {"format": "legacy", "seats": 3},
        {"format": "commander", "seats": 3, "bots": 2},
    ):
        made = ada.send("POST", "/api/v1/tables", invalid | {"deck_id": deck(ada, client)})
        assert (made.status_code, made.json()["code"]) == (422, "invalid_table")

    # One open table at a time.
    second = ada.send("POST", "/api/v1/tables", {"format": "legacy", "deck_id": deck(ada, client)})
    assert (second.status_code, second.json()["code"]) == (409, "at_a_table")
    mine = deck(bob, client, "commander", "Bob's")
    assert bob.send("POST", f"/api/v1/tables/{private}/join", {"deck_id": mine}).status_code == 200
    other = cara.send("POST", "/api/v1/tables", {"format": "legacy", "deck_id": deck(cara, client)})
    other_code = other.json()["code"]
    joined = bob.send("POST", f"/api/v1/tables/{other_code}/join", {"deck_id": deck(bob, client)})
    assert joined.json()["code"] == "at_a_table"

    # A deck the player's library cannot build is refused, as at the practice table.
    locked = cara.send(
        "POST",
        "/api/v1/decks",
        {"title": "Not mine", "format": "commander", "entries": entries(client, "commander")},
    ).json()
    assert locked["playable"] is False
    assert cara.send("POST", f"/api/v1/tables/{other_code}/leave").json()["status"] == "closed"
    refused = cara.send("POST", f"/api/v1/tables/{private}/join", {"deck_id": locked["id"]})
    assert (refused.status_code, refused.json()["code"]) == (409, "table_full")

    # Changing deck makes the player not ready; leaving frees the seat; the host leaving closes.
    bob.send("PATCH", f"/api/v1/tables/{private}/seat", {"ready": True})
    changed = bob.send(
        "PATCH",
        f"/api/v1/tables/{private}/seat",
        {"deck_id": deck(bob, client, "commander", "Other")},
    ).json()
    assert changed["players"][1]["ready"] is False and changed["players"][1]["deck"] == "Other"
    left = bob.send("POST", f"/api/v1/tables/{private}/leave").json()
    assert left["your_seat"] is None and left["players"][1]["taken"] is False
    refused = cara.send("POST", f"/api/v1/tables/{private}/join", {"deck_id": locked["id"]})
    assert (refused.status_code, refused.json()["code"]) == (422, "deck_not_playable")
    assert ada.send("POST", f"/api/v1/tables/{private}/leave").json()["status"] == "closed"
    closed_table = bob.send("POST", f"/api/v1/tables/{private}/join", {"deck_id": mine})
    assert (closed_table.status_code, closed_table.json()["code"]) == (409, "table_closed")

    # A table nobody started closes after a while.
    stale = commander_table(client, ada, [], free=1)
    with Session(client.app.state.database) as db:
        found = db.scalar(select(GameTable).where(GameTable.code == stale))
        assert found is not None
        found.created_at = found.created_at - timedelta(hours=4)
        db.commit()
    assert ada.get(f"/api/v1/tables/{stale}").json()["status"] == "closed"
    assert root.get("/api/v1/tables").json() == []


def test_the_hosts_rules_choose_which_decks_sit(client, engine):
    """The host chooses which cards its decks may hold by their legality (v0.4.5): casual by
    default, tournament rules allowing neither banned cards nor cards not legal in the format.
    Every deck is checked as it sits down, its player told which cards, and again at the start,
    where the host learns only whose deck no longer fits."""
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    root = Account(client, "sysop", kind="sysop")
    tournament = {"banned": False, "not_legal": False}

    # The host's own deck is checked too.
    refused = ada.send(
        "POST",
        "/api/v1/tables",
        {"format": "legacy", "deck_id": banned_deck(ada, client), "rules": tournament},
    )
    assert (refused.status_code, refused.json()["code"]) == (422, "deck_not_allowed")
    assert refused.json()["message"] == (
        "This table does not allow banned cards: Black Lotus is banned in Legacy. Choose another "
        "deck, or take it out of this one."
    )
    ada_deck = deck(ada, client)
    made = ada.send(
        "POST", "/api/v1/tables", {"format": "legacy", "deck_id": ada_deck, "rules": tournament}
    )
    assert made.status_code == 201, made.text
    code = made.json()["code"]
    assert made.json()["rules"] == tournament
    assert [found["rules"] for found in bob.get("/api/v1/tables").json()] == [tournament]
    assert bob.get(f"/api/v1/tables/{code}").json()["rules"] == tournament

    # A player is told which cards keep their deck out: joining, and changing deck.
    bobs_lotus = banned_deck(bob, client)
    joined = bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": bobs_lotus})
    assert (joined.status_code, joined.json()["code"]) == (422, "deck_not_allowed")
    assert "Black Lotus is banned in Legacy" in joined.json()["message"]
    bob_deck = deck(bob, client)
    joined = bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": bob_deck})
    assert joined.status_code == 200, joined.text
    changed = bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"deck_id": bobs_lotus})
    assert changed.json()["code"] == "deck_not_allowed"

    # A deck changed after it sat down is checked again at the start: the host learns whose.
    edited = bob.send(
        "PUT", f"/api/v1/decks/{bob_deck}/draft", {"version": 1, "entries": lotus(client)}
    )
    assert edited.json()["validation"]["needs"] == ["banned"]
    bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True})
    stopped = ada.send("POST", f"/api/v1/tables/{code}/start").json()
    assert stopped["code"] == "deck_not_playable"
    assert stopped["message"] == "bob's deck cannot be played now; they need to choose another."
    assert ada.get(f"/api/v1/tables/{code}").json()["players"][1]["ready"] is False
    # The host's own, edited, is named to the host.
    bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"deck_id": deck(bob, client)})
    bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True})
    ada.send("PUT", f"/api/v1/decks/{ada_deck}/draft", {"version": 1, "entries": lotus(client)})
    own = ada.send("POST", f"/api/v1/tables/{code}/start").json()
    assert own["code"] == "deck_not_allowed" and "Black Lotus" in own["message"]
    assert engine.created == []
    ada.send("POST", f"/api/v1/tables/{code}/leave")

    # A table is casual unless its host says otherwise; one rule may stay on alone.
    casual = bob.send("POST", "/api/v1/tables", {"format": "legacy", "deck_id": bobs_lotus})
    assert casual.status_code == 201 and casual.json()["rules"] == {
        "banned": True,
        "not_legal": True,
    }
    bob.send("POST", f"/api/v1/tables/{casual.json()['code']}/leave")
    no_bans = bob.send(
        "POST",
        "/api/v1/tables",
        {
            "format": "legacy",
            "deck_id": bobs_lotus,
            "rules": {"banned": False, "not_legal": True},
        },
    )
    assert no_bans.json()["code"] == "deck_not_allowed"
    # SysOp's decks need only cards the engine implements, at any table.
    sysops = root.send(
        "POST",
        "/api/v1/tables",
        {"format": "legacy", "deck_id": banned_deck(root, client), "rules": tournament},
    )
    assert sysops.status_code == 201, sysops.text


def test_tables_open_at_the_upgrade_become_casual(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path}/rules.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    config = Config("alembic.ini")
    before = ScriptDirectory.from_config(config).get_revision("0019_table_rules").down_revision
    assert isinstance(before, str)
    command.upgrade(config, before)
    engine = create_engine(url)
    user = uuid.uuid4()
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
                "INSERT INTO game_tables (id, code, host_id, format, visibility, seats, bots, "
                "bot_skill, turn_cap, status, created_at) VALUES (:id, 'open-table-code', :user, "
                "'legacy', 'public', 2, 0, 4, 60, 'open', CURRENT_TIMESTAMP)"
            ),
            {"id": uuid.uuid4().hex, "user": user.hex},
        )
    command.upgrade(config, "head")
    with engine.connect() as connection:
        found = connection.execute(text("SELECT allow_banned, allow_not_legal FROM game_tables"))
        assert [tuple(map(bool, row)) for row in found] == [(True, True)]
    command.downgrade(config, before)
    command.upgrade(config, "head")
    engine.dispose()


def test_starting_keeps_every_players_limit(url, content, engine):
    with served(url, content, engine, games_per_account=1) as client:
        ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
        code = commander_table(client, ada, [bob])
        # Bob started a practice game meanwhile: the table waits for it.
        practice = bob.send(
            "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck(bob, client)}
        )
        assert practice.status_code == 201, practice.text
        busy = ada.send("POST", f"/api/v1/tables/{code}/start")
        assert busy.status_code == 409 and busy.json()["message"].startswith("bob has a game")
        bob.send("POST", f"/api/v1/games/{practice.json()['id']}/close")
        assert ada.send("POST", f"/api/v1/tables/{code}/start").status_code == 200
        again = ada.send("POST", f"/api/v1/tables/{code}/start")
        assert again.json()["code"] == "table_closed"
        # While the table's game runs, neither player starts another.
        another = bob.send(
            "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck(bob, client)}
        )
        assert another.json()["code"] == "game_limit"
        # Another player's deck that can no longer be played is named by its player, not shown.
        cara, dana = Account(client, "cara", admin=True), Account(client, "dana", admin=True)
        code = commander_table(client, cara, [dana])
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            db.execute(
                text("UPDATE decks SET deleted_at = created_at WHERE title = :title"),
                {"title": str(dana.id)},
            )
            db.commit()
        refused = cara.send("POST", f"/api/v1/tables/{code}/start").json()
        assert refused["code"] == "deck_not_playable" and refused["message"].startswith("dana's")
        assert str(dana.id) not in refused["message"]
        assert cara.get(f"/api/v1/tables/{code}").json()["players"][1]["ready"] is False


def test_a_concession_frees_the_seat_and_sysop_observes(client, engine):
    """A player who concedes while the game goes on is out of it: it no longer counts against
    their running games. SysOp observes the first player's seat, sees every deck, and closes."""
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    root = Account(client, "sysop", kind="sysop")
    code = commander_table(client, ada, [bob], bots=1)
    game_id = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
    seen: list[str] = []
    with ExitStack() as stack:
        watching = opened(root, game_id, seen, stack)
        assert watching.until("error")["code"] == "not_owner"
        assert watching.snapshot(1)["seat"] == 0
        bob_tab = opened(bob, game_id, [], stack)
        assert concede(bob_tab, game_id)["status"] == 200
        presence(watching, **{"1": {"left": "conceded"}})
        root_view = root.get(f"/api/v1/games/{game_id}").json()["game"]
        assert root_view["seats"][1]["deck"] and root_view["status"] == "active"
        # Votes come from the players only.
        watching.socket.send_json({"type": "vote", "seat": 1, "remove": True})
        assert watching.until("error")["code"] == "not_a_player"
        watching.socket.send_json({"type": "vote", "seat": "1"})
        assert watching.until("error")["code"] == "invalid_message"
    assert "Secret of seat 1" not in "\n".join(seen)
    assert left_reason(client, bob) == "conceded"
    with Session(client.app.state.database) as db:
        assert games.active_games_of(db, bob.id) == 0
    practice = bob.send(
        "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck(bob, client)}
    )
    assert practice.status_code == 201, practice.text
    closed_now = root.send("POST", f"/api/v1/games/{game_id}/close")
    assert closed_now.status_code == 200
    assert closed_now.json()["result"] == {key: closed()[key] for key in games.RESULT_FIELDS}
    assert "game.closed" in actions(client)


def test_tables_need_the_service(url, content):
    with served(url, content, None) as client:
        ada = Account(client, "ada", admin=True)
        code = commander_table(client, ada, [], free=1)
        off = ada.send("POST", f"/api/v1/tables/{code}/start")
        assert (off.status_code, off.json()["code"]) == (503, "games_unavailable")


def test_the_migration_keeps_table_games_when_it_goes_back(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path}/down.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    config = Config("alembic.ini")
    command.upgrade(config, "head")
    engine = create_engine(url)
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
                "turn_cap) VALUES (:id, 'table', 'legacy', 'finished', :user, CURRENT_TIMESTAMP, "
                "4, 60)"
            ),
            {"id": game.hex, "user": user.hex},
        )
    command.downgrade(config, "0008_tokens")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT kind FROM games")).scalar() == "practice"
    command.upgrade(config, "head")
    engine.dispose()
