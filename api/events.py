"""A game's structured events (v0.9.10; docs/engine/events.md): kept, filtered by perspective, read.

The engine makes the events of each game from XMage's own (engine/GameEvents.java): numbered,
in the schema's words, with each object's id as the seat views know it and the seats that may see
it. This module keeps them past the game (``game_events``), and shows them only through one filter:

- **A seat** sees every event, and an object's identity where the seat may see it: everyone's, or
  its own (a card it drew), or, in a team game, its teammate's (the engine's rules for hands,
  810.5). A replay is a seat's perspective, the viewer's own.
- **A spectator** sees only what every seat may see.
- **Inspection** (SysOp, and an administrator outside a game they play against people: the rule
  of ``games.concealed_for``) sees everything, including who may see what, and each such reading
  is audited (``games.events_inspected``).

An object a perspective may not see is shown as ``{"hidden": true, "owner": seat}``: its id, its
name and its id before a move are all withheld, so nothing in an event's ids or metadata says
which card it was.

Kept ``EVENT_RETENTION_DAYS`` after the game ended (the owner's question, assumed at 90 days on
2026-11-12), then removed by the worker's daily job (``sweep``).
"""

import logging
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal, Protocol
from uuid import UUID

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel
from sqlalchemy import Engine, delete, func, or_, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api.identity import Active, ApiError, Db, Principal, audit
from api.models import Game, GameEventRow, GameSeat

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["events"])

EVENT_RETENTION_DAYS = 90
# The engine answers at most this many events at once (EngineServer.MAX_EVENTS).
ENGINE_PAGE = 2000
# A reader is answered at most this many at once.
MAX_PAGE = 500
OBJECT_FIELDS = ("object", "target", "cause")


@dataclass(frozen=True)
class Perspective:
    """Whose eyes: a seat's (a player's, or a replay's), a spectator's, or inspection's."""

    kind: Literal["seat", "spectator", "inspection"]
    seat: int | None = None

    @staticmethod
    def of_seat(seat: int) -> "Perspective":
        return Perspective("seat", seat)

    @staticmethod
    def spectator() -> "Perspective":
        return Perspective("spectator")

    @staticmethod
    def inspection() -> "Perspective":
        return Perspective("inspection")


def sees(seen_by: object, perspective: Perspective) -> bool:
    """Whether the perspective may see an object the engine marked ``seen_by``: "all", or a list of
    seats. Anything else is hidden: an event the filter cannot read shows no identity."""
    if perspective.kind == "inspection":
        return True
    if seen_by == "all":
        return True
    return perspective.kind == "seat" and isinstance(seen_by, list) and perspective.seat in seen_by


def filtered(event: dict[str, Any], perspective: Perspective) -> dict[str, Any]:
    """The event as the perspective may see it. Inspection sees it whole; every other perspective
    sees each object it may see without who else may, and every other object as hidden."""
    if perspective.kind == "inspection":
        return dict(event)
    shown = dict(event)
    for key in OBJECT_FIELDS:
        value = shown.get(key)
        if not isinstance(value, dict) or "seat" in value:
            continue
        if "ref" not in value or not sees(value.get("seen_by"), perspective):
            hidden: dict[str, Any] = {"hidden": True}
            if isinstance(value.get("owner"), int):
                hidden["owner"] = value["owner"]
            shown[key] = hidden
        else:
            shown[key] = {name: part for name, part in value.items() if name != "seen_by"}
    return shown


def filtered_all(
    events: Iterable[dict[str, Any]], perspective: Perspective
) -> list[dict[str, Any]]:
    return [filtered(event, perspective) for event in events]


# Keeping them: the games' hub reads each game's events from the engine as the game goes on.


class EngineRequests(Protocol):
    async def request(
        self,
        method: str,
        path: str,
        *,
        seat_token: str | None = None,
        body: object = None,
        params: dict[str, str | int] | None = None,
        timeout: float = 10.0,
    ) -> tuple[int, Any]: ...


@dataclass
class Cursor:
    """Where a game's events have been read to: the last sequence number kept, and the epoch."""

    next: int = 0
    epoch: int = 0


def cursor_of(db: Session, game_id: UUID) -> Cursor:
    """The cursor as the database has it (after the API's restart)."""
    row = db.execute(
        select(func.max(GameEventRow.seq), func.max(GameEventRow.epoch)).where(
            GameEventRow.game_id == game_id
        )
    ).one()
    return Cursor(int(row[0] or 0), int(row[1] or 0))


