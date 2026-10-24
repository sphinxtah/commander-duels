"""Public queues (v0.5.0): players find a game without an invite. docs/queues.md describes them.

- **The queues.** One for each format and size (QUEUES): Legacy for two, best of one or best of
  three (api/matches.py), and Commander for two, three or four seats, each size its own queue. A
  queue is a key, (format, seats, best_of). Casual only: no rating, and every game takes the
  casual table's rules (banned cards and cards not legal in the format both allowed).
- **Joining.** A player joins one queue with one of their decks, checked as a table checks it,
  and may choose to wait for players only. A player waits in one queue at a time, and never while
  they sit at an open table (a table refuses a player who waits in a queue, too); joining needs
  room under the account's limit of running games (CD_GAMES_PER_ACCOUNT; SysOp has none). They
  may leave at any time.
- **Matching** runs when a player joins and on a tick in this process (TICK_SECONDS; the API
  runs as one process), one queue at a time under its lock. A queue with as many players waiting
  as it has seats seats the first of them, in the order they joined. Once a player who takes bots
  has waited BOT_WAIT with too few players, every player waiting who takes bots is seated, and
  bots fill the empty seats; a player who chose players only keeps waiting. Claiming the players
  marks their rows starting, in one transaction that locks them (FOR UPDATE) and counts what its
  update changed, so two matches never seat a player twice.
- **The game.** Two players or more make a table's game through the human tables' path: a table
  started at once, marked queued and never listed, with a seat each (tables.add_table_game), so
  the table chat, alliances, away players and votes, concessions, wins and tokens are those of any
  table. A player alone with bots plays a practice game, which records its request for a rematch.
  Bots play at BOT_SKILL, the practice table's and the lobby's default, with the starter decks in
  Commander. Every deck and every player's limit is checked again as the game starts: a player
  they stop is taken out of the queue with the reason, and the others wait on in their places.
- **Following.** The player's app asks about their place every few seconds (GET /queue); the
  answer names the game once it starts, and the app follows into it. A player whose app has not
  asked for STALE_AFTER has closed it, and is taken out.
- **Two-Headed Giant** (v0.5.1): a queue of its own, with Legacy decks, whose teams form solo or
  with a friend. A player alone is paired with another player alone whose deck shares no card
  with theirs (Unified Deck Construction, api/teams.py); a player may instead invite a friend, and
  once the friend accepts with a deck of their own (the two checked together) they wait as one
  team, which is never split: when one of them leaves, or is taken out, so is the other. The bell
  tells the friend of the invitation (team_invite), which ends if the two stop being friends (a
  friendship ended, or a block). Two teams make a full table; after BOT_WAIT bots fill a team's
  empty seat and the other team's. Its games are a Two-Headed Giant table's, with the team's
  fixed channel in the chat (api/table_chat.py).

Without games set up (no CD_ENGINE_SERVICE_TOKEN, development only), players may join and wait,
but no game starts.
"""

import asyncio
import logging
import random
import secrets
from collections import defaultdict
from collections.abc import Callable
from contextlib import AsyncExitStack, suppress
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from functools import partial
from typing import Literal, NamedTuple, cast
from uuid import UUID

from fastapi import APIRouter, FastAPI, Request
from pydantic import Field
from sqlalchemy import ColumnElement, Engine, and_, func, or_, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api import matches, teams
from api.auth import INPUT_ERRORS
from api.custom_play import custom_in_seats
from api.decks import starters_of
from api.games import (
    DECK_FORMATS,
    FORMAT_NAMES,
    TABLE_IDLE_SECONDS,
    EngineUnavailable,
    GameHub,
    LiveGame,
    LiveSeat,
    Player,
    SeatPlan,
    active_games_of,
    engine_game,
    full_access,
    own_deck,
    require_loaded,
    retried,
    starter_seat,
)
from api.identity import (
    ApiError,
    Db,
    Principal,
    not_found,
    permissions_for,
    roles_of,
    settings_of,
    utcnow,
)
from api.library import library_of
from api.models import (
    CatalogRevision,
    Deck,
    FormatVersion,
    Game,
    GameSeat,
    GameTable,
    Notification,
    QueueEntry,
    TableSeat,
    User,
)
from api.roster import roster_of
from api.schemas import (
    BEST_OF_TEXT,
    BestOf,
    Contract,
    Error,
    PracticeGameRequest,
    SeatChoice,
    TableFormatId,
    casual,
)
from api.tables import add_table_game, check_deck, open_table_of, shared_with, team_cards

log = logging.getLogger("api.queues")
router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)


class QueueKey(NamedTuple):
    """A public queue: its format, its seats, and in Legacy how many games its match is the best
    of."""

    format: str
    seats: int
    best_of: int = 1


TEAM_FORMAT = teams.FORMAT
QUEUES = (
    QueueKey("legacy", 2),
    QueueKey("legacy", 2, 3),
    QueueKey("commander", 2),
    QueueKey("commander", 3),
    QueueKey("commander", 4),
    # Two teams of two (v0.5.1), formed alone or with a friend.
    QueueKey(TEAM_FORMAT, teams.SEATS),
)
# A player who takes bots, waiting this long with too few players, gets bots in the empty seats.
BOT_WAIT = timedelta(seconds=60)
# A player whose app has not asked about their place for this long has closed it. The app asks
# every few seconds; a hidden tab's timers may run only once a minute.
STALE_AFTER = timedelta(seconds=150)
# How often the process looks for a match in every queue with players waiting.
TICK_SECONDS = 2.0
# The bots' skill, and the turn cap: the defaults of the practice table and the lobby.
BOT_SKILL = 4
TURN_CAP = 60
# A row in either is the player's place in line: starting is a place a match has claimed.
WAITING = ("waiting", "starting")
# A row in any is the player's place in a queue, an invitation to a friend (v0.5.1) included.
HELD = ("inviting", *WAITING)
GONE = "You left the queue: your app stopped asking about your place."
BUSY = "Every game slot is in use. Your game starts as soon as one frees up."
SILENT = "The rules engine is not answering. Your game starts once it does."


class QueueRequest(Contract):
    """A place in a queue, with one of your decks."""

    format: TableFormatId = "legacy"
    seats: int = Field(
        default=2,
        ge=2,
        le=4,
        description="2 in Legacy; 2, 3 or 4 in Commander, each size its own queue; 4 in "
        "Two-Headed Giant.",
    )
    deck_id: UUID = Field(description="One of your decks, in the queue's format.")
    humans_only: bool = Field(
        default=False, description="Wait for players only: bots never fill your game."
    )
    best_of: BestOf = Field(default=1, description=BEST_OF_TEXT)
    partner_id: UUID | None = Field(
        default=None,
        description="Two-Headed Giant (v0.5.1): a friend you invite to wait with you as a team. "
        "You are inviting until they accept; left out, the queue pairs you with another player.",
    )


