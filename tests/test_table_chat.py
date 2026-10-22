"""The table's chat and alliances (v0.4.4), on a human table's game WebSocket against the fake
engine of tests/test_tables.py: the whole table's messages and emotes, alliances offered,
accepted, ended and ended by leaving the game, messages to allies that no other player's
connection ever receives (SysOp watching sees them), the history a tab gets when it connects,
reports of a line, the rate limit, and no chat in a practice game."""

import uuid
from collections.abc import Iterator
from contextlib import ExitStack
from pathlib import Path
from typing import Any

import pytest
import test_tables
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session
from test_games import Tab
from test_tables import Account, TableEngine, commander_table, concede, deck, opened, served

from api.chat import BURST
from api.models import AuditEvent, TableMessage

# The human tables' fixtures: their database, content and fake engine.
url = test_tables.url
content = test_tables.content
engine = test_tables.engine
CONTEXT = {
    "page": "#tables",
    "app_version": "0.4.4",
    "viewport_width": 1280,
    "viewport_height": 800,
    "pixel_ratio": 1,
}


@pytest.fixture
def client(url: str, content: Path, engine: TableEngine) -> Iterator[TestClient]:
    with served(url, content, engine) as client:
        yield client
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            db.execute(text("DELETE FROM problem_reports"))
            db.execute(text("DELETE FROM table_messages"))
            db.commit()


def say(tab: Tab, body: str, channel: str = "table") -> str:
    client_id = str(uuid.uuid4())
    tab.socket.send_json({"type": "chat", "channel": channel, "text": body, "client_id": client_id})
    return client_id


def heard(tab: Tab, **match: Any) -> dict[str, Any]:
    """The next chat line whose fields match."""
    for _ in range(100):
        message = tab.until("chat")["message"]
        if all(message.get(key) == value for key, value in match.items()):
            return message  # type: ignore[no-any-return]
    raise AssertionError(f"no chat line matching {match}")


def alliances(tab: Tab, **match: Any) -> dict[str, Any]:
    for _ in range(100):
        message = tab.until("alliances")
        if all(message.get(key) == value for key, value in match.items()):
            return message
    raise AssertionError(f"no alliances matching {match}")


def ally(tab: Tab, action: str, seat: int) -> None:
    tab.socket.send_json({"type": "alliance", "action": action, "seat": seat})


def settled(tab: Tab) -> None:
    """Everything sent to the tab so far has arrived: its pong comes after it."""
    tab.socket.send_json({"type": "ping"})
    tab.until("pong")


def table(client: TestClient, players: list[Account]) -> str:
    code = commander_table(client, players[0], players[1:], bots=1)
    return str(players[0].send("POST", f"/api/v1/tables/{code}/start").json()["game_id"])