def store(database: Engine, game_id: UUID, events: list[dict[str, Any]], replace: bool) -> None:
    """Keeps events, each once by its number. ``replace``: the engine took the game up again and
    made its later events anew, so the events kept so far give way to the engine's whole log."""
    with Session(database) as db, db.begin():
        if replace:
            db.execute(delete(GameEventRow).where(GameEventRow.game_id == game_id))
            kept: set[int] = set()
        else:
            numbers = [int(event["seq"]) for event in events]
            kept = set(
                db.scalars(
                    select(GameEventRow.seq).where(
                        GameEventRow.game_id == game_id, GameEventRow.seq.in_(numbers)
                    )
                )
            )
        for event in events:
            seq = int(event["seq"])
            if seq in kept:
                continue
            kept.add(seq)
            db.add(
                GameEventRow(
                    game_id=game_id,
                    seq=seq,
                    epoch=int(event.get("epoch", 0)),
                    turn=int(event.get("turn", 0)),
                    type=str(event.get("type", ""))[:32],
                    event=event,
                )
            )


async def fetch(
    engine: EngineRequests, game_id: UUID, since: int
) -> tuple[int, list[dict[str, Any]]] | None:
    """Every event after ``since`` and the engine's epoch, page by page; None when the engine
    cannot answer (it is restarting, or the game is gone with its recording)."""
    events: list[dict[str, Any]] = []
    epoch = 0
    while True:
        status, body = await engine.request(
            "GET",
            f"/games/{game_id}/events",
            params={"since": since, "limit": ENGINE_PAGE},
        )
        if status != 200 or not isinstance(body, dict) or not isinstance(body.get("events"), list):
            return None
        epoch = int(body.get("epoch", 0))
        page = [event for event in body["events"] if isinstance(event, dict) and "seq" in event]
        events.extend(page)
        if len(page) < ENGINE_PAGE:
            return epoch, events
        since = int(page[-1]["seq"])


async def sync(engine: EngineRequests, database: Engine, game_id: UUID, cursor: Cursor) -> bool:
    """Reads the game's new events from the engine and keeps them; moves the cursor. Since the
    engine's last epoch, a game taken up again: the whole log is read and replaces what was kept.
    Returns whether the engine answered."""
    answer = await fetch(engine, game_id, cursor.next)
    if answer is None:
        return False
    epoch, events = answer
    replace = epoch != cursor.epoch
    if replace and cursor.next > 0:
        whole = await fetch(engine, game_id, 0)
        if whole is None:
            return False
        epoch, events = whole
    if events or replace:
        await run_in_threadpool(store, database, game_id, events, replace and cursor.next > 0)
    if events:
        cursor.next = int(events[-1]["seq"])
    elif replace:
        cursor.next = 0
    cursor.epoch = epoch
    return True


def sweep(db: Session, now: datetime) -> int:
    """The worker's daily job: the events of games over more than EVENT_RETENTION_DAYS ago (an
    interrupted game counts from its start). Safe to run again: what is gone is gone."""
    cutoff = now - timedelta(days=EVENT_RETENTION_DAYS)
    old = select(Game.id).where(
        Game.status != "active",
        or_(
            Game.finished_at < cutoff,
            Game.finished_at.is_(None) & (Game.created_at < cutoff),
        ),
    )
    result = db.execute(delete(GameEventRow).where(GameEventRow.game_id.in_(old)))
    return int(getattr(result, "rowcount", 0) or 0)


# Reading them.


class EventsPage(BaseModel):
    """A page of a game's events, as the perspective may see them."""

    game_id: UUID
    perspective: Literal["seat", "spectator", "inspection"]
    seat: int | None
    events: list[dict[str, Any]]
    # The last number given, to ask after; the same as asked when there was nothing new.
    next: int


def perspective_for(
    db: Session, principal: Principal, game_id: UUID, inspect: bool
) -> Perspective | None:
    """Who may read a game's events, and through whose eyes: a player of the game, their seat; one
    given access to it, the access's perspective (api/access.py); with ``inspect``, SysOp, or an
    administrator where ``games.concealed_for`` lets them see concealed information. Anyone else
    nothing (None), so that a game's existence is not told either."""
    from api.games import concealed_for  # Imported here: api.games imports this module.

    rows = list(db.scalars(select(GameSeat).where(GameSeat.game_id == game_id)))
    if not rows:
        return None
    if inspect:
        return Perspective.inspection() if concealed_for(principal, rows) else None
    for row in rows:
        if row.user_id == principal.user.id:
            return Perspective.of_seat(row.seat)
    # Access given (v0.9.10, api/access.py), asked now, never kept: a coach shown a seat's hand
    # sees as that seat does while it plays; a replay given sees as its seat did, once the game
    # is over; a spectator sees what every seat may.
    from api import access

    for grant in access.active(db, principal.user.id, "hand", game_id):
        seat = grant.scope.get("seat")
        if isinstance(seat, int):
            return Perspective.of_seat(seat)
    game = db.get(Game, game_id)
    if game is not None and game.status != "active":
        for grant in access.active(db, principal.user.id, "replay", game_id):
            seat = grant.scope.get("seat")
            if isinstance(seat, int):
                return Perspective.of_seat(seat)
    if access.active(db, principal.user.id, "spectator", game_id):
        return Perspective.spectator()
    return None


