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

Kept ``EVENT_RETENTION_DAYS`` after the game ended (90 days: assumed on 2026-11-12, the owner's
decision on 2026-11-14), then removed by the worker's daily job (``sweep``).

Since v1.0.0 the timeline's screen reads them (docs/timeline.md): the newest first or from a
number on, of some kinds, of one seat, or naming a card. Every such narrowing that could tell what
a reader may not see (a name, a seat's own card) is applied to the events as the reader sees them,
never to the rows, so that asking for "Counterspell" finds no card that is hidden from the asker.
A running game's newest events are read from the engine as the timeline is asked for.
"""

import logging
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import partial
from typing import Annotated, Any, Literal, Protocol
from uuid import UUID

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel
from sqlalchemy import Engine, delete, func, or_, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api import metrics
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


def shown_object(value: object, perspective: Perspective) -> object:
    """An event's object as the perspective may see it: itself without who else may see it, or
    hidden. A seat (``{"seat": n}``) and anything that is no object are everyone's."""
    if not isinstance(value, dict) or "seat" in value:
        return value
    if "ref" not in value or not sees(value.get("seen_by"), perspective):
        hidden: dict[str, Any] = {"hidden": True}
        if isinstance(value.get("owner"), int):
            hidden["owner"] = value["owner"]
        return hidden
    return {name: part for name, part in value.items() if name != "seen_by"}


def filtered(event: dict[str, Any], perspective: Perspective) -> dict[str, Any]:
    """The event as the perspective may see it. Inspection sees it whole; every other perspective
    sees each object it may see without who else may, and every other object as hidden: the
    event's own (``object``, ``target``, ``cause``) and, since the events' version 2, the sources
    of what changed a cast's cost (``cost.changes[].by``)."""
    if perspective.kind == "inspection":
        return dict(event)
    shown = dict(event)
    for key in OBJECT_FIELDS:
        if key in shown:
            shown[key] = shown_object(shown[key], perspective)
    cost = shown.get("cost")
    if isinstance(cost, dict) and isinstance(cost.get("changes"), list):
        shown["cost"] = {
            **cost,
            "changes": [
                {**change, "by": shown_object(change["by"], perspective)}
                if isinstance(change, dict) and "by" in change
                else change
                for change in cost["changes"]
            ],
        }
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
        # A saved game (v1.0.0) is not over: its events wait with it.
        Game.status.not_in(("active", "saved")),
        or_(
            Game.finished_at < cutoff,
            Game.finished_at.is_(None) & (Game.created_at < cutoff),
        ),
    )
    result = db.execute(delete(GameEventRow).where(GameEventRow.game_id.in_(old)))
    return int(getattr(result, "rowcount", 0) or 0)


# Reading them.


class EventsPage(BaseModel):
    """A page of a game's events, as the perspective may see them, oldest first."""

    game_id: UUID
    perspective: Literal["seat", "spectator", "inspection"]
    seat: int | None
    events: list[dict[str, Any]]
    # The number to ask after for what follows: the last one given, or, when the page was not
    # filled, the last one looked at; the same as asked when there was nothing new.
    next: int
    # Since v1.0.0. The lowest number given, to ask before for what came earlier; 0 with no event.
    first: int = 0
    # Whether events that fit were left out of the page: later ones, or with ``before`` earlier.
    more: bool = False
    # Whose turn each turn of the page's events was: the turn's number to its active seat. A
    # narrowed page holds no steps of its own to tell.
    turns: dict[int, int] = {}


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
    if game is not None and game.status not in ("active", "saved"):
        for grant in access.active(db, principal.user.id, "replay", game_id):
            seat = grant.scope.get("seat")
            if isinstance(seat, int):
                return Perspective.of_seat(seat)
    if access.active(db, principal.user.id, "spectator", game_id):
        return Perspective.spectator()
    return None


def names_in(event: dict[str, Any]) -> list[str]:
    """The names an event shows: of its objects, and of what changed a cast's cost."""
    values = [event.get(key) for key in OBJECT_FIELDS]
    cost = event.get("cost")
    if isinstance(cost, dict) and isinstance(cost.get("changes"), list):
        values += [change.get("by") for change in cost["changes"] if isinstance(change, dict)]
    return [
        value["name"]
        for value in values
        if isinstance(value, dict) and isinstance(value.get("name"), str)
    ]


def involves(event: dict[str, Any], seat: int) -> bool:
    """Whether the event is the seat's: it did it, it happened to the seat, or to a card of the
    seat's (whose it is is told of a hidden card too, as at a table)."""
    if event.get("player") == seat:
        return True
    for key in OBJECT_FIELDS:
        value = event.get(key)
        if isinstance(value, dict) and (value.get("seat") == seat or value.get("owner") == seat):
            return True
    return False


@dataclass(frozen=True)
class Page:
    """What a reading found: the events, where it stopped, and whether more fit."""

    events: list[dict[str, Any]]
    last_read: int
    more: bool


# How many rows a narrowed reading takes from the database at once.
READ_CHUNK = 500


