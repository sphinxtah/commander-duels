"""Chat between friends (v0.4.4): friends only, conversations and their pages, read marks and the
unread counts, the bell's one notification while unread, a resend landing once, the text rules and
the rate limit, the chat's WebSocket telling every tab at once, a report keeping the message and
the ones before it, SysOp's audited reader, and deleting an account or the daily job removing
messages."""

import os
import uuid
from collections.abc import Iterator
from datetime import timedelta
from typing import Any
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, make_url, select, text, update
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketDisconnect
from test_games import ORIGIN
from test_social import TABLES as SOCIAL_TABLES
from test_social import befriend, check_in, database, player, started

from api import chat
from api.accounts import delete_account
from api.chat import BURST, MESSAGE_LENGTH, PER_MINUTE, ChatLimits
from api.identity import utcnow
from api.models import AuditEvent, Conversation, DirectMessage, Notification, User

TABLES = ("problem_reports", "table_messages", "direct_messages", "conversations", *SOCIAL_TABLES)
CONTEXT = {
    "page": "#messages",
    "app_version": "0.4.4",
    "viewport_width": 1280,
    "viewport_height": 800,
    "pixel_ratio": 1,
}


@pytest.fixture(scope="module")
def url(tmp_path_factory) -> str:
    folder = tmp_path_factory.mktemp("chat")
    url = f"sqlite:///{folder}/chat.db"
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("CD_DATABASE_URL", url)
        command.upgrade(Config("alembic.ini"), "head")
    return url


@pytest.fixture
def client(url: str) -> Iterator[TestClient]:
    with started(url) as client:
        yield client
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            for table in TABLES:
                db.execute(text(f"DELETE FROM {table}"))
            db.commit()


@pytest.fixture
def unlimited(monkeypatch: pytest.MonkeyPatch) -> None:
    """For tests that write more than the rate allows."""
    monkeypatch.setattr(chat, "BURST", 10_000)
    monkeypatch.setattr(chat, "PER_MINUTE", 10_000)


def write(sender: Any, recipient: Any, text: str, client_id: str | None = None) -> Any:
    return sender.send(
        "POST",
        f"/api/v1/conversations/{recipient.id}/messages",
        {"text": text, "client_id": client_id or str(uuid4())},
    )


def sent(sender: Any, recipient: Any, text: str) -> dict[str, Any]:
    answer = write(sender, recipient, text)
    assert answer.status_code == 201, answer.text
    return answer.json()  # type: ignore[no-any-return]


def page(who: Any, other: Any, **params: Any) -> dict[str, Any]:
    answer = who.get(f"/api/v1/conversations/{other.id}", **params)
    assert answer.status_code == 200, answer.text
    return answer.json()  # type: ignore[no-any-return]


def bell(who: Any) -> list[dict[str, Any]]:
    return who.get("/api/v1/notifications").json()["items"]  # type: ignore[no-any-return]


def socket(who: Any) -> Any:
    headers = {"cookie": f"cd_session={who.token}", "origin": ORIGIN}
    return who.http.websocket_connect("/api/v1/chat/events", headers=headers)


def opened(who: Any, connection: Any) -> dict[str, Any]:
    connection.send_json({"type": "hello", "csrf_token": who.csrf})
    welcome = connection.receive_json()
    assert welcome["type"] == "welcome", welcome
    return welcome  # type: ignore[no-any-return]


