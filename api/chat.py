"""Chat between friends (v0.4.4). docs/chat.md describes it for players and staff; the table's
chat, on the game's WebSocket, is api/table_chat.py.

- **Friends only.** Two players write to each other while they are friends (api/social.py). A
  friendship that ends, or a block, stops new messages; what was written stays readable to both.
- **Conversations.** One a pair, with each side's read mark. Messages are sent over HTTP (POST,
  with the session's CSRF token like every change), each with the sender's client_id so a resend
  lands once, and kept DIRECT_DAYS days.
- **At once.** While the app is open, each tab holds the chat's WebSocket (/chat/events), signed
  in by its cookie and the CSRF token in the first message. A message reaches the recipient's tabs
  and the sender's other tabs the moment it is stored; reading a conversation reaches the reader's
  other tabs. The API runs as one process, so the tabs are known in its memory.
- **The bell.** New messages from a friend are one notification while unread, renewed by each
  message; reading the conversation marks it read.
- **Limits.** Text is MESSAGE_LENGTH characters at most, without control characters but line
  breaks and tabs; invisible direction overrides are dropped. An account sends BURST messages in
  BURST_SECONDS and PER_MINUTE a minute, here and at tables together; SysOp has no limit.
- **Reading others' chats.** Administrators read a message only when a player reports it, with
  the REPORT_CONTEXT messages before it that the reporter saw (api/reports.py). SysOp may read any
  conversation or table chat (chat.read_all, its own); every reading is audited.
"""

import asyncio
import json
import re
import secrets
import threading
import time
import unicodedata
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal, cast
from uuid import UUID

import anyio
from fastapi import APIRouter, Depends, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import AfterValidator, Field, StringConstraints, ValidationError
from sqlalchemy import and_, case, delete, func, or_, select, update
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api.admin import decode_cursor, encode_cursor
from api.auth import INPUT_ERRORS
from api.identity import (
    Active,
    ApiError,
    Db,
    Principal,
    audit,
    not_found,
    require_permission,
    utcnow,
)
from api.models import (
    Conversation,
    DirectMessage,
    Game,
    GameSeat,
    Notification,
    TableMessage,
    User,
)
from api.schemas import ChatLine, ChatPerson, Contract, ReportedChat, without_nul
from api.social import (
    PlayerRef,
    PlayerSummary,
    friendship_between,
    notify,
    other_player,
    pair,
    player_ref,
    summaries,
    viewer_of,
    visible_player,
)

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
Reader = Annotated[Principal, Depends(require_permission("chat.read_all"))]

MESSAGE_LENGTH = 500
# Line breaks a message may hold; more are a wall of empty lines.
MESSAGE_LINES = 12
BURST = 5
BURST_SECONDS = 5.0
PER_MINUTE = 30
DIRECT_DAYS = 365
TABLE_DAYS = 30
PAGE = 50
CONVERSATIONS = 100
REPORT_CONTEXT = 20
# Chat WebSockets an account may hold: a tab each.
CONNECTIONS_PER_ACCOUNT = 8
# What SysOp's reader shows of one chat: the newest messages.
READER_LIMIT = 1000
# Direction overrides and isolates draw text backwards or out of place, so a message could pass
# for another's words; they are dropped. Joiners stay: emoji need them.
DIRECTION_MARKS = re.compile("[‪-‮⁦-⁩]")


def chat_text(value: str) -> str:
    """A message as typed: Windows line breaks as plain ones, direction overrides dropped. Control
    characters other than line breaks and tabs are refused, as is a wall of line breaks."""
    text = DIRECTION_MARKS.sub("", without_nul(value).replace("\r\n", "\n")).strip()
    if not text:
        raise ValueError("A message needs some text.")
    if any(unicodedata.category(each) == "Cc" and each not in "\n\t" for each in text):
        raise ValueError("A message may not contain control characters.")
    if text.count("\n") > MESSAGE_LINES:
        raise ValueError(f"A message may have at most {MESSAGE_LINES + 1} lines.")
    return text


MessageText = Annotated[
    str,
    StringConstraints(min_length=1, max_length=MESSAGE_LENGTH),
    AfterValidator(chat_text),
]


# Contracts.


class ChatMessage(Contract):
    id: UUID
    sender_id: UUID
    body: str
    created_at: datetime
    client_id: UUID = Field(description="The sender's own ID for it, so a resend lands once.")