def read(
    db: Session,
    game_id: UUID,
    perspective: Perspective,
    since: int,
    limit: int,
    turn: int | None = None,
    kind: str | None = None,
) -> list[dict[str, Any]]:
    """The events after ``since`` in order, of one turn or one kind if asked (both indexed)."""
    query = select(GameEventRow.event).where(
        GameEventRow.game_id == game_id, GameEventRow.seq > since
    )
    if turn is not None:
        query = query.where(GameEventRow.turn == turn)
    if kind is not None:
        query = query.where(GameEventRow.type == kind)
    rows = db.scalars(query.order_by(GameEventRow.seq).limit(limit))
    return filtered_all((dict(event) for event in rows), perspective)


@router.get("/games/{game_id}/timeline", response_model=EventsPage)
def game_events(
    game_id: UUID,
    request: Request,
    principal: Active,
    db: Db,
    since: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = MAX_PAGE,
    view: Annotated[Literal["seat", "inspection"], Query()] = "seat",
    turn: Annotated[int | None, Query(ge=0)] = None,
    type: Annotated[str | None, Query(max_length=32)] = None,
) -> EventsPage:
    """A game's structured events after ``since``, oldest first (v0.9.10), of one ``turn`` or one
    ``type`` if asked: a player's own seat's perspective, or with ``view=inspection`` everything,
    for SysOp (and an administrator outside a game they play against people), each reading
    audited. Anyone else is answered 404."""
    perspective = perspective_for(db, principal, game_id, view == "inspection")
    if perspective is None:
        raise ApiError(404, "not_found", "No such game.")
    if perspective.kind == "inspection":
        audit(
            db,
            request,
            "games.events_inspected",
            actor_id=principal.user.id,
            details={"game": str(game_id), "since": since},
        )
        db.commit()
    events = read(db, game_id, perspective, since, limit, turn, type)
    return EventsPage(
        game_id=game_id,
        perspective=perspective.kind,
        seat=perspective.seat,
        events=events,
        next=int(events[-1]["seq"]) if events else since,
    )


def timeline_lines(events: Iterable[dict[str, Any]]) -> list[str]:
    """A developer's timeline (``python -m api.cli timeline``): one line an event, as filtered."""

    def name(value: object) -> str:
        if not isinstance(value, dict):
            return "-"
        if "seat" in value:
            return f"seat {value['seat']}"
        if value.get("hidden"):
            owner = value.get("owner")
            return "a hidden card" + (f" of seat {owner}" if owner is not None else "")
        return f"{value.get('name')} [{value.get('ref')}]"

    lines = []
    for event in events:
        kind = event.get("type")
        head = f"{event.get('seq'):>5}  T{event.get('turn')} {event.get('step') or '-':<22}"
        if kind == "step":
            lines.append(f"{head} -- step (active seat {event.get('active')})")
            continue
        parts = [str(kind)]
        if event.get("player") is not None:
            parts.append(f"seat {event['player']}")
        if "object" in event:
            parts.append(name(event["object"]))
        if kind == "zone_change":
            parts.append(f"{event.get('from')} -> {event.get('to')}")
        if "target" in event:
            parts.append("-> " + name(event["target"]))
        if event.get("amount") is not None:
            parts.append(f"x{event['amount']}")
        if event.get("counter"):
            parts.append(str(event["counter"]))
        if "cause" in event:
            parts.append("(by " + name(event["cause"]) + ")")
        lines.append(f"{head} {' '.join(parts)}")
    return lines


def timeline(database: Engine, game_id: UUID, perspective: Perspective) -> list[str]:
    with Session(database) as db:
        rows = db.scalars(
            select(GameEventRow.event)
            .where(GameEventRow.game_id == game_id)
            .order_by(GameEventRow.seq)
        )
        return timeline_lines(filtered_all((dict(event) for event in rows), perspective))
