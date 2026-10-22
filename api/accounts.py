"""Deleting an account (v0.4.1): SysOp's and administrators' "Delete account", and the daily
removal of sign-up requests nobody approved.

The account's row stays, as "Deleted player": the ledgers, the audit trail and other players'
games refer to it, and their records stay whole. What identifies the person goes:
- **Sign-in.** The Google identity (its subject and email), so the same Google account signing in
  later makes a new, pending account; every session; every role grant.
- **The profile.** The handle, the name, the avatar, the locale, the accessibility settings and
  the alliance.
- **Decks.** Each deck with its revisions, except a revision a game played (DECK01: a game binds
  to it for good). That one keeps its cards, as the game played them, and loses its title and
  notes; its deck stays only as the row the revision belongs to, emptied, private and in the
  trash. The game seats that played it name it "Deleted deck".
- **Tables.** The account leaves every table still open, as leaving does: a host's table closes.
- **Each feature's own rows**, removed by the functions in CLEANUPS.

Wins, tokens, packs, the library, game results and the audit trail stay: they are no contact
data, and other players' records count them. While the account is seated in a running game,
deleting it is refused; it can be deleted once the game ends or the seat concedes.

The worker's daily job (KIND) deletes accounts still pending or denied UNAPPROVED_DAYS after they
were created, in one transaction, with one audit entry that counts them.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from uuid import UUID

from sqlalchemy import Engine, delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.identity import ApiError, refuse_deleted
from api.models import (
    AuditEvent,
    Deck,
    DeckEntryRow,
    DeckRevision,
    ExternalIdentity,
    Game,
    GameSeat,
    GameTable,
    RoleGrant,
    ScheduledJob,
    TableSeat,
    User,
    UserSession,
)
from catalog.sync import Outcome

log = logging.getLogger("api.accounts")
DELETED_NAME = "Deleted player"
# A kept revision's title, its deck's, and the deck its game seats name. PostgreSQL lets a
# deleted account's revisions change to this title, with no notes, and in no other way
# (migration 0013's trigger, which spells it too).
DELETED_DECK = "Deleted deck"
KIND = "account_cleanup"
# Requests never approved (pending or denied accounts) are deleted this long after they were made.
UNAPPROVED_DAYS = 30
# The daily run's time, UTC: after the night, before the catalog's sync.
CLEANUP_TIME = time(4, 0)
# Rows other features keep about an account, each removed by its own function in the deletion's
# transaction: cleanup(db, user_id). Listed here, not registered from the feature's module, so
# the worker's daily job runs them too.


def remove_reports(db: Session, user_id: UUID) -> int:
    """The account's problem reports and their screenshots (api/reports.py)."""
    # Imported here: api.reports imports api.admin, which imports this module.
    from api.reports import delete_reports_of

    return delete_reports_of(db, user_id)


CLEANUPS: tuple[Callable[[Session, UUID], object], ...] = (remove_reports,)


@dataclass
class Removed:
    """What one deletion removed and kept, for the caller's audit entry and tests."""

    # The account's status before.
    status: str
    sessions: int = 0
    identities: int = 0
    decks: int = 0
    kept_decks: int = 0
    revisions: int = 0
    kept_revisions: int = 0
    tables_left: int = 0


def running_games(db: Session, user_id: UUID) -> int:
    """Running games where the account's seat is still in play (api/games.py, active_games_of)."""
    return (
        db.scalar(
            select(func.count(func.distinct(Game.id)))
            .select_from(Game)
            .join(GameSeat, GameSeat.game_id == Game.id)
            .where(
                GameSeat.user_id == user_id,
                GameSeat.left_at.is_(None),
                Game.status == "active",
            )
        )
        or 0
    )


def leave_open_tables(db: Session, user_id: UUID, now: datetime) -> int:
    """Leaves every open table, as leaving one does (api/tables.py, leave_table): a host's table
    closes for everyone. Expired tables count, so no seat of the account is left open. A started
    table keeps its seats: they record who played its game."""
    seats = db.execute(
        select(TableSeat, GameTable)
        .join(GameTable, GameTable.id == TableSeat.table_id)
        .where(TableSeat.user_id == user_id, GameTable.status == "open")
    ).all()
    for seat, table in seats:
        if table.host_id == user_id:
            table.status = "closed"
            table.closed_at = now
            db.execute(delete(TableSeat).where(TableSeat.table_id == table.id))
        else:
            db.delete(seat)
    db.flush()
    return len(seats)


