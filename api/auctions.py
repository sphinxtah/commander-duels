"""Tivit's Auction House (v0.6.0): players auction cards to each other, as Madden Ultimate Team's
transfer market does (docs/auctions.md). The owner's rules are in the v0.6.0 plan.

- **What is sold.** One copy of one card in one edition (printing) and one finish per auction:
  a copy the seller's library was granted (a pack's, a starter deck's, a grandfathered deck's, or
  one bought here), never an alliance's, a custom card, an unopened pack or a one-of-a-kind
  printing (library.sellable_copies). Basic lands are real copies like any card since v0.6.0 and
  are sold like any. SysOp, whose library is the whole catalog, may list any printing in any
  finish it was printed in; an administrator, whose library is unlimited too, lists only the
  copies granted to it.
- **Listing** takes the copy out of the seller's library at once (the library subtracts its live
  and sold listings), so a deck that used it is collection-locked; the seller's decks are
  revalidated. Unsold, withdrawn or cancelled, the copy comes back; sold, the buyer's library is
  granted that edition and finish (source auction, key auction:<id>) and their decks revalidated.
- **Bids are held**: a bid takes its amount from the bidder's balance at once (ledger kind bid,
  key bid:<bid>), and an outbid one comes back (bid_return:<bid>). The next bid is the starting
  bid, then the current one plus 5%, at least 1 token. A bid in the last 30 seconds pushes the end
  to 30 seconds from then. A bid at or above Buy Now buys at Buy Now. Buy Now ends the auction at
  once. The seller is paid exactly the winning bid (sale:<auction>): no fee.
- **Locks.** Every change locks the auction's row first, then the accounts whose tokens move, in
  the order of their IDs (economy.lock_account), so two bids at once, a bid racing Buy Now or the
  end, and settlement racing a read queue one after the other. A listing locks its seller's row,
  so two listings never take the same copy. Every request carries a client key: a retry lands
  once.
- **Settlement.** Auctions end by time: the worker settles the ended ones every few seconds
  (settle_due), and every read settles any ended auction before it answers, so nothing shows as
  active past its end. Settling is idempotent: it re-reads the auction under its lock.
- **Withdrawing** is the seller's until the first bid; **SysOp cancels** any live auction with a
  reason (audited): the leading bid goes back, and the copy. A reset or deletion of an account
  first ends its live auctions so, and returns its own leading bids (end_auctions_of).
- **Watched, not limited**: no limit on prices. Administrators (auctions.manage) and SysOp see the
  log of every auction, sold ones with their seller, buyer and price.
"""

import math
from collections.abc import Iterable, Mapping
from datetime import date, datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import Field
from sqlalchemy import ColumnElement, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.auth import INPUT_ERRORS
from api.cards import image_of
from api.decks import refresh_decks
from api.economy import credit, hold, lock_account
from api.identity import (
    Active,
    ApiError,
    Db,
    Principal,
    audit,
    not_found,
    permissions_for,
    require_permission,
    roles_of,
    utcnow,
)
from api.library import ONE_OF_A_KIND, library_of, sellable_copies, since_reset
from api.models import (
    Auction,
    AuctionBid,
    AuctionWatch,
    AuditEvent,
    CardConcept,
    CardPrinting,
    CustomCard,
    LibraryGrant,
    User,
)
from api.roster import Planeswalker, roster_of
from api.schemas import Contract, StoredText
from api.social import AuctionKind, notify_auction
from catalog.statuses import playable
from catalog.text import normalize

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
AuctionManager = Annotated[Principal, Depends(require_permission("auctions.manage"))]
# Cancelling a live auction is SysOp's: economy.manage is SysOp's alone.
Canceller = Annotated[Principal, Depends(require_permission("economy.manage"))]
Roster = Mapping[str, Planeswalker]

Finish = Literal["nonfoil", "foil", "etched"]
Duration = Literal["1h", "3h", "12h", "24h", "3d"]
Status = Literal["active", "sold", "expired", "withdrawn", "cancelled"]
Sort = Literal["ending", "newest", "price_low", "price_high", "buy_now_low"]
Color = Literal["W", "U", "B", "R", "G", "C"]
RequestKey = Annotated[str, Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]
Reason = Annotated[StoredText, Field(min_length=3, max_length=200)]

DURATIONS: dict[str, timedelta] = {
    "1h": timedelta(hours=1),
    "3h": timedelta(hours=3),
    "12h": timedelta(hours=12),
    "24h": timedelta(hours=24),
    "3d": timedelta(days=3),
}
# A bid this close to the end pushes the end to this long after it.
SNIPE = timedelta(seconds=30)
INCREMENT_PERCENT = 5
MAX_PRICE = 10_000_000_000
MAX_QUANTITY = 20
PAGE = 24
PAGE_MAX = 60
COMPARED = 20
RECENT_SALES = 10
# The transfer list's and the targets' sections each show this many.
SHOWN = 100
# Settled per pass, by the worker or a read.
SETTLE_BATCH = 100
UNSOLD = ("expired", "withdrawn", "cancelled")


# Contracts.


class AuctionCard(Contract):
    concept_id: UUID
    printing_id: UUID
    name: str
    type_line: str
    colors: list[str] = Field(description="W, U, B, R, G; empty for a colorless card.")
    set_code: str
    set_name: str
    collector_number: str
    rarity: str
    released_at: date | None
    image: str | None = Field(description="The edition's picture on this site, as the library's.")


class AuctionItem(Contract):
    id: UUID
    card: AuctionCard
    finish: Finish
    seller: str = Field(description="The seller's handle.")
    starting_bid: int
    buy_now: int | None
    current_bid: int | None
    high_bidder: str | None
    bids: int
    next_bid: int = Field(description="The lowest bid the auction takes now.")
    duration: Duration
    created_at: datetime
    ends_at: datetime
    status: Status
    sold_price: int | None
    buyer: str | None
    mine: bool = Field(description="The viewer's own auction.")
    leading: bool = Field(description="The viewer's bid leads (or won).")
    outbid: bool = Field(description="The viewer bid, and does not lead.")
    watching: bool
    my_bid: int | None = Field(description="The viewer's highest bid.")


class AuctionPage(Contract):
    items: list[AuctionItem]
    next_cursor: str | None
    total: int


class AuctionList(Contract):
    items: list[AuctionItem]


class RecentSale(Contract):
    price: int
    sold_at: datetime