class TeamDeck(Contract):
    deck_id: UUID = Field(description="One of your Legacy decks, for your friend's team.")


class Friend(Contract):
    """A friend in the Two-Headed Giant queue (v0.5.1), as the queue names them: never an email."""

    id: UUID
    handle: str
    portrait: str | None = Field(description="Their allied Planeswalker.")


class TeamInvite(Contract):
    """A friend's invitation to wait in the Two-Headed Giant queue as their teammate (v0.5.1)."""

    player: Friend
    humans_only: bool = Field(description="Whether they wait for players only.")
    invited_at: datetime


def friend_of(user: User) -> Friend:
    return Friend(id=user.id, handle=user.handle or "", portrait=user.alliance)


class QueueInfo(Contract):
    format: TableFormatId
    seats: int
    best_of: int
    name: str
    waiting: int = Field(description="Players waiting in this queue now.")


class QueueStatus(Contract):
    """Your place in a queue, or what became of your last wait."""

    status: Literal["none", "inviting", "waiting", "matched", "left", "refused"] = Field(
        description="none (never queued), inviting (since v0.5.1: waiting for the friend you "
        "invited to accept), waiting, matched (game_id names the game), left (you left, your app "
        "stopped asking, or your friend declined or left), or refused (taken out as the game "
        "started: reason and message say why)."
    )
    format: TableFormatId | None
    seats: int | None
    best_of: int = Field(default=1, description="3 in the best-of-three Legacy queue.")
    humans_only: bool
    deck_id: UUID | None
    deck: str | None = Field(description="Your deck's title.")
    joined_at: datetime | None
    waited_seconds: int = Field(description="While waiting: how long, in seconds.")
    position: int | None = Field(description="While waiting: your place in line; 1 is next.")
    waiting: int = Field(description="While waiting: players in your queue, you too.")
    bots_in_seconds: int | None = Field(
        description="While waiting with bots allowed: seconds until bots may fill the empty "
        "seats (0 once they may); null for players only.",
    )
    game_id: UUID | None = Field(description="The game your wait found.")
    reason: str | None = Field(
        description="Why you were taken out (an error code, or gone), or why your match waits "
        "(games_busy).",
    )
    message: str | None
    partner: Friend | None = Field(
        default=None,
        description="Two-Headed Giant (v0.5.1): the friend you invited, or wait with as a team.",
    )
    invites: list[TeamInvite] = Field(
        default_factory=list,
        description="Two-Headed Giant (v0.5.1): friends inviting you to wait with them as a team.",
    )


@dataclass
class Group:
    """The players a match claimed, in the order they joined, and the bots that fill the rest."""

    key: QueueKey
    users: list[UUID]
    decks: list[UUID]
    bots: int
    # Each seat's player in turn order, None for a bot: the players, then the bots, except in
    # Two-Headed Giant (v0.5.1), where a bot may be either team's.
    seats: list[UUID | None] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.seats:
            self.seats = [*self.users, *([None] * self.bots)]


class Refused(Exception):
    """Players the start took out of the queue, each with an error code and its words."""

    def __init__(self, players: dict[UUID, tuple[str, str]]) -> None:
        super().__init__(f"{len(players)} players refused")
        self.players = players


class Gone(Exception):
    """A player left the queue as their game started."""


def queue_name(key: QueueKey) -> str:
    if key.format == TEAM_FORMAT:
        return f"{FORMAT_NAMES[key.format]} · two teams of two"
    match = " · best of three" if key.best_of == 3 else ""
    return f"{FORMAT_NAMES[key.format]} · {key.seats} players{match}"


def background(app: FastAPI) -> Request:
    """A request for the work the process does on its own (the tick): the helpers read the app's
    settings and state through it. It has no client, session or headers."""
    return Request(
        {
            "type": "http",
            "app": app,
            "method": "POST",
            "path": "/api/v1/queue",
            "headers": [],
            "query_string": b"",
            "client": None,
            "state": {},
        }
    )


def waiting_of(db: Session, user_id: UUID) -> QueueEntry | None:
    """The account's place in a queue, if it waits in one (or since v0.5.1 invites a friend)."""
    entry = db.get(QueueEntry, user_id)
    return entry if entry is not None and entry.status in HELD else None


def remove_queue_of(db: Session, user_id: UUID) -> int:
    """Takes the account out of the queues and forgets its last wait: for deleting or resetting
    the account (api/accounts.py, api/resets.py). Its team (v0.5.1) leaves with it, and so do the
    invitations it sent and was sent. Returns the rows removed."""
    entry = lock_team(db, user_id, invitations=True)
    leave_team(db, user_id, utcnow(), invitations=True)
    db.execute(
        update(QueueEntry)
        .where(QueueEntry.partner_id == user_id)
        .values(partner_id=None)
        .execution_options(synchronize_session=False)
    )
    if entry is None:
        return 0
    db.delete(entry)
    db.flush()
    return 1


def leave_team(db: Session, user_id: UUID, now: datetime, *, invitations: bool = False) -> None:
    """The account's place is gone: the friend it waited with as a team (v0.5.1) leaves the queue
    too, since a team is never split. With invitations (the account is deleted or reset), those
    sent to it end as well."""
    handle = db.scalar(select(User.handle).where(User.id == user_id)) or "Your friend"
    for row in db.scalars(
        select(QueueEntry)
        .where(
            QueueEntry.partner_id == user_id,
            QueueEntry.status.in_(HELD if invitations else WAITING),
        )
        .with_for_update()
    ):
        inviting = row.status == "inviting"
        row.status = "left"
        row.reason = "invite_ended" if inviting else "partner_left"
        row.message = (
            f"{handle} can no longer join your team."
            if inviting
            else f"{handle} left the queue, so your team did too. Find a game again, together "
            "or alone."
        )
        row.ended_at = now


def lock_team(db: Session, user_id: UUID, *, invitations: bool = False) -> QueueEntry | None:
    """The account's place, locked together with its team's other place (v0.5.1), which names it,
    in one statement and in user_id order: the order claim, put_back and record_group take a team's
    two rows in (they share their joined_at). Locked one after the other, as leaving once did, two
    teammates leaving at once, or a leave and a match, could each hold the row the other waits
    for, a deadlock PostgreSQL ends by failing one of them. With invitations, the places of those
    inviting the account are locked too, for leave_team to end."""
    rows = db.scalars(
        select(QueueEntry)
        .where(
            or_(
                QueueEntry.user_id == user_id,
                and_(
                    QueueEntry.partner_id == user_id,
                    QueueEntry.status.in_(HELD if invitations else WAITING),
                ),
            )
        )
        .order_by(QueueEntry.user_id)
        .with_for_update()
    ).all()
    return next((row for row in rows if row.user_id == user_id), None)


