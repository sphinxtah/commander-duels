"""King's Table (v0.8.7) through the API, against a fake engine that speaks its contract: six
seats in two teams of three, a required kings_table object (refused with any other format), no
starting_seat, the settings echoed, seat views with each player's team, role and life, and the
team result, in which an eliminated General is not among winner_seats. Covers every combination
of the settings reaching the engine, the six-seat table (seats taken by number or team, bots in the
seats the host chooses, the host moving players, readiness cleared by any change, the lock at the
start), practice from each seat and its rematch, the team's result for every original teammate
(paid, counted and recorded), a draw paying nobody, the refusals, and the migration going back."""

import itertools
import json
import uuid
from collections.abc import Iterator
from contextlib import ExitStack
from pathlib import Path
from typing import Any

import httpx
import pytest
import test_progression
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session
from test_tables import (
    Account,
    TableEngine,
    TableGame,
    concede,
    deck,
    left_reason,
    opened,
    served,
    until_finished,
    url,
)

from api import games, kings_table
from api.models import Game, PlayerResult, ProgressEntry, TokenEntry

content = test_progression.content
__all__ = ["url"]
KINGS = "kings_table"
SETTINGS = {"deck_format", "life", "king_attacks_anyone"}
LIVES = ("all_20", "all_40", "generals_20_kings_40")
COMBINATIONS = list(itertools.product(("legacy", "commander"), LIVES, (False, True)))
# Rows these tests leave behind, removed before the tables' own cleanup.
KINGS_TABLES = (
    "rematch_players",
    "rematches",
    "player_achievements",
    "daily_quests",
    "player_results",
    "table_messages",
)


def life_of(settings: dict[str, Any], seat: int) -> int:
    life = settings["life"]
    if life == "generals_20_kings_40":
        return 40 if seat in (1, 4) else 20
    return 20 if life == "all_20" else 40


