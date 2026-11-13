"""Access, consent and temporary entitlement (v0.9.10, the specification's §8; docs/access.md).

One table of grants (``access_grants``): access one account gives another, for a while, never
ownership. A grant names its grantor, its subject (an account), the resource (a deck, a game to
watch or replay, a seat's hand, a group, a league's pool, the sandbox), its scope within it (a
seat), its consent, its expiry and its revocation. Every change is audited.

**Read where access is decided, never copied.** A grant is asked for (``active``) at the moment
access is decided, and nothing of it is written anywhere else: not into a library (so a card the
sandbox lends can reach neither a collection nor the auction house, which read libraries only),
not into a game (a game binds the deck revision it started with, so revoking a lent deck cannot
change a game already started).

**When a grant stops working.** At its expiry; when its grantor or its subject revokes it (or
SysOp does); when its subject declines it; when either account is no longer active (disabled,
deleted); when either blocks the other; and, for a deck, when the deck is no longer its
grantor's or is deleted. ``active`` checks each of these every time, so nothing has to be swept
for access to end.

v0.9.10 reads grants where a game's events are read (api/events.py): a spectator's grant shows
the spectator's perspective, a replay's or a coach's (a seat's hand) the seat's. Lending decks,
the sandbox, groups and pools are v1.0.0's and v0.9.12's workflows; their grants are modelled
and checked here, and no route makes them yet.
"""

from datetime import datetime
from typing import Literal, get_args
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from api.identity import ApiError, utcnow
from api.models import AccessGrant, AuditEvent, Deck, GameSeat, PlayerBlock, User

Resource = Literal["deck", "spectator", "replay", "hand", "group", "pool", "sandbox"]
RESOURCES: tuple[str, ...] = get_args(Resource)
# Taken only once its subject accepts: a lent deck, a group's membership, a pool. The rest are the
# grantor's own to give (their hand to a coach, their game to a spectator, their replay).
NEEDS_CONSENT = frozenset({"deck", "group", "pool"})
# Given only by staff (SysOp, or an administrator): the sandbox's cards.
STAFF_ONLY = frozenset({"sandbox"})
USABLE = ("given", "accepted")


def _audit(db: Session, action: str, actor: UUID | None, grant: AccessGrant) -> None:
    db.add(
        AuditEvent(
            occurred_at=utcnow(),
            actor_id=actor,
            action=action,
            target_user_id=grant.subject_id,
            details={
                "grant": str(grant.id),
                "resource": grant.resource_kind,
                "resource_id": None if grant.resource_id is None else str(grant.resource_id),
                "scope": grant.scope,
            },
        )
    )


def blocked(db: Session, one: UUID, other: UUID) -> bool:
    """Whether either account blocks the other."""
    return (
        db.scalar(
            select(PlayerBlock.id).where(
                or_(
                    (PlayerBlock.blocker_id == one) & (PlayerBlock.blocked_id == other),
                    (PlayerBlock.blocker_id == other) & (PlayerBlock.blocked_id == one),
                )
            )
        )
        is not None
    )


def seat_of(db: Session, game_id: UUID, user_id: UUID) -> int | None:
    return db.scalar(
        select(GameSeat.seat).where(GameSeat.game_id == game_id, GameSeat.user_id == user_id)
    )


def _check_resource(
    db: Session, grantor: User, resource: str, resource_id: UUID | None, scope: dict[str, object]
) -> None:
    """The grantor may give this: it is theirs. Refused in words otherwise."""
    if resource in STAFF_ONLY:
        if grantor.kind != "sysop":
            raise ApiError(403, "forbidden", "Only SysOp gives access to the sandbox's cards.")
        return
    if resource_id is None:
        raise ApiError(422, "invalid_grant", "The grant names no resource.")
    if resource == "deck":
        deck = db.get(Deck, resource_id)
        if deck is None or deck.owner_id != grantor.id or deck.deleted_at is not None:
            raise ApiError(404, "not_found", "No such deck of yours.")
        return
    if resource in ("spectator", "replay", "hand"):
        seat = seat_of(db, resource_id, grantor.id)
        if seat is None:
            raise ApiError(404, "not_found", "No game of yours.")
        if resource in ("replay", "hand") and scope.get("seat") != seat:
            raise ApiError(422, "invalid_grant", "A seat's view is its own player's to give.")
        return
    # Groups and pools come with v0.9.12's playgroups and leagues.
    raise ApiError(409, "not_available", "Access of this kind cannot be given yet.")


