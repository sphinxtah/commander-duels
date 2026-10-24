"""Two-Headed Giant with players (v0.5.1) through the API, against the human tables' fake engine
taught that a concession is the team's (810.8b): tables with teams (choosing a team, readiness and
Unified Deck Construction by team on bound decks, named cards keeping a team, bots in either team,
the start), both winners counted and paid once whatever replays, the fixed team channel that the
other team never reads, the queue whose teams form alone or with a friend (pairing, invitations, a
team never split, bots after a minute), a rematch that keeps the teams and checks the format's
banned card again, and the migration going
back."""

import asyncio
import json
import os
import threading
import time
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager, suppress
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
import test_progression
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, delete, func, select, text, update
from sqlalchemy.orm import Session
from test_games import SERVICE_TOKEN
from test_queues import Clock, hub, place, queued, tick
from test_table_chat import alliances, ally, heard, say, settled
from test_tables import (
    Account,
    TableEngine,
    TableGame,
    card,
    concede,
    deck,
    opened,
    until_finished,
    url,
)

from api import economy, games, progression, queues, social, tables, teams
from api.identity import Principal, utcnow
from api.models import (
    Base,
    Deck,
    Friendship,
    Game,
    GameSeat,
    GameTable,
    Notification,
    PlayerAchievement,
    PlayerResult,
    ProgressEntry,
    QueueEntry,
    TokenEntry,
    User,
)
from api.schemas import TableRules

content = test_progression.content
__all__ = ["url"]
TEAM = "two_headed_giant"
# Rows these tests leave behind, removed before the queues' and tables' own cleanups.
TEAM_TABLES = (
    "player_achievements",
    "daily_quests",
    "player_results",
    "friendships",
    "player_blocks",
)


class TeamGame(TableGame):
    """A table's game that plays Two-Headed Giant's result: a seat's concession is its team's,
    so the other team wins together (810.8b)."""

    def concede(self, seat: int) -> None:
        if self.body["format"] != TEAM:
            super().concede(seat)
            return
        self.out.append(seat)
        self.end(1 - seat // 2, [seat])

    def end(self, team: int, conceded: list[int]) -> None:
        winners = [2 * team, 2 * team + 1]
        self.result = {
            "kind": "completed",
            "winner_seat": winners[0],
            "winner_seats": winners,
            "draw": False,
            "turns": 5,
            "conceded_seats": conceded,
            "error": None,
        }
        self.revision += 1
        self.log.append(f"Team {team} wins.")


class TeamEngine(TableEngine):
    """The tables' fake engine, making team games."""

    def create(self, body: dict[str, Any]) -> httpx.Response:
        with self.lock:
            game = TeamGame(body)
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

    def win(self, game_id: str, team: int) -> None:
        fake = self.games[game_id]
        assert isinstance(fake, TeamGame)
        with self.lock:
            fake.end(team, [])


@pytest.fixture(autouse=True)
def no_background_tick(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(queues, "TICK_SECONDS", 3600.0)


@pytest.fixture
def engine() -> TeamEngine:
    return TeamEngine()


@pytest.fixture
def client(url: str, content: Path, engine: TeamEngine) -> Iterator[TestClient]:
    with queued(url, content, engine) as client:
        try:
            yield client
        finally:
            with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
                for table in TEAM_TABLES:
                    db.execute(text(f"DELETE FROM {table}"))
                db.commit()


@pytest.fixture
def clock(client: TestClient) -> Clock:
    found = Clock()
    hub(client).clock = found
    return found


def bolts(account: Account, client: TestClient, title: str = "Bolts") -> str:
    """A Legacy deck holding Lightning Bolt, which an administrator may build."""
    made = account.send(
        "POST",
        "/api/v1/decks",
        {
            "title": title,
            "format": "legacy",
            "entries": [
                {"card_id": card(client, "Lightning Bolt"), "quantity": 4, "location": "main"},
                {"card_id": card(client, "Mountain"), "quantity": 56, "location": "main"},
            ],
        },
    ).json()
    assert made["playable"] is True, made
    return str(made["id"])


def team_table(host: Account, deck_id: str, **extra: Any) -> dict[str, Any]:
    made = host.send(
        "POST", "/api/v1/tables", {"format": TEAM, "seats": 4, "deck_id": deck_id} | extra
    )
    assert made.status_code == 201, made.text
    return made.json()  # type: ignore[no-any-return]


def sit(account: Account, code: str, deck_id: str, team: int | None = None) -> httpx.Response:
    body: dict[str, Any] = {"deck_id": deck_id}
    if team is not None:
        body["team"] = team
    return account.send("POST", f"/api/v1/tables/{code}/join", body)


def ready(account: Account, code: str) -> httpx.Response:
    return account.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True})


def befriend(one: Account, other: Account) -> None:
    assert one.send("PUT", f"/api/v1/friends/{other.id}").status_code == 200
    assert other.send("PUT", f"/api/v1/friends/{one.id}").status_code == 200


def queue(account: Account, deck_id: str, **extra: Any) -> httpx.Response:
    return account.send(
        "POST", "/api/v1/queue", {"format": TEAM, "seats": 4, "deck_id": deck_id} | extra
    )


def ledger(client: TestClient, model: Any, game_id: str) -> list[Any]:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return list(db.scalars(select(model).where(model.game_id == uuid.UUID(game_id))))


