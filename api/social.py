"""Finding other players, friends, presence and the notification bell (v0.4.3). docs/social.md
describes them for players and staff.

- **The search** (GET /players): a handle matches in part, case aside; an email address only when
  typed in full, case aside, and only an account that lets itself be found by email
  (email_searchable). No answer ever holds an email. It finds active players who have chosen a
  handle; never SysOp, the one searching, or a player who has blocked them. An account searches
  SEARCHES_PER_MINUTE times a minute, EMAIL_SEARCHES_PER_DAY of them by email a day; SysOp has no
  limit.
- **Profiles** (GET /players/{id}): the handle, portrait, tier, wins and first day, and what is
  between the two accounts: friends, a request either way, a block. Any active account with a
  handle has one, SysOp's included, though the search never lists SysOp.
- **Friends are mutual.** Add friend sends a request, which waits until the other player accepts
  it or adds back; either may withdraw, decline or end it. A block ends any friendship or request
  between the two; the blocked player's requests then wait unseen, and they no longer see the
  blocker's presence or find them.
- **Presence** comes from the app's check-in (POST /presence, every CHECK_IN_SECONDS from each
  open tab), which says only whether its own player is using that tab, and from the games the
  server runs: in a game, in a public queue (v0.5.0), online, idle (no tab in use for IDLE_AFTER),
  or offline (no check-in for OFFLINE_AFTER). Friends see it, or everyone when the player
  chooses. Appearing offline shows offline to everyone but administrators and SysOp
  (players.presence), who see the real state and that the player appears offline; nothing tells
  the player.
- **Notifications:** a friend request, a request accepted, and a friend come online, the last only
  to friends online at that moment and at most once in ONLINE_NOTICE_GAP for the same friend; since
  v0.4.4 new messages from a friend too (api/chat.py), one while unread; since v0.5.0 a daily quest
  completed and an achievement earned (api/quests.py, api/achievements.py), with no actor, and a
  rematch offered at the end of a table's game (api/rematches.py), which waits while the offer
  stands.
  Kept NOTIFICATION_DAYS days, at most NOTIFICATION_LIMIT per account. The bell alone shows them:
  no email, no browser notifications.
"""

import threading
import time
from collections import deque
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Annotated, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Query, Request
from pydantic import Field, StringConstraints
from sqlalchemy import case, delete, func, or_, select, update
from sqlalchemy.orm import Session

from api.admin import decode_cursor, encode_cursor
from api.auth import INPUT_ERRORS
from api.identity import Active, ApiError, Db, Principal, not_found, utcnow
from api.models import (
    ExternalIdentity,
    Friendship,
    Game,
    GameSeat,
    Notification,
    PlayerBlock,
    ProgressEntry,
    QueueEntry,
    Rematch,
    RematchPlayer,
    User,
)
from api.progression import TierInfo, tier_info
from api.roster import tier_of
from api.schemas import Avatar, Contract, GameFormatId, without_nul

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

# How often each open tab of the app checks in (the web app's presence.ts says the same).
CHECK_IN_SECONDS = 30
# No check-in for this long: offline. No check-in from a tab in use for this long: idle.
OFFLINE_AFTER = timedelta(seconds=90)
IDLE_AFTER = timedelta(seconds=90)
ONLINE_NOTICE_GAP = timedelta(minutes=30)
# One notification of a friend request a day from the same player, however often they ask again.
REQUEST_NOTICE_GAP = timedelta(days=1)
NOTIFICATION_DAYS = 90
NOTIFICATION_LIMIT = 200
# Unread notifications newer than the page's last check-in, for its pop-ups.
FRESH_LIMIT = 5
SEARCH_RESULTS = 20
SEARCHES_PER_MINUTE = 60
EMAIL_SEARCHES_PER_DAY = 30
# Requests an account may have waiting for others' answers.
PENDING_LIMIT = 50

FriendState = Literal["none", "friends", "requested", "requested_you"]
PresenceState = Literal["in_game", "in_queue", "online", "idle", "offline"]
NotificationKind = Literal[
    "friend_request",
    "friend_accepted",
    "friend_online",
    "message",
    "quest_completed",
    "achievement_earned",
    "rematch",
    "team_invite",
]
AwardKind = Literal["quest_completed", "achievement_earned"]
SearchText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=320),
]


# Contracts.