def invite_over(db: Session, inviter: UUID, invitee: UUID, now: datetime) -> None:
    """An invitation accepted, declined or withdrawn (v0.5.1): its notification waits no more."""
    db.execute(
        update(Notification)
        .where(
            Notification.kind == "team_invite",
            Notification.user_id == invitee,
            Notification.actor_id == inviter,
            Notification.read_at.is_(None),
        )
        .values(read_at=now)
        .execution_options(synchronize_session=False)
    )


def end_invitations(db: Session, one: UUID, other: UUID, now: datetime) -> None:
    """The two are friends no more (v0.5.1: a friendship ended, or a block, api/social.py): an
    invitation either sent the other ends, its inviter is told, and its notification waits no more.
    Only a friend may accept one, so it could otherwise only be refused while its inviter waited.
    A team of the two already waiting stays one; either may leave, and the other goes too."""
    handles = dict(db.execute(select(User.id, User.handle).where(User.id.in_((one, other)))).all())
    for row in db.scalars(
        select(QueueEntry)
        .where(
            or_(
                and_(QueueEntry.user_id == one, QueueEntry.partner_id == other),
                and_(QueueEntry.user_id == other, QueueEntry.partner_id == one),
            ),
            QueueEntry.status == "inviting",
        )
        .order_by(QueueEntry.user_id)
        .with_for_update()
    ).all():
        invitee = other if row.user_id == one else one
        row.status = "left"
        row.reason = "invite_ended"
        row.message = f"{handles.get(invitee) or 'Your friend'} can no longer join your team."
        row.ended_at = now
        invite_over(db, row.user_id, invitee, now)


def fresh(now: datetime) -> ColumnElement[bool]:
    """Places whose app still asks about them."""
    return QueueEntry.seen_at >= now - STALE_AFTER


def in_queue(key: QueueKey) -> list[ColumnElement[bool]]:
    return [
        QueueEntry.format == key.format,
        QueueEntry.seats == key.seats,
        QueueEntry.best_of == key.best_of,
    ]


def status_of(db: Session, user_id: UUID, now: datetime) -> QueueStatus:
    entry = db.get(QueueEntry, user_id)
    status = QueueStatus(
        status="none",
        format=None,
        seats=None,
        humans_only=False,
        deck_id=None,
        deck=None,
        joined_at=None,
        waited_seconds=0,
        position=None,
        waiting=0,
        bots_in_seconds=None,
        game_id=None,
        reason=None,
        message=None,
        invites=invites_to(db, user_id, now),
    )
    if entry is None:
        return status
    deck = db.get(Deck, entry.deck_id)
    waiting = entry.status in WAITING
    status.status = "waiting" if waiting else entry.status  # type: ignore[assignment]
    partner = db.get(User, entry.partner_id) if entry.partner_id else None
    if partner is not None and partner.normalized_handle:
        status.partner = friend_of(partner)
    status.format = entry.format  # type: ignore[assignment]
    status.seats = entry.seats
    status.best_of = entry.best_of
    status.humans_only = entry.humans_only
    status.deck_id = entry.deck_id
    status.deck = deck.title if deck is not None and deck.deleted_at is None else None
    status.joined_at = entry.joined_at
    status.game_id = entry.game_id
    status.reason, status.message = entry.reason, entry.message
    if not waiting:
        return status
    key = QueueKey(entry.format, entry.seats, entry.best_of)
    line = db.execute(
        select(QueueEntry.user_id, QueueEntry.joined_at, QueueEntry.humans_only)
        .where(*in_queue(key), QueueEntry.status.in_(WAITING), fresh(now))
        .order_by(QueueEntry.joined_at, QueueEntry.user_id)
    ).all()
    ahead = [row.user_id for row in line]
    status.waited_seconds = max(0, int((now - entry.joined_at).total_seconds()))
    status.position = ahead.index(user_id) + 1 if user_id in ahead else len(ahead) + 1
    status.waiting = max(len(ahead), status.position)
    if not entry.humans_only:
        # Bots come once the longest-waiting player who takes them has waited BOT_WAIT.
        oldest = min([row.joined_at for row in line if not row.humans_only] + [entry.joined_at])
        status.bots_in_seconds = max(0, int((BOT_WAIT - (now - oldest)).total_seconds()))
    return status


def invites_to(db: Session, user_id: UUID, now: datetime) -> list[TeamInvite]:
    """Friends inviting the account to wait with them as a team (v0.5.1), whose app still asks
    about their place, the oldest first: friends still, since only a friend's may be accepted."""
    from api.social import befriended  # Imported here: see enter.

    found = db.execute(
        select(QueueEntry, User)
        .join(User, User.id == QueueEntry.user_id)
        .where(
            QueueEntry.partner_id == user_id,
            QueueEntry.status == "inviting",
            fresh(now),
            User.status == "active",
            befriended(user_id, QueueEntry.user_id),
        )
        .order_by(QueueEntry.joined_at)
    ).all()
    return [
        TeamInvite(player=friend_of(user), humans_only=row.humans_only, invited_at=row.joined_at)
        for row, user in found
        if user.normalized_handle
    ]


# Matching.


def release_starting(database: Engine) -> None:
    """Places a stopped process was making into games wait again: their games died with it."""
    with Session(database) as db:
        db.execute(
            update(QueueEntry).where(QueueEntry.status == "starting").values(status="waiting")
        )
        db.commit()


def waiting_queues(database: Engine, now: datetime) -> list[QueueKey]:
    """The queues with players waiting. Players whose app stopped asking are taken out first, and
    (v0.5.1) the friends who waited with them as a team."""
    with Session(database) as db:
        gone = list(
            db.scalars(
                select(QueueEntry.user_id).where(
                    QueueEntry.status.in_(("inviting", "waiting")),
                    QueueEntry.seen_at < now - STALE_AFTER,
                )
            )
        )
        if gone:
            # Locked first with their teammates' places (v0.5.1), in user_id order as leaving
            # locks a team's: a teammate leaving at the same moment never holds the row this waits
            # for while waiting for one this holds.
            db.scalars(
                select(QueueEntry.user_id)
                .where(
                    or_(
                        QueueEntry.user_id.in_(gone),
                        and_(QueueEntry.partner_id.in_(gone), QueueEntry.status.in_(WAITING)),
                    )
                )
                .order_by(QueueEntry.user_id)
                .with_for_update()
            ).all()
            db.execute(
                update(QueueEntry)
                .where(
                    QueueEntry.user_id.in_(gone),
                    QueueEntry.status.in_(("inviting", "waiting")),
                )
                .values(status="left", reason="gone", message=GONE, ended_at=now)
            )
            for user_id in gone:
                leave_team(db, user_id, now)
        # Half of a team whose friend no longer waits leaves too: a team is never split.
        paired = {
            row.user_id: row
            for row in db.scalars(
                select(QueueEntry).where(
                    QueueEntry.status == "waiting", QueueEntry.partner_id.is_not(None)
                )
            )
        }
        for row in paired.values():
            mate = paired.get(row.partner_id) if row.partner_id else None
            if mate is None or mate.partner_id != row.user_id:
                row.status, row.reason, row.ended_at = "left", "partner_left", now
                row.message = "Your friend left the queue, so your team did too."
        db.commit()
        found = db.execute(
            select(QueueEntry.format, QueueEntry.seats, QueueEntry.best_of)
            .where(QueueEntry.status == "waiting")
            .distinct()
        ).all()
    keys = {QueueKey(fmt, seats, best_of) for fmt, seats, best_of in found}
    return [key for key in QUEUES if key in keys]