def test_a_team_table_from_the_lobby_to_both_winners_paid(client, engine):
    ada, bob, cara, dan = (Account(client, n, admin=True) for n in ("ada", "bob", "cara", "dan"))
    root = Account(client, "sysop", kind="sysop")
    ada_deck = bolts(ada, client)
    table = team_table(ada, ada_deck)
    code = table["code"]
    assert [(p["seat"], p["team"], p["player"], p["taken"]) for p in table["players"]] == [
        (0, 0, "human", True),
        (1, 0, "human", False),
        (2, 1, "human", False),
        (3, 1, "human", False),
    ]
    # A Two-Headed Giant table takes Legacy decks, not Commander ones.
    commander = sit(bob, code, deck(bob, client, "commander", "Kenrith"))
    assert (commander.status_code, commander.json()["code"]) == (422, "invalid_deck")

    # Bob chooses the other team; Cara takes the first free seat, beside the host.
    assert sit(bob, code, deck(bob, client, title="Bob's"), team=1).json()["your_seat"] == 2
    cara_bolts = bolts(cara, client, "Cara's bolts")
    assert sit(cara, code, cara_bolts).json()["your_seat"] == 1
    full = sit(dan, code, deck(dan, client, title="Dan's"), team=0)
    assert (full.status_code, full.json()["code"]) == (409, "team_full")
    assert sit(dan, code, deck(dan, client, title="Dan's")).json()["your_seat"] == 3
    moved = bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"team": 0})
    assert (moved.status_code, moved.json()["code"]) == (409, "team_full")
    # The lobby lists the teams, no deck of anyone's.
    listed = dan.get("/api/v1/tables").json()[0]
    assert [(p["handle"], p["team"]) for p in listed["players"]] == [
        ("ada", 0),
        ("cara", 0),
        ("bob", 1),
        ("dan", 1),
    ]
    assert ada_deck not in json.dumps(listed)

    # Unified Deck Construction as Cara gets ready: her deck shares a card with Ada's.
    shared = ready(cara, code)
    assert (shared.status_code, shared.json()["code"]) == (422, "team_decks")
    assert shared.json()["message"] == (
        "Your deck and ada's share Lightning Bolt. In Two-Headed Giant teammates' decks may "
        "share only basic lands: one of you needs another deck."
    )
    cara_deck = deck(cara, client, title="Cara's")
    cara.send("PATCH", f"/api/v1/tables/{code}/seat", {"deck_id": cara_deck})
    assert ready(cara, code).json()["players"][1]["ready"] is True
    # The host changing deck makes her teammate ready again, and only her.
    ready(bob, code), ready(dan, code)
    after = ada.send("PATCH", f"/api/v1/tables/{code}/seat", {"deck_id": deck(ada, client)})
    assert [p["ready"] for p in after.json()["players"]] == [True, False, True, True]
    ready(cara, code)
    started = ada.send("POST", f"/api/v1/tables/{code}/start")
    assert started.status_code == 200, started.text
    game_id = started.json()["game_id"]
    body = engine.created[-1]
    assert body["format"] == TEAM and [s["player"] for s in body["seats"]] == ["human"] * 4
    assert all("sideboard" not in seat["deck_list"] for seat in body["seats"])
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        game = db.get(Game, uuid.UUID(game_id))
        assert game is not None and (game.format, game.kind) == (TEAM, "table")

    seen: dict[str, list[str]] = {name: [] for name in ("ada", "bob", "cara", "dan", "root")}
    with ExitStack() as stack:
        tabs = {
            name: opened(account, game_id, seen[name], stack)
            for name, account in (("ada", ada), ("bob", bob), ("cara", cara), ("dan", dan))
        }
        # The teams are the alliances, fixed from the start; no other may be offered.
        for tab in tabs.values():
            assert alliances(tab) == {
                "type": "alliances",
                "alliances": [[0, 1], [2, 3]],
                "offers": [],
                "fixed": True,
            }
        ally(tabs["ada"], "offer", 2)
        assert tabs["ada"].until("error")["code"] == "fixed_teams"
        ally(tabs["ada"], "end", 1)
        assert tabs["ada"].until("error")["code"] == "fixed_teams"
        # The team channel: Cara reads Ada's line; the other team never receives it.
        say(tabs["ada"], "Bolt their blockers", "allies")
        line = heard(tabs["cara"], channel="allies")
        assert (line["seat"], line["seats"]) == (0, [1])
        say(tabs["bob"], "Swing with everything", "allies")
        assert heard(tabs["dan"], channel="allies")["body"] == "Swing with everything"
        say(tabs["dan"], "Good luck!")
        for name in ("ada", "bob", "cara", "dan"):
            heard(tabs[name], body="Good luck!")
        # SysOp watching reads both teams' channels.
        watching = opened(root, game_id, seen["root"], stack)
        history = [line["body"] for line in watching.until("chat_history")["messages"]]
        assert {"Bolt their blockers", "Swing with everything"} <= set(history)
        # A tab of Bob's that connects now is told the table's lines and his team's only.
        late: list[str] = []
        again = opened(bob, game_id, late, stack)
        bodies = [line["body"] for line in again.until("chat_history")["messages"]]
        assert "Swing with everything" in bodies and "Bolt their blockers" not in bodies
        seen["bob"] += late
        for tab in tabs.values():
            settled(tab)
        # Bob concedes from the tab that took his seat's control: his team loses (810.8b), and
        # the game ends with Ada's team's win.
        assert concede(again, game_id)["status"] == 200
        result = tabs["ada"].snapshot(2)["result"]
        assert (result["winner_seat"], result["winner_seats"]) == (0, [0, 1])
    assert "Bolt their blockers" not in "\n".join(seen["bob"] + seen["dan"])
    assert "Swing with everything" not in "\n".join(seen["ada"] + seen["cara"])
    fake = engine.games[game_id]
    for name, seat in (("ada", 0), ("bob", 2), ("cara", 1), ("dan", 3)):
        text_seen = "\n".join(seen[name])
        assert all(f"Secret of seat {other}" not in text_seen for other in {0, 1, 2, 3} - {seat})
        assert all(token not in text_seen for token in fake.tokens.values())
        assert SERVICE_TOKEN not in text_seen
    transcript = root.get(f"/api/v1/admin/chats/games/{game_id}").json()
    assert "Bolt their blockers" in [line["body"] for line in transcript["lines"]]

    # Both winners: a win each, and 50 tokens for each of the other team's players.
    assert until_finished(ada, game_id)["tokens"] == 100
    assert until_finished(cara, game_id)["tokens"] == 100
    assert until_finished(bob, game_id)["tokens"] == 0
    for account, wins in ((ada, 1), (cara, 1), (bob, 0), (dan, 0)):
        assert account.get("/api/v1/me/progress").json()["counted_wins"] == wins
    paid = sorted(
        (entry.opponent_seat, entry.amount, entry.key.split(":")[2])
        for entry in ledger(client, TokenEntry, game_id)
    )
    assert paid == [(2, 50, "0"), (2, 50, "1"), (3, 50, "0"), (3, 50, "1")]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        results = {
            row.seat: (row.outcome, row.players, row.bots)
            for row in db.scalars(
                select(PlayerResult).where(PlayerResult.game_id == uuid.UUID(game_id))
            )
        }
        # A teammate is never an opponent: each faced the other team's two players.
        assert results == {0: ("win", 2, 0), 1: ("win", 2, 0), 2: ("loss", 2, 0), 3: ("loss", 2, 0)}
        firsts = db.scalars(
            select(PlayerAchievement.user_id).where(PlayerAchievement.achievement == "first-win")
        )
        assert set(firsts) == {ada.id, cara.id}
        recorded = db.get(Game, uuid.UUID(game_id))
        assert recorded is not None and recorded.result is not None
        # A replayed end, and the win and pay counted again, pay nothing more.
        games.record_end(client.app.state.database, recorded.id, "finished", fake.result)  # type: ignore[attr-defined]
        progression.count_win(db, recorded)
        economy.pay_game(db, recorded)
        db.commit()
    assert len(ledger(client, TokenEntry, game_id)) == 4
    assert len(ledger(client, ProgressEntry, game_id)) == 2
    history = cara.get("/api/v1/me/history").json()["items"][0]
    assert [(o["seat"], o["won"], o["teammate"]) for o in history["opponents"]] == [
        (0, True, True),
        (2, False, False),
        (3, False, False),
    ]


def test_bots_take_either_teams_seats(client, engine):
    ada, bob, cara = (Account(client, n, admin=True) for n in ("ada", "bob", "cara"))
    for refused in (
        {"format": "commander", "seats": 4, "bots": 1, "bot_teammate": True},
        {"format": TEAM, "seats": 4, "bots": 0, "bot_teammate": True},
        {"format": TEAM, "seats": 2},
    ):
        made = ada.send("POST", "/api/v1/tables", refused | {"deck_id": deck(ada, client)})
        assert (made.status_code, made.json()["code"]) == (422, "invalid_table"), refused
    # A bot teammate for the host, a player and a bot in the other team.
    table = team_table(ada, bolts(ada, client), bots=2, bot_teammate=True, bot_skill=5)
    code = table["code"]
    assert [p["player"] for p in table["players"]] == ["human", "bot", "human", "bot"]
    assert sit(bob, code, bolts(bob, client)).json()["your_seat"] == 2
    ready(bob, code)
    game_id = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
    seats = engine.created[-1]["seats"]
    assert [s["player"] for s in seats] == ["human", "bot", "human", "bot"]
    # Each bot plays a fixture deck its teammate's shares no card with: not the red one.
    assert seats[1]["deck"] != "legacy-mono-red-burn" != seats[3]["deck"]
    with ExitStack() as stack:
        tab = opened(ada, game_id, [], stack)
        assert alliances(tab)["alliances"] == []
        say(tab, "Anyone there?", "allies")
        refusal = tab.until("error")
        assert refusal["code"] == "no_allies" and "teammate is a bot" in refusal["message"]
    engine.win(game_id, 1)
    until_finished(ada, game_id)
    # Bob's team won: Bob is paid for the host and her bot teammate, at skill 5.
    paid = sorted((e.kind, e.opponent_seat, e.amount) for e in ledger(client, TokenEntry, game_id))
    assert paid == [("bot_win", 1, 17), ("human_win", 0, 50)]

    # Two players against two bots: both win and are paid for the bots, and neither beat a player.
    table = team_table(ada, deck(ada, client), bots=2)
    assert [p["player"] for p in table["players"]] == ["human", "human", "bot", "bot"]
    sit(cara, table["code"], deck(cara, client))
    ready(cara, table["code"])
    game_id = ada.send("POST", f"/api/v1/tables/{table['code']}/start").json()["game_id"]
    engine.win(game_id, 0)
    assert until_finished(cara, game_id)["tokens"] == 2 * economy.BOT_TOKENS[4]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        rows = db.scalars(select(PlayerResult).where(PlayerResult.game_id == uuid.UUID(game_id)))
        assert {(row.outcome, row.players, row.bots) for row in rows} == {("win", 0, 2)}


def test_the_history_gives_a_bot_teammate_its_skill(client, engine):
    """A bot teammate beside the host, two players opposite: the host's result counts no bot, as
    the bot is no opponent, and the history still names the bot by its skill, the game's."""
    ada, bob, dan = (Account(client, n, admin=True) for n in ("ada", "bob", "dan"))
    code = team_table(ada, deck(ada, client), bots=1, bot_teammate=True, bot_skill=5)["code"]
    for account in (bob, dan):
        assert sit(account, code, deck(account, client)).json()["your_seat"] in (2, 3)
        assert ready(account, code).status_code == 200
    game_id = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
    engine.win(game_id, 0)
    until_finished(ada, game_id)
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        row = db.scalar(
            select(PlayerResult).where(
                PlayerResult.game_id == uuid.UUID(game_id), PlayerResult.seat == 0
            )
        )
        assert row is not None and (row.players, row.bots, row.bot_skill) == (2, 0, None)
    history = ada.get("/api/v1/me/history").json()["items"][0]
    assert [(o["seat"], o["bot"], o["bot_skill"], o["teammate"]) for o in history["opponents"]] == [
        (1, True, 5, True),
        (2, False, None, False),
        (3, False, None, False),
    ]