class Presence(Contract):
    state: PresenceState
    game_kind: Literal["practice", "table"] | None = Field(
        default=None, description="In a game: a practice game against bots, or a human table."
    )
    game_format: GameFormatId | None = Field(
        default=None, description="In a game, or since v0.5.0 in a public queue: its format."
    )
    appears_offline: bool = Field(
        default=False,
        description="Shown only to the player and to administrators and SysOp: everyone else "
        "sees this player offline.",
    )


class PlayerRef(Contract):
    """Who a player is to everyone: never an email."""

    id: UUID
    handle: str
    avatar: Avatar
    alliance: str | None = Field(description="The allied Planeswalker; its portrait is theirs.")


class PlayerSummary(PlayerRef):
    tier: TierInfo
    presence: Presence | None = Field(
        description="Null when the player does not share their presence with you."
    )
    friendship: FriendState = Field(
        description="none, friends, requested (you asked) or requested_you (they asked)."
    )


class PlayerProfile(PlayerSummary):
    wins: int
    member_since: datetime
    blocked: bool = Field(description="Whether you have blocked this player.")
    you: bool = Field(description="Whether this is your own profile.")


class PlayerSearch(Contract):
    players: list[PlayerSummary]
    by_email: bool = Field(description="Whether the text was taken as an email address.")


class FriendList(Contract):
    friends: list[PlayerSummary]
    incoming: list[PlayerSummary] = Field(description="Requests waiting for your answer.")
    outgoing: list[PlayerSummary] = Field(description="Your requests, waiting for theirs.")


class BlockedPlayer(Contract):
    player: PlayerRef
    blocked_at: datetime


class PrivacySettings(Contract):
    presence_visibility: Literal["friends", "everyone"] = Field(
        description="Who sees whether you are online, idle or in a game."
    )
    appear_offline: bool = Field(
        description="Everyone sees you offline, except administrators and SysOp."
    )
    email_searchable: bool = Field(
        description="Whether a player who types your email address in full finds you."
    )


class PrivacyUpdate(Contract):
    presence_visibility: Literal["friends", "everyone"] | None = None
    appear_offline: bool | None = None
    email_searchable: bool | None = None


class CheckIn(Contract):
    idle: bool = Field(
        default=False,
        description="Whether this tab's player has left it: hidden, or untouched for minutes.",
    )
    since: datetime | None = Field(
        default=None,
        description="The newest notification the page knows of; newer unread ones come back as "
        "fresh.",
    )


class Award(Contract):
    """A daily quest completed or an achievement earned (v0.5.0), as the bell names it."""

    id: str
    name: str
    tokens: int = Field(description="What it paid.")


class NotificationItem(Contract):
    id: UUID
    kind: NotificationKind
    created_at: datetime
    read: bool
    actor: PlayerRef | None
    award: Award | None = Field(
        default=None,
        description="For a quest completed or an achievement earned (v0.5.0): which, and what "
        "it paid.",
    )
    request_pending: bool = Field(
        default=False,
        description="For a friend request, since v0.5.0 a rematch, or since v0.5.1 an invitation "
        "to the Two-Headed Giant queue as a friend's teammate: whether it still waits for your "
        "answer.",
    )
    messages: int = Field(
        default=0,
        description="For new messages (v0.4.4): how many from this friend are still unread.",
    )
    game_id: UUID | None = Field(
        default=None,
        description="For a rematch (v0.5.0): the finished game, whose result screen holds the "
        "offer.",
    )


class CheckedIn(Contract):
    unread: int
    messages_unread: int = Field(
        default=0, description="Unread messages from friends (v0.4.4), in every conversation."
    )
    newest: datetime | None = Field(description="The newest notification's time, if any.")
    fresh: list[NotificationItem] = Field(
        description="Unread notifications newer than the check-in's since, newest first."
    )


class NotificationPage(Contract):
    items: list[NotificationItem]
    unread: int
    next: str | None = Field(description="The cursor of the next, older page.")


class NotificationsRead(Contract):
    up_to: datetime | None = Field(
        default=None, description="Marks unread notifications up to this time read; all if null."
    )


class Unread(Contract):
    unread: int


# Limits on searching, in this process's memory: the API runs as one process (its games live in
# it too), and a restart forgetting the counts errs on the player's side.