class ConversationItem(Contract):
    player: PlayerSummary
    friends: bool = Field(description="Whether you may still write: you are friends.")
    last_message: ChatMessage | None
    unread: int


class ConversationList(Contract):
    conversations: list[ConversationItem]
    unread: int = Field(description="Unread messages in all of them.")


class MessagePage(Contract):
    player: PlayerSummary
    friends: bool
    messages: list[ChatMessage] = Field(description="Oldest first.")
    next: str | None = Field(description="The cursor of the older page, if any.")
    unread: int = Field(description="Unread messages from this player.")


class MessageCreate(Contract):
    text: MessageText
    client_id: UUID


class MessagesRead(Contract):
    up_to: datetime | None = Field(
        default=None, description="Marks their messages up to this time read; all if null."
    )


class ChatUnread(Contract):
    unread: int


class ReaderChat(Contract):
    """A chat SysOp's reader lists: a conversation or a table's game."""

    kind: Literal["direct", "table"]
    id: UUID = Field(description="The conversation's ID, or the game's.")
    players: list[PlayerRef]
    messages: int
    last_message_at: datetime


class ReaderList(Contract):
    chats: list[ReaderChat]


class ReaderTranscript(Contract):
    kind: Literal["direct", "table"]
    id: UUID
    players: list[PlayerRef]
    lines: list[ChatLine] = Field(description="Oldest first; the newest READER_LIMIT at most.")


# Limits on how fast an account writes, here and at tables, in this process's memory.


@dataclass
class ChatLimits:
    lock: threading.Lock = field(default_factory=threading.Lock)
    sent: dict[UUID, deque[float]] = field(default_factory=dict)

    def wait(self, user_id: UUID, now: float | None = None) -> int:
        """Takes a message's place, or how many seconds until one is free (and none is taken)."""
        moment = time.monotonic() if now is None else now
        with self.lock:
            sent = self.sent.setdefault(user_id, deque())
            while sent and sent[0] <= moment - 60:
                sent.popleft()
            recent = [at for at in sent if at > moment - BURST_SECONDS]
            if len(recent) >= BURST:
                return max(1, int(recent[-BURST] + BURST_SECONDS - moment + 0.999))
            if len(sent) >= PER_MINUTE:
                return max(1, int(sent[-PER_MINUTE] + 60 - moment + 0.999))
            sent.append(moment)
            return 0


def limited(wait: int) -> ApiError:
    return ApiError(
        429,
        "chat_limited",
        "You are sending messages very fast. Wait a moment.",
        {"Retry-After": str(wait)},
    )


# The tabs to tell, in this process's memory.


@dataclass(eq=False)
class ChatConnection:
    """One chat WebSocket. Everything sent to it goes through its queue, which one task drains."""

    id: str
    user_id: UUID
    session_id: UUID
    queue: asyncio.Queue[dict[str, Any] | None] = field(default_factory=lambda: asyncio.Queue(256))
    close_code: int | None = None
    ended: anyio.Event = field(default_factory=anyio.Event)

    def send(self, message: dict[str, Any]) -> None:
        if self.close_code is not None:
            return
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            # The client is not reading; it reloads the conversations when it reconnects.
            self.close(4408)

    def close(self, code: int, error: str | None = None) -> None:
        if self.close_code is None:
            self.close_code = code
            while not self.queue.empty():
                self.queue.get_nowait()
            if error is not None:
                self.queue.put_nowait({"type": "error", "code": error})
            self.queue.put_nowait(None)
            self.ended.set()


class ChatHub:
    """The chat's open tabs, by account, and the limits on writing. One per API process."""

    def __init__(self, loop: asyncio.AbstractEventLoop | None = None) -> None:
        self.loop = loop
        self.connections: dict[UUID, dict[str, ChatConnection]] = {}
        self.limits = ChatLimits()

    def tell(self, user_id: UUID, message: dict[str, Any]) -> None:
        """Sends to every tab of the account; from any thread (routes run in the thread pool)."""
        if self.loop is None:
            return
        try:
            self.loop.call_soon_threadsafe(self.send, user_id, message)
        except RuntimeError:
            # The loop has closed: the API is stopping.
            pass

    def send(self, user_id: UUID, message: dict[str, Any]) -> None:
        for connection in list(self.connections.get(user_id, {}).values()):
            connection.send(message)


def chat_hub_of(request: Request | WebSocket) -> ChatHub:
    state = request.app.state
    if not hasattr(state, "chat"):
        state.chat = ChatHub()
    return cast(ChatHub, state.chat)