def choose(rows: list[QueueEntry], seats: int, now: datetime) -> tuple[list[QueueEntry], int]:
    """Who a queue seats now, in the order they joined, and how many bots: a full table of
    players, or once a player who takes bots has waited BOT_WAIT, every player waiting who takes
    them with bots in the empty seats. Nobody, while neither holds."""
    if len(rows) >= seats:
        return rows[:seats], 0
    willing = [row for row in rows if not row.humans_only]
    if willing and now - willing[0].joined_at >= BOT_WAIT:
        return willing, seats - len(willing)
    return [], 0


def claim(database: Engine, key: QueueKey, now: datetime) -> Group | None:
    """Claims the players a queue seats now, marking their places starting; None when it seats
    nobody. Their rows are locked, so another match waits and then sees them taken; the update
    takes only places still waiting, and claims nothing unless it took them all."""
    with Session(database) as db:
        rows = list(
            db.scalars(
                select(QueueEntry)
                .where(*in_queue(key), QueueEntry.status == "waiting", fresh(now))
                .order_by(QueueEntry.joined_at, QueueEntry.user_id)
                .with_for_update()
            )
        )
        if key.format == TEAM_FORMAT:
            seats = choose_teams(db, rows, now)
        else:
            chosen, bots = choose(rows, key.seats, now)
            seats = [*(row.user_id for row in chosen), *([None] * bots)]
        users = [user for user in seats if user is not None]
        if not users:
            return None
        decks = {row.user_id: row.deck_id for row in rows}
        taken = db.execute(
            update(QueueEntry)
            .where(QueueEntry.user_id.in_(users), QueueEntry.status == "waiting")
            .values(status="starting")
        ).rowcount  # type: ignore[attr-defined]
        if taken != len(users):
            db.rollback()
            return None
        db.commit()
    return Group(key, users, [decks[user] for user in users], seats.count(None), seats)


def units_of(rows: list[QueueEntry]) -> list[list[QueueEntry]]:
    """Two-Headed Giant's waiting players as the queue seats them (v0.5.1), in the order they
    joined: two friends waiting together as one team, a player alone on their own. Half of a team
    whose friend no longer waits is passed over; the tick takes it out."""
    by_user = {row.user_id: row for row in rows}
    units: list[list[QueueEntry]] = []
    placed: set[UUID] = set()
    for row in rows:
        if row.user_id in placed:
            continue
        if row.partner_id is None:
            units.append([row])
        elif (mate := by_user.get(row.partner_id)) is not None and mate.partner_id == row.user_id:
            units.append([row, mate])
            placed.add(mate.user_id)
        placed.add(row.user_id)
    return units


def team_up(
    units: list[list[QueueEntry]], cards: dict[UUID, set[str]]
) -> tuple[list[list[QueueEntry]], list[QueueEntry]]:
    """The teams the units make, in the order they form, and the players left alone. Friends are
    a team; a player alone teams with the first player alone before them whose deck shares no
    card with theirs but basic lands (Unified Deck Construction), so no stranger learns a card of
    another's deck."""
    formed: list[list[QueueEntry]] = []
    alone: list[QueueEntry] = []
    for unit in units:
        if len(unit) == 2:
            formed.append(unit)
            continue
        row = unit[0]
        mate = next(
            (
                other
                for other in alone
                if not teams.shared(cards[other.user_id], cards[row.user_id])
            ),
            None,
        )
        if mate is None:
            alone.append(row)
        else:
            alone.remove(mate)
            formed.append([mate, row])
    return formed, alone


def choose_teams(db: Session, rows: list[QueueEntry], now: datetime) -> list[UUID | None]:
    """Who the Two-Headed Giant queue seats now (v0.5.1), seat by seat, None for a bot: two teams
    of players, or once a player who takes bots has waited BOT_WAIT, the first two sides of the
    players who take them, a side of two players first, bots filling each side's empty seats.
    Nobody, while neither holds."""
    cards = {row.user_id: team_cards(db, row.deck_id) for row in rows if row.partner_id is None}
    units = units_of(rows)
    formed, _ = team_up(units, cards)
    if len(formed) >= 2:
        return sides(formed[:2])
    willing = [unit for unit in units if not any(row.humans_only for row in unit)]
    if not willing or now - willing[0][0].joined_at < BOT_WAIT:
        return []
    formed, alone = team_up(willing, cards)
    first = sorted([*formed, *([row] for row in alone)], key=lambda unit: unit[0].joined_at)[:2]
    return sides(sorted(first, key=len, reverse=True))


def sides(units: list[list[QueueEntry]]) -> list[UUID | None]:
    """Each side's players in its two seats, seats 0 and 1 the first's, a bot in each seat left."""
    seats: list[UUID | None] = []
    for index in range(len(teams.TEAMS)):
        players = [row.user_id for row in units[index]] if index < len(units) else []
        seats += [*players, *([None] * (2 - len(players)))]
    return seats


def put_back(
    database: Engine,
    users: list[UUID],
    now: datetime,
    refused: dict[UUID, tuple[str, str]] | None = None,
    reason: str | None = None,
    message: str | None = None,
) -> None:
    """The claimed players wait again in their places, except those taken out with a reason, and
    (v0.5.1) the friend each of those waited with as a team: a team is never split."""
    refused = refused or {}
    with Session(database) as db:
        # In user_id order, as claim and lock_team take a team's two rows.
        rows = list(
            db.scalars(
                select(QueueEntry)
                .where(QueueEntry.user_id.in_(users))
                .order_by(QueueEntry.user_id)
                .with_for_update()
            )
        )
        handles = dict(db.execute(select(User.id, User.handle).where(User.id.in_(users))).all())
        for row in rows:
            if row.status != "starting":
                continue
            if row.user_id in refused:
                row.status = "refused"
                row.reason, row.message = refused[row.user_id]
                row.ended_at = now
            elif row.partner_id in refused:
                row.status = "refused"
                row.reason = "partner_refused"
                row.message = (
                    f"{handles.get(row.partner_id) or 'Your friend'} could not start the game, so "
                    "your team left the queue. Find a game again, together or alone."
                )
                row.ended_at = now
            else:
                row.status = "waiting"
                row.reason, row.message = reason, message
        db.commit()


