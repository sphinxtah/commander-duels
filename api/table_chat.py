"""The table's chat and its alliances (v0.4.4), on the game's WebSocket (api/games.py). docs/chat.md
describes them for players and staff.

- **The table.** At a human table's game, every player writes to the whole table, in text or with
  a preset emote (EMOTES). A player out of the game (conceded, removed or eliminated) still reads
  and writes it; SysOp watching the game does too. Practice games have no chat: bots never read or
  send one.
- **Alliances** (the owner's choice): a player offers one to another player still in the game,
  and it starts when they accept, or offer it back; either may end it at any time, and a player
  leaving the game ends theirs. Everyone sees who is allied with whom, and the table's chat says
  when an alliance starts or ends; an offer is seen only by the two players.
- **Allies only.** A player with allies may write to them alone: the message goes to the sender's
  allies at that moment, and to no other player, like a hand. SysOp watching or inspecting the
  game reads them all, its exception to SEC05 and NET14 (games.view_concealed).
- **Kept.** Every line is stored (table_messages) as it is sent, for the history a tab gets when
  it connects (HISTORY lines it may see), for a report of a message, and for SysOp's reader; the
  worker's daily job deletes them after api/chat.py's TABLE_DAYS. Alliances live with the running
  game, in this process's memory.
- **Limits.** The text rules and the rate of api/chat.py, shared with friends' messages; SysOp has
  no limit.
"""

from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING, Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import Engine, and_, or_, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api.chat import REPORT_CONTEXT, MessageText, chat_hub_of
from api.identity import ApiError, Principal, not_found, utcnow
from api.models import GameSeat, TableMessage, User
from api.schemas import ChatLine, ChatPerson, ReportedChat

if TYPE_CHECKING:
    from fastapi import WebSocket

    from api.games import Connection, GameHub, LiveGame, LiveSeat

# The emotes, by the name the socket carries; the web app shows their words (and may translate).
EMOTES = {
    "hello": "Hello!",
    "good_luck": "Good luck, have fun!",
    "your_turn": "Your turn.",
    "thinking": "Thinking…",
    "nice_play": "Nice play!",
    "thanks": "Thanks!",
    "oops": "Oops!",
    "sorry": "Sorry!",
    "good_game": "Good game!",
}
EmoteName = Literal[
    "hello",
    "good_luck",
    "your_turn",
    "thinking",
    "nice_play",
    "thanks",
    "oops",
    "sorry",
    "good_game",
]
HISTORY = 200
# Lines read back to find the REPORT_CONTEXT a reporter saw before a reported one.
REPORT_SCAN = 500


class ChatIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["chat"]
    channel: Literal["table", "allies"] = "table"
    text: MessageText
    client_id: UUID


class EmoteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["emote"]
    emote: EmoteName
    client_id: UUID


class AllianceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["alliance"]
    action: Literal["offer", "accept", "decline", "withdraw", "end"]
    seat: int = Field(ge=0, le=64)


MESSAGES: dict[str, type[ChatIn] | type[EmoteIn] | type[AllianceIn]] = {
    "chat": ChatIn,
    "emote": EmoteIn,
    "alliance": AllianceIn,
}


def sees_everything(connection: "Connection") -> bool:
    """SysOp watching the game (only SysOp may), or inspecting it from its own seat."""
    return connection.seat is None or connection.inspect


def visible(
    channel: str, sender_seat: int | None, seats: list[int] | None, viewer: int | None
) -> bool:
    """Whether a player's seat sees a line: the table's, or one to allies it sent or received."""
    if channel == "table":
        return True
    return viewer is not None and (viewer == sender_seat or viewer in (seats or []))


def sees(connection: "Connection", row: TableMessage) -> bool:
    return sees_everything(connection) or visible(row.channel, row.seat, row.seats, connection.seat)