def read(
    db: Session,
    game_id: UUID,
    perspective: Perspective,
    since: int,
    limit: int,
    turn: int | None = None,
    kinds: Iterable[str] | None = None,
    *,
    before: int | None = None,
    seat: int | None = None,
    text: str | None = None,
) -> Page:
    """The events after ``since`` in order, or with ``before`` the last ones before that number
    (still oldest first): of one turn or of some kinds if asked (both indexed), of one seat, or
    naming ``text``. The seat and the text are judged on each event as the perspective sees it:
    a hidden card's name finds nothing."""
    query = select(GameEventRow.event).where(GameEventRow.game_id == game_id)
    if turn is not None:
        query = query.where(GameEventRow.turn == turn)
    wanted = sorted(set(kinds)) if kinds is not None else []
    if wanted:
        query = query.where(GameEventRow.type.in_(wanted))
    backwards = before is not None
    needle = text.casefold().strip() if text else ""
    # Narrowed by what only the shown event tells, a page may need many rows; otherwise one more
    # than the page says whether there is more.
    size = READ_CHUNK if seat is not None or needle else limit + 1
    found: list[dict[str, Any]] = []
    edge = before if before is not None else since
    last_read = edge
    more = False
    while not more:
        if backwards:
            chunk = query.where(GameEventRow.seq < edge).order_by(GameEventRow.seq.desc())
        else:
            chunk = query.where(GameEventRow.seq > edge).order_by(GameEventRow.seq)
        rows: list[dict[str, Any]] = [dict(event) for event in db.scalars(chunk.limit(size))]
        for event in filtered_all(rows, perspective):
            if seat is not None and not involves(event, seat):
                continue
            if needle and not any(needle in name.casefold() for name in names_in(event)):
                continue
            if len(found) == limit:
                more = True
                break
            found.append(event)
            last_read = int(event["seq"])
        else:
            if rows:
                edge = last_read = int(rows[-1]["seq"])
        if len(rows) < size:
            break
    if backwards:
        found.reverse()
    return Page(found, last_read, more)


def turn_owners(db: Session, game_id: UUID, turns: Iterable[int]) -> dict[int, int]:
    """Whose turn each of the turns was: the active seat of its steps (public, as at a table)."""
    wanted = sorted(set(turns))
    owners: dict[int, int] = {}
    if not wanted:
        return owners
    rows = db.execute(
        select(GameEventRow.turn, GameEventRow.event)
        .where(
            GameEventRow.game_id == game_id,
            GameEventRow.type == "step",
            GameEventRow.turn.in_(wanted),
        )
        .order_by(GameEventRow.seq)
    )
    for turn, event in rows:
        active = event.get("active") if isinstance(event, dict) else None
        if isinstance(active, int):
            # A turn's later steps stand: an extra turn's controller is the last to be named.
            owners[int(turn)] = active
    return owners


def viewer(
    db: Session, request: Request, principal: Principal, game_id: UUID, inspect: bool, since: int
) -> Perspective:
    """The eyes a timeline is read through, or 404; an inspection is audited."""
    perspective = perspective_for(db, principal, game_id, inspect)
    if perspective is None:
        if db.scalar(select(GameSeat.seat).where(GameSeat.game_id == game_id).limit(1)) is not None:
            # The game exists and the caller has no view of it; answered as a missing game all
            # the same.
            metrics.count("access.refused", code="no_view_of_game")
        raise ApiError(404, "not_found", "No such game.")
    if perspective.kind == "inspection":
        audit(
            db,
            request,
            "games.events_inspected",
            actor_id=principal.user.id,
            details={"game": str(game_id), "since": since},
        )
    # No pooled connection is held while the engine is asked for the game's newest events.
    db.commit()
    return perspective


@router.get("/games/{game_id}/timeline", response_model=EventsPage)
async def game_events(
    game_id: UUID,
    request: Request,
    principal: Active,
    db: Db,
    since: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE)] = MAX_PAGE,
    view: Annotated[Literal["seat", "inspection"], Query()] = "seat",
    turn: Annotated[int | None, Query(ge=0)] = None,
    type: Annotated[str | None, Query(max_length=400)] = None,
    before: Annotated[int | None, Query(ge=1)] = None,
    seat: Annotated[int | None, Query(ge=0, le=7)] = None,
    q: Annotated[str | None, Query(max_length=80)] = None,
) -> EventsPage:
    """A game's structured events, oldest first (v0.9.10): after ``since``, or since v1.0.0 the
    last ones ``before`` a number; of one ``turn``, of the ``type``s named (one, or several with
    commas), of one ``seat``, or naming a card (``q``, part of a name the reader may see). A
    player's own seat's perspective, or with ``view=inspection`` everything, for SysOp (and an
    administrator outside a game they play against people), each reading audited. Anyone else is
    answered 404. A running game's events are read from the engine first, so that the page holds
    what has just happened."""
    perspective = await run_in_threadpool(
        viewer, db, request, principal, game_id, view == "inspection", since
    )
    hub = getattr(request.app.state, "games", None)
    if hub is not None:
        await hub.events_fresh(game_id)
    kinds = [kind for kind in (type or "").split(",") if kind]
    page = await run_in_threadpool(
        partial(
            read,
            db,
            game_id,
            perspective,
            since,
            limit,
            turn,
            kinds,
            before=before,
            seat=seat,
            text=q,
        )
    )
    events = page.events
    turns = await run_in_threadpool(
        turn_owners, db, game_id, {int(event.get("turn", 0)) for event in events}
    )
    return EventsPage(
        game_id=game_id,
        perspective=perspective.kind,
        seat=perspective.seat,
        events=events,
        next=since if before is not None else max(since, page.last_read),
        first=int(events[0]["seq"]) if events else 0,
        more=page.more,
        turns=turns,
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
        if isinstance(event.get("cost"), dict):
            cost = event["cost"]
            parts.append(f"for {cost.get('paid')}")
            for change in cost.get("changes") or []:
                by = "commander tax" if change.get("tax") else name(change.get("by"))
                parts.append(f"[{change.get('how')}: {by}]")
        if event.get("why"):
            parts.append(f"<{event['why']}>")
        if event.get("immediate"):
            parts.append("(immediate)")
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