def test_the_table_talks_and_allies_talk_apart(client, engine):
    ada, bob, cara = (Account(client, name, admin=True) for name in ("ada", "bob", "cara"))
    root = Account(client, "sysop", kind="sysop")
    game_id = table(client, [ada, bob, cara])
    seen = {"ada": [], "bob": [], "cara": [], "root": []}  # type: dict[str, list[str]]
    with ExitStack() as stack:
        tabs = {
            name: opened(account, game_id, seen[name], stack)
            for name, account in (("ada", ada), ("bob", bob), ("cara", cara))
        }
        # A new connection is told the chat so far and the alliances.
        assert tabs["ada"].until("chat_history")["messages"] == []
        assert alliances(tabs["ada"]) == {"type": "alliances", "alliances": [], "offers": []}

        # The whole table hears a message and an emote, with who sent them.
        client_id = say(tabs["ada"], "Good luck, everyone!")
        for name in ("ada", "bob", "cara"):
            line = heard(tabs[name], body="Good luck, everyone!")
            assert line["channel"] == "table" and line["kind"] == "text" and line["seat"] == 0
            assert line["sender"] == {"id": str(ada.id), "handle": "ada"}
        assert line["client_id"] == client_id
        tabs["cara"].socket.send_json(
            {"type": "emote", "emote": "good_game", "client_id": str(uuid.uuid4())}
        )
        assert heard(tabs["bob"], kind="emote")["body"] == "good_game"

        # No allies yet.
        refused_id = say(tabs["ada"], "Psst", "allies")
        refusal = tabs["ada"].until("error")
        assert (refusal["code"], refusal["client_id"]) == ("no_allies", refused_id)

        # Ada offers Bob an alliance: only the two see the offer; Bob accepts.
        ally(tabs["ada"], "offer", 1)
        assert alliances(tabs["bob"])["offers"] == [{"from": 0, "to": 1}]
        assert alliances(tabs["cara"])["offers"] == []
        ally(tabs["bob"], "accept", 0)
        for name in ("ada", "bob", "cara"):
            assert alliances(tabs[name], alliances=[[0, 1]])["offers"] == []
            started = heard(tabs[name], kind="event")
            assert (started["body"], started["seats"]) == ("allied", [0, 1])

        # Ada writes to her allies: Bob reads it, Cara never receives it.
        say(tabs["ada"], "Let's take out Cara first", "allies")
        secret = heard(tabs["bob"], channel="allies")
        assert secret["body"] == "Let's take out Cara first" and secret["seats"] == [1]
        heard(tabs["ada"], channel="allies")
        say(tabs["cara"], "What are you two whispering?")
        heard(tabs["cara"], body="What are you two whispering?")
        settled(tabs["cara"])

        # SysOp watching sees it all, in the history a new connection gets.
        watching = opened(root, game_id, seen["root"], stack)
        history = watching.until("chat_history")["messages"]
        assert "Let's take out Cara first" in [line["body"] for line in history]
        # A tab of Cara's that connects now is told the table's lines only.
        late: list[str] = []
        again = opened(cara, game_id, late, stack)
        bodies = [line["body"] for line in again.until("chat_history")["messages"]]
        assert "Good luck, everyone!" in bodies and "Let's take out Cara first" not in bodies
        seen["cara"] += late

        # Bob reports the line; Cara cannot, as for her it does not exist.
        report = {"summary": "Plotting", "description": "Mean.", "context": CONTEXT}
        mine = bob.send(
            "POST", "/api/v1/reports", report | {"message": {"kind": "table", "id": secret["id"]}}
        )
        assert mine.status_code == 201, mine.text
        other = cara.send(
            "POST", "/api/v1/reports", report | {"message": {"kind": "table", "id": secret["id"]}}
        )
        assert other.status_code == 404
        detail = ada.get(f"/api/v1/admin/reports/{mine.json()['id']}").json()
        lines = detail["chat"]["lines"]
        assert lines[-1]["reported"] and lines[-1]["channel"] == "allies"
        assert lines[-1]["seats"] == [0, 1] and detail["chat"]["game_id"] == game_id
        assert detail["reported_user"]["handle"] == "ada"

        # Ada ends the alliance: the table hears of it, and allies-only messages stop.
        ally(tabs["ada"], "end", 1)
        ended = heard(tabs["cara"], kind="event", body="alliance_ended")
        assert ended["seats"] == [0, 1] and ended["seat"] == 0
        say(tabs["bob"], "Wait!", "allies")
        assert tabs["bob"].until("error")["code"] == "no_allies"

        # Offering back is accepting; leaving the game ends a player's alliances.
        ally(tabs["bob"], "offer", 2)
        ally(tabs["cara"], "offer", 1)
        alliances(tabs["ada"], alliances=[[1, 2]])
        assert concede(tabs["bob"], game_id)["status"] == 200
        alliances(tabs["cara"], alliances=[])
        assert heard(tabs["ada"], body="alliance_ended")["seats"] == [1, 2]
        # Out of the game, Bob still talks at the table, but makes no alliance.
        say(tabs["bob"], "gg, I'm out")
        heard(tabs["ada"], body="gg, I'm out")
        ally(tabs["bob"], "offer", 0)
        assert tabs["bob"].until("error")["code"] == "not_in_game"
        for name in ("ada", "bob", "cara"):
            settled(tabs[name])
    # The allies-only line reached no connection of Cara's.
    assert "Let's take out Cara first" not in "\n".join(seen["cara"])
    assert "Let's take out Cara first" in "\n".join(seen["root"])
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        kinds = list(db.scalars(select(TableMessage.kind).order_by(TableMessage.created_at)))
        assert kinds.count("event") == 4 and kinds.count("emote") == 1
        assert (
            db.scalar(
                select(func.count())
                .select_from(AuditEvent)
                .where(AuditEvent.action == "chat.table_read")
            )
            == 0
        )
    # SysOp's reader shows the whole chat, and records that it did.
    transcript = root.get(f"/api/v1/admin/chats/games/{game_id}").json()
    assert "Let's take out Cara first" in [line["body"] for line in transcript["lines"]]
    assert {p["handle"] for p in transcript["players"]} == {"ada", "bob", "cara"}
    assert ada.get(f"/api/v1/admin/chats/games/{game_id}").status_code == 403


def test_alliance_refusals_and_the_rate_limit(client, engine):
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    game_id = table(client, [ada, bob])
    with ExitStack() as stack:
        tab = opened(ada, game_id, [], stack)
        for action, seat, code in (
            ("accept", 1, "no_offer"),
            ("end", 1, "not_allied"),
            ("withdraw", 1, "no_offer"),
            ("offer", 0, "invalid_alliance"),
            # Seat 2 is the bot's: bots make no alliances.
            ("offer", 2, "invalid_alliance"),
        ):
            ally(tab, action, seat)
            refusal = tab.until("error")
            assert (refusal["code"], refusal["seat"]) == (code, seat), action
        ally(tab, "offer", 1)
        ally(tab, "offer", 1)
        alliances(tab, offers=[{"from": 0, "to": 1}])
        ally(tab, "withdraw", 1)
        alliances(tab, offers=[])
        tab.socket.send_json({"type": "chat", "text": "x" * 501, "client_id": str(uuid.uuid4())})
        assert tab.until("error")["code"] == "invalid_message"
        tab.socket.send_json({"type": "emote", "emote": "rude", "client_id": str(uuid.uuid4())})
        assert tab.until("error")["code"] == "invalid_message"
        for index in range(BURST):
            say(tab, f"spam {index}")
        say(tab, "one too many")
        refusal = tab.until("error")
        assert refusal["code"] == "chat_limited" and refusal["retry_after"] >= 1


def test_a_practice_game_has_no_chat(client, engine):
    ada = Account(client, "ada", admin=True)
    made = ada.send(
        "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck(ada, client)}
    )
    assert made.status_code == 201, made.text
    with ExitStack() as stack:
        tab = opened(ada, made.json()["id"], [], stack)
        say(tab, "Hello, bots?")
        assert tab.until("error")["code"] == "no_chat"