def holding(group: Group, plans: list[SeatPlan], error: ApiError) -> dict[UUID, tuple[str, str]]:
    """The players whose decks hold the cards the engine refused (custom cards it has not loaded,
    or names it does not know), with its refusal."""
    names = {name.casefold() for name in error.names or []}
    found: dict[UUID, tuple[str, str]] = {}
    for user_id, plan in zip(group.seats, plans, strict=False):
        if user_id is None:
            continue
        listed = plan.engine.get("deck_list")
        cards = listed.get("cards", []) if isinstance(listed, dict) else []
        held = {str(card.get("name", "")).casefold() for card in cards} | {
            str(name).casefold()
            for name in (listed.get("commanders", []) if isinstance(listed, dict) else [])
        }
        if names & (held | {name.casefold() for name in plan.custom}):
            found[user_id] = (error.code, error.message)
    return found


def bot_plans(db: Session, request: Request, fmt: str, count: int) -> list[SeatPlan]:
    """Bots for the empty seats: in Commander the starter decks, a different one each, unless the
    site keeps them on the engine's fixture decks; in Legacy the engine's fixture decks."""
    starters = (
        list(starters_of(request).values())
        if fmt == "commander" and settings_of(request).bot_decks == "starters"
        else []
    )
    random.shuffle(starters)
    plans: list[SeatPlan] = []
    for _ in range(count):
        planned = starter_seat(db, starters.pop()) if starters else None
        plans.append(planned or SeatPlan({"player": "bot"}))
    return plans


def plan_group(database: Engine, request: Request, group: Group) -> list[SeatPlan]:
    """Every seat as the engine takes it, in turn order: each player's deck bound to a revision
    now (DECK01) and checked as at a table's start, and the bots. Raises Refused with the players
    whose account, limit or deck stops the game."""
    roster = roster_of(request)
    limit = settings_of(request).games_per_account
    fmt = group.key.format
    refused: dict[UUID, tuple[str, str]] = {}
    players: dict[UUID, SeatPlan] = {}
    with Session(database, expire_on_commit=False) as db:
        for user_id, deck_id in zip(group.users, group.decks, strict=True):
            user = db.get(User, user_id)
            assert user is not None
            permissions = permissions_for(user, roles_of(db, user))
            if user.status != "active" or not {"games.play", "decks.edit"} <= permissions:
                refused[user_id] = ("player_unavailable", "Your account cannot play games now.")
                continue
            if "games.view_concealed" not in permissions and active_games_of(db, user_id) >= limit:
                refused[user_id] = (
                    "game_limit",
                    "You started another game. Join the queue again once it ends.",
                )
                continue
            library = library_of(db, user, permissions, roster)
            try:
                seat, revision, title = own_deck(
                    db, user, permissions, deck_id, DECK_FORMATS.get(fmt, fmt), library, casual()
                )
            except ApiError as error:
                refused[user_id] = (error.code, error.message)
                continue
            if fmt == TEAM_FORMAT:
                # MTR 9.5: Two-Headed Giant Constructed has no sideboards; a deck's stays home.
                cast(dict[str, object], seat["deck_list"]).pop("sideboard", None)
            players[user_id] = SeatPlan({"player": "human", **seat}, revision, title)
        if refused:
            # Revisions made for the game are kept, as at a table's start.
            db.commit()
            raise Refused(refused)
        bots = bot_plans(db, request, fmt, group.bots)
        plans = [players[user] if user is not None else bots.pop(0) for user in group.seats]
        if fmt == TEAM_FORMAT:
            check_queue_teams(db, group, plans)
        # A Godlike player's custom cards (v0.4.0) are checked against the running engine before
        # the game starts; bots play starter or fixture decks, never them.
        for index, held in custom_in_seats(db, [plan.engine for plan in plans]).items():
            plans[index].custom = held
        db.commit()
    return plans


def check_queue_teams(db: Session, group: Group, plans: list[SeatPlan]) -> None:
    """Two-Headed Giant's teams at the start (v0.5.1): each team of two players' decks, bound now,
    share no card but basic lands, and each bot gets a fixture deck its teammate's shares no card
    with (api/teams.py). Friends whose decks now share cards are told which and taken out; two
    players the queue paired (a deck changed meanwhile) wait on, to be paired apart."""
    partners = dict(
        db.execute(
            select(QueueEntry.user_id, QueueEntry.partner_id).where(
                QueueEntry.user_id.in_(group.users)
            )
        ).all()
    )
    handles = dict(db.execute(select(User.id, User.handle).where(User.id.in_(group.users))).all())
    for first, second in teams.TEAMS:
        one, other = group.seats[first], group.seats[second]
        if one is None or other is None:
            continue
        both = teams.shared(
            teams.cards_of(plans[first].engine) or set(),
            teams.cards_of(plans[second].engine) or set(),
        )
        if not both:
            continue
        # Revisions made for the game are kept, as at a table's start.
        db.commit()
        if partners.get(one) != other:
            raise Refused({})
        raise Refused(
            {
                one: ("team_decks", shared_with(handles.get(other), both)),
                other: ("team_decks", shared_with(handles.get(one), both)),
            }
        )
    try:
        teams.assign_and_check([plan.engine for plan in plans], True)
    except ApiError as error:
        db.commit()
        alone = [
            user
            for index, user in enumerate(group.seats)
            if user is not None and group.seats[teams.teammate(index)] is None
        ]
        said = (
            "Your deck shares a card with every bot deck, so no bot can be your teammate. Find a "
            "game with another deck, or with a friend."
        )
        raise Refused({user: ("team_decks", said) for user in alone}) from error