def test_the_start_checks_each_team_again(client, engine):
    ada, bob, cara, dan = (Account(client, n, admin=True) for n in ("ada", "bob", "cara", "dan"))
    code = team_table(ada, deck(ada, client))["code"]
    bob_deck, dan_deck = deck(bob, client, title="Bob's"), deck(dan, client, title="Dan's")
    for account, deck_id in ((cara, deck(cara, client)), (bob, bob_deck), (dan, dan_deck)):
        sit(account, code, deck_id)
        assert ready(account, code).status_code == 200
    # Bob and Dan, the other team, edit their decks in the builder until both hold a Bolt.
    entries = [
        {"card_id": card(client, "Lightning Bolt"), "quantity": 4, "location": "main"},
        {"card_id": card(client, "Mountain"), "quantity": 56, "location": "main"},
    ]
    for account, deck_id in ((bob, bob_deck), (dan, dan_deck)):
        saved = account.send(
            "PUT", f"/api/v1/decks/{deck_id}/draft", {"version": 1, "entries": entries}
        )
        assert saved.status_code == 200, saved.text
    refused = ada.send("POST", f"/api/v1/tables/{code}/start")
    assert (refused.status_code, refused.json()["code"]) == (409, "team_decks")
    # The host learns whose decks, never which card; both must get ready again.
    assert "Lightning Bolt" not in refused.json()["message"]
    assert "bob's and dan's decks share a card" in refused.json()["message"]
    players = ada.get(f"/api/v1/tables/{code}").json()["players"]
    assert [p["ready"] for p in players] == [True, True, False, False]
    again = ready(dan, code)
    assert (again.status_code, again.json()["code"]) == (422, "team_decks")
    assert "Lightning Bolt" in again.json()["message"]


# A card of the test catalog for each fixture deck, in order: the engine's decks hold cards the
# catalog lacks, so each fixture stands for one of these, and a deck may share a card with any.
STAND_INS = ("Lightning Bolt", "Grizzly Bears", "Swords to Plowshares", "Brainstorm")