def test_friends_write_to_each_other(client):
    ada, bob, cara = player(client, "ada"), player(client, "bob"), player(client, "cara")
    # Only friends: a stranger, or a request still waiting, is refused.
    refused = write(ada, bob, "hello?")
    assert refused.status_code == 409 and refused.json()["code"] == "not_friends"
    ada.send("PUT", f"/api/v1/friends/{bob.id}")
    assert write(ada, bob, "hello?").status_code == 409
    bob.send("PUT", f"/api/v1/friends/{ada.id}")

    first = sent(ada, bob, "  Hello, Bob!\r\nGood game earlier.  ")
    assert first["body"] == "Hello, Bob!\nGood game earlier."
    assert first["sender_id"] == str(ada.id)
    sent(ada, bob, "Rematch?")
    # Bob has two unread, in his list, in the check-in and in one notification that counts them.
    listed = bob.get("/api/v1/conversations").json()
    assert listed["unread"] == 2
    [item] = listed["conversations"]
    assert item["player"]["id"] == str(ada.id) and item["friends"] is True
    assert item["unread"] == 2 and item["last_message"]["body"] == "Rematch?"
    assert check_in(bob)["messages_unread"] == 2
    [notice] = [entry for entry in bell(bob) if entry["kind"] == "message"]
    assert notice["actor"]["id"] == str(ada.id) and notice["messages"] == 2
    assert not notice["read"]
    # Ada's own messages are read; nothing waits for her.
    assert ada.get("/api/v1/conversations").json()["unread"] == 0
    assert not [entry for entry in bell(ada) if entry["kind"] == "message"]

    shown = page(bob, ada)
    assert [m["body"] for m in shown["messages"]] == [first["body"], "Rematch?"]
    assert shown["friends"] is True and shown["unread"] == 2 and shown["next"] is None
    read = bob.send("POST", f"/api/v1/conversations/{ada.id}/read", {})
    assert read.status_code == 200 and read.json() == {"unread": 0}
    assert all(entry["read"] for entry in bell(bob) if entry["kind"] == "message")
    # A new message after reading is a new notification.
    sent(ada, bob, "Still there?")
    unread = [e for e in bell(bob) if e["kind"] == "message" and not e["read"]]
    assert len(unread) == 1 and unread[0]["messages"] == 1

    # Cara is no one's friend here: Ada and Bob's conversation is not hers.
    assert cara.get("/api/v1/conversations").json() == {"conversations": [], "unread": 0}
    assert page(cara, ada)["messages"] == []


def test_a_resend_lands_once_and_pages_go_back(client, unlimited):
    ada, bob = player(client, "ada"), player(client, "bob")
    befriend(ada, bob)
    client_id = str(uuid4())
    once = write(ada, bob, "Only once", client_id)
    again = write(ada, bob, "Only once", client_id)
    assert once.status_code == again.status_code == 201
    assert once.json()["id"] == again.json()["id"]
    for index in range(7):
        sent(bob if index % 2 else ada, ada if index % 2 else bob, f"line {index}")
    newest = page(ada, bob, limit=3)
    assert [m["body"] for m in newest["messages"]] == ["line 4", "line 5", "line 6"]
    older = page(ada, bob, limit=3, cursor=newest["next"])
    assert [m["body"] for m in older["messages"]] == ["line 1", "line 2", "line 3"]
    oldest = page(ada, bob, limit=3, cursor=older["next"])
    assert [m["body"] for m in oldest["messages"]] == ["Only once", "line 0"]
    assert oldest["next"] is None


def test_the_text_rules(client):
    ada, bob = player(client, "ada"), player(client, "bob")
    befriend(ada, bob)
    for refused in (
        "",
        "   ",
        "x" * (MESSAGE_LENGTH + 1),
        "bell\x07",
        "nul\x00",
        "\n".join("a" * 14),
    ):
        answer = write(ada, bob, refused)
        assert answer.status_code == 422, repr(refused)
    # Direction overrides are dropped; emoji, accents and tabs stay.
    kept = sent(ada, bob, "gg ‮evil‬ 👍🏽 café\tok")
    assert kept["body"] == "gg evil 👍🏽 café\tok"
    assert sent(ada, bob, "x" * MESSAGE_LENGTH)["body"] == "x" * MESSAGE_LENGTH


def test_writing_too_fast_is_refused_but_not_for_sysop(client):
    ada, bob = player(client, "ada"), player(client, "bob")
    root = player(client, "root", kind="sysop")
    befriend(ada, bob)
    befriend(root, bob)
    for index in range(BURST):
        sent(ada, bob, f"quick {index}")
    refused = write(ada, bob, "one more")
    assert refused.status_code == 429 and refused.json()["code"] == "chat_limited"
    assert int(refused.headers["retry-after"]) >= 1
    for index in range(BURST * 2):
        sent(root, bob, f"root {index}")


def test_the_limits_count_bursts_and_minutes():
    limits = ChatLimits()
    who = uuid.uuid4()
    for index in range(BURST):
        assert limits.wait(who, now=float(index) * 0.1) == 0
    assert limits.wait(who, now=0.5) == 5
    moment = 10.0
    sent_count = BURST
    while sent_count < PER_MINUTE:
        if limits.wait(who, now=moment) == 0:
            sent_count += 1
        moment += 1.1
    assert limits.wait(who, now=moment) > 0
    assert limits.wait(who, now=moment + 61) == 0