class KingsGame(TableGame):
    """A King's Table game: bots without a deck play the deck format's fixtures, each seat's view
    lists every player's team, role, life and range, and the result is a team's. An eliminated
    General is out, never among winner_seats; a King's concession loses their team the game."""

    def __init__(self, body: dict[str, Any]) -> None:
        super().__init__(body)
        self.settings: dict[str, Any] | None = body.get("kings_table")
        if self.settings is not None:
            fixtures = [
                deck
                for deck in games.FIXTURE_DECKS[KINGS]
                if deck.startswith(self.settings["deck_format"])
            ]
            self.decks = [
                seat.get("deck") or ("custom" if "deck_list" in seat else fixtures[index % 4])
                for index, seat in enumerate(body["seats"])
            ]

    def seat_snapshot(self, seat: int, log_from: int | None) -> dict[str, Any]:
        snapshot = super().seat_snapshot(seat, log_from)
        if self.settings is not None:
            # As the engine's views carry them (contracts/engine-seat-view.schema.json).
            snapshot["view"]["you"] = self.player(seat, seat)
            snapshot["view"]["opponents"] = [
                self.player(seat, other) for other in range(6) if other != seat
            ]
        return snapshot

    def player(self, seat: int, other: int) -> dict[str, Any]:
        assert self.settings is not None
        apart = min((other - seat) % 6, (seat - other) % 6)
        king = seat in (1, 4)
        in_range = other != seat and apart <= (2 if king else 1)
        foe = seat // 3 != other // 3
        return {
            "seat": other,
            "team": other // 3,
            "role": "king" if other in (1, 4) else "general",
            "starting_life": life_of(self.settings, other),
            "in_range": in_range,
            "attackable": foe and (in_range or (king and self.settings["king_attacks_anyone"])),
        }

    def concede(self, seat: int) -> None:
        if self.settings is None:
            super().concede(seat)
            return
        self.out.append(seat)
        if seat in (1, 4):
            self.end(1 - seat // 3, [seat])
            return
        self.revision += 1
        self.log.append(f"General {seat} concedes.")
        if all(index in self.out for index in self.tokens):
            # No player is left: the engine ends the game, as it does in every format.
            self.result = {
                "kind": "humans_eliminated",
                "winner_seat": None,
                "winner_seats": [],
                "draw": False,
                "turns": 3,
                "conceded_seats": list(self.out),
                "error": None,
            }

    def end(self, team: int | None, conceded: list[int]) -> None:
        winners = [] if team is None else [s for s in (3 * team + i for i in range(3))]
        standing = [s for s in winners if s not in self.out]
        self.result = {
            "kind": "completed",
            "winner_seat": standing[0] if standing else None,
            "winner_seats": standing,
            "draw": team is None,
            "turns": 7,
            "conceded_seats": conceded,
            "error": None,
        }
        self.revision += 1
        self.log.append("Both Kings fall." if team is None else f"Team {team} wins.")


class KingsEngine(TableEngine):
    """The tables' fake engine, held to King's Table's create contract."""

    def __init__(self) -> None:
        super().__init__()
        self.echo = True

    def create(self, body: dict[str, Any]) -> httpx.Response:
        refused = self.refusal(body)
        if refused:
            return httpx.Response(400, json={"code": "invalid_settings", "message": refused})
        with self.lock:
            game = KingsGame(body)
            self.games[game.id] = game
            self.created.append(body)
        settings: dict[str, Any] = {
            "format": body["format"],
            "seats": [
                {"seat": i, "player": seat["player"], "deck": game.decks[i]}
                for i, seat in enumerate(body["seats"])
            ],
            "kings_table": body.get("kings_table") if self.echo else None,
        }
        if body["format"] == KINGS:
            settings["rules_profile"] = f"kings_table_{body['kings_table']['deck_format']}"
        return httpx.Response(
            201,
            json={
                "game_id": game.id,
                "seats": [
                    {"seat": i, "player": seat["player"], "seat_token": game.tokens.get(i)}
                    for i, seat in enumerate(body["seats"])
                ],
                "spectator_token": game.spectator,
                "settings": settings,
            },
        )

    @staticmethod
    def refusal(body: dict[str, Any]) -> str | None:
        settings = body.get("kings_table")
        if body["format"] != KINGS:
            return "kings_table is King's Table's" if "kings_table" in body else None
        if not isinstance(settings, dict) or set(settings) != SETTINGS:
            return "King's Table needs its settings"
        if settings["deck_format"] not in ("legacy", "commander") or settings["life"] not in LIVES:
            return "unknown King's Table settings"
        if not isinstance(settings["king_attacks_anyone"], bool):
            return "king_attacks_anyone is a boolean"
        if len(body["seats"]) != 6:
            return "King's Table seats six"
        if "starting_seat" in body:
            return "the engine chooses which King starts"
        return None

    def kings(self, game_id: str) -> KingsGame:
        found = self.games[game_id]
        assert isinstance(found, KingsGame)
        return found

    def eliminate(self, game_id: str, seat: int) -> None:
        with self.lock:
            game = self.kings(game_id)
            game.out.append(seat)
            game.revision += 1

    def win(self, game_id: str, team: int) -> None:
        with self.lock:
            self.kings(game_id).end(team, [])

    def draw(self, game_id: str) -> None:
        with self.lock:
            self.kings(game_id).end(None, [])


@pytest.fixture
def engine() -> KingsEngine:
    return KingsEngine()


@pytest.fixture
def client(url: str, content: Path, engine: KingsEngine) -> Iterator[TestClient]:
    with served(url, content, engine, games_per_account=4) as client:
        try:
            yield client
        finally:
            with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
                for table in KINGS_TABLES:
                    db.execute(text(f"DELETE FROM {table}"))
                db.commit()


def players(*handles: str, client: TestClient) -> list[Account]:
    return [Account(client, handle, admin=True) for handle in handles]


def kings_table_of(host: Account, deck_id: str, expect: int = 201, **extra: Any) -> dict[str, Any]:
    made = host.send(
        "POST", "/api/v1/tables", {"format": KINGS, "seats": 6, "deck_id": deck_id} | extra
    )
    assert made.status_code == expect, made.text
    return made.json()  # type: ignore[no-any-return]


def sit(account: Account, code: str, deck_id: str, **extra: Any) -> httpx.Response:
    return account.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": deck_id} | extra)


def patch_seat(account: Account, code: str, **body: Any) -> httpx.Response:
    return account.send("PATCH", f"/api/v1/tables/{code}/seat", body)


def change(host: Account, code: str, **body: Any) -> httpx.Response:
    return host.send("PATCH", f"/api/v1/tables/{code}", body)


def readiness(view: dict[str, Any]) -> dict[int, bool]:
    """Each player's seat and whether they are ready, the host's always."""
    return {p["seat"]: p["ready"] for p in view["players"] if p["player"] == "human" and p["taken"]}


def practice(account: Account, deck_id: str, **extra: Any) -> httpx.Response:
    return account.send(
        "POST", "/api/v1/practice-games", {"format": KINGS, "deck_id": deck_id} | extra
    )


def until_left(client: TestClient, account: Account) -> None:
    assert left_reason(client, account) == "eliminated"


def ledger(client: TestClient, model: Any, game_id: str) -> list[Any]:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return list(db.scalars(select(model).where(model.game_id == uuid.UUID(game_id))))


def outcomes(client: TestClient, game_id: str) -> dict[int, str]:
    return {row.seat: row.outcome for row in ledger(client, PlayerResult, game_id)}


def paid(client: TestClient, game_id: str) -> dict[uuid.UUID, int]:
    found: dict[uuid.UUID, int] = {}
    for row in ledger(client, TokenEntry, game_id):
        found[row.user_id] = found.get(row.user_id, 0) + row.amount
    return found


# The format and its settings.


def test_the_settings_and_the_seats() -> None:
    assert [kings_table.role_of(seat) for seat in range(6)] == [
        "general",
        "king",
        "general",
        "general",
        "king",
        "general",
    ]
    assert [kings_table.team_of(seat) for seat in range(6)] == [0, 0, 0, 1, 1, 1]
    defaults = kings_table.config_of(None)
    assert kings_table.engine_settings(defaults) == {
        "deck_format": "commander",
        "life": "all_40",
        "king_attacks_anyone": False,
    }
    split = kings_table.config_of({"life": "generals_20_kings_40"})
    assert [kings_table.starting_life(split, s) for s in range(6)] == [20, 40, 20, 20, 40, 20]
    # The engine's winners leave an eliminated General out; the team is every seat of it.
    result = {"kind": "completed", "winner_seat": 4, "winner_seats": [4, 5], "draw": False}
    assert kings_table.team_result(result) | {} == result | {
        "winner_seats": [3, 4, 5],
        "winner_team": 1,
    }
    drawn = {"kind": "completed", "winner_seat": None, "winner_seats": [], "draw": True}
    assert kings_table.team_result(drawn)["winner_team"] is None


def test_the_play_page_and_the_practice_options_list_it(client):
    ada = Account(client, "ada", admin=True)
    listed = {found["id"]: found for found in ada.get("/api/v1/formats").json()}
    assert listed[KINGS] | {"description": ""} == {
        "id": KINGS,
        "name": "King's Table",
        "seats": [6],
        "default_seats": 6,
        "description": "",
        "available": True,
        "early": False,
    }
    options = {
        found["id"]: found for found in ada.get("/api/v1/practice-games/options").json()["formats"]
    }
    assert options[KINGS]["bots"] == [5] and options[KINGS]["best_of"] == [1]
    assert options[KINGS]["kings_table"] == {
        "deck_format": "commander",
        "life": "all_40",
        "king_attacks_anyone": False,
    }
    assert options["legacy"]["kings_table"] is None
    # Its fixture decks by deck format (v0.8.8), each list of its own format; others have none.
    by_format = options[KINGS]["decks_by_format"]
    assert set(by_format) == {"legacy", "commander"}
    assert all(d.startswith(f"{fmt}-") for fmt, decks in by_format.items() for d in decks)
    assert options["legacy"]["decks_by_format"] is None


@pytest.mark.parametrize(("deck_format", "life", "king_attacks_anyone"), COMBINATIONS)
def test_every_combination_of_settings_reaches_the_engine(
    client, engine, deck_format, life, king_attacks_anyone
):
    ada = Account(client, "ada", admin=True)
    settings = {
        "deck_format": deck_format,
        "life": life,
        "king_attacks_anyone": king_attacks_anyone,
    }
    mine = deck(ada, client, deck_format, "Mine")

    # At the practice table, from team B's Right General's seat.
    started = practice(ada, mine, seat=3, kings_table=settings)
    assert started.status_code == 201, started.text
    body = engine.created[-1]
    assert body["format"] == KINGS and body["kings_table"] == settings
    assert "starting_seat" not in body
    assert [seat["player"] for seat in body["seats"]] == ["bot"] * 3 + ["human"] + ["bot"] * 2
    assert body["seats"][3]["deck_list"]["cards"]
    assert ("commanders" in body["seats"][3]["deck_list"]) == (deck_format == "commander")
    assert all("deck" not in seat and "deck_list" not in seat for seat in body["seats"][:3])
    summary = started.json()
    assert summary["kings_table"] == settings and summary["your_seat"] == 3
    assert [(s["team"], s["role"], s["starting_life"]) for s in summary["seats"]] == [
        (seat // 3, kings_table.role_of(seat), life_of(settings, seat)) for seat in range(6)
    ]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        game = db.get(Game, uuid.UUID(summary["id"]))
        assert game is not None and game.kings_table == settings
    # The seat's view passes through as the engine made it.
    view = ada.get(f"/api/v1/games/{summary['id']}").json()["snapshot"]["view"]
    shown = sorted([view["you"], *view["opponents"]], key=lambda player: player["seat"])
    assert [p["starting_life"] for p in shown] == [life_of(settings, s) for s in range(6)]
    assert [(p["team"], p["role"]) for p in shown] == [
        (s // 3, kings_table.role_of(s)) for s in range(6)
    ]
    assert ada.send("POST", f"/api/v1/games/{summary['id']}/close").status_code == 200

    # At a table: the host alone in team A's King's seat, bots in the five others.
    table = kings_table_of(ada, mine, kings_table=settings, bot_seats=[0, 2, 3, 4, 5])
    assert table["kings_table"] == settings and table["bots"] == 5 and table["can_start"] is True
    assert [(p["seat"], p["player"], p["role"], p["starting_life"]) for p in table["players"]] == [
        (seat, "human" if seat == 1 else "bot", kings_table.role_of(seat), life_of(settings, seat))
        for seat in range(6)
    ]
    begun = ada.send("POST", f"/api/v1/tables/{table['code']}/start")
    assert begun.status_code == 200, begun.text
    body = engine.created[-1]
    assert body["kings_table"] == settings and "starting_seat" not in body
    assert [seat["player"] for seat in body["seats"]] == [
        "bot",
        "human",
        "bot",
        "bot",
        "bot",
        "bot",
    ]
    game_id = begun.json()["game_id"]
    assert ada.get(f"/api/v1/games/{game_id}").json()["game"]["kings_table"] == settings


# Tables.


def test_seats_moves_and_readiness(client, engine):
    ada, bob, cara, dan = players("ada", "bob", "cara", "dan", client=client)
    decks = {
        account.id: deck(account, client, "commander", account.id.hex)
        for account in (ada, bob, cara, dan)
    }
    table = kings_table_of(ada, decks[ada.id], seat=4, bot_seats=[5])
    code = table["code"]
    assert table["your_seat"] == 4 and table["kings_table"]["deck_format"] == "commander"
    assert [(p["seat"], p["team"], p["role"], p["taken"]) for p in table["players"]] == [
        (0, 0, "general", False),
        (1, 0, "king", False),
        (2, 0, "general", False),
        (3, 1, "general", False),
        (4, 1, "king", True),
        (5, 1, "general", True),
    ]
    # A seat by its number, by its team, or the first open one; never a taken or a bot's seat.
    assert sit(bob, code, decks[bob.id], seat=1).json()["your_seat"] == 1
    taken = sit(cara, code, decks[cara.id], seat=4)
    assert (taken.status_code, taken.json()["code"]) == (409, "seat_taken")
    bots = sit(cara, code, decks[cara.id], seat=5)
    assert (bots.status_code, bots.json()["code"]) == (409, "seat_taken")
    assert sit(cara, code, decks[cara.id], team=1).json()["your_seat"] == 3
    legacy = sit(dan, code, deck(dan, client, "legacy", "Burn"))
    assert (legacy.status_code, legacy.json()["code"]) == (422, "invalid_deck")
    assert sit(dan, code, decks[dan.id]).json()["your_seat"] == 0
    for account in (bob, cara, dan):
        assert patch_seat(account, code, ready=True).status_code == 200
    ready = ada.get(f"/api/v1/tables/{code}").json()
    assert readiness(ready) == {0: True, 1: True, 3: True, 4: True} and ready["can_start"] is False

    # A setting that changes clears every seat's readiness; one that does not, nothing.
    same = change(ada, code, kings_table={"life": "all_40"}).json()
    assert readiness(same) == {0: True, 1: True, 3: True, 4: True}
    split = change(ada, code, kings_table={"life": "generals_20_kings_40"}).json()
    assert split["kings_table"]["life"] == "generals_20_kings_40"
    assert [p["starting_life"] for p in split["players"]] == [20, 40, 20, 20, 40, 20]
    assert readiness(split) == {0: False, 1: False, 3: False, 4: True}
    for account in (bob, cara, dan):
        patch_seat(account, code, ready=True)

    # Only the host changes the table, and only to open seats.
    assert change(bob, code, bot_seats=[2]).json()["code"] == "not_host"
    onto_a_player = change(ada, code, bot_seats=[1, 5])
    assert (onto_a_player.status_code, onto_a_player.json()["code"]) == (409, "seat_taken")
    onto_a_bot = change(ada, code, move={"seat": 0, "to": 5})
    assert (onto_a_bot.status_code, onto_a_bot.json()["code"]) == (409, "seat_taken")
    nobody = change(ada, code, move={"seat": 2, "to": 5})
    assert (nobody.status_code, nobody.json()["code"]) == (409, "not_seated")
    assert readiness(ada.get(f"/api/v1/tables/{code}").json())[0] is True

    # The host moves Dan into the seat a bot leaves, and a bot into the one he left.
    moved = change(ada, code, move={"seat": 0, "to": 5}, bot_seats=[0]).json()
    assert [(p["seat"], p["player"], p["handle"]) for p in moved["players"]] == [
        (0, "bot", None),
        (1, "human", "bob"),
        (2, "human", None),
        (3, "human", "cara"),
        (4, "human", "ada"),
        (5, "human", "dan"),
    ]
    assert readiness(moved) == {1: False, 3: False, 4: True, 5: False}
    for account in (bob, cara, dan):
        patch_seat(account, code, ready=True)
    # Bots' seats alone are a change too.
    more = change(ada, code, bot_seats=[0, 2]).json()
    assert more["bots"] == 2 and readiness(more) == {1: False, 3: False, 4: True, 5: False}
    for account in (bob, cara, dan):
        patch_seat(account, code, ready=True)

    # A player moves themselves to an open seat, or a team's; everyone gets ready again.
    assert change(ada, code, bot_seats=[0]).status_code == 200
    for account in (bob, cara, dan):
        patch_seat(account, code, ready=True)
    self_moved = patch_seat(bob, code, seat=2).json()
    assert self_moved["your_seat"] == 2 and readiness(self_moved) == {
        2: False,
        3: False,
        4: True,
        5: False,
    }
    assert patch_seat(bob, code, team=0).json()["your_seat"] == 2
    # Team A's King's seat is open since Bob left it; then team A has none.
    assert patch_seat(cara, code, team=0).json()["your_seat"] == 1
    full = patch_seat(dan, code, team=0)
    assert (full.status_code, full.json()["code"]) == (409, "team_full")

    # The deck format changes: a Commander deck no longer gets ready, nor starts.
    legacy_rules = change(ada, code, kings_table={"deck_format": "legacy"}).json()
    assert legacy_rules["kings_table"] == {
        "deck_format": "legacy",
        "life": "generals_20_kings_40",
        "king_attacks_anyone": False,
    }
    stuck = patch_seat(bob, code, ready=True)
    assert (stuck.status_code, stuck.json()["code"]) == (422, "invalid_deck")
    assert patch_seat(bob, code, deck_id=deck(bob, client, "legacy", "Bolts")).status_code == 200
    assert patch_seat(bob, code, ready=True).status_code == 200


def test_the_start_locks_the_table_and_the_team_result_counts_for_every_teammate(client, engine):
    ada, bob, cara, dan = players("ada", "bob", "cara", "dan", client=client)
    # Team A: Ada (Left General), a bot King, Cara (Right General). Team B: a bot General, Bob
    # (King), Dan (Left General).
    table = kings_table_of(
        ada,
        deck(ada, client, "legacy", "Ada's"),
        seat=0,
        bot_seats=[1, 3],
        kings_table={"deck_format": "legacy", "life": "all_20", "king_attacks_anyone": True},
    )
    code = table["code"]
    for account, seat in ((bob, 4), (cara, 2), (dan, 5)):
        assert (
            sit(account, code, deck(account, client, "legacy", "Mine"), seat=seat).json()[
                "your_seat"
            ]
            == seat
        )
        patch_seat(account, code, ready=True)
    started = ada.send("POST", f"/api/v1/tables/{code}/start")
    assert started.status_code == 200, started.text
    body = engine.created[-1]
    assert body["kings_table"] == {
        "deck_format": "legacy",
        "life": "all_20",
        "king_attacks_anyone": True,
    }
    assert [seat["player"] for seat in body["seats"]] == [
        "human",
        "bot",
        "human",
        "bot",
        "human",
        "human",
    ]
    assert body["idle_timeout_seconds"] == games.TABLE_IDLE_SECONDS
    game_id = started.json()["game_id"]

    # Settings, seats and decks are the game's now.
    for refused in (
        change(ada, code, kings_table={"life": "all_40"}),
        change(ada, code, move={"seat": 0, "to": 1}),
        patch_seat(bob, code, ready=False),
        sit(Account(client, "eve", admin=True), code, deck(ada, client, "legacy", "Late")),
    ):
        assert (refused.status_code, refused.json()["code"]) == (409, "table_closed"), refused.text
    summary = ada.get(f"/api/v1/games/{game_id}").json()["game"]
    assert summary["kings_table"]["king_attacks_anyone"] is True
    assert [(s["player"], s["team"], s["role"], s["starting_life"]) for s in summary["seats"]] == [
        ("human", 0, "general", 20),
        ("bot", 0, "king", 20),
        ("human", 0, "general", 20),
        ("bot", 1, "general", 20),
        ("human", 1, "king", 20),
        ("human", 1, "general", 20),
    ]
    # The team channel: each two players of a team, fixed.
    live = client.app.state.games.games[uuid.UUID(game_id)]  # type: ignore[attr-defined]
    assert live.teams and live.alliances == {frozenset({0, 2}), frozenset({4, 5})}

    # A General of each team is eliminated; team A wins, the engine naming its King and Cara.
    engine.eliminate(game_id, 0)
    engine.eliminate(game_id, 5)
    until_left(client, ada)
    until_left(client, dan)
    engine.win(game_id, 0)
    finished = until_finished(cara, game_id)
    assert engine.kings(game_id).result["winner_seats"] == [1, 2]  # type: ignore[index]
    assert finished["result"]["winner_seats"] == [0, 1, 2]
    assert finished["result"]["winner_team"] == 0
    # The live result the seats' sockets get names the team too (v0.8.8).
    assert live.seats[2].snapshot["result"]["winner_team"] == 0  # type: ignore[index]
    assert live.seats[2].snapshot["result"]["winner_seats"] == [0, 1, 2]  # type: ignore[index]
    assert finished["seats"][0]["left"] == "eliminated"
    assert outcomes(client, game_id) == {0: "win", 2: "win", 4: "loss", 5: "loss"}
    wins = {row.user_id for row in ledger(client, ProgressEntry, game_id)}
    assert wins == {ada.id, cara.id}
    tokens = paid(client, game_id)
    assert set(tokens) == {ada.id, cara.id} and tokens[ada.id] == tokens[cara.id] > 0
    # Each winner is paid for the other team's three seats: Bob, Dan and a bot.
    keys = sorted(row.key for row in ledger(client, TokenEntry, game_id))
    assert keys == sorted(
        f"tokens:{game_id}:{winner}:{beaten}" for winner in (0, 2) for beaten in (3, 4, 5)
    )
    # The history names teammates and opponents as such.
    history = ada.get("/api/v1/me/history").json()["items"][0]
    assert {o["seat"]: (o["teammate"], o["won"]) for o in history["opponents"]} == {
        1: (True, True),
        2: (True, True),
        3: (False, False),
        4: (False, False),
        5: (False, False),
    }


def test_a_draw_pays_nobody_and_is_every_players(client, engine):
    ada, bob = players("ada", "bob", client=client)
    table = kings_table_of(
        ada, deck(ada, client, "commander", "Ada's"), seat=2, bot_seats=[0, 1, 3, 5]
    )
    code = table["code"]
    sit(bob, code, deck(bob, client, "commander", "Bob's"), seat=4)
    patch_seat(bob, code, ready=True)
    game_id = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
    engine.eliminate(game_id, 2)
    until_left(client, ada)
    engine.draw(game_id)
    finished = until_finished(bob, game_id)
    assert finished["result"]["draw"] is True and finished["result"]["winner_team"] is None
    assert finished["result"]["winner_seats"] == []
    assert outcomes(client, game_id) == {2: "draw", 4: "draw"}
    assert ledger(client, TokenEntry, game_id) == []
    assert ledger(client, ProgressEntry, game_id) == []
    assert finished["tokens"] == 0


def test_a_rematch_keeps_the_seats_and_the_settings(client, engine):
    ada, bob = players("ada", "bob", client=client)
    settings = {
        "deck_format": "legacy",
        "life": "generals_20_kings_40",
        "king_attacks_anyone": True,
    }
    table = kings_table_of(
        ada,
        deck(ada, client, "legacy", "Ada's"),
        seat=1,
        bot_seats=[0, 2, 3, 5],
        kings_table=settings,
    )
    code = table["code"]
    sit(bob, code, deck(bob, client, "legacy", "Bob's"), seat=4)
    patch_seat(bob, code, ready=True)
    game_id = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
    engine.win(game_id, 1)
    assert until_finished(ada, game_id)["result"]["winner_team"] == 1
    assert ada.send("POST", f"/api/v1/games/{game_id}/rematch").json()["status"] == "open"
    answered = bob.send("POST", f"/api/v1/games/{game_id}/rematch").json()
    assert answered["status"] == "started", answered
    body = engine.created[-1]
    assert body["kings_table"] == settings
    assert [seat["player"] for seat in body["seats"]] == [
        "bot",
        "human",
        "bot",
        "bot",
        "human",
        "bot",
    ]
    again = ada.get(f"/api/v1/games/{answered['game_id']}").json()["game"]
    assert again["kings_table"] == settings and again["your_seat"] == 1


# Practice.


@pytest.mark.parametrize("seat", range(6))
def test_practice_from_every_seat(client, engine, seat):
    ada = Account(client, "ada", admin=True)
    mine = deck(ada, client, "commander", "Kenrith")
    bots = [{"deck": "commander-mono-red-raiders"}] + [{}] * 4
    started = practice(ada, mine, seat=seat, bot_skill=2, bots=bots)
    assert started.status_code == 201, started.text
    body = engine.created[-1]
    assert body["kings_table"] == {
        "deck_format": "commander",
        "life": "all_40",
        "king_attacks_anyone": False,
    }
    assert body["skill"] == 2 and len(body["seats"]) == 6
    assert [index for index, s in enumerate(body["seats"]) if s["player"] == "human"] == [seat]
    # The bots in seat order without the player's: the first bot's chosen deck in the first.
    first_bot = 0 if seat != 0 else 1
    assert body["seats"][first_bot]["deck"] == "commander-mono-red-raiders"
    game = started.json()
    assert game["your_seat"] == seat and game["seats"][seat]["role"] == kings_table.role_of(seat)
    state = ada.get(f"/api/v1/games/{game['id']}").json()
    assert state["snapshot"]["seat"] == seat
    # A King's concession loses their team the game. A General's puts the player out, and with no
    # other player left the engine ends the game.
    seen: list[str] = []
    with ExitStack() as stack:
        concede(opened(ada, game["id"], seen, stack), game["id"])
    finished = until_finished(ada, game["id"])
    if seat in (1, 4):
        assert finished["result"]["winner_team"] == 1 - seat // 3
        assert finished["result"]["winner_seats"] == list(kings_table.TEAMS[1 - seat // 3])
    else:
        assert finished["result"]["kind"] == "humans_eliminated"
        assert finished["result"]["winner_team"] is None
    assert outcomes(client, game["id"]) == {seat: "loss"} and finished["tokens"] == 0
    assert not any(token in "".join(seen) for token in engine.kings(game["id"]).tokens.values())


def test_a_practice_rematch_keeps_the_seat_and_the_settings(client, engine):
    ada = Account(client, "ada", admin=True)
    settings = {"deck_format": "legacy", "life": "all_20", "king_attacks_anyone": True}
    game = practice(ada, deck(ada, client, "legacy", "Burn"), seat=5, kings_table=settings).json()
    engine.win(game["id"], 1)
    finished = until_finished(ada, game["id"])
    assert finished["result"]["winner_seats"] == [3, 4, 5] and finished["tokens"] > 0
    assert outcomes(client, game["id"]) == {5: "win"}
    rematch = ada.send("POST", f"/api/v1/games/{game['id']}/rematch").json()
    assert rematch["status"] == "started", rematch
    body = engine.created[-1]
    assert body["kings_table"] == settings and body["seats"][5]["player"] == "human"
    assert ada.get(f"/api/v1/games/{rematch['game_id']}").json()["game"]["your_seat"] == 5


def test_practice_decks_follow_the_deck_format(client, engine):
    ada = Account(client, "ada", admin=True)
    legacy = deck(ada, client, "legacy", "Burn")
    wrong = practice(ada, legacy)  # The default deck format is Commander.
    assert (wrong.status_code, wrong.json()["code"]) == (422, "invalid_deck")
    bot = practice(
        ada,
        legacy,
        kings_table={"deck_format": "legacy"},
        bots=[{"deck": "commander-mono-blue-flyers"}, {}, {}, {}, {}],
    )
    assert (bot.status_code, bot.json()["code"]) == (422, "invalid_deck")
    assert "not a King's Table" not in bot.json()["message"]
    fixture = ada.send(
        "POST",
        "/api/v1/practice-games",
        {"format": KINGS, "deck": "legacy-mono-red-burn", "kings_table": {"deck_format": "legacy"}},
    )
    assert fixture.status_code == 201, fixture.text
    assert engine.created[-1]["seats"][1]["deck"] == "legacy-mono-red-burn"


# Refusals.


def test_refusals(client, engine):
    ada, bob = players("ada", "bob", client=client)
    commander = deck(ada, client, "commander", "Kenrith")
    legacy = deck(ada, client, "legacy", "Burn")

    def refused(response: httpx.Response, status: int, code: str) -> None:
        assert (response.status_code, response.json().get("code")) == (status, code), response.text

    # No public queue.
    refused(
        ada.send("POST", "/api/v1/queue", {"format": KINGS, "deck_id": commander}),
        422,
        "invalid_queue",
    )
    # Six seats, no more, no fewer; a bot per seat, never in a player's.
    refused(
        ada.send("POST", "/api/v1/tables", {"format": KINGS, "seats": 4, "deck_id": commander}),
        422,
        "invalid_table",
    )
    too_many = ada.send(
        "POST", "/api/v1/tables", {"format": KINGS, "seats": 7, "deck_id": commander}
    )
    assert too_many.status_code == 422
    refused(
        ada.send(
            "POST", "/api/v1/tables", {"format": "commander", "seats": 6, "deck_id": commander}
        ),
        422,
        "invalid_table",
    )
    refused(
        ada.send(
            "POST",
            "/api/v1/tables",
            {"format": KINGS, "seats": 6, "deck_id": commander, "bot_seats": [1]},
        ),
        409,
        "seat_taken",
    )
    refused(
        ada.send(
            "POST",
            "/api/v1/tables",
            {"format": KINGS, "seats": 6, "deck_id": commander, "bot_seats": [0, 0]},
        ),
        422,
        "invalid_table",
    )
    refused(
        ada.send(
            "POST",
            "/api/v1/tables",
            {"format": KINGS, "seats": 6, "deck_id": commander, "bots": 2, "bot_seats": [0]},
        ),
        422,
        "invalid_table",
    )
    refused(
        ada.send(
            "POST",
            "/api/v1/tables",
            {"format": KINGS, "seats": 6, "deck_id": commander, "best_of": 3},
        ),
        422,
        "invalid_table",
    )
    # King's Table's settings, seats and changes belong to King's Table tables.
    for extra in (
        {"kings_table": {"life": "all_20"}},
        {"seat": 1},
        {"bot_seats": [1]},
    ):
        refused(
            ada.send("POST", "/api/v1/tables", {"format": "legacy", "deck_id": legacy} | extra),
            422,
            "invalid_table",
        )
    other = ada.send("POST", "/api/v1/tables", {"format": "legacy", "deck_id": legacy}).json()
    refused(change(ada, other["code"], kings_table={"life": "all_20"}), 422, "invalid_table")
    refused(
        sit(bob, other["code"], deck(bob, client, "legacy", "Bob's"), seat=1), 422, "invalid_table"
    )
    refused(patch_seat(ada, other["code"], seat=1), 422, "invalid_table")
    assert ada.send("POST", f"/api/v1/tables/{other['code']}/leave").status_code == 200
    # A setting that is not one.
    bad = ada.send(
        "POST",
        "/api/v1/tables",
        {"format": KINGS, "seats": 6, "deck_id": commander, "kings_table": {"life": "all_30"}},
    )
    assert bad.status_code == 422
    # A table that waits for an open seat does not start.
    waiting = kings_table_of(ada, commander, bot_seats=[0, 2, 3, 4])
    refused(ada.send("POST", f"/api/v1/tables/{waiting['code']}/start"), 409, "table_not_full")
    assert ada.send("POST", f"/api/v1/tables/{waiting['code']}/leave").status_code == 200

    # Practice: five bots, best of one, and the settings and seat only at King's Table.
    refused(practice(ada, commander, bots=[{}] * 4), 422, "invalid_table")
    refused(practice(ada, commander, best_of=3), 422, "invalid_table")
    for extra in ({"seat": 0}, {"kings_table": {"life": "all_20"}}):
        refused(
            ada.send(
                "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": legacy} | extra
            ),
            422,
            "invalid_table",
        )
    assert practice(ada, commander, seat=6).status_code == 422
    assert engine.created == []


def test_an_engine_that_ignores_the_settings_is_not_followed(client, engine):
    ada = Account(client, "ada", admin=True)
    engine.echo = False
    started = practice(ada, deck(ada, client, "commander", "Kenrith"))
    assert (started.status_code, started.json()["code"]) == (503, "engine_unavailable")
    assert engine.closed, "the game the API will not follow is closed"


def test_the_migration_goes_back(tmp_path, monkeypatch):
    database = f"sqlite:///{tmp_path}/kings.db"
    monkeypatch.setenv("CD_DATABASE_URL", database)
    config = Config("alembic.ini")
    command.upgrade(config, "head")
    engine = create_engine(database)
    user, game, practice_game, table = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    settings = json.dumps({"deck_format": "legacy", "life": "all_20", "king_attacks_anyone": False})
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO users (id, display_name, kind, status, onboarding, avatar, locale, "
                "preferences, privilege_version, created_at) VALUES (:id, 'Ada', 'player', "
                "'active', 'complete', 'sigil', 'en', '{}', 0, CURRENT_TIMESTAMP)"
            ),
            {"id": user.hex},
        )
        for game_id, kind in ((game, "table"), (practice_game, "practice")):
            connection.execute(
                text(
                    "INSERT INTO games (id, kind, format, status, created_by, created_at, "
                    "bot_skill, turn_cap, kings_table, settings, bots_passive, "
                    "passive_bots_used) VALUES (:id, :kind, 'kings_table', 'finished', :user, "
                    "CURRENT_TIMESTAMP, 4, 60, :settings, '{}', 0, 0)"
                ),
                {"id": game_id.hex, "kind": kind, "user": user.hex, "settings": settings},
            )
        connection.execute(
            text(
                "INSERT INTO game_tables (id, code, host_id, format, visibility, seats, bots, "
                "bot_seats, bot_skill, turn_cap, allow_banned, allow_not_legal, best_of, status, "
                "game_id, created_at, queued, kings_table) VALUES (:id, 'kings-table-1', :user, "
                "'kings_table', 'public', 6, 5, '[0, 2, 3, 4, 5]', 4, 60, 1, 1, 1, 'started', "
                ":game, CURRENT_TIMESTAMP, 0, :settings)"
            ),
            {"id": table.hex, "user": user.hex, "game": game.hex, "settings": settings},
        )
    command.downgrade(config, "0035_passive_bots")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM game_tables")).scalar() == 0
        rows = connection.execute(text("SELECT kind, format, settings FROM games")).all()
        assert sorted(rows) == [("practice", "legacy", None), ("table", "legacy", None)]
        lapsed = connection.execute(text("SELECT status, game_id FROM rematches")).all()
        assert lapsed == [("lapsed", game.hex)]
    command.upgrade(config, "head")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM games")).scalar() == 2
    engine.dispose()


def test_the_fake_engine_deals_the_deck_formats_fixtures() -> None:
    game = KingsGame(
        {
            "format": KINGS,
            "seats": [{"player": "bot"}] * 6,
            "kings_table": {
                "deck_format": "legacy",
                "life": "all_40",
                "king_attacks_anyone": False,
            },
        }
    )
    assert all(found.startswith("legacy-") for found in game.decks)