def stand_ins(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """The fixture decks, each holding its stand-in card alone."""
    decks = list(teams.FIXTURES)
    held = {deck: frozenset({name}) for deck, name in zip(decks, STAND_INS, strict=True)}
    monkeypatch.setattr(teams, "FIXTURES", held)
    return decks


def holding(client: TestClient, *names: str) -> list[dict[str, object]]:
    """A Legacy deck's entries: four of each card named, and Mountains."""
    counted = [(name, 4) for name in names] + [("Mountain", 60 - 4 * len(names))]
    return [
        {"card_id": card(client, name), "quantity": quantity, "location": "main"}
        for name, quantity in counted
    ]


def built(account: Account, client: TestClient, *names: str) -> str:
    """A deck of `holding`'s, which an administrator may build."""
    entries = holding(client, *names)
    made = account.send(
        "POST", "/api/v1/decks", {"title": "Mixed", "format": "legacy", "entries": entries}
    ).json()
    assert made["playable"] is True, made
    return str(made["id"])


def test_a_bot_teammate_gets_a_deck_whenever_one_can(client, engine, monkeypatch):
    """Regression (v0.5.1): the bots' fixture decks were dealt first-fit, so a start another
    dealing allowed was refused, naming nobody and making nobody not ready; and a player beside a
    bot learnt of a deck no bot could play beside only from the host's failed start."""
    decks = stand_ins(monkeypatch)
    ada, bob, cara, dan = (Account(client, n, admin=True) for n in ("ada", "bob", "cara", "dan"))
    # Ada's deck rules out the first fixture for her bot; Bob's every one but the second for his.
    code = team_table(ada, built(ada, client, STAND_INS[0]), bots=2, bot_teammate=True)["code"]
    assert sit(bob, code, built(bob, client, *STAND_INS[:1], *STAND_INS[2:])).status_code == 200
    assert ready(bob, code).status_code == 200
    started = ada.send("POST", f"/api/v1/tables/{code}/start")
    assert started.status_code == 200, started.text
    seats = engine.created[-1]["seats"]
    assert (seats[1]["deck"], seats[3]["deck"]) == (decks[2], decks[1])

    # A deck sharing a card with every fixture deck is refused as its player gets ready.
    every = built(dan, client, *STAND_INS)
    code = team_table(cara, built(cara, client, STAND_INS[0]), bots=2, bot_teammate=True)["code"]
    sit(dan, code, every)
    refused = ready(dan, code)
    assert (refused.status_code, refused.json()["code"]) == (422, "team_decks")
    assert refused.json()["message"] == tables.NO_BOT_TEAMMATE
    # Dan gets ready with another, then edits it in the builder until it holds them all.
    bears = built(dan, client, STAND_INS[1])
    dan.send("PATCH", f"/api/v1/tables/{code}/seat", {"deck_id": bears})
    assert ready(dan, code).status_code == 200
    every_card = holding(client, *STAND_INS)
    saved = dan.send("PUT", f"/api/v1/decks/{bears}/draft", {"version": 1, "entries": every_card})
    assert saved.status_code == 200, saved.text
    refused = cara.send("POST", f"/api/v1/tables/{code}/start")
    assert (refused.status_code, refused.json()["code"]) == (409, "team_decks")
    # The host learns whose deck, never its cards, and Dan must get ready again.
    assert refused.json()["message"] == (
        "dan's deck shares a card with every bot deck, so no bot can be their teammate: they need "
        "another deck."
    )
    players = cara.get(f"/api/v1/tables/{code}").json()["players"]
    assert [p["ready"] for p in players if p["handle"] == "dan"] == [False]
    # The host's own deck is named to the host, and Dan, whose deck suits a bot, stays ready.
    dan.send("PATCH", f"/api/v1/tables/{code}/seat", {"deck_id": built(dan, client)})
    assert ready(dan, code).status_code == 200
    cara.send("PATCH", f"/api/v1/tables/{code}/seat", {"deck_id": built(cara, client, *STAND_INS)})
    refused = cara.send("POST", f"/api/v1/tables/{code}/start")
    assert (refused.status_code, refused.json()["code"]) == (409, "team_decks")
    assert refused.json()["message"] == tables.NO_BOT_TEAMMATE
    players = cara.get(f"/api/v1/tables/{code}").json()["players"]
    assert [p["ready"] for p in players if p["handle"] == "dan"] == [True]


def seat(account: Account, code: str, **change: Any) -> httpx.Response:
    return account.send("PATCH", f"/api/v1/tables/{code}/seat", change)


def kept(response: httpx.Response) -> bool:
    return (response.status_code, response.json()["code"]) == (409, "team_locked")


def test_cards_named_at_ready_keep_both_players_on_that_team(client, engine):
    """A player on the other team moves beside Ada and gets ready in one request: the move stands
    with the refusal that names Ada's cards, and from then on neither may leave that team at the
    table, by moving or by sitting down again (v0.5.1)."""
    hal, ada, eve = (Account(client, n, admin=True) for n in ("hal", "ada", "eve"))
    code = team_table(hal, deck(hal, client))["code"]
    assert sit(ada, code, bolts(ada, client), team=1).json()["your_seat"] == 2
    assert ready(ada, code).status_code == 200
    assert sit(eve, code, bolts(eve, client, "Eve's bolts"), team=0).json()["your_seat"] == 1

    probe = seat(eve, code, team=1, ready=True)
    assert (probe.status_code, probe.json()["code"]) == (422, "team_decks")
    assert "Your deck and ada's share Lightning Bolt" in probe.json()["message"]
    # Ada sees her new teammate, and is not ready again: nothing about the request was undone.
    players = ada.get(f"/api/v1/tables/{code}").json()["players"]
    assert [(p["handle"], p["ready"]) for p in players] == [
        ("hal", True),
        (None, False),
        ("ada", False),
        ("eve", False),
    ]
    assert kept(seat(eve, code, team=0))
    assert kept(seat(ada, code, team=0))
    # Sitting down again puts Eve back in Ada's team, never in the other one.
    eve.send("POST", f"/api/v1/tables/{code}/leave")
    assert kept(sit(eve, code, deck(eve, client), team=0))
    # A player nothing was named to moves freely; while Ada's team is full, Eve may not sit at all.
    cara = Account(client, "cara", admin=True)
    assert sit(cara, code, deck(cara, client)).json()["your_seat"] == 1
    assert seat(cara, code, team=1).json()["your_seat"] == 3
    assert kept(sit(eve, code, deck(eve, client)))
    assert seat(cara, code, team=0).json()["your_seat"] == 1
    assert sit(eve, code, deck(eve, client)).json()["your_seat"] == 3


def test_sysop_is_never_kept_on_a_team(client, engine):
    """SysOp, who may read every deck anyway, is never kept on a team: not when told a teammate's
    cards, nor when SysOp's own are named to a player, who is (v0.5.1)."""
    hal, ada = Account(client, "hal", admin=True), Account(client, "ada", admin=True)
    root = Account(client, "sysop", kind="sysop")
    code = team_table(hal, deck(hal, client))["code"]
    assert sit(root, code, bolts(root, client), team=1).json()["your_seat"] == 2
    assert sit(ada, code, bolts(ada, client), team=1).json()["your_seat"] == 3
    told = ready(ada, code)
    assert "Your deck and sysop's share Lightning Bolt" in told.json()["message"]
    assert "Your deck and ada's share Lightning Bolt" in ready(root, code).json()["message"]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        table = db.scalar(select(GameTable).where(GameTable.code == code))
        assert table is not None and table.kept_teams == {str(ada.id): 1}
    assert seat(root, code, team=0).json()["your_seat"] == 1
    assert kept(seat(ada, code, team=0))


def test_a_host_told_at_the_start_stays_on_the_team(client, engine):
    """The host is told the cards their teammate's deck shares with theirs at the start: the two
    stay on that team at the table (v0.5.1)."""
    hal, cara, bob, dan = (Account(client, n, admin=True) for n in ("hal", "cara", "bob", "dan"))
    hal_deck, cara_deck = deck(hal, client), deck(cara, client, title="Cara's")
    code = team_table(hal, hal_deck)["code"]
    for account, deck_id in ((cara, cara_deck), (bob, deck(bob, client)), (dan, deck(dan, client))):
        sit(account, code, deck_id)
        assert ready(account, code).status_code == 200
    entries = [
        {"card_id": card(client, "Lightning Bolt"), "quantity": 4, "location": "main"},
        {"card_id": card(client, "Mountain"), "quantity": 56, "location": "main"},
    ]
    for account, deck_id in ((hal, hal_deck), (cara, cara_deck)):
        saved = account.send(
            "PUT", f"/api/v1/decks/{deck_id}/draft", {"version": 1, "entries": entries}
        )
        assert saved.status_code == 200, saved.text
    refused = hal.send("POST", f"/api/v1/tables/{code}/start")
    assert (refused.status_code, refused.json()["code"]) == (409, "team_decks")
    assert "Your deck and cara's share Lightning Bolt" in refused.json()["message"]
    bob.send("POST", f"/api/v1/tables/{code}/leave")
    assert kept(seat(hal, code, team=1))
    assert kept(seat(cara, code, team=1))
    assert seat(dan, code, team=0).json()["code"] == "team_full"


def test_a_ready_check_compares_bound_decks_never_drafts(client, engine):
    """The ready check compares the deck each seat is bound to, checked against its player's
    library (v0.5.1): a draft of cards the player does not own is refused as their own deck's
    problem, naming nothing of the teammate's, and a teammate's draft edited since they sat down
    is not read."""
    ada, mia = Account(client, "ada", admin=True), Account(client, "mia")
    code = team_table(ada, bolts(ada, client))["code"]
    mia_deck = deck(mia, client, title="Mia's")
    assert sit(mia, code, mia_deck).json()["your_seat"] == 1
    # Mia's library holds basic lands only: her draft of Bolts is saved, and is no deck she owns.
    probing = [
        {"card_id": card(client, "Lightning Bolt"), "quantity": 4, "location": "main"},
        {"card_id": card(client, "Mountain"), "quantity": 56, "location": "main"},
    ]
    saved = mia.send("PUT", f"/api/v1/decks/{mia_deck}/draft", {"version": 1, "entries": probing})
    assert saved.status_code == 200, saved.text
    probe = ready(mia, code)
    assert (probe.status_code, probe.json()["code"]) == (422, "deck_not_playable")
    assert "Lightning Bolt" not in probe.json()["message"]
    assert "ada" not in probe.json()["message"]
    # A refusal that names nothing undoes the whole request, a move in it included.
    moving = seat(mia, code, team=1, ready=True)
    assert (moving.status_code, moving.json()["code"]) == (422, "deck_not_playable")
    assert mia.get(f"/api/v1/tables/{code}").json()["your_seat"] == 1
    # Nothing was named, so Mia may change team.
    assert seat(mia, code, team=1).json()["your_seat"] == 2

    # Bob sits in the other team with basic lands, then puts Bolts in his deck's draft: Dan's Bolts
    # are compared with the deck Bob sat down with.
    bob, dan = Account(client, "bob", admin=True), Account(client, "dan", admin=True)
    mia.send("POST", f"/api/v1/tables/{code}/leave")
    bob_deck = deck(bob, client, title="Bob's")
    assert sit(bob, code, bob_deck, team=1).json()["your_seat"] == 2
    saved = bob.send("PUT", f"/api/v1/decks/{bob_deck}/draft", {"version": 1, "entries": probing})
    assert saved.status_code == 200, saved.text
    assert sit(dan, code, bolts(dan, client, "Dan's bolts"), team=1).json()["your_seat"] == 3
    assert ready(dan, code).json()["players"][3]["ready"] is True
    # Bob getting ready binds his deck as it now stands, and is told.
    told = ready(bob, code)
    assert (told.status_code, told.json()["code"]) == (422, "team_decks")
    assert "Your deck and dan's share Lightning Bolt" in told.json()["message"]


def test_two_headed_giants_own_banned_card():
    """MTR 9.5 bans Erayo, Soratami Ascendant in Two-Headed Giant Constructed: a table refusing
    banned cards refuses it, unless the deck is SysOp's."""
    erayo = {"Erayo, Soratami Ascendant", "Brainstorm"}
    strict = TableRules(banned=False, not_legal=False)
    refused = tables.team_banned(erayo, strict, frozenset())
    assert refused is not None and refused.code == "deck_not_allowed"
    assert "Erayo, Soratami Ascendant is banned in Two-Headed Giant" in refused.message
    assert tables.team_banned(erayo, TableRules(banned=True, not_legal=False), frozenset()) is None
    assert tables.team_banned(erayo, strict, frozenset({"cards.any"})) is None
    assert tables.team_banned({"Brainstorm"}, strict, frozenset()) is None


def test_players_alone_are_paired_into_teams_that_share_no_card(client, engine, clock):
    ada, bob, cara, dan = (Account(client, n, admin=True) for n in ("ada", "bob", "cara", "dan"))
    decks = {
        "ada": bolts(ada, client),
        "bob": bolts(bob, client),
        "cara": deck(cara, client),
        "dan": deck(dan, client),
    }
    for name, account in (("ada", ada), ("bob", bob), ("cara", cara)):
        waiting = queue(account, decks[name], humans_only=True).json()
        assert waiting["status"] == "waiting", waiting
        clock.advance(1)
    found = queue(dan, decks["dan"]).json()
    assert found["status"] == "matched", found
    game_id = found["game_id"]
    # Ada and Bob both hold Lightning Bolt, so each was paired with a player whose deck does not.
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        seats = list(
            db.scalars(
                select(GameSeat.user_id)
                .where(GameSeat.game_id == uuid.UUID(game_id))
                .order_by(GameSeat.seat)
            )
        )
    assert seats == [ada.id, cara.id, bob.id, dan.id]
    body = engine.created[-1]
    assert body["format"] == TEAM and body["idle_timeout_seconds"] == 3600
    table = queues_table(client, game_id)
    assert (table.format, table.queued, table.bots, table.bot_seats) == (TEAM, True, 0, [])
    with ExitStack() as stack:
        assert alliances(opened(bob, game_id, [], stack))["alliances"] == [[0, 1], [2, 3]]


def queues_table(client: TestClient, game_id: str) -> GameTable:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        found = db.scalar(select(GameTable).where(GameTable.game_id == uuid.UUID(game_id)))
    assert found is not None
    return found


def test_friends_queue_as_a_team(client, engine, clock):
    ada, bob, cara, dan = (Account(client, n, admin=True) for n in ("ada", "bob", "cara", "dan"))
    ada_deck = bolts(ada, client)
    # Only a friend, and only in Two-Headed Giant.
    stranger = queue(ada, ada_deck, partner_id=str(bob.id))
    assert (stranger.status_code, stranger.json()["code"]) == (409, "not_friends")
    befriend(ada, bob)
    legacy = ada.send(
        "POST",
        "/api/v1/queue",
        {"format": "legacy", "deck_id": ada_deck, "partner_id": str(bob.id)},
    )
    assert (legacy.status_code, legacy.json()["code"]) == (422, "invalid_queue")

    inviting = queue(ada, ada_deck, partner_id=str(bob.id), humans_only=True).json()
    assert inviting["status"] == "inviting" and inviting["partner"]["handle"] == "bob"
    # Bob hears of it through the bell, and sees it in his place.
    bell = bob.get("/api/v1/notifications").json()["items"][0]
    assert (bell["kind"], bell["actor"]["handle"], bell["request_pending"]) == (
        "team_invite",
        "ada",
        True,
    )
    invites = place(bob)["invites"]
    assert [(i["player"]["handle"], i["humans_only"]) for i in invites] == [("ada", True)]
    # An invitation is in no line: a solo player waiting meanwhile is not matched with it.
    assert bob.get("/api/v1/queues").json()[5]["waiting"] == 0
    # Unified Deck Construction as he accepts: the shared card named to the two of them.
    shared = bob.send("POST", f"/api/v1/queue/invites/{ada.id}", {"deck_id": bolts(bob, client)})
    assert (shared.status_code, shared.json()["code"]) == (422, "team_decks")
    assert "Lightning Bolt" in shared.json()["message"] and "ada's" in shared.json()["message"]
    bob_deck = deck(bob, client, title="Bob's")
    accepted = bob.send("POST", f"/api/v1/queue/invites/{ada.id}", {"deck_id": bob_deck}).json()
    assert accepted["status"] == "waiting" and accepted["partner"]["handle"] == "ada"
    assert accepted["humans_only"] is True
    assert place(ada)["status"] == "waiting" and place(ada)["partner"]["handle"] == "bob"
    pending = bob.get("/api/v1/notifications").json()["items"][0]["request_pending"]
    assert pending is False

    # Two players alone make the other team; the friends keep theirs, as the first team.
    clock.advance(5)
    queue(cara, deck(cara, client), humans_only=True)
    clock.advance(1)
    found = queue(dan, deck(dan, client)).json()
    assert found["status"] == "matched"
    game_id = found["game_id"]
    assert place(ada)["game_id"] == game_id == place(bob)["game_id"]
    seated = [seat.user_id for seat in seats_of(client, game_id)]
    assert set(seated[:2]) == {ada.id, bob.id} and seated[2:] == [cara.id, dan.id]
    with ExitStack() as stack:
        assert alliances(opened(cara, game_id, [], stack))["alliances"] == [[0, 1], [2, 3]]


def seats_of(client: TestClient, game_id: str) -> list[GameSeat]:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return list(
            db.scalars(
                select(GameSeat)
                .where(GameSeat.game_id == uuid.UUID(game_id))
                .order_by(GameSeat.seat)
            )
        )


def test_a_team_is_never_split(client, engine, clock):
    ada, bob, cara = (Account(client, n, admin=True) for n in ("ada", "bob", "cara"))
    befriend(ada, bob)
    befriend(ada, cara)
    # A decline ends the invitation, and Ada is told who declined.
    queue(ada, deck(ada, client), partner_id=str(bob.id))
    declined = bob.send("POST", f"/api/v1/queue/invites/{ada.id}/decline").json()
    assert declined["invites"] == []
    after = place(ada)
    assert (after["status"], after["reason"]) == ("left", "declined")
    assert after["message"].startswith("bob declined your invitation")
    gone = bob.send("POST", f"/api/v1/queue/invites/{ada.id}", {"deck_id": deck(bob, client)})
    assert (gone.status_code, gone.json()["code"]) == (409, "invite_gone")

    # Inviting a friend who invited you is accepting.
    queue(ada, deck(ada, client), partner_id=str(bob.id))
    back = queue(bob, deck(bob, client), partner_id=str(ada.id)).json()
    assert back["status"] == "waiting" and back["partner"]["handle"] == "ada"
    # One leaving takes the other out.
    bob.send("DELETE", "/api/v1/queue")
    alone = place(ada)
    assert (alone["status"], alone["reason"]) == ("left", "partner_left")
    assert alone["message"].startswith("bob left the queue")

    # A team whose app stopped asking goes together.
    queue(ada, deck(ada, client), partner_id=str(cara.id))
    cara.send("POST", f"/api/v1/queue/invites/{ada.id}", {"deck_id": deck(cara, client)})
    clock.advance(100)
    place(ada)
    clock.advance(100)
    tick(client)
    assert (place(ada)["status"], place(ada)["reason"]) == ("left", "partner_left")
    assert (place(cara)["status"], place(cara)["reason"]) == ("left", "gone")

    # Refused at the start, a player takes their friend with them.
    queue(ada, deck(ada, client), partner_id=str(cara.id))
    cara_deck = deck(cara, client)
    cara.send("POST", f"/api/v1/queue/invites/{ada.id}", {"deck_id": cara_deck})
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(update(Deck).where(Deck.id == uuid.UUID(cara_deck)).values(deleted_at=utcnow()))
        db.commit()
    clock.advance(61)
    place(ada), place(cara)
    tick(client)
    assert (place(cara)["status"], place(ada)["status"]) == ("refused", "refused")
    assert place(ada)["reason"] == "partner_refused"
    assert len(engine.created) == 0


def test_an_invitation_ends_with_the_friendship(client):
    ada, bob, cara, dan, eve = (
        Account(client, n, admin=True) for n in ("ada", "bob", "cara", "dan", "eve")
    )
    for friend in (bob, cara, dan, eve):
        befriend(ada, friend)

    def ended(name: str, invitee: Account) -> None:
        """Ada's invitation is over, she is told, and the friend no longer sees it anywhere."""
        after = place(ada)
        assert (after["status"], after["reason"]) == ("left", "invite_ended")
        assert after["message"] == f"{name} can no longer join your team."
        assert place(invitee)["invites"] == []
        items = invitee.get("/api/v1/notifications").json()["items"]
        assert not any(item["request_pending"] for item in items)

    # Bob ends the friendship while Ada's invitation waits for him.
    queue(ada, deck(ada, client), partner_id=str(bob.id))
    assert bob.send("DELETE", f"/api/v1/friends/{ada.id}").status_code == 200
    ended("bob", bob)
    # Ada blocks Cara, whom she invited; Dan blocks Ada, who invited him.
    queue(ada, deck(ada, client), partner_id=str(cara.id))
    assert ada.send("PUT", f"/api/v1/blocks/{cara.id}").status_code == 200
    ended("cara", cara)
    queue(ada, deck(ada, client), partner_id=str(dan.id))
    assert dan.send("PUT", f"/api/v1/blocks/{ada.id}").status_code == 200
    ended("dan", dan)
    # An invitation left open when a friendship ends some other way (its row deleted here) shows
    # nowhere, and cannot be accepted.
    queue(ada, deck(ada, client), partner_id=str(eve.id))
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(delete(Friendship))
        db.commit()
    assert place(eve)["invites"] == []
    bell = eve.get("/api/v1/notifications").json()["items"][0]
    assert (bell["kind"], bell["request_pending"]) == ("team_invite", False)
    refused = eve.send("POST", f"/api/v1/queue/invites/{ada.id}", {"deck_id": deck(eve, client)})
    assert (refused.status_code, refused.json()["code"]) == (409, "not_friends")


def test_bots_come_after_a_minute(client, engine, clock):
    ada, bob, cara, dan = (Account(client, n, admin=True) for n in ("ada", "bob", "cara", "dan"))
    # Alone: a practice game with a bot teammate, which records its request.
    queue(ada, bolts(ada, client))
    clock.advance(61)
    place(ada)
    tick(client)
    found = place(ada)
    assert found["status"] == "matched"
    body = engine.created[-1]
    assert body["format"] == TEAM and [s["player"] for s in body["seats"]] == [
        "human",
        "bot",
        "bot",
        "bot",
    ]
    assert body["seats"][1]["deck"] != "legacy-mono-red-burn"
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        game = db.get(Game, uuid.UUID(found["game_id"]))
        assert game is not None and game.kind == "practice" and game.settings is not None
        assert game.settings["format"] == TEAM and len(game.settings["bots"]) == 3

    # Two players alone whose decks share a card play on opposite teams, each with a bot.
    queue(bob, bolts(bob, client))
    clock.advance(1)
    queue(cara, bolts(cara, client))
    clock.advance(61)
    place(bob), place(cara)
    tick(client)
    game_id = place(cara)["game_id"]
    assert [seat.user_id for seat in seats_of(client, game_id)] == [bob.id, None, cara.id, None]
    assert queues_table(client, game_id).bot_seats == [1, 3]

    # Friends after a minute: the two of them against two bots.
    befriend(ada, dan)
    # Ada's practice game is over, so she may play again.
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(update(Game).values(status="finished"))
        db.commit()
    queue(ada, deck(ada, client), partner_id=str(dan.id))
    dan.send("POST", f"/api/v1/queue/invites/{ada.id}", {"deck_id": deck(dan, client)})
    clock.advance(61)
    place(ada), place(dan)
    tick(client)
    game_id = place(dan)["game_id"]
    seated = [seat.user_id for seat in seats_of(client, game_id)]
    assert set(seated[:2]) == {ada.id, dan.id} and seated[2:] == [None, None]


def test_the_queue_refuses_only_a_deck_no_bot_can_play_beside(client, engine, clock, monkeypatch):
    """Regression (v0.5.1): when one bot got no fixture deck, every player beside a bot was taken
    out, told falsely that their deck shared a card with every bot deck; and the decks were dealt
    first-fit, so that happened when another dealing worked."""
    decks = stand_ins(monkeypatch)
    bob, cara, dan, erin = (Account(client, n, admin=True) for n in ("bob", "cara", "dan", "erin"))
    # Bob's deck rules out the first fixture for his bot, Cara's every one but the second; both
    # hold a Bolt, so they sit on opposite sides, each with a bot.
    queue(bob, built(bob, client, STAND_INS[0]))
    clock.advance(1)
    queue(cara, built(cara, client, *STAND_INS[:1], *STAND_INS[2:]))
    clock.advance(61)
    place(bob), place(cara)
    tick(client)
    assert (place(bob)["status"], place(cara)["status"]) == ("matched", "matched")
    game_id = place(cara)["game_id"]
    assert [seat.user_id for seat in seats_of(client, game_id)] == [bob.id, None, cara.id, None]
    seats = engine.created[-1]["seats"]
    assert (seats[1]["deck"], seats[3]["deck"]) == (decks[2], decks[1])

    # Dan's deck shares a card with every fixture deck: he alone is taken out, and Erin, waiting
    # again, plays with bots.
    queue(dan, built(dan, client, *STAND_INS))
    clock.advance(1)
    queue(erin, built(erin, client, STAND_INS[0]))
    clock.advance(61)
    place(dan), place(erin)
    tick(client)
    refused = place(dan)
    assert (refused["status"], refused["reason"]) == ("refused", "team_decks")
    assert refused["message"].startswith("Your deck shares a card with every bot deck")
    assert place(erin)["status"] == "matched"
    assert [s["player"] for s in engine.created[-1]["seats"]] == ["human", "bot", "bot", "bot"]


def test_a_rematch_keeps_the_teams(client, engine):
    ada, bob, cara = (Account(client, n, admin=True) for n in ("ada", "bob", "cara"))
    code = team_table(ada, deck(ada, client), bots=1)["code"]
    sit(bob, code, deck(bob, client), team=1)
    sit(cara, code, deck(cara, client))
    ready(bob, code), ready(cara, code)
    game_id = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
    assert [seat.user_id for seat in seats_of(client, game_id)] == [ada.id, cara.id, bob.id, None]
    # Cara was voted out while away: a bot takes her seat in the rematch, in her team.
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(
            update(GameSeat)
            .where(GameSeat.game_id == uuid.UUID(game_id), GameSeat.user_id == cara.id)
            .values(left_reason="removed", left_at=utcnow())
        )
        db.commit()
    engine.win(game_id, 1)
    until_finished(ada, game_id)
    offer = ada.send("POST", f"/api/v1/games/{game_id}/rematch").json()
    assert [p["handle"] for p in offer["players"]] == ["ada", "bob"]
    started = bob.send("POST", f"/api/v1/games/{game_id}/rematch").json()
    new_id = started["game_id"]
    assert new_id, started
    assert [s["player"] for s in engine.created[-1]["seats"]] == ["human", "bot", "human", "bot"]
    assert [seat.user_id for seat in seats_of(client, new_id)] == [ada.id, None, bob.id, None]
    table = queues_table(client, new_id)
    assert (table.format, table.bots, table.bot_seats) == (TEAM, 2, [1, 3])


def test_a_rematch_refuses_two_headed_giants_banned_card_again(client, engine, monkeypatch):
    """At a table refusing banned cards, the rematch checks each deck for the card banned in
    Two-Headed Giant itself (MTR 9.5), as the table's start does: a deck that took it in after
    the game stops the rematch, its player named and the card not."""
    # The test catalog has no Erayo: Lightning Bolt, legal in Legacy, stands in for it.
    monkeypatch.setattr(teams, "BANNED", frozenset({"Lightning Bolt"}))
    ada, bob, cara = (Account(client, n, admin=True) for n in ("ada", "bob", "cara"))
    strict = {"banned": False, "not_legal": False}
    code = team_table(ada, deck(ada, client), bots=1, rules=strict)["code"]
    bob_deck = deck(bob, client, title="Bob's")
    sit(bob, code, bob_deck, team=1)
    sit(cara, code, deck(cara, client))
    ready(bob, code), ready(cara, code)
    game_id = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
    engine.win(game_id, 0)
    until_finished(ada, game_id)
    # Bob puts the card in his deck in the builder after the game.
    entries = [
        {"card_id": card(client, "Lightning Bolt"), "quantity": 4, "location": "main"},
        {"card_id": card(client, "Mountain"), "quantity": 56, "location": "main"},
    ]
    saved = bob.send("PUT", f"/api/v1/decks/{bob_deck}/draft", {"version": 1, "entries": entries})
    assert saved.status_code == 200, saved.text
    ada.send("POST", f"/api/v1/games/{game_id}/rematch")
    bob.send("POST", f"/api/v1/games/{game_id}/rematch")
    refused = cara.send("POST", f"/api/v1/games/{game_id}/rematch")
    assert (refused.status_code, refused.json()["code"]) == (409, "deck_not_playable")
    assert refused.json()["message"] == "bob's deck cannot be played now."
    view = ada.get(f"/api/v1/games/{game_id}/rematch").json()
    assert (view["status"], view["message"]) == ("failed", "bob's deck cannot be played now.")
    assert len(engine.created) == 1


def test_deleting_an_account_ends_its_team_and_invitations(client):
    from api.accounts import delete_account

    ada, bob, cara = (Account(client, n, admin=True) for n in ("ada", "bob", "cara"))
    befriend(ada, bob)
    befriend(cara, bob)
    queue(ada, deck(ada, client), partner_id=str(bob.id))
    bob.send("POST", f"/api/v1/queue/invites/{ada.id}", {"deck_id": deck(bob, client)})
    queue(cara, deck(cara, client), partner_id=str(bob.id))
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        user = db.get(User, bob.id)
        assert user is not None
        delete_account(db, user, utcnow())
        db.commit()
        assert db.get(QueueEntry, bob.id) is None
        assert db.scalar(select(func.count()).where(QueueEntry.partner_id == bob.id)) == 0
    assert (place(ada)["status"], place(ada)["reason"]) == ("left", "partner_left")
    assert (place(cara)["status"], place(cara)["reason"]) == ("left", "invite_ended")


def test_the_migration_goes_back(tmp_path, monkeypatch):
    database = f"sqlite:///{tmp_path}/teams.db"
    monkeypatch.setenv("CD_DATABASE_URL", database)
    config = Config("alembic.ini")
    command.upgrade(config, "head")
    engine = create_engine(database)
    user, game, deck_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
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
                "INSERT INTO decks (id, owner_id, title, format, visibility, notes, draft, "
                "draft_version, draft_hash, card_count, legal, playable, collection_locked, "
                "identity, source, removed_cards, switched_editions, created_at, updated_at) "
                "VALUES (:id, :user, 'Burn', 'legacy', 'private', '', '{}', 1, '', 0, 0, 0, 0, "
                "'', 'empty', '[]', '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            ),
            {"id": deck_id.hex, "user": user.hex},
        )
        connection.execute(
            text(
                "INSERT INTO games (id, kind, format, status, created_by, created_at, bot_skill, "
                "turn_cap) VALUES (:id, 'table', 'two_headed_giant', 'finished', :user, "
                "CURRENT_TIMESTAMP, 4, 60)"
            ),
            {"id": game.hex, "user": user.hex},
        )
        table_ids = {"started-table": uuid.uuid4(), "open-table-1": uuid.uuid4()}
        for code, started in (("started-table", game.hex), ("open-table-1", None)):
            connection.execute(
                text(
                    "INSERT INTO game_tables (id, code, host_id, format, visibility, seats, bots, "
                    "bot_seats, bot_skill, turn_cap, allow_banned, allow_not_legal, best_of, "
                    "status, game_id, created_at, queued, kept_teams) VALUES (:id, :code, :user, "
                    "'two_headed_giant', 'public', 4, 1, '[1]', 4, 60, 1, 1, 1, :status, :game, "
                    "CURRENT_TIMESTAMP, 0, :kept)"
                ),
                {
                    "id": table_ids[code].hex,
                    "code": code,
                    "user": user.hex,
                    "status": "started" if started else "open",
                    "game": started,
                    "kept": json.dumps({str(user): 0}),
                },
            )
        # Each table's seat is bound to a revision of the deck (v0.5.1).
        revision = uuid.uuid4()
        connection.execute(
            text(
                "INSERT INTO deck_revisions (id, deck_id, number, format, title, notes, "
                "content_hash, legal, playable, created_at) VALUES (:id, :deck, 1, 'legacy', "
                "'Burn', '', 'x', 1, 1, CURRENT_TIMESTAMP)"
            ),
            {"id": revision.hex, "deck": deck_id.hex},
        )
        for table_id in table_ids.values():
            connection.execute(
                text(
                    "INSERT INTO table_seats (id, table_id, seat, user_id, deck_id, "
                    "deck_revision_id, ready, joined_at) VALUES (:id, :table, 0, :user, :deck, "
                    ":revision, 1, CURRENT_TIMESTAMP)"
                ),
                {
                    "id": uuid.uuid4().hex,
                    "table": table_id.hex,
                    "user": user.hex,
                    "deck": deck_id.hex,
                    "revision": revision.hex,
                },
            )
        connection.execute(
            text(
                "INSERT INTO queue_entries (user_id, format, seats, best_of, deck_id, "
                "humans_only, partner_id, status, joined_at, seen_at) VALUES (:user, "
                "'two_headed_giant', 4, 1, :deck, 0, :user, 'inviting', CURRENT_TIMESTAMP, "
                "CURRENT_TIMESTAMP)"
            ),
            {"user": user.hex, "deck": deck_id.hex},
        )
        connection.execute(
            text(
                "INSERT INTO notifications (id, user_id, kind, actor_id, created_at) VALUES (:id, "
                ":user, 'team_invite', :user, CURRENT_TIMESTAMP)"
            ),
            {"id": uuid.uuid4().hex, "user": user.hex},
        )
    command.downgrade(config, "0025_library_editions")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM notifications")).scalar() == 0
        assert connection.execute(text("SELECT count(*) FROM queue_entries")).scalar() == 0
        found = connection.execute(text("SELECT code, format FROM game_tables")).all()
        assert found == [("started-table", "legacy")]
        assert connection.execute(text("SELECT format FROM games")).scalar() == TEAM
        # The started table keeps its seat, without the revision it was bound to; the columns go.
        seats = connection.execute(text("SELECT * FROM table_seats")).mappings().all()
        assert len(seats) == 1 and "deck_revision_id" not in seats[0]
        tables_left = connection.execute(text("SELECT * FROM game_tables")).mappings().all()
        assert "kept_teams" not in tables_left[0]
    command.upgrade(config, "head")
    engine.dispose()