def record_group(
    database: Engine,
    group: Group,
    created: dict[str, object],
    plans: list[SeatPlan],
    now: datetime,
) -> tuple[Game, list[UUID | None]]:
    """The game, its seats and, for two players or more, its table; and every place matched, in
    one transaction. Raises Gone, with the others waiting again, when a player left meanwhile.
    Returns the game and each seat's player."""
    with Session(database, expire_on_commit=False) as db:
        # In user_id order, as claim and lock_team take a team's two rows.
        rows = {
            row.user_id: row
            for row in db.scalars(
                select(QueueEntry)
                .where(QueueEntry.user_id.in_(group.users))
                .order_by(QueueEntry.user_id)
                .with_for_update()
            )
        }
        if any(
            (row := rows.get(user_id)) is None or row.status != "starting"
            for user_id in group.users
        ):
            for row in rows.values():
                if row.status == "starting":
                    row.status = "waiting"
            db.commit()
            raise Gone()
        users = group.seats
        fmt, seats = group.key.format, group.key.seats
        if len(group.users) > 1:
            table = GameTable(
                code=secrets.token_urlsafe(12),
                host_id=group.users[0],
                format=fmt,
                visibility="private",
                seats=seats,
                bots=group.bots,
                # Two-Headed Giant's bots (v0.5.1) sit in the seats its teams leave them.
                bot_seats=(
                    [seat for seat, user in enumerate(users) if user is None]
                    if fmt == TEAM_FORMAT
                    else None
                ),
                bot_skill=BOT_SKILL,
                turn_cap=TURN_CAP,
                allow_banned=True,
                allow_not_legal=True,
                status="open",
                created_at=utcnow(),
                queued=True,
                # Best of three (v0.5.0): add_table_game begins the table's match.
                best_of=group.key.best_of,
            )
            db.add(table)
            db.flush()
            decks = dict(zip(group.users, group.decks, strict=True))
            for index, user_id in enumerate(users):
                if user_id is None:
                    continue
                db.add(
                    TableSeat(
                        table_id=table.id,
                        seat=index,
                        user_id=user_id,
                        deck_id=decks[user_id],
                        ready=True,
                        joined_at=rows[user_id].joined_at,
                    )
                )
            db.flush()
            game = add_table_game(db, table, created, plans, users)
        else:
            game = add_practice_game(db, group, created, plans)
        for user_id in group.users:
            row = rows[user_id]
            row.status = "matched"
            row.game_id = game.id
            row.ended_at = now
            row.reason = row.message = None
        db.commit()
    return game, users


def add_practice_game(
    db: Session, group: Group, created: dict[str, object], plans: list[SeatPlan]
) -> Game:
    """A player alone with bots: a practice game, which records the request a practice table would
    have sent, so its rematch replays it (api/rematches.py)."""
    fmt = group.key.format
    request = PracticeGameRequest(
        format=fmt,  # type: ignore[arg-type]
        deck_id=group.decks[0],
        bots=[SeatChoice() for _ in range(group.bots)],
        bot_skill=BOT_SKILL,
        turn_cap=TURN_CAP,
        rules=casual(),
        best_of=group.key.best_of,  # type: ignore[arg-type]
    )
    game = Game(
        id=UUID(str(created["game_id"])),
        kind="practice",
        format=fmt,
        status="active",
        created_by=group.users[0],
        created_at=utcnow(),
        bot_skill=BOT_SKILL,
        turn_cap=TURN_CAP,
        catalog_revision_id=db.scalar(select(func.max(CatalogRevision.id))),
        # The decks' format: Two-Headed Giant plays Legacy decks (v0.5.1).
        format_version=db.scalar(
            select(func.max(FormatVersion.version)).where(
                FormatVersion.format == DECK_FORMATS.get(fmt, fmt)
            )
        ),
        settings=request.model_dump(mode="json"),
    )
    db.add(game)
    db.flush()
    settings = created["settings"]
    assert isinstance(settings, dict)
    decks = {entry["seat"]: entry["deck"] for entry in settings["seats"]}
    for index, plan in enumerate(plans):
        human = plan.engine["player"] == "human"
        db.add(
            GameSeat(
                game_id=game.id,
                seat=index,
                player=plan.engine["player"],
                user_id=group.users[0] if human else None,
                deck=plan.title or decks[index],
                deck_list=plan.engine.get("deck_list"),
                deck_revision_id=plan.revision,
            )
        )
    # Best of three (v0.5.0): the first game of the player's match against the bot.
    matches.begin(db, game, group.key.best_of)
    db.flush()
    return game


class QueueHub:
    """The public queues' matching in this process: one queue at a time, on joins and on the
    tick. Its clock may be replaced (tests)."""

    def __init__(self, app: FastAPI) -> None:
        self.app = app
        self.locks: defaultdict[QueueKey, asyncio.Lock] = defaultdict(asyncio.Lock)
        self.clock: Callable[[], datetime] = utcnow

    @property
    def games(self) -> GameHub:
        return cast(GameHub, self.app.state.games)

    @property
    def database(self) -> Engine:
        return self.games.database

    def start(self) -> None:
        self.games.spawn(self.run())

    async def run(self) -> None:
        """Places a stopped process was matching wait again; then every TICK_SECONDS each queue
        with players waiting is matched. A tick that fails is logged, and the next one runs."""
        await retried(partial(release_starting, self.database), "free the queue's places")
        while True:
            await asyncio.sleep(TICK_SECONDS)
            try:
                await self.tick()
            except Exception:
                log.exception("The queues' tick failed")

    async def tick(self) -> None:
        """Takes out the places nobody asks about, then matches each queue with players waiting:
        without games set up, nothing starts."""
        keys = await run_in_threadpool(waiting_queues, self.database, self.clock())
        if self.games.engine is None:
            return
        for key in keys:
            await self.match(key)

    async def match(self, key: QueueKey) -> None:
        """Starts the queue's games while it seats players: a full table, or bots after the wait.
        Stops when nobody is seated, or when no game can start now (every slot busy, the engine
        silent); the tick tries again."""
        if self.games.engine is None:
            return
        async with self.locks[key]:
            while True:
                group = await run_in_threadpool(claim, self.database, key, self.clock())
                if group is None or not await self.start_game(group):
                    return

    async def start_game(self, group: Group) -> bool:
        """Makes the claimed players' game; True when the queue may be matched again at once."""
        hub = self.games
        engine = hub.require_engine()
        request = background(self.app)
        now = self.clock()
        table = len(group.users) > 1
        async with AsyncExitStack() as stack:
            # Every player's lock, in one order, as a table's start takes them: no practice game or
            # table of theirs starts meanwhile, and two starts cannot wait on each other.
            for user_id in sorted(group.users, key=str):
                await stack.enter_async_context(hub.locks[user_id])
            try:
                plans = await run_in_threadpool(plan_group, self.database, request, group)
            except Refused as refused:
                await run_in_threadpool(put_back, self.database, group.users, now, refused.players)
                # Nobody taken out (two players paired as a deck changed): the tick pairs again.
                return bool(refused.players)
            try:
                await require_loaded(request, plans)
            except ApiError as error:
                if error.code != "custom_not_loaded":
                    await run_in_threadpool(
                        put_back, self.database, group.users, now, None, error.code, SILENT
                    )
                    return False
                # Only a Godlike player's deck holds custom cards: those players are taken out.
                await run_in_threadpool(
                    put_back, self.database, group.users, now, holding(group, plans, error)
                )
                return True
            try:
                hub.reserve()
            except ApiError:
                await run_in_threadpool(
                    put_back, self.database, group.users, now, None, "games_busy", BUSY
                )
                return False
            try:
                body: dict[str, object] = {
                    "format": group.key.format,
                    "seats": [plan.engine for plan in plans],
                    "skill": BOT_SKILL,
                    "turn_cap": TURN_CAP,
                }
                if table:
                    body["idle_timeout_seconds"] = TABLE_IDLE_SECONDS
                try:
                    created = await engine_game(engine, body, request)
                except ApiError as error:
                    out = holding(group, plans, error) if error.code == "unknown_cards" else {}
                    if out:
                        await run_in_threadpool(put_back, self.database, group.users, now, out)
                        return True
                    log.warning("The engine refused a queue's game: %s", error.code)
                    busy = error.status == 429
                    await run_in_threadpool(
                        put_back,
                        self.database,
                        group.users,
                        now,
                        None,
                        "games_busy" if busy else error.code,
                        BUSY if busy else SILENT,
                    )
                    return False
                try:
                    game, users = await run_in_threadpool(
                        record_group, self.database, group, created, plans, now
                    )
                except (Gone, SQLAlchemyError) as failure:
                    with suppress(EngineUnavailable):
                        await engine.request("POST", f"/games/{created['game_id']}/close", body={})
                    if isinstance(failure, SQLAlchemyError):
                        await run_in_threadpool(put_back, self.database, group.users, now)
                        raise
                    return True
                tokens = {entry["seat"]: entry["seat_token"] for entry in created["seats"]}
                hub.register(
                    LiveGame(
                        id=game.id,
                        kind="table" if table else "practice",
                        seats={
                            seat: LiveSeat(seat, user_id, tokens[seat])
                            for seat, user_id in enumerate(users)
                            if user_id is not None
                        },
                        teams=table and group.key.format == TEAM_FORMAT,
                    )
                )
                log.info(
                    "A %s queue's game started: %d players, %d bots",
                    queue_name(group.key),
                    len(group.users),
                    group.bots,
                )
            finally:
                hub.starting -= 1
        return True