def take_turn(request: Request | WebSocket, principal: Principal) -> None:
    """Refuses a message sent too fast; SysOp has no limit."""
    if principal.user.kind != "sysop":
        wait = chat_hub_of(request).limits.wait(principal.user.id)
        if wait:
            raise limited(wait)


# Conversations.


def conversation_between(db: Session, one: UUID, other: UUID) -> Conversation | None:
    low, high = pair(one, other)
    return db.scalar(
        select(Conversation).where(Conversation.user_low == low, Conversation.user_high == high)
    )


def read_mark(row: Conversation, user_id: UUID) -> datetime | None:
    return row.low_read_at if row.user_low == user_id else row.high_read_at


def set_read_mark(row: Conversation, user_id: UUID, moment: datetime) -> None:
    current = read_mark(row, user_id)
    if current is not None and current >= moment:
        return
    if row.user_low == user_id:
        row.low_read_at = moment
    else:
        row.high_read_at = moment


def unread_by_player(db: Session, user_id: UUID) -> dict[UUID, int]:
    """Unread messages to the account, by the friend who wrote them."""
    mark = case(
        (Conversation.user_low == user_id, Conversation.low_read_at),
        else_=Conversation.high_read_at,
    )
    rows = db.execute(
        select(DirectMessage.sender_id, func.count())
        .join(Conversation, Conversation.id == DirectMessage.conversation_id)
        .where(
            or_(Conversation.user_low == user_id, Conversation.user_high == user_id),
            DirectMessage.sender_id != user_id,
            or_(mark.is_(None), DirectMessage.created_at > mark),
        )
        .group_by(DirectMessage.sender_id)
    )
    return {sender: int(count) for sender, count in rows}


def unread_total(db: Session, user_id: UUID) -> int:
    return sum(unread_by_player(db, user_id).values())


def message_of(row: DirectMessage) -> ChatMessage:
    return ChatMessage(
        id=row.id,
        sender_id=row.sender_id,
        body=row.body,
        created_at=row.created_at,
        client_id=row.client_id,
    )


def friends_now(db: Session, one: UUID, other: UUID) -> bool:
    row = friendship_between(db, one, other)
    return row is not None and row.status == "accepted"


def renew_notification(db: Session, recipient: UUID, sender: UUID, now: datetime) -> None:
    """New messages from a friend are one notification while unread: the newest message renews
    it, so the bell shows it first."""
    row = db.scalar(
        select(Notification).where(
            Notification.user_id == recipient,
            Notification.kind == "message",
            Notification.actor_id == sender,
            Notification.read_at.is_(None),
        )
    )
    if row is None:
        notify(db, recipient, "message", sender, now)
    else:
        row.created_at = now


def read_notifications_from(db: Session, user_id: UUID, sender: UUID, now: datetime) -> None:
    db.execute(
        update(Notification)
        .where(
            Notification.user_id == user_id,
            Notification.kind == "message",
            Notification.actor_id == sender,
            Notification.read_at.is_(None),
        )
        .values(read_at=now)
    )


@router.get("/conversations", response_model=ConversationList)
def conversations(principal: Active, db: Db) -> ConversationList:
    """The account's conversations, the latest first, with what is unread in each."""
    me = principal.user.id
    rows = list(
        db.scalars(
            select(Conversation)
            .where(or_(Conversation.user_low == me, Conversation.user_high == me))
            .order_by(Conversation.last_message_at.desc())
            .limit(CONVERSATIONS)
        )
    )
    others = {row.id: row.user_high if row.user_low == me else row.user_low for row in rows}
    users = {
        user.id: user
        for user in db.scalars(
            select(User).where(
                User.id.in_(list(others.values())),
                User.status == "active",
                User.normalized_handle.is_not(None),
            )
        )
    }
    viewer = viewer_of(db, principal)
    shown = {summary.id: summary for summary in summaries(db, viewer, list(users.values()))}
    unread = unread_by_player(db, me)
    items = []
    for row in rows:
        other = others[row.id]
        if other not in shown:
            continue
        last = db.scalar(
            select(DirectMessage)
            .where(DirectMessage.conversation_id == row.id)
            .order_by(DirectMessage.created_at.desc(), DirectMessage.id.desc())
            .limit(1)
        )
        items.append(
            ConversationItem(
                player=shown[other],
                friends=viewer.state_with(other) == "friends",
                last_message=message_of(last) if last is not None else None,
                unread=unread.get(other, 0),
            )
        )
    return ConversationList(conversations=items, unread=sum(item.unread for item in items))