@dataclass
class SearchLimits:
    lock: threading.Lock = field(default_factory=threading.Lock)
    recent: dict[UUID, deque[float]] = field(default_factory=dict)
    emails: dict[UUID, deque[float]] = field(default_factory=dict)

    def take(self, user_id: UUID, *, email: bool, now: float | None = None) -> None:
        moment = time.monotonic() if now is None else now
        with self.lock:
            recent = self.window(self.recent, user_id, moment - 60)
            emails = self.window(self.emails, user_id, moment - 86400)
            if len(recent) >= SEARCHES_PER_MINUTE:
                raise ApiError(
                    429,
                    "search_limited",
                    "That is a lot of searching. Wait a minute and try again.",
                )
            if email and len(emails) >= EMAIL_SEARCHES_PER_DAY:
                raise ApiError(
                    429,
                    "search_limited",
                    f"You have searched by email {EMAIL_SEARCHES_PER_DAY} times in the last day. "
                    "Search by handle, or try again tomorrow.",
                )
            recent.append(moment)
            if email:
                emails.append(moment)

    @staticmethod
    def window(store: dict[UUID, deque[float]], user_id: UUID, after: float) -> deque[float]:
        found = store.setdefault(user_id, deque())
        while found and found[0] <= after:
            found.popleft()
        return found


def limits_of(request: Request) -> SearchLimits:
    state = request.app.state
    if not hasattr(state, "search_limits"):
        state.search_limits = SearchLimits()
    return cast(SearchLimits, state.search_limits)


# Who is who to whom.


def pair(one: UUID, other: UUID) -> tuple[UUID, UUID]:
    """A friendship's two IDs in its row's order."""
    return (one, other) if one < other else (other, one)


def friendship_between(db: Session, one: UUID, other: UUID) -> Friendship | None:
    low, high = pair(one, other)
    return db.scalar(
        select(Friendship).where(Friendship.user_low == low, Friendship.user_high == high)
    )


def friendships_of(db: Session, user_id: UUID) -> dict[UUID, Friendship]:
    """Every friendship and request the account is part of, by the other player's ID."""
    rows = db.scalars(
        select(Friendship).where(
            or_(Friendship.user_low == user_id, Friendship.user_high == user_id)
        )
    )
    return {row.user_high if row.user_low == user_id else row.user_low: row for row in rows}


def blocked_by(db: Session, user_id: UUID) -> set[UUID]:
    """The players who have blocked the account."""
    return set(db.scalars(select(PlayerBlock.blocker_id).where(PlayerBlock.blocked_id == user_id)))


def blocks_of(db: Session, user_id: UUID) -> set[UUID]:
    """The players the account has blocked."""
    return set(db.scalars(select(PlayerBlock.blocked_id).where(PlayerBlock.blocker_id == user_id)))


@dataclass
class Viewer:
    """What decides what one account sees of others."""

    id: UUID
    sees_all: bool
    friendships: dict[UUID, Friendship]
    blocked_by: set[UUID]
    blocks: set[UUID]

    def friends(self) -> set[UUID]:
        return {other for other, row in self.friendships.items() if row.status == "accepted"}

    def state_with(self, other: UUID) -> FriendState:
        row = self.friendships.get(other)
        if row is None:
            return "none"
        if row.status == "accepted":
            return "friends"
        if row.requested_by == self.id:
            return "requested"
        # A request from a player this account blocked waits unseen.
        return "none" if other in self.blocks else "requested_you"


def viewer_of(db: Session, principal: Principal) -> Viewer:
    user_id = principal.user.id
    return Viewer(
        id=user_id,
        sees_all=principal.can("players.presence"),
        friendships=friendships_of(db, user_id),
        blocked_by=blocked_by(db, user_id),
        blocks=blocks_of(db, user_id),
    )


def wins_by_user(db: Session, ids: Iterable[UUID]) -> dict[UUID, int]:
    rows = db.execute(
        select(ProgressEntry.user_id, func.coalesce(func.sum(ProgressEntry.wins), 0))
        .where(ProgressEntry.user_id.in_(list(ids)))
        .group_by(ProgressEntry.user_id)
    )
    return {user_id: int(wins) for user_id, wins in rows}


def games_by_user(db: Session, ids: Iterable[UUID]) -> dict[UUID, tuple[str, str]]:
    """Each account's running game, the newest if several: its kind and format."""
    rows = db.execute(
        select(GameSeat.user_id, Game.kind, Game.format)
        .join(Game, Game.id == GameSeat.game_id)
        .where(
            GameSeat.user_id.in_(list(ids)),
            GameSeat.left_at.is_(None),
            Game.status == "active",
        )
        .order_by(Game.created_at.desc())
    )
    found: dict[UUID, tuple[str, str]] = {}
    for user_id, kind, game_format in rows:
        if user_id is not None:
            found.setdefault(user_id, (kind, game_format))
    return found