class Comparison(Contract):
    items: list[AuctionItem] = Field(description="Live listings, the lowest price first.")
    recent_sales: list[RecentSale] = Field(description="The latest sales, newest first.")


class Listing(Contract):
    printing_id: UUID
    finish: Finish
    starting_bid: int
    buy_now: int | None = None
    duration: Duration
    quantity: int = Field(default=1, ge=1, le=MAX_QUANTITY)
    key: RequestKey


class Relisting(Contract):
    starting_bid: int
    buy_now: int | None = None
    duration: Duration
    key: RequestKey


class BidRequest(Contract):
    amount: int
    key: RequestKey


class BuyNowRequest(Contract):
    key: RequestKey


class Targets(Contract):
    active: list[AuctionItem]
    won: list[AuctionItem]
    lost: list[AuctionItem] = Field(description="Ended without the viewer winning.")


class TransferList(Contract):
    active: list[AuctionItem]
    sold: list[AuctionItem]
    unsold: list[AuctionItem] = Field(
        description="Expired, withdrawn or cancelled, not relisted or cleared."
    )


class ClearTargets(Contract):
    which: Literal["won", "lost"]


class ClearList(Contract):
    which: Literal["sold", "unsold"]


class SellableItem(Contract):
    card: AuctionCard
    finish: Finish
    copies: int = Field(description="Copies held in this edition and finish.")
    sellable: int = Field(
        description="Copies that may be listed; for SysOp, the most one listing takes."
    )


class SellablePage(Contract):
    items: list[SellableItem]
    next_cursor: str | None


class Cancellation(Contract):
    reason: Reason


# What an auction shows.


def card_of(printing: CardPrinting, concept: CardConcept) -> AuctionCard:
    return AuctionCard(
        concept_id=concept.id,
        printing_id=printing.id,
        name=concept.name,
        type_line=concept.type_line,
        colors=list(concept.colors or []),
        set_code=printing.set_code,
        set_name=printing.set_name,
        collector_number=printing.collector_number,
        rarity=printing.rarity,
        released_at=printing.released_at,
        image=f"/api/v1/card-images/printings/{printing.id}?size=normal"
        if image_of(printing)
        else None,
    )


def label_of(concept: CardConcept, printing: CardPrinting, finish: str) -> str:
    """The item as the ledger's reasons name it: "Lightning Bolt (Revised Edition #162, foil)"."""
    shown = "" if finish == "nonfoil" else f", {finish}"
    return f"{concept.name} ({printing.set_name} #{printing.collector_number}{shown})"


def name_of(user: User | None) -> str:
    if user is None:
        return "A player"
    return user.handle or user.display_name or "A player"


def next_bid(auction: Auction) -> int:
    """The lowest bid the auction takes: the starting bid, then the current one and 5% more."""
    if auction.current_bid is None:
        return auction.starting_bid
    return auction.current_bid + max(1, math.ceil(auction.current_bid * INCREMENT_PERCENT / 100))


def items_of(db: Session, viewer: User, auctions: list[Auction]) -> list[AuctionItem]:
    """The auctions as the viewer sees them, in their order."""
    if not auctions:
        return []
    printings = {
        printing.id: printing
        for printing in db.scalars(
            select(CardPrinting).where(
                CardPrinting.id.in_({auction.printing_id for auction in auctions})
            )
        )
    }
    concepts = {
        concept.id: concept
        for concept in db.scalars(
            select(CardConcept).where(
                CardConcept.id.in_({printing.concept_id for printing in printings.values()})
            )
        )
    }
    people = {
        person
        for auction in auctions
        for person in (auction.seller_id, auction.high_bidder_id, auction.buyer_id)
        if person is not None
    }
    users = {user.id: user for user in db.scalars(select(User).where(User.id.in_(people)))}
    ids = [auction.id for auction in auctions]
    mine = dict(
        db.execute(
            select(AuctionBid.auction_id, func.max(AuctionBid.amount))
            .where(AuctionBid.auction_id.in_(ids), AuctionBid.bidder_id == viewer.id)
            .group_by(AuctionBid.auction_id)
        ).all()
    )
    watched = set(
        db.scalars(
            select(AuctionWatch.auction_id).where(
                AuctionWatch.user_id == viewer.id,
                AuctionWatch.auction_id.in_(ids),
                AuctionWatch.watching.is_(True),
            )
        )
    )
    items = []
    for auction in auctions:
        printing = printings[auction.printing_id]
        leading = auction.high_bidder_id == viewer.id
        my_bid = mine.get(auction.id)
        items.append(
            AuctionItem(
                id=auction.id,
                card=card_of(printing, concepts[printing.concept_id]),
                finish=auction.finish,  # type: ignore[arg-type]
                seller=name_of(users.get(auction.seller_id)),
                starting_bid=auction.starting_bid,
                buy_now=auction.buy_now,
                current_bid=auction.current_bid,
                high_bidder=name_of(users.get(auction.high_bidder_id))
                if auction.high_bidder_id
                else None,
                bids=auction.bid_count,
                next_bid=next_bid(auction),
                duration=auction.duration,  # type: ignore[arg-type]
                created_at=auction.created_at,
                ends_at=auction.ends_at,
                status=auction.status,  # type: ignore[arg-type]
                sold_price=auction.sold_price,
                buyer=name_of(users.get(auction.buyer_id)) if auction.buyer_id else None,
                mine=auction.seller_id == viewer.id,
                leading=leading,
                outbid=my_bid is not None and not leading,
                watching=auction.id in watched,
                my_bid=int(my_bid) if my_bid is not None else None,
            )
        )
    return items


def item_of(db: Session, viewer: User, auction: Auction) -> AuctionItem:
    return items_of(db, viewer, [auction])[0]


# Locks, the ledger and the library.