def offer(
    db: Session,
    grantor: User,
    subject: User,
    resource: str,
    resource_id: UUID | None,
    *,
    scope: dict[str, object] | None = None,
    expires_at: datetime | None = None,
    now: datetime | None = None,
) -> AccessGrant:
    """Gives or offers access, in the caller's transaction, audited. A deck, a group or a pool
    waits for its subject's answer (offered); anything else is given at once."""
    now = now or utcnow()
    scope = dict(scope or {})
    if resource not in RESOURCES:
        raise ApiError(422, "invalid_grant", "No such kind of access.")
    if grantor.id == subject.id:
        raise ApiError(422, "invalid_grant", "Access is given to someone else.")
    if subject.status != "active" or grantor.status != "active":
        raise ApiError(409, "account_unavailable", "That account cannot be given access.")
    if blocked(db, grantor.id, subject.id):
        raise ApiError(409, "blocked", "That account cannot be given access.")
    if expires_at is not None and expires_at <= now:
        raise ApiError(422, "invalid_grant", "A grant cannot end before it begins.")
    _check_resource(db, grantor, resource, resource_id, scope)
    grant = AccessGrant(
        grantor_id=grantor.id,
        subject_id=subject.id,
        resource_kind=resource,
        resource_id=resource_id,
        scope=scope,
        consent="offered" if resource in NEEDS_CONSENT else "given",
        created_at=now,
        expires_at=expires_at,
    )
    db.add(grant)
    db.flush()
    _audit(db, f"access.{grant.consent}", grantor.id, grant)
    return grant


def answer(
    db: Session, grant: AccessGrant, subject: User, accept: bool, now: datetime | None = None
) -> AccessGrant:
    """The subject's answer to an offer, once, audited."""
    if grant.subject_id != subject.id:
        raise ApiError(404, "not_found", "No such offer.")
    if grant.consent != "offered" or grant.revoked_at is not None:
        raise ApiError(409, "answered", "This offer is no longer open.")
    grant.consent = "accepted" if accept else "declined"
    grant.answered_at = now or utcnow()
    _audit(db, f"access.{grant.consent}", subject.id, grant)
    return grant


def revoke(
    db: Session, grant: AccessGrant, actor: User, now: datetime | None = None
) -> AccessGrant:
    """Ends a grant: its grantor takes it back, its subject gives it up, or SysOp ends it. Once;
    what was done with it stands (a game started with a lent deck plays on as it started)."""
    if actor.id not in (grant.grantor_id, grant.subject_id) and actor.kind != "sysop":
        raise ApiError(404, "not_found", "No such grant.")
    if grant.revoked_at is None:
        grant.revoked_at = now or utcnow()
        grant.revoked_by = actor.id
        _audit(db, "access.revoked", actor.id, grant)
    return grant


def active(
    db: Session,
    subject_id: UUID,
    resource: str,
    resource_id: UUID | None,
    now: datetime | None = None,
) -> list[AccessGrant]:
    """The grants that give the subject this access now: consented to, not expired, not revoked,
    between two active accounts neither of which blocks the other, and for a deck one still its
    grantor's. Asked every time access is decided."""
    now = now or utcnow()
    query = select(AccessGrant).where(
        AccessGrant.subject_id == subject_id,
        AccessGrant.resource_kind == resource,
        AccessGrant.consent.in_(USABLE),
        AccessGrant.revoked_at.is_(None),
        or_(AccessGrant.expires_at.is_(None), AccessGrant.expires_at > now),
    )
    query = query.where(
        AccessGrant.resource_id.is_(None)
        if resource_id is None
        else AccessGrant.resource_id == resource_id
    )
    usable = []
    for grant in db.scalars(query):
        grantor = db.get(User, grant.grantor_id)
        subject = db.get(User, grant.subject_id)
        if grantor is None or subject is None:
            continue
        if grantor.status != "active" or subject.status != "active":
            continue
        if blocked(db, grant.grantor_id, grant.subject_id):
            continue
        if resource == "deck":
            deck = db.get(Deck, grant.resource_id)
            if deck is None or deck.owner_id != grant.grantor_id or deck.deleted_at is not None:
                continue
        usable.append(grant)
    return usable


def deck_usable(db: Session, user_id: UUID, deck: Deck, now: datetime | None = None) -> bool:
    """Whether the account may play the deck: its own, or one lent to it now (v1.0.0's lending
    will seat it; the game then binds the revision it started with, as for any deck)."""
    if deck.deleted_at is not None:
        return False
    return deck.owner_id == user_id or bool(active(db, user_id, "deck", deck.id, now))