@router.get("/conversations/{player_id}", response_model=MessagePage)
def conversation(
    player_id: UUID,
    principal: Active,
    db: Db,
    limit: Annotated[int, Query(ge=1, le=100)] = PAGE,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
) -> MessagePage:
    """The messages between the account and a player, the newest page first; each page oldest
    first. A player never written to has an empty one."""
    me = principal.user.id
    other = visible_player(db, player_id)
    row = conversation_between(db, me, other.id) if other.id != me else None
    messages: list[DirectMessage] = []
    more = False
    if row is not None:
        query = select(DirectMessage).where(DirectMessage.conversation_id == row.id)
        if cursor:
            moment, row_id = decode_cursor(cursor)
            query = query.where(
                or_(
                    DirectMessage.created_at < moment,
                    and_(DirectMessage.created_at == moment, DirectMessage.id < row_id),
                )
            )
        found = list(
            db.scalars(
                query.order_by(DirectMessage.created_at.desc(), DirectMessage.id.desc()).limit(
                    limit + 1
                )
            )
        )
        more = len(found) > limit
        messages = list(reversed(found[:limit]))
    viewer = viewer_of(db, principal)
    return MessagePage(
        player=summaries(db, viewer, [other])[0],
        friends=viewer.state_with(other.id) == "friends",
        messages=[message_of(message) for message in messages],
        next=encode_cursor(messages[0].created_at, messages[0].id) if more else None,
        unread=unread_by_player(db, me).get(other.id, 0),
    )


@router.post("/conversations/{player_id}/messages", response_model=ChatMessage, status_code=201)
def send_message(
    player_id: UUID, body: MessageCreate, request: Request, principal: Active, db: Db
) -> ChatMessage:
    """Writes to a friend. A resend with the same client_id answers the message already sent."""
    me = principal.user
    other = other_player(db, principal, player_id)
    existing = db.scalar(
        select(DirectMessage).where(
            DirectMessage.sender_id == me.id, DirectMessage.client_id == body.client_id
        )
    )
    if existing is not None:
        return message_of(existing)
    if not friends_now(db, me.id, other.id):
        raise ApiError(409, "not_friends", "You can write only to your friends.")
    take_turn(request, principal)
    now = utcnow()
    row = conversation_between(db, me.id, other.id)
    if row is None:
        low, high = pair(me.id, other.id)
        row = Conversation(user_low=low, user_high=high, created_at=now, last_message_at=now)
        db.add(row)
        db.flush()
    row.last_message_at = now
    # Your own messages are read.
    set_read_mark(row, me.id, now)
    message = DirectMessage(
        conversation_id=row.id,
        sender_id=me.id,
        client_id=body.client_id,
        body=body.text,
        created_at=now,
    )
    db.add(message)
    renew_notification(db, other.id, me.id, now)
    db.commit()
    sent = message_of(message)
    hub = chat_hub_of(request)
    payload = sent.model_dump(mode="json")
    hub.tell(
        other.id,
        {
            "type": "message",
            "player_id": str(me.id),
            "player": player_ref(me).model_dump(mode="json"),
            "message": payload,
            "unread": unread_total(db, other.id),
        },
    )
    hub.tell(
        me.id,
        {
            "type": "message",
            "player_id": str(other.id),
            "player": player_ref(other).model_dump(mode="json"),
            "message": payload,
            "unread": unread_total(db, me.id),
        },
    )
    return sent


@router.post("/conversations/{player_id}/read", response_model=ChatUnread)
def read_conversation(
    player_id: UUID, body: MessagesRead, request: Request, principal: Active, db: Db
) -> ChatUnread:
    """Marks a player's messages read, up to a time or all of them, with their notification."""
    me = principal.user.id
    other = visible_player(db, player_id)
    row = conversation_between(db, me, other.id) if other.id != me else None
    now = utcnow()
    if row is not None:
        set_read_mark(row, me, min(body.up_to or now, now))
        read_notifications_from(db, me, other.id, now)
        db.commit()
    unread = unread_total(db, me)
    chat_hub_of(request).tell(me, {"type": "read", "player_id": str(other.id), "unread": unread})
    return ChatUnread(unread=unread)