def queues_by_user(db: Session, ids: Iterable[UUID]) -> dict[UUID, str]:
    """Each account waiting in a public queue (v0.5.0), or since v0.5.1 inviting a friend to wait
    with it: the queue's format."""
    rows = db.execute(
        select(QueueEntry.user_id, QueueEntry.format).where(
            QueueEntry.user_id.in_(list(ids)),
            QueueEntry.status.in_(("inviting", "waiting", "starting")),
        )
    )
    return {user_id: game_format for user_id, game_format in rows}


def online(user: User, now: datetime) -> bool:
    return user.presence_at is not None and now - user.presence_at <= OFFLINE_AFTER


def real_presence(
    user: User, game: tuple[str, str] | None, now: datetime, queue: str | None = None
) -> Presence:
    if not online(user, now):
        return Presence(state="offline")
    if game is not None:
        return Presence(
            state="in_game",
            game_kind=game[0],  # type: ignore[arg-type]
            game_format=game[1],  # type: ignore[arg-type]
        )
    if queue is not None:
        return Presence(state="in_queue", game_format=queue)  # type: ignore[arg-type]
    if user.active_at is None or now - user.active_at > IDLE_AFTER:
        return Presence(state="idle")
    return Presence(state="online")


def presence_for(
    viewer: Viewer,
    user: User,
    game: tuple[str, str] | None,
    now: datetime,
    queue: str | None = None,
) -> Presence | None:
    real = real_presence(user, game, now, queue)
    if viewer.id == user.id or viewer.sees_all:
        # Administrators and SysOp see it passively: nothing records or tells that they did.
        return real.model_copy(update={"appears_offline": user.appear_offline})
    if user.id in viewer.blocked_by:
        return None
    if user.presence_visibility != "everyone" and viewer.state_with(user.id) != "friends":
        return None
    if user.appear_offline:
        return Presence(state="offline")
    return real


def player_ref(user: User) -> PlayerRef:
    return PlayerRef(
        id=user.id,
        handle=user.handle or "",
        avatar=user.avatar,  # type: ignore[arg-type]
        alliance=user.alliance,
    )


def summaries(db: Session, viewer: Viewer, users: list[User]) -> list[PlayerSummary]:
    ids = [user.id for user in users]
    wins = wins_by_user(db, ids)
    games = games_by_user(db, ids)
    queues = queues_by_user(db, ids)
    now = utcnow()
    return [
        PlayerSummary(
            **player_ref(user).model_dump(),
            tier=tier_info(tier_of(wins.get(user.id, 0))),
            presence=presence_for(viewer, user, games.get(user.id), now, queues.get(user.id)),
            friendship=viewer.state_with(user.id),
        )
        for user in users
    ]


def profile_of(db: Session, viewer: Viewer, user: User) -> PlayerProfile:
    summary = summaries(db, viewer, [user])[0]
    return PlayerProfile(
        **summary.model_dump(),
        wins=wins_by_user(db, [user.id]).get(user.id, 0),
        member_since=user.created_at,
        blocked=user.id in viewer.blocks,
        you=user.id == viewer.id,
    )


def visible_player(db: Session, player_id: UUID) -> User:
    """An active account with a handle, SysOp's included; any other is not found."""
    user = db.get(User, player_id)
    if user is None or user.status != "active" or not user.normalized_handle:
        raise not_found()
    return user


def other_player(db: Session, principal: Principal, player_id: UUID) -> User:
    """The other player of a friendship or block, for an account that has chosen its handle."""
    if not principal.user.normalized_handle:
        raise ApiError(409, "handle_required", "Choose your handle first.")
    if player_id == principal.user.id:
        raise ApiError(409, "own_account", "That is your own account.")
    return visible_player(db, player_id)


# Notifications.


def prune(db: Session, user_id: UUID, now: datetime) -> None:
    """Drops notifications older than NOTIFICATION_DAYS and those past the newest
    NOTIFICATION_LIMIT."""
    db.execute(
        delete(Notification).where(
            Notification.user_id == user_id,
            Notification.created_at < now - timedelta(days=NOTIFICATION_DAYS),
        )
    )
    extra = db.scalars(
        select(Notification.id)
        .where(Notification.user_id == user_id)
        .order_by(Notification.created_at.desc(), Notification.id.desc())
        .offset(NOTIFICATION_LIMIT)
    ).all()
    if extra:
        db.execute(delete(Notification).where(Notification.id.in_(extra)))


