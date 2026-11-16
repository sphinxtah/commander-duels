"""Friend deck lending (v1.0.0, the specification's section 20; docs/decks.md).

A player lends one of their decks to a friend, who looks at it, accepts, and plays it at a table
without owning its cards. Nothing changes hands: the cards stay in the lender's library, a loan
is a grant of access (api/access.py), and a borrowed deck is validated against its lender's
library, never the borrower's.

The owner's decisions (2026-11-15):

- **It lasts seven days** from the day it is accepted; an offer nobody answers lapses after as
  long. The lender takes it back, or the borrower gives it back, at any time; a game already
  started plays on with the deck it started with.
- **Played only at a private table where its lender sits** (api/tables.py checks that as the
  borrower sits down, gets ready and at the start).
- **As a real deck handed over.** A deck is lent to one friend at a time, and while a loan is
  accepted its owner cannot play that deck themselves (``access.lent_out``, asked wherever a
  deck is chosen for a game: api/games.py own_deck).

**What is lent is one version.** Offering binds the deck as it stands then to an immutable
revision (the loan's scope). The friend looks at that version before accepting and plays that
version: the lender's later edits to the draft change nothing of the loan, and nothing of a
game. A deck holding the game's custom cards is not lent, as it is not shown when shared.

Behind the gate ``deck_lending``: while it is not an account's to reach, these routes answer as
paths that do not exist, and a grant it holds seats nothing.
"""

from datetime import datetime, timedelta
from typing import Literal
from uuid import UUID

from fastapi import Request
from pydantic import Field
from sqlalchemy import ColumnElement, or_, select
from sqlalchemy.orm import Session

from api import access, rollout, social
from api.auth import INPUT_ERRORS
from api.cards import CardSummary, mark_owned, summaries_by_id
from api.custom_play import without_custom
from api.decks import Builder, entries_of, owned, publish, revision_entries
from api.games import revision_seat
from api.identity import ApiError, Db, Principal, not_found, permissions_for, roles_of, utcnow
from api.library import CurrentLibrary, library_of
from api.models import AccessGrant, CardConcept, Deck, DeckRevision, User
from api.roster import roster_of
from api.schemas import Contract, Error, TableRules
from api.social import PlayerRef, player_ref
from api.validation import DeckEntry, GameFormatName

router = rollout.router("deck_lending", prefix="/api/v1", tags=["loans"], responses=INPUT_ERRORS)

LOAN_DAYS = 7
# The most decks an account has out, offered or lent, at once.
LOAN_LIMIT = 20
OPEN = ("offered", "accepted")


class LoanDeck(Contract):
    id: UUID
    title: str
    format: GameFormatName
    version: int = Field(description="The saved version the loan is of.")
    card_count: int = Field(description="Its cards, the maybeboard apart.")
    commanders: list[str]


class Loan(Contract):
    id: UUID
    deck: LoanDeck
    lender: PlayerRef
    borrower: PlayerRef
    state: Literal["offered", "accepted"] = Field(
        description="offered: it waits for the friend's answer; accepted: the friend has the "
        "deck, and its owner cannot play it."
    )
    offered_at: datetime
    until: datetime = Field(description="When it ends by itself.")
    yours: bool = Field(description="Whether the caller is its lender.")


class Loans(Contract):
    given: list[Loan] = Field(description="The caller's decks offered or lent to friends.")
    taken: list[Loan] = Field(description="Friends' decks offered or lent to the caller.")
    days: int = Field(description="How long a loan lasts once accepted.")
    limit: int = Field(description="The most decks an account has out at once.")


class LoanOffer(Contract):
    player_id: UUID = Field(description="The friend the deck is offered to.")


class LentDeck(Contract):
    """A lent deck's list, for its borrower to look at: the version the loan is of."""

    loan: Loan
    entries: list[DeckEntry]
    cards: dict[UUID, CardSummary]


def live(now: datetime) -> tuple[ColumnElement[bool], ...]:
    """The loans that are open now: offered or accepted, not ended."""
    return (
        AccessGrant.resource_kind == "deck",
        AccessGrant.consent.in_(OPEN),
        AccessGrant.revoked_at.is_(None),
        or_(AccessGrant.expires_at.is_(None), AccessGrant.expires_at > now),
    )


def revision_of(db: Session, grant: AccessGrant) -> DeckRevision | None:
    """The version a loan is of."""
    try:
        return db.get(DeckRevision, UUID(str((grant.scope or {}).get("revision"))))
    except ValueError:
        return None