def test_an_ended_friendship_or_a_block_stops_new_messages(client):
    ada, bob = player(client, "ada"), player(client, "bob")
    befriend(ada, bob)
    sent(ada, bob, "Before")
    bob.send("DELETE", f"/api/v1/friends/{ada.id}")
    assert write(ada, bob, "After").json()["code"] == "not_friends"
    shown = page(ada, bob)
    assert shown["friends"] is False and [m["body"] for m in shown["messages"]] == ["Before"]
    befriend(ada, bob)
    ada.send("PUT", f"/api/v1/blocks/{bob.id}")
    assert write(bob, ada, "Hey").status_code == 409
    assert write(ada, bob, "Hey").status_code == 409


def test_the_socket_tells_every_tab_at_once(client):
    ada, bob = player(client, "ada"), player(client, "bob")
    befriend(ada, bob)
    sent(ada, bob, "Waiting for you")
    with socket(bob) as first, socket(bob) as second, socket(ada) as mine:
        assert opened(bob, first)["unread"] == 1
        opened(bob, second)
        opened(ada, mine)
        message = sent(ada, bob, "Are you there?")
        for tab in (first, second):
            told = tab.receive_json()
            assert told == {
                "type": "message",
                "player_id": str(ada.id),
                "player": {"id": str(ada.id), "handle": "ada", "avatar": "sigil", "alliance": None},
                "message": message,
                "unread": 2,
            }
        # The sender's own tabs hear of it too, under the friend they wrote to.
        own = mine.receive_json()
        assert own["player_id"] == str(bob.id) and own["unread"] == 0
        # Reading in one tab tells the others.
        bob.send("POST", f"/api/v1/conversations/{ada.id}/read", {"up_to": message["created_at"]})
        for tab in (first, second):
            assert tab.receive_json() == {"type": "read", "player_id": str(ada.id), "unread": 0}
        first.send_json({"type": "ping"})
        assert first.receive_json() == {"type": "pong"}


def test_the_socket_needs_a_session_its_csrf_token_and_our_origin(client):
    ada = player(client, "ada")
    with client.websocket_connect("/api/v1/chat/events", headers={"origin": ORIGIN}) as anon:
        assert anon.receive_json()["code"] == "authentication_required"
    with client.websocket_connect(
        "/api/v1/chat/events",
        headers={"cookie": f"cd_session={ada.token}", "origin": "https://evil.example"},
    ) as foreign:
        assert foreign.receive_json()["code"] == "origin_refused"
    with socket(ada) as forged:
        forged.send_json({"type": "hello", "csrf_token": "forged"})
        assert forged.receive_json()["code"] == "csrf_failed"
        with pytest.raises(WebSocketDisconnect):
            forged.receive_json()


def report(who: Any, kind: str, message_id: str) -> Any:
    return who.send(
        "POST",
        "/api/v1/reports",
        {
            "summary": "A message",
            "description": "Rude.",
            "context": CONTEXT,
            "message": {"kind": kind, "id": message_id},
        },
    )


def test_a_report_keeps_the_message_and_the_ones_before_it(client, unlimited):
    ada, bob, cara = player(client, "ada"), player(client, "bob"), player(client, "cara")
    admin = player(client, "admin", admin=True)
    befriend(ada, bob)
    for index in range(24):
        sent(ada if index % 2 else bob, bob if index % 2 else ada, f"line {index}")
    rude = sent(ada, bob, "Something rude")
    sent(ada, bob, "After it")
    # Only the one who received it may report it: not its sender, nor a stranger.
    assert report(ada, "direct", rude["id"]).json()["code"] == "own_message"
    assert report(cara, "direct", rude["id"]).status_code == 404
    receipt = report(bob, "direct", rude["id"])
    assert receipt.status_code == 201, receipt.text
    detail = admin.get(f"/api/v1/admin/reports/{receipt.json()['id']}").json()
    assert detail["reported_user"] == {"id": str(ada.id), "handle": "ada"}
    lines = detail["chat"]["lines"]
    assert len(lines) == 21 and lines[-1]["body"] == "Something rude" and lines[-1]["reported"]
    assert lines[0]["body"] == "line 4" and not any(line["reported"] for line in lines[:-1])
    assert all(line["channel"] == "direct" for line in lines)
    listed = admin.get("/api/v1/admin/reports").json()["items"][0]
    assert listed["reported_user"]["handle"] == "ada"