def notify(
    db: Session,
    user_id: UUID,
    kind: NotificationKind,
    actor_id: UUID,
    now: datetime,
    game_id: UUID | None = None,
) -> None:
    db.add(
        Notification(user_id=user_id, kind=kind, actor_id=actor_id, created_at=now, game_id=game_id)
    )
    db.flush()
    prune(db, user_id, now)


def notify_award(db: Session, user_id: UUID, kind: AwardKind, subject: str, now: datetime) -> None:
    """A quest completed or an achievement earned (v0.5.0): no player caused it, and the subject
    names which."""
    db.add(Notification(user_id=user_id, kind=kind, subject=subject, created_at=now))
    db.flush()
    prune(db, user_id, now)


def rematches_waiting(db: Session, user_id: UUID, game_ids: list[UUID]) -> set[UUID]:
    """The games among these whose rematch (v0.5.0) still waits for the account's answer: open,
    not lapsed, and not answered yet."""
    if not game_ids:
        return set()
    return set(
        db.scalars(
            select(Rematch.game_id)
            .join(RematchPlayer, RematchPlayer.rematch_id == Rematch.id)
            .where(
                Rematch.game_id.in_(game_ids),
                Rematch.status == "open",
                Rematch.expires_at > utcnow(),
                RematchPlayer.user_id == user_id,
                RematchPlayer.answer.is_(None),
            )
        )
    )


def invitations_waiting(db: Session, user_id: UUID, inviters: list[UUID]) -> set[UUID]:
    """The friends among these whose invitation to the Two-Headed Giant queue (v0.5.1) still waits
    for the account's answer."""
    if not inviters:
        return set()
    return set(
        db.scalars(
            select(QueueEntry.user_id).where(
                QueueEntry.user_id.in_(inviters),
                QueueEntry.status == "inviting",
                QueueEntry.partner_id == user_id,
            )
        )
    )


def notified_since(
    db: Session, user_id: UUID, kind: NotificationKind, actor_id: UUID, after: datetime
) -> bool:
    return (
        db.scalar(
            select(Notification.id)
            .where(
                Notification.user_id == user_id,
                Notification.kind == kind,
                Notification.actor_id == actor_id,
                Notification.created_at >= after,
            )
            .limit(1)
        )
        is not None
    )


def announce_online(db: Session, user: User, now: datetime) -> None:
    """Tells each friend online now that the account came online, at most once in a while."""
    friends = [
        other for other, row in friendships_of(db, user.id).items() if row.status == "accepted"
    ]
    if not friends:
        return
    listening = db.scalars(
        select(User.id).where(
            User.id.in_(friends),
            User.status == "active",
            User.presence_at >= now - OFFLINE_AFTER,
        )
    ).all()
    for friend in listening:
        if not notified_since(db, friend, "friend_online", user.id, now - ONLINE_NOTICE_GAP):
            notify(db, friend, "friend_online", user.id, now)


def unread_of(db: Session, user_id: UUID) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(Notification)
            .where(Notification.user_id == user_id, Notification.read_at.is_(None))
        )
        or 0
    )


def items_of(db: Session, viewer: Viewer, rows: list[Notification]) -> list[NotificationItem]:
    # Imported here: api.chat and api.awards import this module.
    from api.awards import award_of
    from api.chat import unread_by_player

    unread = unread_by_player(db, viewer.id) if any(r.kind == "message" for r in rows) else {}
    waiting = rematches_waiting(
        db, viewer.id, [r.game_id for r in rows if r.kind == "rematch" and r.game_id]
    )
    inviting = invitations_waiting(
        db, viewer.id, [r.actor_id for r in rows if r.kind == "team_invite" and r.actor_id]
    )
    actors = {
        user.id: user
        for user in db.scalars(
            select(User).where(User.id.in_([row.actor_id for row in rows if row.actor_id]))
        )
    }
    items = []
    for row in rows:
        actor = actors.get(row.actor_id) if row.actor_id else None
        items.append(
            NotificationItem(
                id=row.id,
                kind=row.kind,  # type: ignore[arg-type]
                created_at=row.created_at,
                read=row.read_at is not None,
                actor=player_ref(actor) if actor is not None and actor.normalized_handle else None,
                request_pending=(
                    row.kind == "friend_request"
                    and actor is not None
                    and viewer.state_with(actor.id) == "requested_you"
                )
                or (row.kind == "rematch" and row.game_id in waiting)
                or (row.kind == "team_invite" and row.actor_id in inviting),
                messages=unread.get(row.actor_id, 0)
                if row.kind == "message" and row.actor_id
                else 0,
                award=award_of(row.kind, row.subject),
                game_id=row.game_id if row.kind == "rematch" else None,
            )
        )
    return items


