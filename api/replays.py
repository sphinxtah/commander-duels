"""Replays and review (v1.0.0, the specification's section 23; docs/replays.md).

A game that is over can be played back and looked into: its structured events (api/events.py),
which every game has kept since v0.9.10, read from the first to the last through one seat's eyes.
**The events are the replay.** Nothing is run again: a bot's decisions are not reproducible, and
the events already say what happened, so a replay needs no engine, no recording and no engine
build, and an upgrade ends none.

- **Whose eyes.** A player of the game replays it through their own seat: what that seat saw, and
  nothing that was hidden from it. A replay shared with an account is read through the sharer's
  seat. There is no other way to read one here; every event leaves through the events' one
  filter (``events.filtered``), whatever is asked for and from whichever number.
- **What it shows** (the owner's decision 23, 2026-11-15): the timeline, played step by step,
  over a scoreboard the reader's page counts from the same events (each player's life, hand,
  battlefield and graveyard). The board itself is not drawn: the events do not hold it. The
  header says what the scoreboard starts from (``starting``): each seat's life and its team.
- **Bookmarks and notes** (``replay_marks``). A reader marks an event with a label and a note,
  and keeps one note on the game as a whole (``seq`` 0). They are the account's alone: no route
  shows them to anyone else, and a shared replay carries none of its sharer's.
- **Sharing** (the owner's decision 24): with friends only, by a grant of access (api/access.py,
  ``replay``, the seat in its scope), given at once and withdrawn by its player whenever they
  like; the friend may give it up too. It ends by itself with the events, when the friendship
  ends in a block, and when either account is gone. The friend is told by a notification.
- **How long.** As long as the events are kept: ``events.EVENT_RETENTION_DAYS`` (90) after the
  game ended. The marks go with them (``sweep``, in the worker's daily job) and with the account;
  a share ends at the same moment (its grant's expiry).

Behind the gate ``replays`` (api/rollout.py): off until SysOp stages it. The timeline itself
(``GET /games/{id}/timeline``) has no gate and stays as it is.
"""

from datetime import datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import Path, Query, Request
from pydantic import Field
from sqlalchemy import delete, exists, func, or_, select
from sqlalchemy.orm import Session

from api import access, events, kings_table, rollout, social, teams
from api.auth import INPUT_ERRORS
from api.events import EventsPage, Perspective
from api.games import campaign_or_none, summary_of
from api.identity import Active, ApiError, Db, Principal, not_found, utcnow
from api.models import (
    AccessGrant,
    Deck,
    DeckRevision,
    Game,
    GameEventRow,
    GameSeat,
    ReplayMark,
    User,
)
from api.schemas import Contract, GameSummary
from api.social import PlayerRef, player_ref

router = rollout.router("replays", prefix="/api/v1", tags=["replays"], responses=INPUT_ERRORS)

# A game that is running or saved is not over: it has a timeline, and no replay yet.
NOT_OVER = ("active", "saved")
# How many bookmarks an account keeps on one game, and how many friends one replay is shared with.
MARK_LIMIT = 50
SHARE_LIMIT = 20
LABEL_MAX = 80
NOTE_MAX = 2000
LIST_MAX = 100
# No game has this many events; a number past it names none.
MAX_SEQ = 10_000_000

# Each format's starting life, as the engine deals it (engine/GameFormat.java, LegacyDuel.java);
# King's Table's is its settings' (api/kings_table.py).
STARTING_LIFE = {"legacy": 20, "commander": 40, teams.FORMAT: 30}


class ReplayStart(Contract):
    """What a seat starts the game with, for the scoreboard."""

    seat: int
    life: int
    team: int | None = Field(
        description="Two-Headed Giant and King's Table: the seat's team. In Two-Headed Giant a "
        "team has one life total, so a life change of either player is the team's."
    )
    shared_life: bool = Field(description="Whether the seat's life total is its team's.")


