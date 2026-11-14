"""Entitlements: functional access to cards, bound to an account (v0.9.12; docs/economy.md).

The owner's specification (section 11) asks the economy to tell **functional access** (an account
may build with a card) from **collectible ownership** (it holds a copy of an edition in a finish,
which it may sell). An entitlement is the first: a row that says an account may build with a card.
The library adds it to what the account builds from, in the card's default printing
(api/library.py functional_cards), and nothing else reads it: it is no library grant, so the
auction house cannot list it, print runs do not count it, and the catalog's supply is as it was.

**The starter-staple pool** (section 22: "an attainable starter-staple pool") is its first use,
behind the starter_staples policy (api/policies.py), off by default:

- **The pool** is content/starter-staples.json: cards nearly every Commander deck wants.
- **Picks.** An account has the policy's initial picks, more for each campaign ward it has won
  and for each weekly quest board it has finished, read from the records those already keep
  (campaign_rewards' seals, quest_boards), so no pick can be earned twice and none is stored.
- **A claim** spends a pick on one card of the pool, once: the entitlement's key is the account
  and the card, so a retry or two requests at once claim once, and the account's row is locked
  while it is made. A card already claimed is answered as it stands.
- **Off** means out of reach: the routes answer as a missing page does, and nothing is claimed.
  Entitlements made while it was on stay: turning the policy off stops new claims and takes
  nothing a deck was built with.

SysOp gives and ends entitlements for testing through the same model (kind staff), audited.
"""

import json
from functools import lru_cache
from pathlib import Path
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api import policies
from api.auth import INPUT_ERRORS
from api.cards import CardSummary, summaries_by_id
from api.decks import refresh_decks
from api.economy import lock_account
from api.identity import (
    Active,
    ApiError,
    Db,
    Principal,
    audit,
    not_found,
    permissions_for,
    refuse_deleted,
    require_permission,
    roles_of,
    settings_of,
    utcnow,
)
from api.library import library_of, reset_key, since_reset
from api.models import CampaignReward, CardConcept, Entitlement, QuestBoard, User
from api.roster import roster_of
from api.schemas import Contract, StoredText

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
EconomyManager = Annotated[Principal, Depends(require_permission("economy.manage"))]

POLICY = "staples-v1"
FILE = "starter-staples.json"


@lru_cache(maxsize=4)
def pool_in(folder: str) -> tuple[str, ...]:
    """The pool's card names, in the content's order; none when the content has no pool."""
    path = Path(folder) / FILE
    if not path.is_file():
        return ()
    names = json.loads(path.read_text(encoding="utf-8"))["cards"]
    return tuple(dict.fromkeys(str(name) for name in names))


def pool_cards(db: Session, names: tuple[str, ...]) -> list[UUID]:
    """The catalog's card for each name of the pool, in the pool's order; a name the catalog
    lacks is left out."""
    cards: dict[str, UUID] = {}
    for card_id, name in db.execute(
        select(CardConcept.id, CardConcept.name)
        .where(CardConcept.name.in_(names))
        .order_by(CardConcept.default_printing_id.is_(None), CardConcept.id)
    ):
        cards.setdefault(name, card_id)
    return [cards[name] for name in names if name in cards]


def picks_earned(db: Session, user: User, policy: policies.StarterStaples) -> int:
    """The account's picks, from records that already exist: the wards it has won (their seals)
    and the weekly boards it has finished, each since any reset."""
    wards = db.scalar(
        select(func.count())
        .select_from(CampaignReward)
        .where(
            CampaignReward.user_id == user.id,
            CampaignReward.reward.like("seal:%"),
            since_reset(user, CampaignReward.created_at),
        )
    )
    weeks = db.scalar(
        select(func.count())
        .select_from(QuestBoard)
        .where(
            QuestBoard.user_id == user.id,
            QuestBoard.board == "weekly",
            since_reset(user, QuestBoard.completed_at),
        )
    )
    return (
        policy.initial
        + policy.per_ward * int(wards or 0)
        + policy.per_weekly_board * int(weeks or 0)
    )


def entitled(db: Session, user: User, kind: str | None = None) -> list[Entitlement]:
    """The account's entitlements that stand: not revoked, and made since any reset."""
    query = select(Entitlement).where(
        Entitlement.user_id == user.id,
        Entitlement.revoked_at.is_(None),
        since_reset(user, Entitlement.created_at),
    )
    if kind is not None:
        query = query.where(Entitlement.kind == kind)
    return list(db.scalars(query.order_by(Entitlement.created_at, Entitlement.id)))


def staple_key(user: User, card_id: UUID) -> str:
    return reset_key(user, f"staple:{user.id}:{card_id}")


def claim(db: Session, user: User, card_id: UUID, folder: str) -> Entitlement:
    """Spends a pick on a card of the pool, once (the caller commits). Refused when the pool is
    off (as a missing page), the card is not of the pool, or no pick is left."""
    policy = policies.read(db, policies.StarterStaples)
    if not policy.enabled:
        raise not_found()
    if card_id not in pool_cards(db, pool_in(folder)):
        raise ApiError(404, "not_a_staple", "That card is not in the starter-staple pool.")
    lock_account(db, user.id)
    key = staple_key(user, card_id)
    held = db.scalar(select(Entitlement).where(Entitlement.key == key))
    if held is not None and held.revoked_at is None:
        return held
    used = len(entitled(db, user, "staple"))
    if used >= picks_earned(db, user, policy):
        raise ApiError(
            409,
            "no_picks",
            "You have no pick left. Win a campaign ward or finish a weekly quest board to earn "
            "another.",
        )
    if held is not None:
        # One SysOp ended: the claim is a new fact, under a key of its own.
        key = f"{key}:{uuid4()}"
    made = Entitlement(
        user_id=user.id,
        kind="staple",
        card_id=card_id,
        copies=1,
        key=key,
        policy=POLICY,
        created_at=utcnow(),
    )
    try:
        with db.begin_nested():
            db.add(made)
    except IntegrityError:
        # The same claim, made by another request since the lock was asked for.
        found = db.scalar(select(Entitlement).where(Entitlement.key == key))
        assert found is not None
        return found
    return made