def delete_social_of(db: Session, user_id: UUID) -> int:
    """An account's friendships and requests, blocks either way, and the notifications it received
    or caused; for deleting the account (api/accounts.py CLEANUPS). Returns the rows removed."""
    removed = 0
    for statement in (
        delete(Friendship).where(
            or_(Friendship.user_low == user_id, Friendship.user_high == user_id)
        ),
        delete(PlayerBlock).where(
            or_(PlayerBlock.blocker_id == user_id, PlayerBlock.blocked_id == user_id)
        ),
        delete(Notification).where(
            or_(Notification.user_id == user_id, Notification.actor_id == user_id)
        ),
    ):
        removed += db.execute(statement).rowcount  # type: ignore[attr-defined]
    return removed


# Routes: the search and profiles.


def escaped(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("/players", response_model=PlayerSearch)
def search_players(
    request: Request,
    principal: Active,
    db: Db,
    q: Annotated[SearchText, Query(description="A handle, or part of one; or an email address.")],
) -> PlayerSearch:
    """Players by handle (in part) or by email address (in full); never anyone's email."""
    text = without_nul(q)
    by_email = "@" in text
    if principal.user.kind != "sysop":
        limits_of(request).take(principal.user.id, email=by_email)
    viewer = viewer_of(db, principal)
    query = select(User).where(
        User.status == "active",
        User.kind == "player",
        User.normalized_handle.is_not(None),
        User.id != principal.user.id,
    )
    if viewer.blocked_by:
        query = query.where(User.id.not_in(viewer.blocked_by))
    if by_email:
        query = (
            query.join(ExternalIdentity, ExternalIdentity.user_id == User.id)
            .where(
                User.email_searchable.is_(True),
                func.lower(ExternalIdentity.email) == text.lower(),
            )
            .distinct()
            .order_by(User.normalized_handle)
        )
    else:
        wanted = text.casefold()
        pattern = escaped(wanted)
        query = query.where(User.normalized_handle.like(f"%{pattern}%", escape="\\")).order_by(
            case(
                (User.normalized_handle == wanted, 0),
                (User.normalized_handle.like(f"{pattern}%", escape="\\"), 1),
                else_=2,
            ),
            User.normalized_handle,
        )
    users = list(db.scalars(query.limit(SEARCH_RESULTS)))
    return PlayerSearch(players=summaries(db, viewer, users), by_email=by_email)


@router.get("/players/{player_id}", response_model=PlayerProfile)
def player_profile(player_id: UUID, principal: Active, db: Db) -> PlayerProfile:
    user = visible_player(db, player_id)
    return profile_of(db, viewer_of(db, principal), user)


# Friends.


@router.get("/friends", response_model=FriendList)
def friend_list(principal: Active, db: Db) -> FriendList:
    viewer = viewer_of(db, principal)
    others = list(
        db.scalars(
            select(User)
            .where(
                User.id.in_(list(viewer.friendships)),
                User.status == "active",
                User.normalized_handle.is_not(None),
            )
            .order_by(User.normalized_handle)
        )
    )
    shown = summaries(db, viewer, others)
    return FriendList(
        friends=[player for player in shown if player.friendship == "friends"],
        incoming=[player for player in shown if player.friendship == "requested_you"],
        outgoing=[player for player in shown if player.friendship == "requested"],
    )


@router.put("/friends/{player_id}", response_model=PlayerProfile)
def add_friend(player_id: UUID, principal: Active, db: Db) -> PlayerProfile:
    """Add friend: a request, or the answer to theirs, which makes the two friends."""
    me = principal.user
    other = other_player(db, principal, player_id)
    if db.scalar(
        select(PlayerBlock.id).where(
            PlayerBlock.blocker_id == me.id, PlayerBlock.blocked_id == other.id
        )
    ):
        raise ApiError(409, "player_blocked", "You have blocked this player. Unblock them first.")
    now = utcnow()
    row = friendship_between(db, me.id, other.id)
    they_blocked = (
        db.scalar(
            select(PlayerBlock.id).where(
                PlayerBlock.blocker_id == other.id, PlayerBlock.blocked_id == me.id
            )
        )
        is not None
    )
    if row is None:
        waiting = db.scalar(
            select(func.count())
            .select_from(Friendship)
            .where(Friendship.requested_by == me.id, Friendship.status == "pending")
        )
        if (waiting or 0) >= PENDING_LIMIT:
            raise ApiError(
                429,
                "too_many_requests",
                f"{PENDING_LIMIT} of your friend requests are still waiting for an answer.",
            )
        low, high = pair(me.id, other.id)
        db.add(
            Friendship(
                user_low=low, user_high=high, requested_by=me.id, status="pending", created_at=now
            )
        )
        # A player who blocked this one never hears of the request.
        if not they_blocked and not notified_since(
            db, other.id, "friend_request", me.id, now - REQUEST_NOTICE_GAP
        ):
            notify(db, other.id, "friend_request", me.id, now)
    elif row.status == "pending" and row.requested_by != me.id:
        row.status, row.accepted_at = "accepted", now
        # Their request is answered: its notification is read, and they hear of the answer.
        db.execute(
            update(Notification)
            .where(
                Notification.user_id == me.id,
                Notification.kind == "friend_request",
                Notification.actor_id == other.id,
                Notification.read_at.is_(None),
            )
            .values(read_at=now)
        )
        notify(db, other.id, "friend_accepted", me.id, now)
    db.commit()
    return profile_of(db, viewer_of(db, principal), other)


def forget_requests(db: Session, recipient: UUID, actor: UUID) -> None:
    """A request that no longer waits takes its notification with it."""
    db.execute(
        delete(Notification).where(
            Notification.user_id == recipient,
            Notification.kind == "friend_request",
            Notification.actor_id == actor,
        )
    )


@router.delete("/friends/{player_id}", response_model=PlayerProfile)
def remove_friend(player_id: UUID, principal: Active, db: Db) -> PlayerProfile:
    """Withdraws a request, declines one, or ends a friendship. A request's notification stays,
    no longer waiting, so asking again within a day tells no one twice."""
    me = principal.user
    other = other_player(db, principal, player_id)
    row = friendship_between(db, me.id, other.id)
    if row is not None:
        if row.status == "pending" and row.requested_by == other.id:
            # Declined: answered, so read.
            db.execute(
                update(Notification)
                .where(
                    Notification.user_id == me.id,
                    Notification.kind == "friend_request",
                    Notification.actor_id == other.id,
                    Notification.read_at.is_(None),
                )
                .values(read_at=utcnow())
            )
        db.delete(row)
        db.commit()
    return profile_of(db, viewer_of(db, principal), other)


# Blocks.


@router.get("/me/blocks", response_model=list[BlockedPlayer])
def my_blocks(principal: Active, db: Db) -> list[BlockedPlayer]:
    rows = db.execute(
        select(PlayerBlock.created_at, User)
        .join(User, User.id == PlayerBlock.blocked_id)
        .where(PlayerBlock.blocker_id == principal.user.id, User.normalized_handle.is_not(None))
        .order_by(User.normalized_handle)
    ).all()
    return [BlockedPlayer(player=player_ref(user), blocked_at=at) for at, user in rows]


@router.put("/blocks/{player_id}", response_model=PlayerProfile)
def block_player(player_id: UUID, principal: Active, db: Db) -> PlayerProfile:
    """Blocks a player: any friendship or request between the two ends."""
    me = principal.user
    other = other_player(db, principal, player_id)
    existing = db.scalar(
        select(PlayerBlock.id).where(
            PlayerBlock.blocker_id == me.id, PlayerBlock.blocked_id == other.id
        )
    )
    if existing is None:
        db.add(PlayerBlock(blocker_id=me.id, blocked_id=other.id, created_at=utcnow()))
        row = friendship_between(db, me.id, other.id)
        if row is not None:
            db.delete(row)
        # The notifications they caused here go, and so does a request of this account's that
        # waited for them; what they were told before stays theirs.
        db.execute(
            delete(Notification).where(
                Notification.user_id == me.id, Notification.actor_id == other.id
            )
        )
        forget_requests(db, other.id, me.id)
        db.commit()
    return profile_of(db, viewer_of(db, principal), other)


@router.delete("/blocks/{player_id}", response_model=PlayerProfile)
def unblock_player(player_id: UUID, principal: Active, db: Db) -> PlayerProfile:
    """Unblocks a player. A request they sent while blocked is dropped, so nothing old surfaces."""
    me = principal.user
    other = other_player(db, principal, player_id)
    found = db.scalar(
        select(PlayerBlock).where(
            PlayerBlock.blocker_id == me.id, PlayerBlock.blocked_id == other.id
        )
    )
    if found is not None:
        db.delete(found)
        row = friendship_between(db, me.id, other.id)
        if row is not None and row.status == "pending" and row.requested_by == other.id:
            db.delete(row)
        db.commit()
    return profile_of(db, viewer_of(db, principal), other)


# Privacy settings.


def privacy_of(user: User) -> PrivacySettings:
    return PrivacySettings(
        presence_visibility=user.presence_visibility,  # type: ignore[arg-type]
        appear_offline=user.appear_offline,
        email_searchable=user.email_searchable,
    )


@router.get("/me/privacy", response_model=PrivacySettings)
def my_privacy(principal: Active) -> PrivacySettings:
    return privacy_of(principal.user)


@router.patch("/me/privacy", response_model=PrivacySettings)
def change_privacy(body: PrivacyUpdate, principal: Active, db: Db) -> PrivacySettings:
    user = principal.user
    for name, value in body.model_dump(exclude_none=True).items():
        setattr(user, name, value)
    user.updated_at = utcnow()
    db.commit()
    return privacy_of(user)


# Presence and notifications.


@router.post("/presence", response_model=CheckedIn)
def check_in(body: CheckIn, principal: Active, db: Db) -> CheckedIn:
    """The app's check-in, from each open tab every CHECK_IN_SECONDS. It is not activity: it never
    holds off the session's idle limit (identity.BACKGROUND_PATHS)."""
    user = principal.user
    now = utcnow()
    # Locked, so two tabs checking in at once announce the account once.
    db.refresh(user, with_for_update=True)
    came_online = not online(user, now)
    user.presence_at = now
    if not body.idle:
        user.active_at = now
    if came_online and not user.appear_offline and user.normalized_handle:
        announce_online(db, user, now)
    db.commit()
    newest = db.scalar(
        select(func.max(Notification.created_at)).where(Notification.user_id == user.id)
    )
    fresh: list[NotificationItem] = []
    if body.since is not None:
        rows = list(
            db.scalars(
                select(Notification)
                .where(
                    Notification.user_id == user.id,
                    Notification.read_at.is_(None),
                    Notification.created_at > body.since,
                )
                .order_by(Notification.created_at.desc(), Notification.id.desc())
                .limit(FRESH_LIMIT)
            )
        )
        fresh = items_of(db, viewer_of(db, principal), rows) if rows else []
    # Imported here: api.chat imports this module.
    from api.chat import unread_total

    return CheckedIn(
        unread=unread_of(db, user.id),
        messages_unread=unread_total(db, user.id),
        newest=newest,
        fresh=fresh,
    )


@router.get("/notifications", response_model=NotificationPage)
def notifications(
    principal: Active,
    db: Db,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
) -> NotificationPage:
    """The account's notifications, newest first; the bell shows the first few."""
    query = select(Notification).where(Notification.user_id == principal.user.id)
    if cursor:
        moment, row_id = decode_cursor(cursor)
        query = query.where(
            or_(
                Notification.created_at < moment,
                (Notification.created_at == moment) & (Notification.id < row_id),
            )
        )
    rows = list(
        db.scalars(
            query.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(limit + 1)
        )
    )
    more = len(rows) > limit
    rows = rows[:limit]
    return NotificationPage(
        items=items_of(db, viewer_of(db, principal), rows),
        unread=unread_of(db, principal.user.id),
        next=encode_cursor(rows[-1].created_at, rows[-1].id) if more and rows else None,
    )


@router.post("/notifications/read", response_model=Unread)
def read_notifications(body: NotificationsRead, principal: Active, db: Db) -> Unread:
    """Marks the account's unread notifications read, up to a time or all of them."""
    statement = (
        update(Notification)
        .where(Notification.user_id == principal.user.id, Notification.read_at.is_(None))
        .values(read_at=utcnow())
    )
    if body.up_to is not None:
        statement = statement.where(Notification.created_at <= body.up_to)
    db.execute(statement)
    db.commit()
    return Unread(unread=unread_of(db, principal.user.id))