@contextmanager
def on_postgresql() -> Iterator[Engine]:
    """A schema of the test's own on PostgreSQL (CD_TEST_POSTGRES_URL), dropped after it."""
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
        yield database
    finally:
        database.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_parallel_team_claims_on_postgresql_seat_each_player_once():
    """The Two-Headed Giant queue's matches in parallel connections: eight players alone make two
    tables of two teams, and no player is claimed twice."""
    with on_postgresql() as database:
        now = utcnow()
        with Session(database) as db:
            for index in range(9):
                user = User(display_name=f"Player {index}", created_at=now)
                db.add(user)
                db.flush()
                owned = Deck(
                    owner_id=user.id,
                    title="Mountains",
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
                        format=TEAM,
                        seats=4,
                        deck_id=owned.id,
                        humans_only=True,
                        status="waiting",
                        joined_at=now + timedelta(seconds=index),
                        seen_at=now,
                    )
                )
            db.commit()
        key = queues.QueueKey(TEAM, 4)
        with ThreadPoolExecutor(max_workers=4) as workers:
            claims = list(workers.map(lambda _: queues.claim(database, key, now), range(4)))
        groups = [group for group in claims if group is not None]
        claimed = [user for group in groups for user in group.users]
        assert len(groups) == 2 and all(len(group.seats) == 4 for group in groups)
        assert all(None not in group.seats for group in groups)
        assert len(set(claimed)) == len(claimed) == 8
        with Session(database) as db:
            statuses = list(db.scalars(select(QueueEntry.status)))
        assert sorted(statuses) == ["starting"] * 8 + ["waiting"]