def view_of(db: Session, grant: AccessGrant, viewer: UUID) -> Loan | None:
    """A loan as its two players see it; none once its deck or one of them is gone, or while
    it gives nothing because one account is not active or one blocks the other (api/access.py
    ``active`` seats nothing of it then, and its owner plays the deck)."""
    deck = db.get(Deck, grant.resource_id)
    revision = revision_of(db, grant)
    lender = db.get(User, grant.grantor_id)
    borrower = db.get(User, grant.subject_id)
    if (
        deck is None
        or deck.deleted_at is not None
        or deck.owner_id != grant.grantor_id
        or revision is None
        or lender is None
        or borrower is None
        or grant.expires_at is None
        or lender.status != "active"
        or borrower.status != "active"
        or access.blocked(db, lender.id, borrower.id)
    ):
        return None
    played = [e for e in revision_entries(db, revision) if e.location != "maybeboard"]
    commanders = [e.card_id for e in played if e.location == "commander"]
    names = dict(
        db.execute(
            select(CardConcept.id, CardConcept.name).where(CardConcept.id.in_(commanders))
        ).all()
    )
    return Loan(
        id=grant.id,
        deck=LoanDeck(
            id=deck.id,
            title=revision.title,
            format=deck.format,  # type: ignore[arg-type]
            version=revision.number,
            card_count=sum(e.quantity for e in played),
            commanders=[names[card] for card in commanders if card in names],
        ),
        lender=player_ref(lender),
        borrower=player_ref(borrower),
        state=grant.consent,  # type: ignore[arg-type]
        offered_at=grant.created_at,
        until=grant.expires_at,
        yours=grant.grantor_id == viewer,
    )


def loans_of(db: Session, user: User, now: datetime) -> Loans:
    rows = db.scalars(
        select(AccessGrant)
        .where(
            *live(now),
            or_(AccessGrant.grantor_id == user.id, AccessGrant.subject_id == user.id),
        )
        .order_by(AccessGrant.created_at.desc())
    )
    given: list[Loan] = []
    taken: list[Loan] = []
    for grant in rows:
        shown = view_of(db, grant, user.id)
        if shown is None:
            continue
        (given if shown.yours else taken).append(shown)
    return Loans(given=given, taken=taken, days=LOAN_DAYS, limit=LOAN_LIMIT)


def loan_of(db: Session, principal: Principal, loan_id: UUID, now: datetime) -> AccessGrant:
    """An open loan the caller is the lender or the borrower of; anyone else is told of none."""
    grant = db.scalar(select(AccessGrant).where(AccessGrant.id == loan_id, *live(now)))
    if grant is None or principal.user.id not in (grant.grantor_id, grant.subject_id):
        raise not_found()
    return grant


@router.get("/loans", response_model=Loans)
def my_loans(principal: Builder, db: Db) -> Loans:
    """The decks the caller has offered or lent, and those offered or lent to them."""
    return loans_of(db, principal.user, utcnow())


@router.get("/decks/{deck_id}/loans", response_model=list[Loan])
def deck_loans(deck_id: UUID, principal: Builder, db: Db) -> list[Loan]:
    """The open loan of one of the caller's decks: none, or the one (a deck is lent to one
    friend at a time)."""
    deck = owned(db, principal, deck_id)
    now = utcnow()
    rows = db.scalars(select(AccessGrant).where(*live(now), AccessGrant.resource_id == deck.id))
    return [shown for grant in rows if (shown := view_of(db, grant, principal.user.id))]


@router.post(
    "/decks/{deck_id}/loans",
    response_model=Loan,
    status_code=201,
    responses={409: {"model": Error}},
)
def offer_deck(
    deck_id: UUID,
    body: LoanOffer,
    request: Request,
    principal: Builder,
    library: CurrentLibrary,
    db: Db,
) -> Loan:
    """Offers one of the caller's decks to a friend: the deck as it stands, bound to a version.
    It must be playable, hold none of the game's custom cards, and not be offered or lent
    already. The friend is told, and has it once they accept."""
    deck = owned(db, principal, deck_id)
    now = utcnow()
    friend = db.get(User, body.player_id)
    friendly = friend is not None and db.scalar(
        select(User.id).where(User.id == friend.id, social.befriended(principal.user.id, User.id))
    )
    if friend is None or not friendly:
        raise ApiError(403, "not_a_friend", "A deck is lent to a friend.")
    out = []
    for grant in db.scalars(
        select(AccessGrant).where(*live(now), AccessGrant.grantor_id == principal.user.id)
    ).all():
        if view_of(db, grant, principal.user.id) is not None:
            out.append(grant)
        elif grant.resource_id == deck.id:
            # A loan of this deck that gives nothing and is shown to nobody (its friend's
            # account is closed, or one blocks the other) ends here, so the deck can be lent.
            access.revoke(db, grant, principal.user, now)
    already = next((grant for grant in out if grant.resource_id == deck.id), None)
    if already is not None:
        other = db.get(User, already.subject_id)
        raise ApiError(
            409,
            "already_lent",
            f"{deck.title} is already "
            f"{'lent' if already.consent == 'accepted' else 'offered'} to "
            f"{other.handle if other else 'a friend'}. Take it back to lend it again.",
        )
    if len(out) >= LOAN_LIMIT:
        raise ApiError(
            409,
            "loan_limit",
            f"An account has at most {LOAN_LIMIT} decks out at once. Take one back first.",
        )
    entries = entries_of(deck)
    if len(without_custom(db, entries)) != len(entries):
        raise ApiError(
            422, "not_lendable", f"{deck.title} holds custom cards, and those are not lent."
        )
    revision = publish(db, deck, library)
    # Playable as its owner would play it, by casual rules: a table's own rules are checked
    # where the friend sits down with it.
    revision_seat(
        db,
        deck,
        revision,
        principal.permissions,
        deck.format,
        library,
        TableRules(banned=True, not_legal=True, stand_in=True),
    )
    grant = access.offer(
        db,
        principal.user,
        friend,
        "deck",
        deck.id,
        scope={"revision": str(revision.id), "number": revision.number},
        expires_at=now + timedelta(days=LOAN_DAYS),
        now=now,
    )
    social.notify(db, friend.id, "deck_offered", principal.user.id, now)
    db.commit()
    shown = view_of(db, grant, principal.user.id)
    assert shown is not None
    return shown