def queues_of(request: Request) -> QueueHub:
    return cast(QueueHub, request.app.state.queues)


# Routes.


def enter(
    db: Session, request: Request, principal: Principal, body: QueueRequest, now: datetime
) -> None:
    """Takes a place in the queue: the deck checked as a table checks it, and the account free to
    play. The account's row is locked, as a seat at a table locks it, so two requests at once
    join once, and a table and a queue never both take the player. With a friend to invite
    (v0.5.1, Two-Headed Giant) the place is an invitation until the friend accepts it, and the bell
    tells the friend."""
    user = principal.user
    friend = invited_friend(db, user, body) if body.partner_id is not None else None
    check_deck(db, request, user, principal.permissions, body.deck_id, body.format, casual())
    entry = free_to_queue(db, request, principal)
    if entry is None:
        entry = QueueEntry(user_id=user.id)
        db.add(entry)
    entry.format = body.format
    entry.seats = body.seats
    entry.best_of = body.best_of
    entry.deck_id = body.deck_id
    entry.humans_only = body.humans_only
    entry.status = "inviting" if friend is not None else "waiting"
    entry.partner_id = friend.id if friend is not None else None
    entry.joined_at = entry.seen_at = now
    entry.ended_at = entry.game_id = None
    entry.reason = entry.message = None
    try:
        db.flush()
        if friend is not None:
            # Imported here: api.social reaches api.resets, which imports this module.
            from api.social import notify

            notify(db, friend.id, "team_invite", user.id, utcnow())
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ApiError(409, "in_queue", "You are already waiting in a queue.") from None


def free_to_queue(db: Session, request: Request, principal: Principal) -> QueueEntry | None:
    """The account may take a place: at no open table, in no queue, and under its limit of running
    games. Locks the account's row and returns its last place, if any."""
    user = principal.user
    db.scalar(select(User.id).where(User.id == user.id).with_for_update())
    if open_table_of(db, user.id) is not None:
        raise ApiError(409, "at_a_table", "You sit at an open table. Leave it to join a queue.")
    entry = db.get(QueueEntry, user.id, with_for_update=True)
    if entry is not None and entry.status in HELD:
        raise ApiError(409, "in_queue", "You are already waiting in a queue. Leave it first.")
    limit = settings_of(request).games_per_account
    if not full_access(principal) and active_games_of(db, user.id) >= limit:
        raise ApiError(409, "game_limit", "Finish your running game before you join a queue.")
    return entry


def friends(db: Session, one: UUID, other: UUID) -> bool:
    from api.social import friendship_between  # Imported here: see enter.

    found = friendship_between(db, one, other)
    return found is not None and found.status == "accepted"


def invited_friend(db: Session, user: User, body: QueueRequest) -> User:
    """The friend a player invites to the Two-Headed Giant queue as their teammate (v0.5.1): an
    active player with a handle, and a friend (a block ends a friendship)."""
    if body.format != TEAM_FORMAT:
        raise ApiError(422, "invalid_queue", "Only Two-Headed Giant takes a teammate.")
    if body.partner_id == user.id:
        raise ApiError(422, "invalid_queue", "Invite a friend to your team, not yourself.")
    friend = db.get(User, body.partner_id)
    if friend is None or friend.status != "active" or not friend.normalized_handle:
        raise not_found()
    if not friends(db, user.id, friend.id):
        raise ApiError(409, "not_friends", "You can invite only a friend to your team.")
    return friend


def invitation(db: Session, inviter: UUID, invitee: UUID, now: datetime) -> QueueEntry | None:
    """A friend's invitation still open to the account, its row locked."""
    row = db.get(QueueEntry, inviter, with_for_update=True)
    if (
        row is None
        or row.status != "inviting"
        or row.partner_id != invitee
        or row.seen_at < now - STALE_AFTER
    ):
        return None
    return row


def accept(
    db: Session,
    request: Request,
    principal: Principal,
    inviter_id: UUID,
    deck_id: UUID,
    now: datetime,
) -> None:
    """Accepts a friend's invitation to the Two-Headed Giant queue (v0.5.1) with one of your Legacy
    decks: checked as a table checks it, and with your friend's deck (Unified Deck Construction,
    the shared cards named to the two). From now on the two wait as one team."""
    user = principal.user
    check_deck(db, request, user, principal.permissions, deck_id, TEAM_FORMAT, casual())
    entry = free_to_queue(db, request, principal)
    theirs = invitation(db, inviter_id, user.id, now)
    if theirs is None:
        raise ApiError(409, "invite_gone", "That invitation is no longer open.")
    if not friends(db, user.id, inviter_id):
        raise ApiError(409, "not_friends", "You can join only a friend's team.")
    both = teams.shared(team_cards(db, deck_id), team_cards(db, theirs.deck_id))
    if both:
        handle = db.scalar(select(User.handle).where(User.id == inviter_id))
        raise ApiError(422, "team_decks", shared_with(handle, both))
    if entry is None:
        entry = QueueEntry(user_id=user.id)
        db.add(entry)
    entry.format, entry.seats, entry.best_of = TEAM_FORMAT, teams.SEATS, 1
    entry.deck_id = deck_id
    entry.humans_only = theirs.humans_only
    entry.partner_id = inviter_id
    entry.ended_at = entry.game_id = None
    entry.reason = entry.message = None
    for row in (entry, theirs):
        # The team takes its place in line now.
        row.status = "waiting"
        row.joined_at = row.seen_at = now
    invite_over(db, inviter_id, user.id, now)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ApiError(409, "in_queue", "You are already waiting in a queue.") from None