def players(database: Engine, *names: str) -> dict[str, tuple[uuid.UUID, uuid.UUID]]:
    """Active players with a handle, each with a Legacy deck: their IDs and their decks'."""
    now = utcnow()
    made: dict[str, tuple[uuid.UUID, uuid.UUID]] = {}
    with Session(database) as db:
        for name in names:
            user = User(handle=name, normalized_handle=name, display_name=name, created_at=now)
            db.add(user)
            db.flush()
            owned = Deck(
                owner_id=user.id,
                title="Mountains",
                format="legacy",
                draft_hash="",
                created_at=now,
                updated_at=now,
            )
            db.add(owned)
            db.flush()
            made[name] = (user.id, owned.id)
        db.commit()
    return made


def a_team(database: Engine, now: datetime) -> list[uuid.UUID]:
    """Two players waiting in the Two-Headed Giant queue as a team, as accepting leaves them (one
    joined_at): their IDs, in user_id order."""
    (ada, ada_deck), (bob, bob_deck) = players(database, "ada", "bob").values()
    with Session(database) as db:
        for user_id, deck_id, partner in ((ada, ada_deck, bob), (bob, bob_deck, ada)):
            db.add(
                QueueEntry(
                    user_id=user_id,
                    format=TEAM,
                    seats=4,
                    deck_id=deck_id,
                    humans_only=True,
                    partner_id=partner,
                    status="waiting",
                    joined_at=now,
                    seen_at=now,
                )
            )
        db.commit()
    return sorted((ada, bob))