# The chat's WebSocket.


@router.websocket("/chat/events")
async def chat_events(websocket: WebSocket) -> None:
    """New messages and read marks for the signed-in account, as they happen. The first message is
    a hello with the session's CSRF token; then the server sends a welcome with the unread count,
    and each message and read mark (docs/chat.md)."""
    # Imported here: api.games imports far, and only the socket needs its handshake.
    from api.games import (
        CLOSE_BAD_MESSAGE,
        CLOSE_FORBIDDEN,
        CLOSE_TOO_MANY,
        CLOSE_UNAUTHENTICATED,
        HELLO_SECONDS,
        Hello,
        connection_principal,
        origin_refused,
        refuse,
        session_ended,
    )

    hub = chat_hub_of(websocket)
    database = websocket.app.state.database
    websocket.state.request_id = secrets.token_hex(16)
    await websocket.accept()
    if origin_refused(websocket):
        await refuse(websocket, CLOSE_FORBIDDEN, "origin_refused")
        return
    principal = await run_in_threadpool(connection_principal, database, websocket)
    if isinstance(principal, str):
        await refuse(websocket, CLOSE_UNAUTHENTICATED, principal)
        return
    if principal.user.status != "active":
        await refuse(websocket, CLOSE_FORBIDDEN, "forbidden")
        return
    try:
        hello = Hello.model_validate_json(
            await asyncio.wait_for(websocket.receive_text(), HELLO_SECONDS)
        )
    except (TimeoutError, ValidationError, WebSocketDisconnect, KeyError):
        await refuse(websocket, CLOSE_BAD_MESSAGE, "hello_required")
        return
    if not secrets.compare_digest(hello.csrf_token, principal.session.csrf_token):
        await refuse(websocket, CLOSE_FORBIDDEN, "csrf_failed")
        return
    user_id = principal.user.id
    tabs = hub.connections.setdefault(user_id, {})
    if len(tabs) >= CONNECTIONS_PER_ACCOUNT:
        await refuse(websocket, CLOSE_TOO_MANY, "too_many_connections")
        return
    if hub.loop is None:
        hub.loop = asyncio.get_running_loop()
    connection = ChatConnection(
        id=secrets.token_hex(8), user_id=user_id, session_id=principal.session.id
    )
    tabs[connection.id] = connection

    def unread() -> int:
        with Session(database) as db:
            return unread_total(db, user_id)

    async def writer() -> None:
        try:
            while True:
                message = await connection.queue.get()
                if message is None:
                    break
                await websocket.send_json(message)
            await websocket.close(connection.close_code or 1000)
        except (WebSocketDisconnect, RuntimeError):
            pass

    async def watcher() -> None:
        while connection.close_code is None:
            with anyio.move_on_after(60):
                await connection.ended.wait()
            if connection.close_code is not None:
                return
            ended = await run_in_threadpool(
                session_ended, database, websocket, connection.session_id
            )
            if ended is not None:
                connection.close(CLOSE_UNAUTHENTICATED, ended)

    try:
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(writer)
            tasks.start_soon(watcher)
            try:
                connection.send({"type": "welcome", "unread": await run_in_threadpool(unread)})
                while connection.close_code is None:
                    try:
                        text = await websocket.receive_text()
                    except (WebSocketDisconnect, RuntimeError, KeyError):
                        return
                    # The page only listens; it may ping to keep proxies from closing the socket.
                    try:
                        ping = json.loads(text).get("type") == "ping"
                    except (ValueError, AttributeError):
                        ping = False
                    connection.send(
                        {"type": "pong"} if ping else {"type": "error", "code": "invalid_message"}
                    )
            finally:
                connection.close(1000)
    finally:
        tabs.pop(connection.id, None)
        if not tabs:
            hub.connections.pop(user_id, None)


# Reports of a message (api/reports.py), and what an account's deletion and the daily job remove.


def person(user: User | None) -> ChatPerson:
    if user is None:
        return ChatPerson(id=None, handle=None)
    return ChatPerson(id=user.id, handle=user.handle)