class ReplayThrough(Contract):
    """Whose eyes the replay is read through."""

    seat: int
    yours: bool = Field(description="The reader's own seat; false for a replay shared with them.")
    shared_by: PlayerRef | None = Field(description="Who shared it, for a shared replay.")
    grant_id: UUID | None = Field(
        description="A shared replay's grant, which its reader may give up."
    )


class ReplayDeck(Contract):
    """The deck the replay's seat played, as it was when the game began."""

    title: str
    version: int | None = Field(
        description="The saved version played; null for a deck that has none (a bot's, a "
        "starter's list, a deck list pasted for one game)."
    )
    deck_id: UUID | None = Field(
        description="The deck, when it is the reader's own and still there: to open it."
    )


class ReplayMarkView(Contract):
    seq: int = Field(description="The marked event's number.")
    turn: int | None
    label: str
    note: str
    updated_at: datetime


class ReplayShare(Contract):
    id: UUID
    player: PlayerRef
    shared_at: datetime


class Replay(Contract):
    """A replay's header: everything but its events."""

    game: GameSummary
    through: ReplayThrough
    deck: ReplayDeck | None
    starting: list[ReplayStart]
    events: int = Field(description="The last event's number: how long the replay is.")
    turns: int = Field(description="The game's last turn.")
    kept_until: datetime = Field(
        description="When the replay goes: its events are kept 90 days after the game."
    )
    marks: list[ReplayMarkView] = Field(description="The reader's own bookmarks, in order.")
    note: str = Field(description="The reader's own note on the game.")
    shares: list[ReplayShare] = Field(
        description="The friends the reader shared their own replay with; empty for a shared one."
    )


class ReplayEntry(Contract):
    """A replay in the account's list."""

    game: GameSummary
    through: ReplayThrough
    kept_until: datetime
    turns: int
    marks: int = Field(description="How many bookmarks the reader keeps on it.")
    noted: bool = Field(description="Whether the reader keeps a note on it.")
    shares: int = Field(description="How many friends the reader shared it with.")


class ReplayList(Contract):
    own: list[ReplayEntry] = Field(description="Games the account played, newest first.")
    shared: list[ReplayEntry] = Field(description="Replays friends shared with it, newest first.")
    more: bool = Field(description="Whether older games of its own were left out.")


class MarkBody(Contract):
    label: str = Field(default="", max_length=LABEL_MAX)
    note: str = Field(default="", max_length=NOTE_MAX)


class ShareBody(Contract):
    player_id: UUID


def kept_until(game: Game) -> datetime:
    """When the game's events go (events.sweep): an interrupted game counts from its start."""
    return (game.finished_at or game.created_at) + timedelta(days=events.EVENT_RETENTION_DAYS)


def starting(game: Game, rows: list[GameSeat]) -> list[ReplayStart]:
    kings = kings_table.config_of(game.kings_table) if game.format == kings_table.FORMAT else None
    found = []
    for row in rows:
        if kings is not None:
            life, team, shared = (
                kings_table.starting_life(kings, row.seat),
                kings_table.team_of(row.seat),
                False,
            )
        elif game.format == teams.FORMAT:
            life, team, shared = STARTING_LIFE[teams.FORMAT], row.seat // 2, True
        else:
            life, team, shared = STARTING_LIFE.get(game.format, 20), None, False
        found.append(ReplayStart(seat=row.seat, life=life, team=team, shared_life=shared))
    return found


def shared_with(db: Session, user_id: UUID, game_id: UUID | None = None) -> list[AccessGrant]:
    """The replays shared with the account that work now (access.active decides), newest first."""
    query = select(AccessGrant.resource_id).where(
        AccessGrant.subject_id == user_id,
        AccessGrant.resource_kind == "replay",
        AccessGrant.revoked_at.is_(None),
        AccessGrant.resource_id.is_not(None),
    )
    if game_id is not None:
        query = query.where(AccessGrant.resource_id == game_id)
    grants: list[AccessGrant] = []
    for resource in dict.fromkeys(db.scalars(query)):
        grants.extend(access.active(db, user_id, "replay", resource))
    return sorted(grants, key=lambda grant: grant.created_at, reverse=True)