def leave_at(database: Engine, now: datetime, user_id: uuid.UUID) -> str:
    """Leaves the queue as its route does, in a connection of its own: the place's status after."""
    state = SimpleNamespace(queues=SimpleNamespace(clock=lambda: now))
    request = SimpleNamespace(app=SimpleNamespace(state=state))
    principal = SimpleNamespace(user=SimpleNamespace(id=user_id))
    with Session(database, expire_on_commit=False) as db:
        return queues.leave_queue(request, principal, db).status  # type: ignore[arg-type]


def meeting(seconds: float) -> Any:
    """A wait for the other request at the same point, given up after a while: before the fixes
    below, both reach it holding what they have locked; after them, the second waits for the
    first's locks instead, so the first goes on alone once the wait is given up."""
    barrier = threading.Barrier(2, timeout=seconds)

    def wait() -> None:
        with suppress(threading.BrokenBarrierError):
            barrier.wait()

    return wait


def paused_leaving(monkeypatch: pytest.MonkeyPatch) -> threading.Event:
    """Each request meets the other (see meeting) as it takes its team's other place out; the
    event is set once the first gets there."""
    meet = meeting(2)
    reached = threading.Event()
    leave_team = queues.leave_team

    def paused(*args: Any, **kwargs: Any) -> None:
        reached.set()
        meet()
        leave_team(*args, **kwargs)

    monkeypatch.setattr(queues, "leave_team", paused)
    return reached


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_teammates_leaving_at_once_on_postgresql(monkeypatch):
    """Two teammates leave the Two-Headed Giant queue at the same moment, in their own connections:
    each locks the team's two rows together in one order, so neither holds the row the other waits
    for (a deadlock PostgreSQL would end by failing one), and the team leaves once."""
    paused_leaving(monkeypatch)
    now = utcnow()
    with on_postgresql() as database:
        team = a_team(database, now)
        with ThreadPoolExecutor(max_workers=2) as workers:
            answers = list(workers.map(lambda user_id: leave_at(database, now, user_id), team))
        assert answers == ["left", "left"]
        with Session(database) as db:
            reasons = sorted(row.reason or "" for row in db.scalars(select(QueueEntry)))
        assert reasons == ["left", "partner_left"]


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_a_teammate_leaving_as_the_tick_takes_the_other_out_on_postgresql(monkeypatch):
    """The tick takes out a teammate whose app stopped asking while the other leaves, in their own
    connections: the tick locks the team's two rows first, in the order leaving does, so the leave
    waits for it rather than holding the row it takes out next, and the team leaves once."""
    reached = paused_leaving(monkeypatch)
    now = utcnow()
    with on_postgresql() as database:
        # The one leaving comes first in user_id order, the order leaving locks the two in.
        leaving, gone = a_team(database, now)
        with Session(database) as db:
            row = db.get(QueueEntry, gone)
            assert row is not None
            row.seen_at = now - queues.STALE_AFTER - timedelta(seconds=1)
            db.commit()
        with ThreadPoolExecutor(max_workers=2) as workers:
            ticked = workers.submit(queues.waiting_queues, database, now)
            # The tick is about to take the teammate out, holding what it has locked.
            assert reached.wait(5)
            left = workers.submit(leave_at, database, now, leaving)
            assert (ticked.result(), left.result()) == ([], "left")
        with Session(database) as db:
            rows = {row.user_id: row for row in db.scalars(select(QueueEntry))}
        assert (rows[gone].status, rows[gone].reason) == ("left", "gone")
        assert (rows[leaving].status, rows[leaving].reason) == ("left", "partner_left")


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_friends_inviting_each_other_at_once_on_postgresql(monkeypatch):
    """Two friends invite each other to the Two-Headed Giant queue at the same moment, in their own
    connections: both accounts are locked before either looks for the other's invitation, so the
    second accepts the first's and they wait as a team, not each on an invitation."""
    meet = meeting(2)
    monkeypatch.setattr(queues, "check_deck", lambda *args, **kwargs: meet())
    now = utcnow()

    async def no_match(key: queues.QueueKey) -> None:
        return None

    state = SimpleNamespace(
        queues=SimpleNamespace(clock=lambda: now, match=no_match),
        settings=SimpleNamespace(games_per_account=3),
    )
    request = SimpleNamespace(app=SimpleNamespace(state=state))
    with on_postgresql() as database:
        made = players(database, "ada", "bob")
        (ada, ada_deck), (bob, bob_deck) = made["ada"], made["bob"]
        decks = {ada: ada_deck, bob: bob_deck}
        with Session(database) as db:
            low, high = sorted((ada, bob))
            db.add(
                Friendship(
                    user_low=low,
                    user_high=high,
                    requested_by=ada,
                    status="accepted",
                    created_at=now,
                    accepted_at=now,
                )
            )
            db.commit()

        def invite(me: uuid.UUID, friend: uuid.UUID) -> str:
            with Session(database, expire_on_commit=False) as db:
                user = db.get(User, me)
                allowed = frozenset({"games.play", "decks.edit"})
                principal = Principal(user, None, ["player"], allowed)  # type: ignore[arg-type]
                body = queues.QueueRequest(
                    format=TEAM, seats=4, deck_id=decks[me], partner_id=friend
                )
                answer = asyncio.run(queues.join_queue(body, request, principal, db))  # type: ignore[arg-type]
                return answer.status

        with ThreadPoolExecutor(max_workers=2) as workers:
            answers = list(workers.map(invite, (ada, bob), (bob, ada)))
        # The second accepted the first's invitation; the first may see their team already.
        assert "waiting" in answers and set(answers) <= {"inviting", "waiting"}
        with Session(database) as db:
            rows = {row.user_id: row for row in db.scalars(select(QueueEntry))}
            pending = db.scalar(
                select(func.count()).where(
                    Notification.kind == "team_invite", Notification.read_at.is_(None)
                )
            )
        assert (rows[ada].status, rows[bob].status) == ("waiting", "waiting")
        assert (rows[ada].partner_id, rows[bob].partner_id) == (bob, ada)
        assert rows[ada].joined_at == rows[bob].joined_at
        assert pending == 0


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_inviting_a_friend_as_another_accepts_their_invitation_on_postgresql(monkeypatch):
    """Ada invites Bob while Cara accepts Bob's invitation, in their own connections. Ada's request
    locks the two accounts FOR NO KEY UPDATE, which Cara's new place, naming Bob, need not wait
    for: Cara's accepting goes on while Ada's request waits for Bob's place, and neither fails, as
    they would on a deadlock if Ada's request held Bob's account FOR UPDATE."""
    monkeypatch.setattr(queues, "check_deck", lambda *args, **kwargs: None)
    meet = meeting(2)
    reached = threading.Event()
    friends = queues.friends

    def paused(*args: Any) -> bool:
        reached.set()
        meet()
        return friends(*args)

    monkeypatch.setattr(queues, "friends", paused)
    now = utcnow()
    state = SimpleNamespace(
        queues=SimpleNamespace(clock=lambda: now),
        settings=SimpleNamespace(games_per_account=3),
    )
    request = SimpleNamespace(app=SimpleNamespace(state=state))
    allowed = frozenset({"games.play", "decks.edit"})
    with on_postgresql() as database:
        (ada, ada_deck), (bob, bob_deck), (cara, cara_deck) = players(
            database, "ada", "bob", "cara"
        ).values()
        with Session(database) as db:
            for one, other in ((ada, bob), (bob, cara)):
                low, high = sorted((one, other))
                db.add(
                    Friendship(
                        user_low=low,
                        user_high=high,
                        requested_by=one,
                        status="accepted",
                        created_at=now,
                        accepted_at=now,
                    )
                )
            db.add(
                QueueEntry(
                    user_id=bob,
                    format=TEAM,
                    seats=4,
                    deck_id=bob_deck,
                    humans_only=False,
                    partner_id=cara,
                    status="inviting",
                    joined_at=now,
                    seen_at=now,
                )
            )
            db.commit()

        def accept() -> None:
            with Session(database) as db:
                principal = Principal(db.get(User, cara), None, ["player"], allowed)  # type: ignore[arg-type]
                queues.accept(db, request, principal, bob, cara_deck, now)  # type: ignore[arg-type]

        def invite() -> None:
            with Session(database) as db:
                principal = Principal(db.get(User, ada), None, ["player"], allowed)  # type: ignore[arg-type]
                body = queues.QueueRequest(format=TEAM, seats=4, deck_id=ada_deck, partner_id=bob)
                queues.join(db, request, principal, body, now)  # type: ignore[arg-type]

        with ThreadPoolExecutor(max_workers=2) as workers:
            accepting = workers.submit(accept)
            # Cara holds Bob's place, about to take her own beside it, which names Bob.
            assert reached.wait(5)
            inviting = workers.submit(invite)
            accepting.result()
            inviting.result()
        with Session(database) as db:
            rows = {
                row.user_id: (row.status, row.partner_id) for row in db.scalars(select(QueueEntry))
            }
        assert rows == {ada: ("inviting", bob), bob: ("waiting", cara), cara: ("waiting", bob)}