def remove_decks(db: Session, user_id: UUID, now: datetime, removed: Removed) -> None:
    """Deletes the account's decks, revisions and entries that no game played; strips the rest
    (see the module's docstring). Run after the account is marked deleted, which the database's
    trigger on revisions checks."""
    owned = select(Deck.id).where(Deck.owner_id == user_id)
    revisions = select(DeckRevision.id).where(DeckRevision.deck_id.in_(owned))
    played = select(GameSeat.deck_revision_id).where(GameSeat.deck_revision_id.is_not(None))
    unplayed = revisions.where(DeckRevision.id.not_in(played))
    quiet = {"synchronize_session": False}
    db.execute(
        delete(DeckEntryRow).where(DeckEntryRow.revision_id.in_(unplayed)),
        execution_options=quiet,
    )
    removed.revisions = db.execute(
        delete(DeckRevision).where(DeckRevision.deck_id.in_(owned), DeckRevision.id.not_in(played)),
        execution_options=quiet,
    ).rowcount  # type: ignore[attr-defined]
    # What is left was played: its cards stay, its words go.
    removed.kept_revisions = db.execute(
        update(DeckRevision)
        .where(DeckRevision.deck_id.in_(owned))
        .values(title=DELETED_DECK, notes=""),
        execution_options=quiet,
    ).rowcount  # type: ignore[attr-defined]
    db.execute(
        update(GameSeat).where(GameSeat.deck_revision_id.in_(revisions)).values(deck=DELETED_DECK),
        execution_options=quiet,
    )
    # A deck stays while a played revision or a started table's seat refers to it.
    kept = select(DeckRevision.deck_id).where(DeckRevision.deck_id.in_(owned))
    seated = select(TableSeat.deck_id)
    removed.decks = db.execute(
        delete(Deck).where(Deck.owner_id == user_id, Deck.id.not_in(kept), Deck.id.not_in(seated)),
        execution_options=quiet,
    ).rowcount  # type: ignore[attr-defined]
    removed.kept_decks = db.execute(
        update(Deck)
        .where(Deck.owner_id == user_id)
        .values(
            title=DELETED_DECK,
            notes="",
            visibility="private",
            share_code=None,
            draft={"entries": []},
            draft_hash="",
            card_count=0,
            legal=False,
            playable=False,
            collection_locked=False,
            identity="",
            deleted_at=now,
            updated_at=now,
        ),
        execution_options=quiet,
    ).rowcount  # type: ignore[attr-defined]


def delete_account(db: Session, user: User, now: datetime) -> Removed:
    """Deletes a player's account (the module's docstring says what goes and what stays), in the
    caller's transaction: the caller audits and commits. Refuses 409 while the account is seated
    in a running game."""
    if user.kind != "player":
        raise ValueError("Only a player's account can be deleted.")
    # The account's row is locked, as taking a seat at a table locks it, and read again, so a
    # deletion that got there first is seen.
    db.refresh(user, with_for_update=True)
    refuse_deleted(user)
    if running_games(db, user.id):
        raise ApiError(
            409,
            "account_in_game",
            "This account is playing a game. Delete it once the game ends or its seat concedes.",
        )
    removed = Removed(user.status)
    removed.tables_left = leave_open_tables(db, user.id, now)
    user.status = "deleted"
    user.deleted_at = now
    user.handle = user.normalized_handle = None
    user.display_name = DELETED_NAME
    user.avatar, user.locale, user.preferences = "sigil", "en", {}
    user.alliance = user.alliance_since = None
    user.last_seen_at = None
    user.updated_at = now
    # Any session that survived would rotate, and then find no account to stand for.
    user.privilege_version += 1
    db.flush()
    remove_decks(db, user.id, now, removed)
    removed.sessions = db.execute(
        delete(UserSession).where(UserSession.user_id == user.id)
    ).rowcount  # type: ignore[attr-defined]
    removed.identities = db.execute(
        delete(ExternalIdentity).where(ExternalIdentity.user_id == user.id)
    ).rowcount  # type: ignore[attr-defined]
    db.execute(delete(RoleGrant).where(RoleGrant.user_id == user.id))
    for cleanup in CLEANUPS:
        cleanup(db, user.id)
    db.flush()
    return removed


# The daily job: requests never approved.


def due_time(day: datetime) -> datetime:
    return datetime.combine(day.date(), CLEANUP_TIME, UTC)


def ensure_scheduled(engine: Engine, now: datetime) -> None:
    """Keeps today's and tomorrow's runs queued; the deduplication key allows one a day. A new
    installation's first run is due at once when today's time has passed."""
    for day in (now, now + timedelta(days=1)):
        key = f"{KIND}:{day.date().isoformat()}"
        with Session(engine) as session:
            if session.scalar(select(ScheduledJob.id).where(ScheduledJob.deduplication_key == key)):
                continue
            session.add(
                ScheduledJob(
                    kind=KIND,
                    deduplication_key=key,
                    payload={"trigger": "schedule"},
                    status="pending",
                    due_at=due_time(day),
                )
            )
            try:
                session.commit()
            except IntegrityError:
                session.rollback()


def remove_unapproved(engine: Engine, now: datetime) -> int:
    """Deletes every account still pending or denied UNAPPROVED_DAYS after it was created, in one
    transaction, and records how many in the audit trail as the system's own action."""
    cutoff = now - timedelta(days=UNAPPROVED_DAYS)
    with Session(engine) as db:
        stale = list(
            db.scalars(
                select(User).where(
                    User.kind == "player",
                    User.status.in_(("pending", "denied")),
                    User.created_at <= cutoff,
                )
            )
        )
        for user in stale:
            delete_account(db, user, now)
        if stale:
            db.add(
                AuditEvent(
                    occurred_at=now,
                    action="account.unapproved_deleted",
                    details={"count": len(stale), "after_days": UNAPPROVED_DAYS},
                )
            )
        db.commit()
    return len(stale)


def handle(engine: Engine, now: datetime) -> Outcome:
    """One run of the job, as the outcome catalog.sync.settle records on it."""
    try:
        count = remove_unapproved(engine, now)
    except Exception:
        # Tomorrow's run tries again; the accounts wait one more day.
        log.exception("Deleting unapproved accounts failed")
        return Outcome("failed", "internal_error")
    if count:
        log.info("Deleted %s accounts never approved in %s days", count, UNAPPROVED_DAYS)
    return Outcome("completed", "deleted" if count else "nothing_due")