def wire(row: TableMessage, handles: Mapping[UUID, str | None]) -> dict[str, Any]:
    """A line as the socket sends it."""
    return {
        "id": str(row.id),
        "channel": row.channel,
        "kind": row.kind,
        "seat": row.seat,
        "sender": (
            {"id": str(row.sender_id), "handle": handles.get(row.sender_id)}
            if row.sender_id is not None
            else None
        ),
        "body": row.body,
        "seats": row.seats or [],
        "client_id": str(row.client_id) if row.client_id else None,
        "created_at": row.created_at.isoformat(),
    }


def line_of(row: TableMessage, handles: Mapping[UUID, str | None]) -> ChatLine:
    """A line as a report or SysOp's reader keeps it: seats holds the sender's seat first."""
    seats = row.seats or []
    if row.kind != "event" and row.seat is not None:
        seats = [row.seat, *seats]
    return ChatLine(
        id=row.id,
        sender=(
            ChatPerson(id=row.sender_id, handle=handles.get(row.sender_id))
            if row.sender_id is not None
            else None
        ),
        channel=row.channel,  # type: ignore[arg-type]
        kind=row.kind,  # type: ignore[arg-type]
        body=row.body,
        seats=seats,
        created_at=row.created_at,
    )


def handles_of(db: Session, ids: set[UUID]) -> dict[UUID, str | None]:
    if not ids:
        return {}
    rows = db.execute(select(User.id, User.handle).where(User.id.in_(ids)))
    return {user_id: handle for user_id, handle in rows}


def stored(database: Engine, row: TableMessage) -> dict[UUID, str | None]:
    """Stores a line; the sender's handle, for sending it."""
    with Session(database, expire_on_commit=False) as db:
        db.add(row)
        db.commit()
        return handles_of(db, {row.sender_id} if row.sender_id else set())


def recent(database: Engine, game_id: UUID) -> tuple[list[TableMessage], dict[UUID, str | None]]:
    """The game's latest lines, oldest first, with their senders' handles."""
    with Session(database, expire_on_commit=False) as db:
        rows = list(
            db.scalars(
                select(TableMessage)
                .where(TableMessage.game_id == game_id)
                .order_by(TableMessage.created_at.desc(), TableMessage.id.desc())
                .limit(HISTORY * 4)
            )
        )
        rows.reverse()
        return rows, handles_of(db, {row.sender_id for row in rows if row.sender_id})


# On the game's WebSocket.


def alliances_of(game: "LiveGame", connection: "Connection") -> dict[str, Any]:
    """Every alliance, and the offers this connection's seat made or received (all, for SysOp)."""
    everything = sees_everything(connection)
    return {
        "type": "alliances",
        "alliances": sorted(sorted(pair) for pair in game.alliances),
        "offers": [
            {"from": giver, "to": taker}
            for giver, taker in sorted(game.offers)
            if everything or connection.seat in (giver, taker)
        ],
    }


def alliances_changed(game: "LiveGame") -> None:
    for connection in list(game.connections.values()):
        connection.send(alliances_of(game, connection))


async def welcome(hub: "GameHub", game: "LiveGame", connection: "Connection") -> None:
    """A table's new connection: the chat it may see so far, and the alliances."""
    rows, handles = await run_in_threadpool(recent, hub.database, game.id)
    shown = [wire(row, handles) for row in rows if sees(connection, row)][-HISTORY:]
    connection.send({"type": "chat_history", "messages": shown})
    connection.send(alliances_of(game, connection))


async def post(hub: "GameHub", game: "LiveGame", row: TableMessage) -> None:
    """Stores a line, then sends it to every connection that may see it."""
    handles = await run_in_threadpool(stored, hub.database, row)
    message = {"type": "chat", "message": wire(row, handles)}
    for connection in list(game.connections.values()):
        if sees(connection, row):
            connection.send(message)