def test_sysop_reads_any_chat_and_each_reading_is_audited(client):
    ada, bob = player(client, "ada"), player(client, "bob")
    admin, root = player(client, "admin", admin=True), player(client, "root", kind="sysop")
    befriend(ada, bob)
    sent(ada, bob, "Just between us")
    # Administrators read only what is reported.
    assert admin.get("/api/v1/admin/chats").status_code == 403
    listed = root.get("/api/v1/admin/chats", player_id=str(ada.id)).json()["chats"]
    [found] = listed
    assert found["kind"] == "direct" and found["messages"] == 1
    assert {p["handle"] for p in found["players"]} == {"ada", "bob"}
    with database(client) as db:
        assert db.scalar(select(func.count()).select_from(AuditEvent)) == 0
    read = root.get(f"/api/v1/admin/chats/conversations/{found['id']}").json()
    assert [line["body"] for line in read["lines"]] == ["Just between us"]
    with database(client) as db:
        assert list(db.scalars(select(AuditEvent.action))) == ["chat.conversation_read"]
    assert root.get(f"/api/v1/admin/chats/conversations/{uuid4()}").status_code == 404


def test_deleting_an_account_or_time_removes_messages(client):
    ada, bob, cara = player(client, "ada"), player(client, "bob"), player(client, "cara")
    befriend(ada, bob)
    befriend(bob, cara)
    sent(ada, bob, "Ada to Bob")
    sent(cara, bob, "Cara to Bob")
    with database(client) as db:
        user = db.get(User, ada.id)
        assert user is not None
        delete_account(db, user, utcnow())
        db.commit()
        assert db.scalar(select(func.count()).select_from(Conversation)) == 1
        assert list(db.scalars(select(DirectMessage.body))) == ["Cara to Bob"]
        # A year on, the daily job removes it, and the conversation with it.
        db.execute(update(DirectMessage).values(created_at=utcnow() - timedelta(days=366)))
        db.execute(update(Conversation).values(last_message_at=utcnow() - timedelta(days=366)))
        assert chat.prune_chat(db, utcnow()) == 2
        db.commit()
        assert db.scalar(select(func.count()).select_from(Conversation)) == 0
        assert (
            db.scalar(
                select(func.count()).select_from(Notification).where(Notification.kind == "message")
            )
            == 1
        )  # Cara's, read or not, goes with the bell's own pruning.


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_chat_on_postgresql(monkeypatch):
    """The unread counts' read marks, the pages' cursors and the report's JSON on PostgreSQL."""
    url = os.environ["CD_TEST_POSTGRES_URL"]
    schema = f"test_{uuid4().hex}"
    admin_engine = create_engine(url, connect_args={"connect_timeout": 3})
    with admin_engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    scoped = (
        make_url(url)
        .update_query_dict({"options": f"-csearch_path={schema}"})
        .render_as_string(hide_password=False)
    )
    monkeypatch.setenv("CD_DATABASE_URL", scoped)
    try:
        command.upgrade(Config("alembic.ini"), "head")
        with started(scoped) as client:
            ada, bob = player(client, "ada"), player(client, "bob")
            admin = player(client, "admin", admin=True)
            befriend(ada, bob)
            for index in range(5):
                sent(ada, bob, f"line {index}")
            assert bob.get("/api/v1/conversations").json()["unread"] == 5
            newest = page(bob, ada, limit=2)
            assert [
                m["body"] for m in page(bob, ada, limit=2, cursor=newest["next"])["messages"]
            ] == [
                "line 1",
                "line 2",
            ]
            last = newest["messages"][-1]
            bob.send(
                "POST",
                f"/api/v1/conversations/{ada.id}/read",
                {"up_to": newest["messages"][0]["created_at"]},
            )
            assert bob.get("/api/v1/conversations").json()["unread"] == 1
            receipt = report(bob, "direct", last["id"]).json()
            detail = admin.get(f"/api/v1/admin/reports/{receipt['id']}").json()
            assert detail["chat"]["lines"][-1]["reported"] is True
    finally:
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin_engine.dispose()