class Reading:
    """A replay as one account reads it: the game, its seats, and the seat it is read through."""

    def __init__(
        self, game: Game, rows: list[GameSeat], seat: int, grant: AccessGrant | None
    ) -> None:
        self.game = game
        self.rows = rows
        self.seat = seat
        self.grant = grant

    @property
    def perspective(self) -> Perspective:
        return Perspective.of_seat(self.seat)


def reading(db: Session, principal: Principal, game_id: UUID, shared_by: UUID | None) -> Reading:
    """The replay the caller may read, or 404 as for a game that does not exist: their own
    seat's, or with ``shared_by`` the one that player shared with them. A game that is not over
    has no replay: its own player is told so, anyone else nothing."""
    game = db.get(Game, game_id)
    rows = list(
        db.scalars(select(GameSeat).where(GameSeat.game_id == game_id).order_by(GameSeat.seat))
    )
    if game is None or not rows:
        raise not_found()
    own = next((row.seat for row in rows if row.user_id == principal.user.id), None)
    if shared_by is None and own is not None:
        if game.status in NOT_OVER:
            raise ApiError(
                409, "replay_not_ready", "A replay is of a game that is over. This one is not."
            )
        return Reading(game, rows, own, None)
    if game.status not in NOT_OVER:
        for grant in shared_with(db, principal.user.id, game_id):
            seat = grant.scope.get("seat")
            if isinstance(seat, int) and (shared_by is None or grant.grantor_id == shared_by):
                return Reading(game, rows, seat, grant)
    raise not_found()


def through_of(db: Session, found: Reading) -> ReplayThrough:
    sharer = db.get(User, found.grant.grantor_id) if found.grant is not None else None
    return ReplayThrough(
        seat=found.seat,
        yours=found.grant is None,
        shared_by=player_ref(sharer) if sharer is not None else None,
        grant_id=found.grant.id if found.grant is not None else None,
    )


def deck_of(db: Session, found: Reading, reader: UUID) -> ReplayDeck | None:
    row = next((row for row in found.rows if row.seat == found.seat), None)
    if row is None:
        return None
    revision = db.get(DeckRevision, row.deck_revision_id) if row.deck_revision_id else None
    if revision is None:
        return ReplayDeck(title=row.deck, version=None, deck_id=None)
    deck = db.get(Deck, revision.deck_id)
    yours = deck is not None and deck.owner_id == reader and deck.deleted_at is None
    return ReplayDeck(
        title=revision.title,
        version=revision.number,
        deck_id=revision.deck_id if yours else None,
    )


def length_of(db: Session, game_id: UUID) -> tuple[int, int]:
    """The last event's number and the last turn; zeros for a game whose events are gone."""
    row = db.execute(
        select(func.max(GameEventRow.seq), func.max(GameEventRow.turn)).where(
            GameEventRow.game_id == game_id
        )
    ).one()
    return int(row[0] or 0), int(row[1] or 0)


def marks_of(db: Session, user_id: UUID, game_id: UUID) -> list[ReplayMark]:
    return list(
        db.scalars(
            select(ReplayMark)
            .where(ReplayMark.user_id == user_id, ReplayMark.game_id == game_id)
            .order_by(ReplayMark.seq)
        )
    )


def shares_of(db: Session, user_id: UUID, game_id: UUID, now: datetime) -> list[AccessGrant]:
    """The grants by which the account shares its replay of the game now."""
    return list(
        db.scalars(
            select(AccessGrant)
            .where(
                AccessGrant.grantor_id == user_id,
                AccessGrant.resource_kind == "replay",
                AccessGrant.resource_id == game_id,
                AccessGrant.revoked_at.is_(None),
                or_(AccessGrant.expires_at.is_(None), AccessGrant.expires_at > now),
            )
            .order_by(AccessGrant.created_at)
        )
    )