def line(
    game: "LiveGame",
    *,
    sender: UUID | None,
    seat: int | None,
    channel: str,
    kind: str,
    body: str,
    seats: list[int] | None = None,
    client_id: UUID | None = None,
) -> TableMessage:
    return TableMessage(
        id=uuid4(),
        game_id=game.id,
        sender_id=sender,
        seat=seat,
        channel=channel,
        kind=kind,
        body=body,
        seats=seats,
        client_id=client_id,
        created_at=utcnow(),
    )


def allies_of(game: "LiveGame", seat: int) -> list[int]:
    return sorted(
        other for pair in game.alliances if seat in pair for other in pair if other != seat
    )


async def receive(
    hub: "GameHub",
    game: "LiveGame",
    connection: "Connection",
    websocket: "WebSocket",
    message: dict[str, Any],
) -> None:
    """A chat, emote or alliance message from a connection; a refusal goes back as an error."""

    def refuse(code: str, text: str, **extra: Any) -> None:
        connection.send({"type": "error", "code": code, "message": text} | extra)

    client_id = message.get("client_id") if isinstance(message.get("client_id"), str) else None
    if game.kind != "table":
        refuse("no_chat", "Chat is for tables with other players.", client_id=client_id)
        return
    try:
        parsed = MESSAGES[message["type"]].model_validate(message)
    except ValidationError:
        refuse("invalid_message", "That message cannot be sent.", client_id=client_id)
        return
    if isinstance(parsed, AllianceIn):
        alliance(hub, game, connection, parsed, refuse)
        return
    # SysOp's connections are the ones not counted against the limits (api/games.py crowded).
    if connection.counted:
        wait = chat_hub_of(websocket).limits.wait(connection.user_id)
        if wait:
            refuse(
                "chat_limited",
                "You are sending messages very fast. Wait a moment.",
                client_id=client_id,
                retry_after=wait,
            )
            return
    if isinstance(parsed, EmoteIn):
        row = line(
            game,
            sender=connection.user_id,
            seat=connection.seat,
            channel="table",
            kind="emote",
            body=parsed.emote,
            client_id=parsed.client_id,
        )
    elif parsed.channel == "allies":
        allies = allies_of(game, connection.seat) if connection.seat is not None else []
        if not allies:
            refuse("no_allies", "You have no allies at this table.", client_id=client_id)
            return
        row = line(
            game,
            sender=connection.user_id,
            seat=connection.seat,
            channel="allies",
            kind="text",
            body=parsed.text,
            seats=allies,
            client_id=parsed.client_id,
        )
    else:
        row = line(
            game,
            sender=connection.user_id,
            seat=connection.seat,
            channel="table",
            kind="text",
            body=parsed.text,
            client_id=parsed.client_id,
        )
    await post(hub, game, row)


def alliance(
    hub: "GameHub",
    game: "LiveGame",
    connection: "Connection",
    wanted: AllianceIn,
    refuse: Callable[..., None],
) -> None:
    """Offers, accepts, declines, withdraws or ends an alliance between the connection's seat and
    another player's still in the game."""
    seat = connection.seat
    mine = game.seats.get(seat) if seat is not None else None
    other = game.seats.get(wanted.seat)
    if mine is None or seat is None:
        refuse("not_a_player", "Only the table's players make alliances.", seat=wanted.seat)
        return
    if game.finished or mine.left is not None:
        refuse("not_in_game", "You are out of this game.", seat=wanted.seat)
        return
    if other is None or other is mine:
        refuse("invalid_alliance", "There is no such player to ally with.", seat=wanted.seat)
        return
    pair = frozenset({seat, wanted.seat})
    action = wanted.action
    if action == "offer" and (wanted.seat, seat) in game.offers:
        # Offering one back is accepting it, as adding a friend back is.
        action = "accept"
    if action == "offer":
        if other.left is not None:
            refuse("not_in_game", "That player is out of the game.", seat=wanted.seat)
            return
        if pair in game.alliances:
            refuse("already_allied", "You are allies already.", seat=wanted.seat)
            return
        game.offers.add((seat, wanted.seat))
    elif action == "accept":
        if (wanted.seat, seat) not in game.offers:
            refuse("no_offer", "That player has not offered an alliance.", seat=wanted.seat)
            return
        game.offers.discard((wanted.seat, seat))
        game.offers.discard((seat, wanted.seat))
        game.alliances.add(pair)
        event(hub, game, "allied", [wanted.seat, seat], sender=connection.user_id, seat=seat)
    elif action in ("decline", "withdraw"):
        offer = (wanted.seat, seat) if action == "decline" else (seat, wanted.seat)
        if offer not in game.offers:
            refuse("no_offer", "There is no such offer.", seat=wanted.seat)
            return
        game.offers.discard(offer)
    else:
        if pair not in game.alliances:
            refuse("not_allied", "You are not allies.", seat=wanted.seat)
            return
        game.alliances.discard(pair)
        event(
            hub, game, "alliance_ended", [seat, wanted.seat], sender=connection.user_id, seat=seat
        )
    alliances_changed(game)