def reported_direct(
    db: Session, principal: Principal, message_id: UUID
) -> tuple[UUID, ReportedChat]:
    """A friend's message the account received, and the REPORT_CONTEXT messages before it in their
    conversation: what a report of it keeps."""
    me = principal.user.id
    message = db.get(DirectMessage, message_id)
    row = db.get(Conversation, message.conversation_id) if message is not None else None
    if message is None or row is None or me not in (row.user_low, row.user_high):
        raise not_found()
    if message.sender_id == me:
        raise ApiError(409, "own_message", "That is your own message.")
    before = list(
        db.scalars(
            select(DirectMessage)
            .where(
                DirectMessage.conversation_id == row.id,
                or_(
                    DirectMessage.created_at < message.created_at,
                    and_(
                        DirectMessage.created_at == message.created_at,
                        DirectMessage.id < message.id,
                    ),
                ),
            )
            .order_by(DirectMessage.created_at.desc(), DirectMessage.id.desc())
            .limit(REPORT_CONTEXT)
        )
    )
    shown = [*reversed(before), message]
    users = {
        user.id: user
        for user in db.scalars(select(User).where(User.id.in_({m.sender_id for m in shown})))
    }
    return message.sender_id, ReportedChat(
        kind="direct",
        reported_user=person(users.get(message.sender_id)),
        lines=[
            ChatLine(
                id=each.id,
                sender=person(users.get(each.sender_id)),
                channel="direct",
                kind="text",
                body=each.body,
                created_at=each.created_at,
                reported=each.id == message.id,
            )
            for each in shown
        ],
    )


def delete_chat_of(db: Session, user_id: UUID) -> int:
    """An account's conversations with every message in them, and its own lines in tables'
    chats; for deleting the account (api/accounts.py CLEANUPS). Returns the rows removed. A copy in
    a problem report stays with the report."""
    ids = list(
        db.scalars(
            select(Conversation.id).where(
                or_(Conversation.user_low == user_id, Conversation.user_high == user_id)
            )
        )
    )
    removed = 0
    if ids:
        removed += db.execute(  # type: ignore[attr-defined]
            delete(DirectMessage).where(DirectMessage.conversation_id.in_(ids))
        ).rowcount
        removed += db.execute(  # type: ignore[attr-defined]
            delete(Conversation).where(Conversation.id.in_(ids))
        ).rowcount
    removed += db.execute(  # type: ignore[attr-defined]
        delete(TableMessage).where(TableMessage.sender_id == user_id)
    ).rowcount
    return removed


def prune_chat(db: Session, now: datetime) -> int:
    """Friends' messages older than DIRECT_DAYS, conversations left empty as long, and tables'
    chats older than TABLE_DAYS (a game lasts hours, so its chat is kept TABLE_DAYS after it
    ends). The worker's daily job runs it. Returns the rows removed; the caller commits."""
    direct = now - timedelta(days=DIRECT_DAYS)
    removed = db.execute(  # type: ignore[attr-defined]
        delete(DirectMessage).where(DirectMessage.created_at < direct)
    ).rowcount
    removed += db.execute(  # type: ignore[attr-defined]
        delete(Conversation).where(
            Conversation.last_message_at < direct,
            ~select(DirectMessage.id)
            .where(DirectMessage.conversation_id == Conversation.id)
            .exists(),
        )
    ).rowcount
    removed += db.execute(  # type: ignore[attr-defined]
        delete(TableMessage).where(TableMessage.created_at < now - timedelta(days=TABLE_DAYS))
    ).rowcount
    return int(removed)


# SysOp's reader (chat.read_all): any conversation or table chat, every reading audited.


def refs_of(db: Session, ids: set[UUID]) -> dict[UUID, PlayerRef]:
    return {user.id: player_ref(user) for user in db.scalars(select(User).where(User.id.in_(ids)))}