def share_views(db: Session, grants: list[AccessGrant]) -> list[ReplayShare]:
    users = {
        user.id: user
        for user in db.scalars(
            select(User).where(User.id.in_([grant.subject_id for grant in grants]))
        )
    }
    return [
        ReplayShare(
            id=grant.id, player=player_ref(users[grant.subject_id]), shared_at=grant.created_at
        )
        for grant in grants
        if grant.subject_id in users
    ]


def view_of(db: Session, request: Request, principal: Principal, found: Reading) -> Replay:
    marks = marks_of(db, principal.user.id, found.game.id)
    last, turns = length_of(db, found.game.id)
    shares = (
        shares_of(db, principal.user.id, found.game.id, utcnow()) if found.grant is None else []
    )
    return Replay(
        game=summary_of(db, found.game, principal, campaign_or_none(request)),
        through=through_of(db, found),
        deck=deck_of(db, found, principal.user.id),
        starting=starting(found.game, found.rows),
        events=last,
        turns=turns,
        kept_until=kept_until(found.game),
        marks=[
            ReplayMarkView(
                seq=mark.seq,
                turn=mark.turn,
                label=mark.label,
                note=mark.note,
                updated_at=mark.updated_at,
            )
            for mark in marks
            if mark.seq > 0
        ],
        note=next((mark.note for mark in marks if mark.seq == 0), ""),
        shares=share_views(db, shares),
    )


def entry_of(
    db: Session, request: Request, principal: Principal, found: Reading, now: datetime
) -> ReplayEntry:
    marks = marks_of(db, principal.user.id, found.game.id)
    return ReplayEntry(
        game=summary_of(db, found.game, principal, campaign_or_none(request)),
        through=through_of(db, found),
        kept_until=kept_until(found.game),
        turns=length_of(db, found.game.id)[1],
        marks=sum(1 for mark in marks if mark.seq > 0),
        noted=any(mark.seq == 0 and mark.note for mark in marks),
        shares=len(shares_of(db, principal.user.id, found.game.id, now))
        if found.grant is None
        else 0,
    )


@router.get("/replays", response_model=ReplayList)
def list_replays(
    request: Request,
    principal: Active,
    db: Db,
    limit: Annotated[int, Query(ge=1, le=LIST_MAX)] = 30,
) -> ReplayList:
    """The replays the account may read: of the games it played that are over and still have
    their events, newest first, and the ones friends shared with it."""
    now = utcnow()
    # By the events' own key, game by game: never a pass over every game's events.
    kept = exists().where(GameEventRow.game_id == Game.id)
    games = list(
        db.scalars(
            select(Game)
            .where(
                Game.id.in_(select(GameSeat.game_id).where(GameSeat.user_id == principal.user.id)),
                Game.status.not_in(NOT_OVER),
                kept,
            )
            .order_by(func.coalesce(Game.finished_at, Game.created_at).desc())
            .limit(limit + 1)
        )
    )
    own = []
    for game in games[:limit]:
        rows = list(
            db.scalars(select(GameSeat).where(GameSeat.game_id == game.id).order_by(GameSeat.seat))
        )
        seat = next(row.seat for row in rows if row.user_id == principal.user.id)
        own.append(entry_of(db, request, principal, Reading(game, rows, seat, None), now))
    shared = []
    for grant in shared_with(db, principal.user.id):
        theirs = db.get(Game, grant.resource_id)
        through = grant.scope.get("seat")
        if theirs is None or theirs.status in NOT_OVER or not isinstance(through, int):
            continue
        rows = list(
            db.scalars(
                select(GameSeat).where(GameSeat.game_id == theirs.id).order_by(GameSeat.seat)
            )
        )
        shared.append(entry_of(db, request, principal, Reading(theirs, rows, through, grant), now))
    return ReplayList(own=own, shared=shared, more=len(games) > limit)