def event(
    hub: "GameHub",
    game: "LiveGame",
    name: str,
    seats: list[int],
    *,
    sender: UUID | None,
    seat: int | None,
) -> None:
    """An alliance's start or end, said in the table's chat."""
    row = line(
        game, sender=sender, seat=seat, channel="table", kind="event", body=name, seats=seats
    )
    hub.spawn(post(hub, game, row))


def seat_out(hub: "GameHub", game: "LiveGame", seat: "LiveSeat") -> None:
    """A player out of the game: their alliances end and their offers go."""
    changed = False
    for offer in [each for each in game.offers if seat.seat in each]:
        game.offers.discard(offer)
        changed = True
    for pair in [each for each in game.alliances if seat.seat in each]:
        game.alliances.discard(pair)
        other = next(iter(pair - {seat.seat}))
        event(hub, game, "alliance_ended", [seat.seat, other], sender=None, seat=None)
        changed = True
    if changed:
        alliances_changed(game)


# A report of a table's message (api/reports.py).


def reported_table(
    db: Session, principal: Principal, message_id: UUID
) -> tuple[UUID, ReportedChat]:
    """A line of a table's chat the account saw, and the REPORT_CONTEXT lines before it that it
    saw: what a report of it keeps. Another seat's allies-only line looks like a missing one."""
    me = principal.user.id
    row = db.get(TableMessage, message_id)
    if row is None:
        raise not_found()
    seat = db.scalar(
        select(GameSeat.seat).where(GameSeat.game_id == row.game_id, GameSeat.user_id == me)
    )
    everything = principal.can("games.view_concealed")
    if not (everything or (seat is not None and visible(row.channel, row.seat, row.seats, seat))):
        raise not_found()
    if row.kind == "event" or row.sender_id is None:
        raise ApiError(409, "not_reportable", "Only a player's message can be reported.")
    if row.sender_id == me:
        raise ApiError(409, "own_message", "That is your own message.")
    earlier = db.scalars(
        select(TableMessage)
        .where(
            TableMessage.game_id == row.game_id,
            or_(
                TableMessage.created_at < row.created_at,
                and_(TableMessage.created_at == row.created_at, TableMessage.id < row.id),
            ),
        )
        .order_by(TableMessage.created_at.desc(), TableMessage.id.desc())
        .limit(REPORT_SCAN)
    )
    before = [
        each for each in earlier if everything or visible(each.channel, each.seat, each.seats, seat)
    ][:REPORT_CONTEXT]
    shown = [*reversed(before), row]
    handles = handles_of(db, {each.sender_id for each in shown if each.sender_id})
    lines = [line_of(each, handles) for each in shown]
    lines[-1] = lines[-1].model_copy(update={"reported": True})
    return row.sender_id, ReportedChat(
        kind="table",
        game_id=row.game_id,
        reported_user=ChatPerson(id=row.sender_id, handle=handles.get(row.sender_id)),
        lines=lines,
    )