@router.get("/admin/chats", response_model=ReaderList)
def reader_chats(
    principal: Reader,
    db: Db,
    player_id: Annotated[UUID | None, Query(description="Only this player's chats.")] = None,
) -> ReaderList:
    """The latest conversations and table chats, or one player's; listing reads no message."""
    direct = select(
        Conversation.id,
        Conversation.user_low,
        Conversation.user_high,
        func.count(),
        func.max(DirectMessage.created_at),
    ).join(DirectMessage, DirectMessage.conversation_id == Conversation.id)
    tables = select(TableMessage.game_id, func.count(), func.max(TableMessage.created_at)).group_by(
        TableMessage.game_id
    )
    if player_id is not None:
        direct = direct.where(
            or_(Conversation.user_low == player_id, Conversation.user_high == player_id)
        )
        tables = tables.where(
            TableMessage.game_id.in_(select(GameSeat.game_id).where(GameSeat.user_id == player_id))
        )
    direct_rows = db.execute(
        direct.group_by(Conversation.id, Conversation.user_low, Conversation.user_high)
        .order_by(func.max(DirectMessage.created_at).desc())
        .limit(CONVERSATIONS)
    ).all()
    table_rows = db.execute(
        tables.order_by(func.max(TableMessage.created_at).desc()).limit(CONVERSATIONS)
    ).all()
    seats: dict[UUID, list[UUID]] = {}
    for game_id, user_id in db.execute(
        select(GameSeat.game_id, GameSeat.user_id)
        .where(GameSeat.game_id.in_([row[0] for row in table_rows]), GameSeat.user_id.is_not(None))
        .order_by(GameSeat.seat)
    ):
        if user_id is not None:
            seats.setdefault(game_id, []).append(user_id)
    refs = refs_of(
        db,
        {user for row in direct_rows for user in (row[1], row[2])}
        | {user for users in seats.values() for user in users},
    )
    chats = [
        ReaderChat(
            kind="direct",
            id=row[0],
            players=[refs[user] for user in (row[1], row[2]) if user in refs],
            messages=row[3],
            last_message_at=row[4],
        )
        for row in direct_rows
    ] + [
        ReaderChat(
            kind="table",
            id=row[0],
            players=[refs[user] for user in seats.get(row[0], []) if user in refs],
            messages=row[1],
            last_message_at=row[2],
        )
        for row in table_rows
    ]
    chats.sort(key=lambda chat: chat.last_message_at, reverse=True)
    return ReaderList(chats=chats)


@router.get("/admin/chats/conversations/{conversation_id}", response_model=ReaderTranscript)
def reader_conversation(
    conversation_id: UUID, request: Request, principal: Reader, db: Db
) -> ReaderTranscript:
    """A conversation's messages, for SysOp; audited as chat.conversation_read."""
    row = db.get(Conversation, conversation_id)
    if row is None:
        raise not_found()
    found = list(
        db.scalars(
            select(DirectMessage)
            .where(DirectMessage.conversation_id == row.id)
            .order_by(DirectMessage.created_at.desc(), DirectMessage.id.desc())
            .limit(READER_LIMIT)
        )
    )
    users = {
        user.id: user
        for user in db.scalars(select(User).where(User.id.in_({row.user_low, row.user_high})))
    }
    audit(
        db,
        request,
        "chat.conversation_read",
        actor_id=principal.user.id,
        details={"conversation": str(row.id), "players": [str(row.user_low), str(row.user_high)]},
    )
    db.commit()
    return ReaderTranscript(
        kind="direct",
        id=row.id,
        players=[
            player_ref(users[user]) for user in (row.user_low, row.user_high) if user in users
        ],
        lines=[
            ChatLine(
                id=each.id,
                sender=person(users.get(each.sender_id)),
                channel="direct",
                kind="text",
                body=each.body,
                created_at=each.created_at,
            )
            for each in reversed(found)
        ],
    )


@router.get("/admin/chats/games/{game_id}", response_model=ReaderTranscript)
def reader_table(game_id: UUID, request: Request, principal: Reader, db: Db) -> ReaderTranscript:
    """A table's chat, allies-only messages included, for SysOp; audited as chat.table_read."""
    # Imported here: api.table_chat imports api.games, which imports far.
    from api.table_chat import line_of

    game = db.get(Game, game_id)
    if game is None:
        raise not_found()
    found = list(
        db.scalars(
            select(TableMessage)
            .where(TableMessage.game_id == game_id)
            .order_by(TableMessage.created_at.desc(), TableMessage.id.desc())
            .limit(READER_LIMIT)
        )
    )
    players = list(
        db.scalars(
            select(GameSeat.user_id)
            .where(GameSeat.game_id == game_id, GameSeat.user_id.is_not(None))
            .order_by(GameSeat.seat)
        )
    )
    senders = {each.sender_id for each in found if each.sender_id is not None}
    refs = refs_of(db, {user for user in players if user is not None} | senders)
    audit(
        db,
        request,
        "chat.table_read",
        actor_id=principal.user.id,
        details={"game": str(game_id)},
    )
    db.commit()
    handles = {user: ref.handle for user, ref in refs.items()}
    return ReaderTranscript(
        kind="table",
        id=game_id,
        players=[refs[user] for user in players if user is not None and user in refs],
        lines=[line_of(each, handles) for each in reversed(found)],
    )