class Picks(Contract):
    earned: int
    used: int
    left: int


class Staple(Contract):
    card: CardSummary
    claimed: bool = Field(description="The account builds with it through this pool.")


class StaplePool(Contract):
    picks: Picks
    cards: list[Staple] = Field(description="The pool, in its own order.")


def pool_view(db: Session, user: User, folder: str) -> StaplePool:
    policy = policies.read(db, policies.StarterStaples)
    if not policy.enabled:
        raise not_found()
    ids = pool_cards(db, pool_in(folder))
    cards = summaries_by_id(db, set(ids))
    mine = {held.card_id for held in entitled(db, user, "staple")}
    earned = picks_earned(db, user, policy)
    return StaplePool(
        picks=Picks(earned=earned, used=len(mine), left=max(0, earned - len(mine))),
        cards=[Staple(card=cards[card_id], claimed=card_id in mine) for card_id in ids],
    )


@router.get("/me/staples", response_model=StaplePool)
def my_staples(request: Request, principal: Active, db: Db) -> StaplePool:
    """The starter-staple pool, the account's picks and what it has claimed (v0.9.12). Not found
    while the starter_staples policy is off."""
    return pool_view(db, principal.user, settings_of(request).content_dir)


@router.post("/me/staples/{card_id}", response_model=StaplePool)
def claim_staple(card_id: UUID, request: Request, principal: Active, db: Db) -> StaplePool:
    """Claims a card of the pool with a pick, once: from then on the account builds with one
    copy of it, in its default printing, without owning it. A card already claimed is answered
    as it stands."""
    folder = settings_of(request).content_dir
    claim(db, principal.user, card_id, folder)
    recheck(db, request, principal.user)
    db.commit()
    return pool_view(db, principal.user, folder)


class EntitlementView(Contract):
    id: UUID
    kind: str
    card_id: UUID
    name: str
    copies: int
    reason: str | None


class Entitlements(Contract):
    entitlements: list[EntitlementView]


class EntitlementGrant(Contract):
    card_id: UUID
    copies: int = Field(default=1, ge=1, le=4)
    reason: Annotated[StoredText, Field(min_length=3, max_length=200)]


def view_of(db: Session, user: User) -> Entitlements:
    held = entitled(db, user)
    names = dict(
        db.execute(
            select(CardConcept.id, CardConcept.name).where(
                CardConcept.id.in_({each.card_id for each in held})
            )
        ).all()
    )
    return Entitlements(
        entitlements=[
            EntitlementView(
                id=each.id,
                kind=each.kind,
                card_id=each.card_id,
                name=names.get(each.card_id, ""),
                copies=each.copies,
                reason=each.reason,
            )
            for each in held
        ]
    )


def recheck(db: Session, request: Request, user: User) -> None:
    """The account's decks checked again, now that what it builds with has changed."""
    db.flush()
    permissions = permissions_for(user, roles_of(db, user))
    refresh_decks(db, user.id, library_of(db, user, permissions, roster_of(request)))


def target(db: Session, user_id: UUID) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise not_found()
    refuse_deleted(user)
    return user


@router.get("/admin/users/{user_id}/entitlements", response_model=Entitlements)
def account_entitlements(user_id: UUID, principal: EconomyManager, db: Db) -> Entitlements:
    return view_of(db, target(db, user_id))


@router.post("/admin/users/{user_id}/entitlements", response_model=Entitlements)
def give_entitlement(
    user_id: UUID, body: EntitlementGrant, request: Request, principal: EconomyManager, db: Db
) -> Entitlements:
    """SysOp lets an account build with a card it does not own, for testing; audited. It is
    functional access, not a card: SysOp's cards for testing are grants (api/testing.py)."""
    user = target(db, user_id)
    if db.get(CardConcept, body.card_id) is None:
        raise ApiError(404, "unknown_card", "The catalog has no such card.")
    made = Entitlement(
        user_id=user.id,
        kind="staff",
        card_id=body.card_id,
        copies=body.copies,
        key=f"staff:{uuid4()}",
        policy=POLICY,
        reason=body.reason,
        actor_id=principal.user.id,
        created_at=utcnow(),
    )
    db.add(made)
    audit(
        db,
        request,
        "economy.entitlement_given",
        actor_id=principal.user.id,
        target_user_id=user.id,
        details={"card_id": str(body.card_id), "copies": body.copies, "reason": body.reason},
    )
    recheck(db, request, user)
    db.commit()
    return view_of(db, user)


@router.delete("/admin/users/{user_id}/entitlements/{entitlement_id}", response_model=Entitlements)
def end_entitlement(
    user_id: UUID, entitlement_id: UUID, request: Request, principal: EconomyManager, db: Db
) -> Entitlements:
    """SysOp ends an entitlement; audited. A deck that held the card says so when it is next
    checked, and a game already started plays on with the deck it was given."""
    user = target(db, user_id)
    held = db.get(Entitlement, entitlement_id)
    if held is None or held.user_id != user.id:
        raise not_found()
    if held.revoked_at is None:
        held.revoked_at, held.revoked_by = utcnow(), principal.user.id
        audit(
            db,
            request,
            "economy.entitlement_ended",
            actor_id=principal.user.id,
            target_user_id=user.id,
            details={"card_id": str(held.card_id), "kind": held.kind},
        )
        recheck(db, request, user)
        db.commit()
    return view_of(db, user)