@router.get("/games/{game_id}/replay", response_model=Replay)
def read_replay(
    game_id: UUID,
    request: Request,
    principal: Active,
    db: Db,
    shared_by: Annotated[UUID | None, Query()] = None,
) -> Replay:
    """A replay's header: the game, whose eyes it is read through, the deck played, what the
    scoreboard starts from, how long it is and until when it is kept, and the reader's own
    bookmarks, note and shares. Your own seat's, or with ``shared_by`` the replay that player
    shared with you. Anyone else is answered 404."""
    return view_of(db, request, principal, reading(db, principal, game_id, shared_by))


@router.get("/games/{game_id}/replay/events", response_model=EventsPage)
def replay_events(
    game_id: UUID,
    principal: Active,
    db: Db,
    shared_by: Annotated[UUID | None, Query()] = None,
    since: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=events.MAX_PAGE)] = events.MAX_PAGE,
) -> EventsPage:
    """The replay's events after ``since``, oldest first, through the replay's seat: the one
    filter every reading of a game's events goes through, so that neither sharing nor seeking
    shows more than that seat saw."""
    found = reading(db, principal, game_id, shared_by)
    page = events.read(db, game_id, found.perspective, since, limit)
    turns = events.turn_owners(db, game_id, {int(event.get("turn", 0)) for event in page.events})
    return EventsPage(
        game_id=game_id,
        perspective="seat",
        seat=found.seat,
        events=page.events,
        next=max(since, page.last_read),
        first=int(page.events[0]["seq"]) if page.events else 0,
        more=page.more,
        turns=turns,
    )


@router.put("/games/{game_id}/replay/marks/{seq}", response_model=Replay)
def put_mark(
    game_id: UUID,
    seq: Annotated[int, Path(ge=0, le=MAX_SEQ)],
    body: MarkBody,
    request: Request,
    principal: Active,
    db: Db,
    shared_by: Annotated[UUID | None, Query()] = None,
) -> Replay:
    """Keeps the reader's bookmark at an event, with its label and its note, or changes it; at 0,
    the reader's note on the game as a whole, which an empty note removes. Their own, on any
    replay they may read, and nobody else's to see."""
    found = reading(db, principal, game_id, shared_by)
    label, note = body.label.strip(), body.note.strip()
    turn = None
    if seq > 0:
        turn = db.scalar(
            select(GameEventRow.turn).where(
                GameEventRow.game_id == game_id, GameEventRow.seq == seq
            )
        )
        if turn is None:
            raise ApiError(404, "no_such_event", "The replay has no such event.")
    stamp = utcnow()
    mark = db.scalar(
        select(ReplayMark).where(
            ReplayMark.user_id == principal.user.id,
            ReplayMark.game_id == game_id,
            ReplayMark.seq == seq,
        )
    )
    if seq == 0 and not note:
        if mark is not None:
            db.delete(mark)
    elif mark is None:
        kept = db.scalar(
            select(func.count())
            .select_from(ReplayMark)
            .where(
                ReplayMark.user_id == principal.user.id,
                ReplayMark.game_id == game_id,
                ReplayMark.seq > 0,
            )
        )
        if seq > 0 and int(kept or 0) >= MARK_LIMIT:
            raise ApiError(
                409, "mark_limit", f"A replay holds {MARK_LIMIT} bookmarks. Remove one first."
            )
        db.add(
            ReplayMark(
                user_id=principal.user.id,
                game_id=game_id,
                seq=seq,
                turn=turn,
                label=label if seq > 0 else "",
                note=note,
                created_at=stamp,
                updated_at=stamp,
            )
        )
    else:
        mark.label, mark.note, mark.updated_at = (label if seq > 0 else ""), note, stamp
    db.commit()
    return view_of(db, request, principal, found)