def locked(db: Session, auction_id: UUID) -> Auction | None:
    """The auction, read again under its row's lock until the transaction ends."""
    return db.scalar(
        select(Auction)
        .where(Auction.id == auction_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def lock_accounts(db: Session, ids: Iterable[UUID | None]) -> None:
    """The accounts' rows, in the order of their IDs, as paying a game's winners locks them."""
    for user_id in sorted({user_id for user_id in ids if user_id is not None}, key=str):
        lock_account(db, user_id)


def leading_bid(db: Session, auction: Auction) -> AuctionBid | None:
    if auction.high_bidder_id is None:
        return None
    return db.scalar(
        select(AuctionBid)
        .where(
            AuctionBid.auction_id == auction.id,
            AuctionBid.bidder_id == auction.high_bidder_id,
            AuctionBid.status == "held",
        )
        .order_by(AuctionBid.amount.desc())
        .limit(1)
        .execution_options(populate_existing=True)
    )


def what(db: Session, auction: Auction) -> tuple[CardConcept, CardPrinting]:
    printing = db.get_one(CardPrinting, auction.printing_id)
    return db.get_one(CardConcept, printing.concept_id), printing


def give_back(db: Session, bid: AuctionBid, reason: str) -> None:
    """Returns a held bid to its bidder."""
    bid.status = "returned"
    credit(db, bid.bidder_id, "bid_return", bid.amount, f"bid_return:{bid.id}", reason)


def refresh_library(db: Session, user_id: UUID, roster: Roster | None) -> None:
    """Revalidates the account's decks after its library changed (as opening a pack does)."""
    user = db.get(User, user_id)
    if user is None or user.status == "deleted" or roster is None:
        return
    permissions = permissions_for(user, roles_of(db, user))
    refresh_decks(db, user.id, library_of(db, user, permissions, dict(roster)))


def record(
    db: Session,
    request: Request | None,
    action: str,
    *,
    actor_id: UUID | None = None,
    target_user_id: UUID | None = None,
    details: dict[str, object],
) -> None:
    """An audit entry; the worker's, with no request, as the system's own."""
    if request is not None:
        audit(
            db, request, action, actor_id=actor_id, target_user_id=target_user_id, details=details
        )
        return
    db.add(
        AuditEvent(
            occurred_at=utcnow(),
            actor_id=actor_id,
            action=action,
            target_user_id=target_user_id,
            details=details,
        )
    )


def tell(
    db: Session,
    user_id: UUID | None,
    kind: AuctionKind,
    auction: Auction,
    actor_id: UUID | None,
    now: datetime,
) -> None:
    if user_id is None:
        return
    user = db.get(User, user_id)
    if user is None or user.status == "deleted":
        return
    notify_auction(db, user_id, kind, auction.id, actor_id, now)


def watch(db: Session, user_id: UUID, auction_id: UUID, now: datetime) -> None:
    row = db.get(AuctionWatch, (user_id, auction_id))
    if row is None:
        db.add(AuctionWatch(user_id=user_id, auction_id=auction_id, watching=True, created_at=now))
    else:
        row.watching = True


# Ending auctions.


def sell(
    db: Session,
    request: Request | None,
    auction: Auction,
    bid: AuctionBid,
    now: datetime,
    roster: Roster | None,
) -> None:
    """The auction sold to the bid: its hold is the payment, the seller is paid exactly that, the
    buyer's library gains the copy. The auction's row and both accounts are locked."""
    concept, printing = what(db, auction)
    buyer = db.get_one(User, bid.bidder_id)
    bid.status = "won"
    auction.status = "sold"
    auction.buyer_id = bid.bidder_id
    auction.high_bidder_id = bid.bidder_id
    auction.current_bid = bid.amount
    auction.sold_price = bid.amount
    auction.ended_at = now
    label = label_of(concept, printing, auction.finish)
    credit(
        db,
        auction.seller_id,
        "sale",
        bid.amount,
        f"sale:{auction.id}",
        f"Sold {label} to {name_of(buyer)}",
    )
    db.add(
        LibraryGrant(
            user_id=bid.bidder_id,
            concept_id=concept.id,
            printing_id=printing.id,
            finish=auction.finish,
            quantity=1,
            source="auction",
            grant_key=f"auction:{auction.id}",
            created_at=now,
        )
    )
    db.flush()
    tell(db, bid.bidder_id, "auction_won", auction, auction.seller_id, now)
    tell(db, auction.seller_id, "auction_sold", auction, bid.bidder_id, now)
    record(
        db,
        request,
        "auction.sold",
        actor_id=bid.bidder_id,
        target_user_id=auction.seller_id,
        details={
            "auction": str(auction.id),
            "printing": str(printing.id),
            "finish": auction.finish,
            "price": bid.amount,
            "buy_now": bid.buy_now,
        },
    )
    refresh_library(db, bid.bidder_id, roster)


def finish_auction(
    db: Session, request: Request | None, auction: Auction, now: datetime, roster: Roster | None
) -> None:
    """An auction past its end, its row locked: sold to the leading bid, or unsold with none."""
    bid = leading_bid(db, auction)
    if bid is None:
        auction.status = "expired"
        auction.ended_at = now
        auction.high_bidder_id = None
        auction.current_bid = None
        tell(db, auction.seller_id, "auction_unsold", auction, None, now)
        refresh_library(db, auction.seller_id, roster)
        return
    lock_accounts(db, (auction.seller_id, bid.bidder_id))
    sell(db, request, auction, bid, now, roster)


def settle(
    db: Session, auction_id: UUID, now: datetime, roster: Roster | None, request: Request | None
) -> bool:
    """Settles the auction if it ended and is not settled yet: under its lock, so twice is once."""
    auction = locked(db, auction_id)
    if auction is None or auction.status != "active" or auction.ends_at > now:
        return False
    finish_auction(db, request, auction, now, roster)
    return True


def any_due(db: Session) -> bool:
    """Whether any auction ended and waits to be settled."""
    return (
        db.scalar(
            select(Auction.id)
            .where(Auction.status == "active", Auction.ends_at <= utcnow())
            .limit(1)
        )
        is not None
    )


def settle_due(
    db: Session,
    roster: Roster | None,
    request: Request | None = None,
    ids: Iterable[UUID] | None = None,
) -> int:
    """Settles the ended auctions (among ids, if given), each in a transaction of its own."""
    now = utcnow()
    query = select(Auction.id).where(Auction.status == "active", Auction.ends_at <= now)
    if ids is not None:
        query = query.where(Auction.id.in_(list(ids)))
    due = list(db.scalars(query.order_by(Auction.ends_at).limit(SETTLE_BATCH)))
    settled = 0
    for auction_id in due:
        try:
            if settle(db, auction_id, now, roster, request):
                settled += 1
            db.commit()
        except Exception:
            db.rollback()
            raise
    return settled


def cancel(
    db: Session,
    request: Request | None,
    auction: Auction,
    now: datetime,
    reason: str,
    actor: User | None,
    roster: Roster | None,
) -> None:
    """Cancels a live auction, its row locked: the leading bid goes back, the copy too."""
    bid = leading_bid(db, auction)
    lock_accounts(db, (auction.seller_id, bid.bidder_id if bid else None))
    concept, printing = what(db, auction)
    if bid is not None:
        give_back(
            db, bid, f"Bid returned: {label_of(concept, printing, auction.finish)} (cancelled)"
        )
        tell(db, bid.bidder_id, "auction_cancelled", auction, None, now)
    auction.status = "cancelled"
    auction.ended_at = now
    auction.cancel_reason = reason
    auction.cancelled_by = actor.id if actor else None
    tell(db, auction.seller_id, "auction_cancelled", auction, None, now)
    record(
        db,
        request,
        "auction.cancelled",
        actor_id=actor.id if actor else None,
        target_user_id=auction.seller_id,
        details={
            "auction": str(auction.id),
            "printing": str(printing.id),
            "finish": auction.finish,
            "high_bid": bid.amount if bid else None,
            "reason": reason,
        },
    )
    refresh_library(db, auction.seller_id, roster)


def end_auctions_of(
    db: Session,
    user: User,
    reason: str,
    request: Request | None = None,
    roster: Roster | None = None,
) -> int:
    """Before an account's reset or deletion: its live auctions end as cancelled ones do (an ended
    one not settled yet settles as it would have), and its own leading bids go back to it. The
    auctions are locked first, by ID, then the accounts. Returns how many auctions it touched."""
    now = utcnow()
    ids = sorted(
        set(
            db.scalars(
                select(Auction.id).where(
                    Auction.status == "active",
                    (Auction.seller_id == user.id) | (Auction.high_bidder_id == user.id),
                )
            )
        ),
        key=str,
    )
    if not ids:
        return 0
    auctions = list(
        db.scalars(
            select(Auction)
            .where(Auction.id.in_(ids))
            .order_by(Auction.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    touched = 0
    for auction in sorted(auctions, key=lambda found: str(found.id)):
        if auction.status != "active":
            continue
        touched += 1
        if auction.ends_at <= now:
            if roster is not None:
                finish_auction(db, request, auction, now, roster)
        elif auction.seller_id == user.id:
            cancel(db, request, auction, now, reason, None, None)
        elif auction.high_bidder_id == user.id:
            bid = leading_bid(db, auction)
            lock_accounts(db, (user.id,))
            if bid is not None:
                concept, printing = what(db, auction)
                give_back(
                    db,
                    bid,
                    f"Bid returned: {label_of(concept, printing, auction.finish)} ({reason})",
                )
            auction.current_bid = None
            auction.high_bidder_id = None
    db.flush()
    return touched


# Listing.


def check_prices(starting_bid: int, buy_now: int | None) -> None:
    if not 1 <= starting_bid <= MAX_PRICE:
        raise ApiError(422, "invalid_price", f"The starting bid is 1 to {MAX_PRICE:,} tokens.")
    if buy_now is not None and not starting_bid < buy_now <= MAX_PRICE:
        raise ApiError(
            422,
            "invalid_price",
            f"Buy Now is more than the starting bid, at most {MAX_PRICE:,} tokens, or none.",
        )


def not_sellable(message: str) -> ApiError:
    return ApiError(422, "not_sellable", message)


def listable(
    db: Session, user: User, printing_id: UUID, finish: str, quantity: int, roster: Roster | None
) -> tuple[CardConcept, CardPrinting]:
    """The edition, if the account may list this many copies of it in this finish; refuses
    otherwise. The account's row is locked by the caller."""
    printing = db.get(CardPrinting, printing_id)
    if printing is None:
        if db.get(CustomCard, printing_id) is not None:
            raise not_sellable("The Godlike tier's custom cards cannot be sold.")
        raise not_found()
    concept = db.get_one(CardConcept, printing.concept_id)
    if printing.scryfall_id in ONE_OF_A_KIND:
        raise not_sellable(f"{concept.name} from {printing.set_name} is one of a kind: it stays.")
    if user.kind == "sysop":
        # SysOp's library is the whole catalog: in the finishes the edition was printed in. A
        # player sells the copies granted, in the finish granted.
        printed = list(printing.finishes or []) or ["nonfoil"]
        if finish not in printed:
            raise not_sellable(f"{concept.name} from {printing.set_name} was not printed {finish}.")
        return concept, printing
    available = sellable_copies(db, user, {printing.id}).get((printing.id, finish), 0)
    if available >= quantity:
        return concept, printing
    if available == 0 and finish == "nonfoil" and roster is not None:
        # An alliance's playset is in the library while the alliance lasts, and is never sold.
        permissions = permissions_for(user, roles_of(db, user))
        edition = library_of(db, user, permissions, dict(roster)).editions.get(printing.id)
        if edition is not None and edition.copies > 0 and "alliance" in edition.sources:
            raise not_sellable(
                f"{concept.name} is your alliance's: an alliance's cards cannot be sold."
            )
    raise ApiError(
        409,
        "not_enough_copies",
        f"You can sell {available} {finish} "
        f"{'copy' if available == 1 else 'copies'} of {concept.name} from {printing.set_name}.",
    )


def listed_by(db: Session, user: User, key: str) -> list[Auction]:
    return list(
        db.scalars(
            select(Auction)
            .where(Auction.seller_id == user.id, Auction.request_key == key)
            .order_by(Auction.batch_index)
        )
    )


def put_up(
    db: Session,
    request: Request,
    user: User,
    concept: CardConcept,
    printing: CardPrinting,
    finish: str,
    starting_bid: int,
    buy_now: int | None,
    duration: str,
    key: str,
    index: int,
    now: datetime,
    relisted: UUID | None = None,
) -> Auction:
    auction = Auction(
        id=uuid4(),
        seller_id=user.id,
        concept_id=concept.id,
        printing_id=printing.id,
        finish=finish,
        starting_bid=starting_bid,
        buy_now=buy_now,
        duration=duration,
        status="active",
        bid_count=0,
        request_key=key,
        batch_index=index,
        relisted_from=relisted,
        created_at=now,
        ends_at=now + DURATIONS[duration],
    )
    db.add(auction)
    record(
        db,
        request,
        "auction.listed",
        actor_id=user.id,
        details={
            "auction": str(auction.id),
            "printing": str(printing.id),
            "finish": finish,
            "starting_bid": starting_bid,
            "buy_now": buy_now,
            "duration": duration,
            "relisted_from": str(relisted) if relisted else None,
        },
    )
    return auction


# Routes: the market.


def market_filters(
    q: str | None,
    set_code: str | None,
    rarity: list[str] | None,
    finish: list[str] | None,
    card_type: str | None,
    min_bid: int | None,
    max_bid: int | None,
    min_buy_now: int | None,
    max_buy_now: int | None,
    buy_now_only: bool,
    max_time_left: int | None,
    now: datetime,
) -> list[ColumnElement[bool]]:
    price = func.coalesce(Auction.current_bid, Auction.starting_bid)
    found: list[ColumnElement[bool]] = []
    if q and normalize(q):
        found.append(CardConcept.normalized_name.contains(normalize(q), autoescape=True))
    if set_code:
        found.append(func.lower(CardPrinting.set_code) == set_code.strip().lower())
    if rarity:
        found.append(CardPrinting.rarity.in_(rarity))
    if finish:
        found.append(Auction.finish.in_(finish))
    if card_type and card_type.strip():
        found.append(
            func.lower(CardConcept.type_line).contains(card_type.strip().lower(), autoescape=True)
        )
    if min_bid is not None:
        found.append(price >= min_bid)
    if max_bid is not None:
        found.append(price <= max_bid)
    if min_buy_now is not None:
        found.append(Auction.buy_now >= min_buy_now)
    if max_buy_now is not None:
        found.append(Auction.buy_now <= max_buy_now)
    if buy_now_only:
        found.append(Auction.buy_now.is_not(None))
    if max_time_left is not None:
        found.append(Auction.ends_at <= now + timedelta(seconds=max_time_left))
    return found


def colored(colors: list[str], wanted: set[str]) -> bool:
    """A card of any colour asked for; C asks for colorless cards."""
    return bool(set(colors) & wanted) or ("C" in wanted and not colors)


def offset_of(cursor: str | None) -> int:
    if cursor is None:
        return 0
    if not cursor.isdigit() or len(cursor) > 9:
        raise ApiError(422, "invalid_cursor", "The page cursor is not valid.")
    return int(cursor)


@router.get("/auctions", response_model=AuctionPage)
def market(
    request: Request,
    principal: Active,
    db: Db,
    q: Annotated[str | None, Query(max_length=100, description="The card's name contains.")] = None,
    set_code: Annotated[str | None, Query(alias="set", max_length=16)] = None,
    rarity: Annotated[list[str] | None, Query()] = None,
    finish: Annotated[list[Finish] | None, Query()] = None,
    color: Annotated[list[Color] | None, Query()] = None,
    card_type: Annotated[str | None, Query(alias="type", max_length=64)] = None,
    min_bid: Annotated[int | None, Query(ge=0)] = None,
    max_bid: Annotated[int | None, Query(ge=0)] = None,
    min_buy_now: Annotated[int | None, Query(ge=0)] = None,
    max_buy_now: Annotated[int | None, Query(ge=0)] = None,
    buy_now_only: bool = False,
    max_time_left: Annotated[int | None, Query(ge=0, description="Seconds.")] = None,
    include_mine: bool = False,
    sort: Sort = "ending",
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=PAGE_MAX)] = PAGE,
) -> AuctionPage:
    """The transfer market: live auctions, never the viewer's own unless asked, filtered and
    sorted; bids count as the current bid, else the starting bid."""
    settle_due(db, roster_of(request), request)
    start = offset_of(cursor)
    now = utcnow()
    query = (
        select(Auction, CardConcept.colors)
        .join(CardPrinting, CardPrinting.id == Auction.printing_id)
        .join(CardConcept, CardConcept.id == Auction.concept_id)
        .where(
            Auction.status == "active",
            Auction.ends_at > now,
            *market_filters(
                q,
                set_code,
                rarity,
                list(finish) if finish else None,
                card_type,
                min_bid,
                max_bid,
                min_buy_now,
                max_buy_now,
                buy_now_only,
                max_time_left,
                now,
            ),
        )
    )
    if not include_mine:
        query = query.where(Auction.seller_id != principal.user.id)
    price = func.coalesce(Auction.current_bid, Auction.starting_bid)
    order = {
        "ending": (Auction.ends_at, Auction.id),
        "newest": (Auction.created_at.desc(), Auction.id),
        "price_low": (price, Auction.ends_at, Auction.id),
        "price_high": (price.desc(), Auction.ends_at, Auction.id),
        "buy_now_low": (Auction.buy_now.asc().nulls_last(), Auction.ends_at, Auction.id),
    }[sort]
    rows = db.execute(query.order_by(*order)).all()
    wanted: set[str] = set(color or [])
    found = [auction for auction, colors in rows if not wanted or colored(colors or [], wanted)]
    page = found[start : start + limit]
    return AuctionPage(
        items=items_of(db, principal.user, page),
        next_cursor=str(start + limit) if start + limit < len(found) else None,
        total=len(found),
    )


@router.get("/auctions/compare", response_model=Comparison)
def compare(
    printing_id: UUID, finish: Finish, request: Request, principal: Active, db: Db
) -> Comparison:
    """The same edition and finish's live listings, the lowest price first, and its last sales."""
    settle_due(db, roster_of(request), request)
    price = func.coalesce(Auction.current_bid, Auction.starting_bid)
    live = list(
        db.scalars(
            select(Auction)
            .where(
                Auction.printing_id == printing_id,
                Auction.finish == finish,
                Auction.status == "active",
            )
            .order_by(price, Auction.ends_at, Auction.id)
            .limit(COMPARED)
        )
    )
    sales = db.execute(
        select(Auction.sold_price, Auction.ended_at)
        .where(
            Auction.printing_id == printing_id,
            Auction.finish == finish,
            Auction.status == "sold",
        )
        .order_by(Auction.ended_at.desc())
        .limit(RECENT_SALES)
    ).all()
    return Comparison(
        items=items_of(db, principal.user, live),
        recent_sales=[
            RecentSale(price=int(sold), sold_at=when)
            for sold, when in sales
            if sold is not None and when is not None
        ],
    )


def with_bids_of(db: Session, user_id: UUID) -> set[UUID]:
    return set(
        db.scalars(select(AuctionBid.auction_id).where(AuctionBid.bidder_id == user_id).distinct())
    )


def target_auctions(db: Session, user: User) -> tuple[list[Auction], list[Auction], list[Auction]]:
    """The auctions the account watches or bid on, not its own: live, won and lost, the cleared
    ones and those that ended before a reset left out."""
    rows = list(db.scalars(select(AuctionWatch).where(AuctionWatch.user_id == user.id)))
    cleared = {row.auction_id for row in rows if row.cleared_at is not None}
    ids = ({row.auction_id for row in rows if row.watching} | with_bids_of(db, user.id)) - cleared
    if not ids:
        return [], [], []
    found = list(
        db.scalars(select(Auction).where(Auction.id.in_(ids), Auction.seller_id != user.id))
    )
    if user.reset_at is not None:
        found = [
            auction
            for auction in found
            if auction.ended_at is None or auction.ended_at > user.reset_at
        ]
    active = sorted(
        (auction for auction in found if auction.status == "active"),
        key=lambda auction: auction.ends_at,
    )
    ended = sorted(
        (auction for auction in found if auction.status != "active"),
        key=lambda auction: auction.ended_at or auction.ends_at,
        reverse=True,
    )
    won = [auction for auction in ended if auction.buyer_id == user.id]
    lost = [auction for auction in ended if auction.buyer_id != user.id]
    return active[:SHOWN], won[:SHOWN], lost[:SHOWN]


@router.get("/auctions/targets", response_model=Targets)
def targets(request: Request, principal: Active, db: Db) -> Targets:
    """The transfer targets: auctions the viewer watches or bid on, live, won and lost."""
    settle_due(db, roster_of(request), request)
    active, won, lost = target_auctions(db, principal.user)
    return Targets(
        active=items_of(db, principal.user, active),
        won=items_of(db, principal.user, won),
        lost=items_of(db, principal.user, lost),
    )


@router.post("/auctions/targets/clear", status_code=204)
def clear_targets(body: ClearTargets, request: Request, principal: Active, db: Db) -> Response:
    """Hides the won or the lost auctions from the transfer targets."""
    settle_due(db, roster_of(request), request)
    _, won, lost = target_auctions(db, principal.user)
    now = utcnow()
    for auction in won if body.which == "won" else lost:
        row = db.get(AuctionWatch, (principal.user.id, auction.id))
        if row is None:
            db.add(
                AuctionWatch(
                    user_id=principal.user.id,
                    auction_id=auction.id,
                    watching=False,
                    cleared_at=now,
                    created_at=now,
                )
            )
        else:
            row.cleared_at = now
    db.commit()
    return Response(status_code=204)


def own_auctions(db: Session, user: User) -> tuple[list[Auction], list[Auction], list[Auction]]:
    found = list(
        db.scalars(
            select(Auction).where(
                Auction.seller_id == user.id, since_reset(user, Auction.created_at)
            )
        )
    )
    relisted = {auction.relisted_from for auction in found if auction.relisted_from}
    active = sorted(
        (auction for auction in found if auction.status == "active"),
        key=lambda auction: auction.ends_at,
    )
    ended = sorted(
        (
            auction
            for auction in found
            if auction.status != "active" and auction.seller_cleared_at is None
        ),
        key=lambda auction: auction.ended_at or auction.ends_at,
        reverse=True,
    )
    sold = [auction for auction in ended if auction.status == "sold"]
    unsold = [
        auction for auction in ended if auction.status in UNSOLD and auction.id not in relisted
    ]
    return active[:SHOWN], sold[:SHOWN], unsold[:SHOWN]


@router.get("/auctions/mine", response_model=TransferList)
def transfer_list(request: Request, principal: Active, db: Db) -> TransferList:
    """The transfer list: the viewer's auctions, live, sold, and unsold ones to relist."""
    settle_due(db, roster_of(request), request)
    active, sold, unsold = own_auctions(db, principal.user)
    return TransferList(
        active=items_of(db, principal.user, active),
        sold=items_of(db, principal.user, sold),
        unsold=items_of(db, principal.user, unsold),
    )


@router.post("/auctions/mine/clear", status_code=204)
def clear_list(body: ClearList, request: Request, principal: Active, db: Db) -> Response:
    """Hides the sold or the unsold auctions from the transfer list."""
    settle_due(db, roster_of(request), request)
    _, sold, unsold = own_auctions(db, principal.user)
    now = utcnow()
    for auction in sold if body.which == "sold" else unsold:
        auction.seller_cleared_at = now
    db.commit()
    return Response(status_code=204)


@router.get("/auctions/sellable", response_model=SellablePage)
def sellable(
    principal: Active,
    db: Db,
    q: Annotated[str | None, Query(max_length=100)] = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=PAGE_MAX)] = PAGE,
) -> SellablePage:
    """What the viewer may list, by edition and finish, by name: copies granted to it, less those
    listed; for SysOp, any printing the game can play, in each finish it was printed in."""
    user = principal.user
    start = offset_of(cursor)
    wanted = normalize(q) if q else ""
    if user.kind == "sysop":
        query = (
            select(CardPrinting, CardConcept)
            .join(CardConcept, CardConcept.id == CardPrinting.concept_id)
            .where(playable(), CardPrinting.scryfall_id.not_in(list(ONE_OF_A_KIND)))
            .order_by(
                CardConcept.normalized_name,
                CardPrinting.released_at.desc().nulls_last(),
                CardPrinting.id,
            )
        )
        if wanted:
            query = query.where(CardConcept.normalized_name.contains(wanted, autoescape=True))
        rows = db.execute(query.offset(start).limit(limit + 1)).all()
        held = sellable_copies(db, user, {printing.id for printing, _ in rows})
        return SellablePage(
            items=[
                SellableItem(
                    card=card_of(printing, concept),
                    finish=finish,  # type: ignore[arg-type]
                    copies=held.get((printing.id, finish), 0),
                    sellable=MAX_QUANTITY,
                )
                for printing, concept in rows[:limit]
                for finish in list(printing.finishes or []) or ["nonfoil"]
                if finish in ("nonfoil", "foil", "etched")
            ],
            next_cursor=str(start + limit) if len(rows) > limit else None,
        )
    copies = sellable_copies(db, user)
    if not copies:
        return SellablePage(items=[], next_cursor=None)
    printings = {
        printing.id: (printing, concept)
        for printing, concept in db.execute(
            select(CardPrinting, CardConcept)
            .join(CardConcept, CardConcept.id == CardPrinting.concept_id)
            .where(CardPrinting.id.in_({printing for printing, _ in copies}))
        )
    }
    lines = sorted(
        (
            (printings[printing][0], printings[printing][1], finish, count)
            for (printing, finish), count in copies.items()
            if printing in printings
            and (not wanted or wanted in printings[printing][1].normalized_name)
        ),
        key=lambda line: (
            line[1].normalized_name,
            -(line[0].released_at.toordinal() if line[0].released_at else 0),
            line[0].set_code,
            line[0].collector_number,
            ("nonfoil", "foil", "etched").index(line[2]),
        ),
    )
    page = lines[start : start + limit]
    held_now = held_by_finish(db, principal, {line[0].id for line in page})
    return SellablePage(
        items=[
            SellableItem(
                card=card_of(printing, concept),
                finish=finish,  # type: ignore[arg-type]
                copies=max(count, held_now.get((printing.id, finish), count)),
                sellable=count,
            )
            for printing, concept, finish, count in page
        ],
        next_cursor=str(start + limit) if start + limit < len(lines) else None,
    )


def held_by_finish(
    db: Session, principal: Principal, printings: set[UUID]
) -> dict[tuple[UUID, str], int]:
    """The copies the library holds of these editions by finish, an alliance's among them."""
    if not printings:
        return {}
    library = library_of(db, principal.user, principal.permissions, {})
    return {
        (printing, finish): count
        for printing, finishes in library.finishes.items()
        if printing in printings
        for finish, count in finishes.items()
    }


@router.get("/auctions/{auction_id}", response_model=AuctionItem)
def auction(auction_id: UUID, request: Request, principal: Active, db: Db) -> AuctionItem:
    """One auction, in any state."""
    settle_due(db, roster_of(request), request, ids=[auction_id])
    found = db.get(Auction, auction_id)
    if found is None:
        raise not_found()
    return item_of(db, principal.user, found)


# Routes: listing, bidding, withdrawing, watching.


@router.post("/auctions", response_model=AuctionList, status_code=201)
def list_cards(body: Listing, request: Request, principal: Active, db: Db) -> AuctionList:
    """Lists copies of one edition in one finish, an auction each: they leave the library at once.
    A retried request (the same key) lists nothing more and answers with what it listed."""
    check_prices(body.starting_bid, body.buy_now)
    user = principal.user
    lock_account(db, user.id)
    db.refresh(user)
    earlier = listed_by(db, user, body.key)
    if earlier:
        return AuctionList(items=items_of(db, user, earlier))
    concept, printing = listable(
        db, user, body.printing_id, body.finish, body.quantity, roster_of(request)
    )
    now = utcnow()
    made = [
        put_up(
            db,
            request,
            user,
            concept,
            printing,
            body.finish,
            body.starting_bid,
            body.buy_now,
            body.duration,
            body.key,
            index,
            now,
        )
        for index in range(body.quantity)
    ]
    db.flush()
    refresh_library(db, user.id, roster_of(request))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        earlier = listed_by(db, user, body.key)
        if not earlier:
            raise
        return AuctionList(items=items_of(db, user, earlier))
    return AuctionList(items=items_of(db, user, made))


def bid_by_key(db: Session, user: User, key: str) -> AuctionBid | None:
    return db.scalar(
        select(AuctionBid).where(AuctionBid.bidder_id == user.id, AuctionBid.request_key == key)
    )


def place(
    db: Session,
    request: Request,
    principal: Principal,
    auction_id: UUID,
    amount: int | None,
    key: str,
) -> AuctionItem:
    """A bid (amount), or Buy Now (no amount). The auction's row is locked first, then the
    accounts: the bidder's, the leading bidder's, and on a sale the seller's."""
    user = principal.user
    roster = roster_of(request)
    earlier = bid_by_key(db, user, key)
    if earlier is not None:
        if earlier.auction_id != auction_id:
            raise ApiError(409, "key_reused", "That key placed a bid on another auction.")
        settle_due(db, roster, request, ids=[auction_id])
        return item_of(db, user, db.get_one(Auction, auction_id))
    if amount is not None and not 1 <= amount <= MAX_PRICE:
        raise ApiError(422, "invalid_price", f"A bid is 1 to {MAX_PRICE:,} tokens.")
    auction = locked(db, auction_id)
    if auction is None:
        raise not_found()
    now = utcnow()
    if auction.status == "active" and auction.ends_at <= now:
        finish_auction(db, request, auction, now, roster)
        db.commit()
    if auction.status != "active":
        raise ApiError(409, "auction_ended", "This auction has ended.")
    if auction.seller_id == user.id:
        raise ApiError(409, "own_auction", "You cannot bid on your own auction.")
    if amount is None:
        if auction.buy_now is None:
            raise ApiError(409, "no_buy_now", "This auction has no Buy Now price.")
        price = auction.buy_now
    else:
        if auction.high_bidder_id == user.id:
            raise ApiError(409, "already_leading", "Your bid leads already.")
        minimum = next_bid(auction)
        if amount < minimum:
            raise ApiError(409, "bid_too_low", f"The next bid is at least {minimum:,} tokens.")
        price = amount if auction.buy_now is None else min(amount, auction.buy_now)
    buying = auction.buy_now is not None and price >= auction.buy_now
    previous = leading_bid(db, auction)
    lock_accounts(
        db,
        (user.id, previous.bidder_id if previous else None, auction.seller_id if buying else None),
    )
    concept, printing = what(db, auction)
    label = label_of(concept, printing, auction.finish)
    # The leading bid goes back first, so a leader buying it now counts its own tokens.
    if previous is not None:
        give_back(db, previous, f"Outbid on {label}")
        if previous.bidder_id != user.id:
            tell(db, previous.bidder_id, "auction_outbid", auction, user.id, now)
    bid = AuctionBid(
        id=uuid4(),
        auction_id=auction.id,
        bidder_id=user.id,
        amount=price,
        buy_now=buying,
        status="held",
        request_key=key,
        created_at=now,
    )
    db.add(bid)
    db.flush()
    hold(db, user.id, price, f"bid:{bid.id}", f"{'Bought' if buying else 'Bid on'} {label}")
    auction.current_bid = price
    auction.high_bidder_id = user.id
    auction.bid_count += 1
    watch(db, user.id, auction.id, now)
    if buying:
        sell(db, request, auction, bid, now, roster)
    elif auction.ends_at - now < SNIPE:
        auction.ends_at = now + SNIPE
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        earlier = bid_by_key(db, user, key)
        if earlier is None:
            raise
    return item_of(db, user, db.get_one(Auction, auction_id))


@router.post("/auctions/{auction_id}/bids", response_model=AuctionItem)
def make_bid(
    auction_id: UUID, body: BidRequest, request: Request, principal: Active, db: Db
) -> AuctionItem:
    """A bid: held from the balance at once, the leading bid returned to its bidder; at or above
    Buy Now it buys at Buy Now; in the last 30 seconds it pushes the end to 30 seconds away."""
    return place(db, request, principal, auction_id, body.amount, body.key)


@router.post("/auctions/{auction_id}/buy-now", response_model=AuctionItem)
def buy_now(
    auction_id: UUID, body: BuyNowRequest, request: Request, principal: Active, db: Db
) -> AuctionItem:
    """Buys at the Buy Now price: the auction ends at once, the leading bid returned."""
    return place(db, request, principal, auction_id, None, body.key)


def own_locked(db: Session, request: Request, user: User, auction_id: UUID) -> Auction:
    """The viewer's own auction under its lock, settled first if it ended."""
    auction = locked(db, auction_id)
    if auction is None:
        raise not_found()
    if auction.seller_id != user.id:
        raise ApiError(403, "not_your_auction", "Only its seller can do that.")
    now = utcnow()
    if auction.status == "active" and auction.ends_at <= now:
        finish_auction(db, request, auction, now, roster_of(request))
        db.commit()
        auction = locked(db, auction_id)
        assert auction is not None
    return auction


@router.delete("/auctions/{auction_id}", response_model=AuctionItem)
def withdraw(auction_id: UUID, request: Request, principal: Active, db: Db) -> AuctionItem:
    """The seller withdraws the auction, until its first bid: the copy comes back."""
    user = principal.user
    auction = own_locked(db, request, user, auction_id)
    if auction.status != "active":
        raise ApiError(409, "auction_ended", "This auction has ended.")
    if auction.high_bidder_id is not None:
        raise ApiError(409, "has_bids", "This auction has a bid: it runs to its end.")
    auction.status = "withdrawn"
    auction.ended_at = utcnow()
    record(
        db,
        request,
        "auction.withdrawn",
        actor_id=user.id,
        details={"auction": str(auction.id), "printing": str(auction.printing_id)},
    )
    db.flush()
    refresh_library(db, user.id, roster_of(request))
    db.commit()
    return item_of(db, user, auction)


@router.post("/auctions/{auction_id}/relist", response_model=AuctionItem, status_code=201)
def relist(
    auction_id: UUID, body: Relisting, request: Request, principal: Active, db: Db
) -> AuctionItem:
    """A new auction for an unsold auction's copy, if the library still holds it."""
    check_prices(body.starting_bid, body.buy_now)
    user = principal.user
    earlier = listed_by(db, user, body.key)
    if earlier:
        return item_of(db, user, earlier[0])
    old = own_locked(db, request, user, auction_id)
    lock_account(db, user.id)
    db.refresh(user)
    if old.status not in UNSOLD:
        raise ApiError(409, "not_relistable", "Only an unsold auction can be relisted.")
    if db.scalar(select(Auction.id).where(Auction.relisted_from == old.id)) is not None:
        raise ApiError(409, "not_relistable", "This auction was relisted already.")
    concept, printing = listable(db, user, old.printing_id, old.finish, 1, roster_of(request))
    now = utcnow()
    made = put_up(
        db,
        request,
        user,
        concept,
        printing,
        old.finish,
        body.starting_bid,
        body.buy_now,
        body.duration,
        body.key,
        0,
        now,
        relisted=old.id,
    )
    db.flush()
    refresh_library(db, user.id, roster_of(request))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        earlier = listed_by(db, user, body.key)
        if not earlier:
            raise
        return item_of(db, user, earlier[0])
    return item_of(db, user, made)


@router.put("/auctions/{auction_id}/watch", status_code=204)
def start_watching(auction_id: UUID, principal: Active, db: Db) -> Response:
    if db.get(Auction, auction_id) is None:
        raise not_found()
    watch(db, principal.user.id, auction_id, utcnow())
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
    return Response(status_code=204)


@router.delete("/auctions/{auction_id}/watch", status_code=204)
def stop_watching(auction_id: UUID, principal: Active, db: Db) -> Response:
    row = db.get(AuctionWatch, (principal.user.id, auction_id))
    if row is not None:
        row.watching = False
        db.commit()
    return Response(status_code=204)


# Administration: the log, and SysOp's cancellation.


@router.get("/admin/auctions", response_model=AuctionPage)
def auction_log(
    request: Request,
    principal: AuctionManager,
    db: Db,
    status: Status | None = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=PAGE_MAX)] = 50,
) -> AuctionPage:
    """Every auction, newest first: with status=sold the log of sales (seller, buyer, card,
    edition, finish, price, time); cancelled ones with their reason in the audit trail."""
    settle_due(db, roster_of(request), request)
    start = offset_of(cursor)
    query = select(Auction)
    counted = select(func.count()).select_from(Auction)
    if status is not None:
        query = query.where(Auction.status == status)
        counted = counted.where(Auction.status == status)
    total = int(db.scalar(counted) or 0)
    page = list(
        db.scalars(query.order_by(Auction.created_at.desc(), Auction.id).offset(start).limit(limit))
    )
    return AuctionPage(
        items=items_of(db, principal.user, page),
        next_cursor=str(start + limit) if start + limit < total else None,
        total=total,
    )


@router.post("/admin/auctions/{auction_id}/cancel", response_model=AuctionItem)
def cancel_auction(
    auction_id: UUID, body: Cancellation, request: Request, principal: Canceller, db: Db
) -> AuctionItem:
    """SysOp cancels a live auction, with a reason: the leading bid goes back, the copy too."""
    roster = roster_of(request)
    auction = locked(db, auction_id)
    if auction is None:
        raise not_found()
    now = utcnow()
    if auction.status == "active" and auction.ends_at <= now:
        finish_auction(db, request, auction, now, roster)
        db.commit()
    if auction.status != "active":
        raise ApiError(409, "auction_ended", "This auction has ended.")
    cancel(db, request, auction, now, body.reason, principal.user, roster)
    db.commit()
    return item_of(db, principal.user, auction)