def decline(db: Session, principal: Principal, inviter_id: UUID, now: datetime) -> None:
    """Declines a friend's invitation (v0.5.1): their place ends, and they are told who declined."""
    theirs = invitation(db, inviter_id, principal.user.id, now)
    if theirs is not None:
        theirs.status = "left"
        theirs.reason = "declined"
        theirs.message = (
            f"{principal.user.handle or 'Your friend'} declined your invitation. Find a game "
            "alone, or invite another friend."
        )
        theirs.ended_at = now
    invite_over(db, inviter_id, principal.user.id, now)
    db.commit()


@router.get("/queues", response_model=list[QueueInfo])
def list_queues(request: Request, principal: Player, db: Db) -> list[QueueInfo]:
    """The public queues, with how many players wait in each."""
    now = queues_of(request).clock()
    counts = {
        QueueKey(fmt, seats, best_of): count
        for fmt, seats, best_of, count in db.execute(
            select(QueueEntry.format, QueueEntry.seats, QueueEntry.best_of, func.count())
            .where(QueueEntry.status.in_(WAITING), fresh(now))
            .group_by(QueueEntry.format, QueueEntry.seats, QueueEntry.best_of)
        )
    }
    return [
        QueueInfo(
            format=key.format,  # type: ignore[arg-type]
            seats=key.seats,
            best_of=key.best_of,
            name=queue_name(key),
            waiting=counts.get(key, 0),
        )
        for key in QUEUES
    ]


@router.get("/queue", response_model=QueueStatus)
def my_queue(request: Request, principal: Player, db: Db) -> QueueStatus:
    """Your place in a queue, or what became of your last wait. Asking keeps the place: the app
    asks every few seconds while it waits, and a place nobody asks about for STALE_AFTER goes."""
    now = queues_of(request).clock()
    db.execute(
        update(QueueEntry)
        .where(QueueEntry.user_id == principal.user.id, QueueEntry.status.in_(HELD))
        .values(seen_at=now)
    )
    db.commit()
    return status_of(db, principal.user.id, now)


@router.post(
    "/queue",
    response_model=QueueStatus,
    status_code=201,
    responses={409: {"model": Error}},
)
async def join_queue(
    body: QueueRequest, request: Request, principal: Player, db: Db
) -> QueueStatus:
    """Joins a public queue with one of your decks. The answer is your place, or the game the
    queue found at once."""
    queues = queues_of(request)
    key = QueueKey(body.format, body.seats, body.best_of)
    if key not in QUEUES:
        raise ApiError(
            422,
            "invalid_queue",
            f"{FORMAT_NAMES[body.format]} has no queue for {body.seats} players"
            + (", best of three." if body.best_of == 3 else "."),
        )
    await run_in_threadpool(join, db, request, principal, body, queues.clock())
    await match_now(queues, key)
    return await run_in_threadpool(status_of, db, principal.user.id, queues.clock())


def join(
    db: Session, request: Request, principal: Principal, body: QueueRequest, now: datetime
) -> None:
    """Takes a place in the queue, except that inviting a friend who has invited you is accepting
    their invitation (v0.5.1). The two accounts' rows are locked first, in one order (as paying a
    game's winners locks theirs), and the invitation is looked for and answered in that one
    transaction: two friends inviting each other at the same moment take turns, and the second
    accepts the first's invitation. Looked for before the lock, as it once was, both could miss
    the other's and wait on invitations neither could accept, or deadlock, each holding their own
    account while their new place, naming the other's, waited for it. The locks are FOR NO KEY
    UPDATE, which a new row naming the friend does not wait for: a request that holds the friend's
    place while it writes one (another friend accepting their invitation, their game being
    recorded) goes on, while this one waits for that place."""
    friend = body.partner_id
    if friend is not None:
        for user_id in sorted({principal.user.id, friend}, key=str):
            db.scalar(select(User.id).where(User.id == user_id).with_for_update(key_share=True))
        if invitation(db, friend, principal.user.id, now) is not None:
            accept(db, request, principal, friend, body.deck_id, now)
            return
    enter(db, request, principal, body, now)


async def match_now(queues: QueueHub, key: QueueKey) -> None:
    try:
        await queues.match(key)
    except SQLAlchemyError:
        # The place is taken; the tick matches it once the database answers again.
        log.warning("Could not match the %s queue on a join", queue_name(key), exc_info=True)


@router.post(
    "/queue/invites/{player_id}",
    response_model=QueueStatus,
    responses={409: {"model": Error}},
)
async def accept_invite(
    player_id: UUID, body: TeamDeck, request: Request, principal: Player, db: Db
) -> QueueStatus:
    """Accepts a friend's invitation to the Two-Headed Giant queue (v0.5.1) with one of your Legacy
    decks: the two of you wait as one team. The answer is your place, or the game found at once."""
    queues = queues_of(request)
    await run_in_threadpool(accept, db, request, principal, player_id, body.deck_id, queues.clock())
    await match_now(queues, QueueKey(TEAM_FORMAT, teams.SEATS))
    return await run_in_threadpool(status_of, db, principal.user.id, queues.clock())


@router.post("/queue/invites/{player_id}/decline", response_model=QueueStatus)
def decline_invite(player_id: UUID, request: Request, principal: Player, db: Db) -> QueueStatus:
    """Declines a friend's invitation (v0.5.1); they are told."""
    now = queues_of(request).clock()
    decline(db, principal, player_id, now)
    return status_of(db, principal.user.id, now)


@router.delete("/queue", response_model=QueueStatus)
def leave_queue(request: Request, principal: Player, db: Db) -> QueueStatus:
    """Leaves the queue, or withdraws your invitation to a friend. A game found a moment before
    stays: the answer names it. Your team (v0.5.1) leaves with you."""
    now = queues_of(request).clock()
    entry = lock_team(db, principal.user.id)
    if entry is not None and entry.status in HELD:
        if entry.status == "inviting" and entry.partner_id is not None:
            invite_over(db, principal.user.id, entry.partner_id, now)
        else:
            leave_team(db, principal.user.id, now)
        entry.status = "left"
        entry.reason = "left"
        entry.message = None
        entry.ended_at = now
    db.commit()
    return status_of(db, principal.user.id, now)