def test_the_pairing_rules():
    """Units in join order: friends are one; a player alone pairs with the first one before them
    whose deck shares no card, and a side of two goes first."""
    now = utcnow()

    def row(name: str, seconds: int, partner: str | None = None) -> QueueEntry:
        return QueueEntry(
            user_id=uuid.uuid5(uuid.NAMESPACE_OID, name),
            partner_id=uuid.uuid5(uuid.NAMESPACE_OID, partner) if partner else None,
            humans_only=False,
            joined_at=now + timedelta(seconds=seconds),
        )

    rows = [row("a", 0), row("b", 1), row("p", 2, "q"), row("q", 2, "p"), row("c", 3)]
    cards = {
        rows[0].user_id: {"Lightning Bolt"},
        rows[1].user_id: {"Lightning Bolt"},
        rows[4].user_id: {"Brainstorm"},
    }
    units = queues.units_of(rows)
    assert [[r.user_id for r in unit] for unit in units] == [
        [rows[0].user_id],
        [rows[1].user_id],
        [rows[2].user_id, rows[3].user_id],
        [rows[4].user_id],
    ]
    formed, alone = queues.team_up(units, cards)
    assert [[r.user_id for r in team] for team in formed] == [
        [rows[2].user_id, rows[3].user_id],
        [rows[0].user_id, rows[4].user_id],
    ]
    assert [r.user_id for r in alone] == [rows[1].user_id]
    assert queues.sides([[rows[1]]]) == [rows[1].user_id, None, None, None]
    # Half of a team whose friend is not waiting is passed over.
    assert queues.units_of([row("p", 0, "q")]) == []
    assert teams.SEATS == 4


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_an_invitation_sent_as_the_friendship_ends_does_not_stay_open(monkeypatch):
    """Regression (v0.5.1, the fix's review): an invitation written while the friendship ended at
    the same moment stayed open, its inviter waiting on a friend who never saw it. Ending the
    friendship now waits for the invitation's account locks, then ends it."""
    reached, unfriending = threading.Event(), threading.Event()

    def paused(*args: Any, **kwargs: Any) -> None:
        reached.set()
        unfriending.wait(5)

    monkeypatch.setattr(queues, "check_deck", paused)
    now = utcnow()
    state = SimpleNamespace(
        queues=SimpleNamespace(clock=lambda: now),
        settings=SimpleNamespace(games_per_account=3),
    )
    request = SimpleNamespace(app=SimpleNamespace(state=state))
    allowed = frozenset({"games.play", "decks.edit"})
    with on_postgresql() as database:
        (ada, ada_deck), (bob, _) = players(database, "ada", "bob").values()
        with Session(database) as db:
            low, high = sorted((ada, bob))
            db.add(
                Friendship(
                    user_low=low,
                    user_high=high,
                    requested_by=ada,
                    status="accepted",
                    created_at=now,
                    accepted_at=now,
                )
            )
            db.commit()

        def invite() -> None:
            with Session(database) as db:
                user = db.get(User, ada)
                assert user is not None
                principal = Principal(user, None, ["player"], allowed)  # type: ignore[arg-type]
                body = queues.QueueRequest(format=TEAM, seats=4, deck_id=ada_deck, partner_id=bob)
                queues.join(db, request, principal, body, now)  # type: ignore[arg-type]

        def unfriend() -> None:
            with Session(database) as db:
                me, other = db.get(User, bob), db.get(User, ada)
                assert me is not None and other is not None
                social.unfriend(db, me, other)

        with ThreadPoolExecutor(max_workers=2) as workers:
            inviting = workers.submit(invite)
            assert reached.wait(5)
            ending = workers.submit(unfriend)
            # The friendship's end waits for the invitation's locks; the invitation goes on.
            time.sleep(0.5)
            assert not ending.done()
            unfriending.set()
            inviting.result(10)
            ending.result(10)
        with Session(database) as db:
            row = db.get(QueueEntry, ada)
            assert row is not None and (row.status, row.reason) == ("left", "invite_ended")
            assert list(db.scalars(select(Friendship))) == []