@router.get("/loans/{loan_id}/deck", response_model=LentDeck)
def look(loan_id: UUID, principal: Builder, library: CurrentLibrary, db: Db) -> LentDeck:
    """The lent deck's list, for the friend it is offered or lent to: the version the loan is
    of, with how many of each card their own library holds."""
    now = utcnow()
    grant = loan_of(db, principal, loan_id, now)
    shown = view_of(db, grant, principal.user.id)
    revision = revision_of(db, grant)
    if shown is None or revision is None:
        raise not_found()
    entries = revision_entries(db, revision)
    cards = summaries_by_id(db, {entry.card_id for entry in entries})
    mark_owned(db, cards.values(), library)
    return LentDeck(loan=shown, entries=entries, cards=cards)


@router.post("/loans/{loan_id}/accept", response_model=Loans, responses={409: {"model": Error}})
def accept(loan_id: UUID, principal: Builder, db: Db) -> Loans:
    """The friend accepts: the deck is theirs to play for seven days, and its owner's to play
    again only once the loan ends."""
    now = utcnow()
    grant = loan_of(db, principal, loan_id, now)
    access.answer(db, grant, principal.user, True, now)
    grant.expires_at = now + timedelta(days=LOAN_DAYS)
    db.commit()
    return loans_of(db, principal.user, now)


@router.post("/loans/{loan_id}/decline", response_model=Loans, responses={409: {"model": Error}})
def decline(loan_id: UUID, principal: Builder, db: Db) -> Loans:
    now = utcnow()
    grant = loan_of(db, principal, loan_id, now)
    access.answer(db, grant, principal.user, False, now)
    db.commit()
    return loans_of(db, principal.user, now)


@router.delete("/loans/{loan_id}", response_model=Loans)
def end(loan_id: UUID, principal: Builder, db: Db) -> Loans:
    """Ends a loan: its lender takes the deck back, or the friend gives it back. A game already
    started with it plays on; a seat at a table that has not started must choose another deck."""
    now = utcnow()
    grant = loan_of(db, principal, loan_id, now)
    access.revoke(db, grant, principal.user, now)
    db.commit()
    return loans_of(db, principal.user, now)


def borrowed_seat(
    db: Session,
    request: Request,
    borrower: User,
    deck: Deck,
    fmt: str,
    rules: TableRules,
) -> tuple[dict[str, object], UUID, str]:
    """A deck lent to the player as the engine's deck list: the version the loan is of, checked
    against its lender's library and the table's rules. Refused in words when no loan gives the
    player the deck now, or when it can no longer be played."""
    grants = access.active(db, borrower.id, "deck", deck.id)
    grant = next((found for found in grants if found.consent == "accepted"), None)
    lender = db.get(User, deck.owner_id)
    revision = revision_of(db, grant) if grant is not None else None
    if grant is None or lender is None or revision is None:
        raise ApiError(422, "invalid_deck", "That is not one of your decks, nor one lent to you.")
    if deck.format != fmt:
        raise ApiError(422, "invalid_deck", f"{revision.title} is not a deck of this format.")
    permissions = permissions_for(lender, roles_of(db, lender))
    library = library_of(db, lender, permissions, roster_of(request))
    try:
        return revision_seat(db, deck, revision, permissions, fmt, library, rules)
    except ApiError as refused:
        if refused.code != "deck_not_playable":
            raise
        raise ApiError(
            422,
            "deck_not_playable",
            f"{revision.title} cannot be played now: {lender.handle}'s library no longer holds "
            "its cards as they lent it.",
        ) from refused