@router.delete("/games/{game_id}/replay/marks/{seq}", response_model=Replay)
def delete_mark(
    game_id: UUID,
    seq: Annotated[int, Path(ge=0, le=MAX_SEQ)],
    request: Request,
    principal: Active,
    db: Db,
    shared_by: Annotated[UUID | None, Query()] = None,
) -> Replay:
    """Removes the reader's bookmark at an event (or, at 0, their note on the game). Removing
    what is not there changes nothing."""
    found = reading(db, principal, game_id, shared_by)
    db.execute(
        delete(ReplayMark).where(
            ReplayMark.user_id == principal.user.id,
            ReplayMark.game_id == game_id,
            ReplayMark.seq == seq,
        )
    )
    db.commit()
    return view_of(db, request, principal, found)


def own_replay(db: Session, principal: Principal, game_id: UUID) -> Reading:
    """The caller's own replay of the game: only a seat's own player shares it."""
    found = reading(db, principal, game_id, None)
    if found.grant is not None:
        raise not_found()
    return found


@router.post("/games/{game_id}/replay/shares", response_model=Replay)
def share_replay(
    game_id: UUID, body: ShareBody, request: Request, principal: Active, db: Db
) -> Replay:
    """Shares the caller's replay of a game they played with a friend: the game through the
    caller's own seat, their hand as they saw it, until the replay goes or they take it back.
    Friends only (the owner's decision, 2026-11-15). Sharing twice shares once."""
    found = own_replay(db, principal, game_id)
    now = utcnow()
    until = kept_until(found.game)
    if until <= now or length_of(db, game_id)[0] == 0:
        raise ApiError(409, "replay_gone", "This game's events are no longer kept.")
    friend = db.get(User, body.player_id)
    friendly = friend is not None and db.scalar(
        select(User.id).where(User.id == friend.id, social.befriended(principal.user.id, User.id))
    )
    if friend is None or not friendly:
        raise ApiError(403, "not_a_friend", "A replay is shared with a friend.")
    shares = shares_of(db, principal.user.id, game_id, now)
    if not any(grant.subject_id == friend.id for grant in shares):
        if len(shares) >= SHARE_LIMIT:
            raise ApiError(
                409,
                "share_limit",
                f"A replay is shared with at most {SHARE_LIMIT} friends. Take one back first.",
            )
        access.offer(
            db,
            principal.user,
            friend,
            "replay",
            game_id,
            scope={"seat": found.seat},
            expires_at=until,
            now=now,
        )
        social.notify(db, friend.id, "replay_shared", principal.user.id, now, game_id=game_id)
    db.commit()
    return view_of(db, request, principal, found)


@router.delete("/games/{game_id}/replay/shares/{grant_id}", status_code=204)
def unshare_replay(game_id: UUID, grant_id: UUID, principal: Active, db: Db) -> None:
    """Ends a share: its player takes it back, or the friend it was shared with gives it up.
    From then on the friend reads nothing of it. Ending what has ended changes nothing."""
    grant = db.get(AccessGrant, grant_id)
    if (
        grant is None
        or grant.resource_kind != "replay"
        or grant.resource_id != game_id
        or principal.user.id not in (grant.grantor_id, grant.subject_id)
    ):
        raise not_found()
    access.revoke(db, grant, principal.user)
    db.commit()


def sweep(db: Session, now: datetime) -> int:
    """The worker's daily job, beside the events' own (events.sweep): the marks on games whose
    events are past their time. Safe to run again."""
    cutoff = now - timedelta(days=events.EVENT_RETENTION_DAYS)
    old = select(Game.id).where(
        Game.status.not_in(NOT_OVER),
        or_(
            Game.finished_at < cutoff,
            Game.finished_at.is_(None) & (Game.created_at < cutoff),
        ),
    )
    result = db.execute(delete(ReplayMark).where(ReplayMark.game_id.in_(old)))
    return int(getattr(result, "rowcount", 0) or 0)
