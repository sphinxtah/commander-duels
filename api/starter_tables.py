"""A starter deck bought at the table (v1.0.0, the owner's request; docs/tables.md).

The owner, 2026-11-14: "I want a gameplay option where when you get to the table, you purchase a
starter deck of whichever edition you want (Leng prices, no discounts, unless the deck is already
on weekly discount), and you play that deck at the table. You can play humans or bots in that
gameplay mode, with legacy or commander as the option, which will limit the starter decks allowed
to purchase."

What a starter-deck table is, and where each part lives:

- **The offers** (here): the decks Leng sells for the table's format. A Legacy table offers the
  products that are decks (shop.DECK_KINDS: Starter Decks, Tournament Packs and Tournament Decks),
  a Commander table Leng's ten starter decks. Each at Leng's price; the week's sale price where
  the product is on sale, and no other discount. A sold-out product is not offered.
- **The purchase** (here): one request spends the tokens, puts the cards in the library as the
  shop does, and makes a deck of them, bound to the revision it came as. A Commander starter the
  account already owns is bought again (the owner's decision): only this purchase lifts the
  shop's rule that each sells once. It is keyed, so a retry buys once.
- **The game** (api/games.py, api/tables.py): the deck sits down at a starter-deck table or, from
  the Play wizard, at a starter-deck game against the bots. It plays as it came: such a table's
  rules are casual, and it sets aside the limit of four copies, since a Legacy starter is 60
  random cards of its edition. Only the revision the purchase made plays so: a deck changed since
  is refused. The bots play starter decks of the same kind at no cost: a Commander starter each,
  or a Legacy starter rolled for the game from a product on the shelf, which grants nothing and
  takes nothing from a print run.
- **One table a purchase.** A purchase sits down at one table of people: once that table's game
  has started, it sits at no other. Before that it may move (the table closed, the player left).
  Against the bots the deck may be played again, as a rematch plays it.
- **What it earns** is what its game earns as any table's or practice game: nothing of the
  economy changes.

It is a workflow behind a gate of its own (api/rollout.py, ``starter_tables``): off until SysOp
stages it, so it can be tried at ``staff`` first. The routes here are made on its router; where a
table or a game is asked to be one, ``require`` asks the same gate.
"""

import random
import secrets
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import Depends, Query, Request
from pydantic import Field
from sqlalchemy import not_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api import pack_supply as supply
from api import rollout
from api.auth import INPUT_ERRORS
from api.collation import draw, load
from api.decks import create_deck, publish, starters_of
from api.economy import balance_of, lock_account, spend
from api.identity import (
    ApiError,
    Db,
    Principal,
    not_found,
    require_permission,
    settings_of,
    utcnow,
)
from api.library import grant_deck, library_of, one_of_a_kind, starter_entries
from api.models import (
    CardConcept,
    CardPrinting,
    Deck,
    GameTable,
    Pack,
    PackOpening,
    ShopProduct,
    StarterPurchase,
    User,
)
from api.print_runs import dealt, limited
from api.products import deck_prices, kind_of, price_of, selling
from api.roster import roster_of
from api.sales import weekly_sale
from api.schemas import Contract
from api.shop import (
    DECK_KINDS,
    DeckCard,
    ProductRef,
    RequestKey,
    art_of,
    deck_offers,
    free_decks,
    free_title,
    open_pack,
    opening_deck,
    products_of,
    ref_of,
    refuse_sold_out,
    revealed_deck,
)
from api.validation import DeckEntry
from catalog.statuses import in_game

WORKFLOW = "starter_tables"
StarterFormat = Literal["legacy", "commander"]
FORMATS: tuple[str, ...] = ("legacy", "commander")
# What refuses a deck's copies beyond four: the one rule of deck building such a table sets aside.
COPY_LIMIT = "deck.copy_limit"
# The Legacy products tried for a bot's deck before the engine's own deck plays instead.
BOT_ROLLS = 4

router = rollout.router(WORKFLOW, prefix="/api/v1", responses=INPUT_ERRORS)
Builder = Annotated[Principal, Depends(require_permission("decks.edit"))]


class StarterOffer(Contract):
    """A deck Leng sells that a starter-deck table of the format takes."""

    id: str = Field(description="A Commander starter deck's ID, or a Legacy deck product's.")
    format: StarterFormat
    title: str
    detail: str = Field(
        description="A Commander starter's commander and colours; a Legacy product's edition "
        "and size."
    )
    price: int = Field(
        description="What it costs now, in tokens: Leng's price, or the week's sale price."
    )
    list_price: int = Field(description="Leng's price, the sale aside.")
    on_sale: bool = Field(description="In this week's sale.")
    affordable: bool = Field(description="Whether the account's tokens buy it now.")
    owned: bool = Field(
        default=False,
        description="A Commander starter the account has already: here it is bought again.",
    )
    commander_printing_id: UUID | None = Field(
        default=None, description="A Commander starter's commander's picture."
    )
    product: ProductRef | None = Field(
        default=None, description="A Legacy product, as the shop shows it."
    )


class StarterOffers(Contract):
    format: StarterFormat
    balance: int
    offers: list[StarterOffer]
    short: int = Field(
        description="The tokens the account lacks for the cheapest deck on offer; 0 when it can "
        "buy one, or none is on offer. A player who can buy none cannot sit down."
    )


class StarterPurchaseRequest(Contract):
    format: StarterFormat
    offer: str = Field(min_length=1, max_length=64, description="The offer's ID.")
    key: RequestKey = Field(description="The client's key for this purchase: a retry buys once.")


class StarterBought(Contract):
    id: UUID
    format: StarterFormat
    offer: str
    title: str
    deck_id: UUID = Field(description="The deck it made, which the table plays as it came.")
    tokens: int = Field(description="The price paid.")
    sale: bool
    balance: int
    opening_id: UUID | None = Field(
        description="A Legacy product's opening, to reveal as a pack is (GET /shop/openings/"
        "{id}); null for a Commander starter."
    )
    cards: list[DeckCard] = Field(
        default_factory=list,
        description="A Commander starter's cards as a pack reveals them, the commander last; "
        "empty for a Legacy product, whose opening holds them, and on a retry.",
    )
    repeated: bool = Field(description="A retry: it was bought already.")


# The gate, for the games and the tables.


def available(db: Session, user: User | None) -> bool:
    return rollout.available(db, WORKFLOW, user)


def require(db: Session, user: User | None) -> None:
    """Refuses a starter-deck table or game while the workflow is not the account's to reach, as
    something that does not exist."""
    rollout.require(db, WORKFLOW, user)


# The offers.


def legacy_products(request: Request, db: Session) -> list[ShopProduct]:
    """The Legacy deck products on sale now, the newest first."""
    today = utcnow().date()
    found = [
        product
        for product in products_of(request, db)
        if DECK_KINDS.get(kind_of(product.booster)) == "legacy" and selling(product, today)
    ]
    return sorted(found, key=lambda product: (product.released or today, product.name))[::-1]


def offers_of(db: Session, request: Request, user: User, fmt: str) -> StarterOffers:
    balance = balance_of(db, user.id)
    offers: list[StarterOffer] = []
    if fmt == "commander":
        for deck in deck_offers(request, db, user):
            if deck.price is None:
                continue
            offers.append(
                StarterOffer(
                    id=deck.id,
                    format="commander",
                    title=deck.title,
                    detail=f"{deck.commander} · {deck.color_names}",
                    price=deck.price,
                    list_price=deck.price,
                    on_sale=False,
                    affordable=deck.price <= balance,
                    owned=deck.owned,
                    commander_printing_id=deck.commander_printing_id,
                )
            )
    else:
        products = legacy_products(request, db)
        sale = weekly_sale(db, products_of(request, db), utcnow())
        # SysOp's packs are not counted against a print run, so nothing is sold out for it.
        gone = (
            set()
            if user.kind == "sysop"
            else supply.sold_out(db, settings_of(request).content_dir, products)
        )
        art = art_of(request)
        for product in products:
            if str(product.id) in gone:
                continue
            listed, _ = price_of(product)
            discounted = sale.price(product.id, listed)
            price = listed if discounted is None else discounted
            offers.append(
                StarterOffer(
                    id=str(product.id),
                    format="legacy",
                    title=product.name,
                    detail=f"{product.set_code.upper()} · {product.pack_size} cards",
                    price=price,
                    list_price=listed,
                    on_sale=discounted is not None,
                    affordable=price <= balance,
                    product=ref_of(product, art),
                )
            )
    cheapest = min((offer.price for offer in offers), default=None)
    return StarterOffers(
        format=fmt,  # type: ignore[arg-type]
        balance=balance,
        offers=offers,
        short=max(0, cheapest - balance) if cheapest is not None else 0,
    )


@router.get("/starter-decks", response_model=StarterOffers)
def starter_decks(
    request: Request,
    principal: Builder,
    db: Db,
    format: Annotated[StarterFormat, Query()] = "commander",
) -> StarterOffers:
    """The starter decks a starter-deck table of the format takes, each at what it costs now,
    with the account's tokens and what it lacks for the cheapest."""
    return offers_of(db, request, principal.user, format)


# The purchase.


def bought_view(
    db: Session, purchase: StarterPurchase, cards: list[DeckCard], repeated: bool
) -> StarterBought:
    return StarterBought(
        id=purchase.id,
        format=purchase.format,  # type: ignore[arg-type]
        offer=purchase.offer,
        title=purchase.title,
        deck_id=purchase.deck_id,
        tokens=purchase.tokens,
        sale=purchase.sale,
        balance=balance_of(db, purchase.user_id),
        opening_id=purchase.opening_id,
        cards=cards,
        repeated=repeated,
    )


def earlier_purchase(db: Session, user_id: UUID, key: str) -> StarterPurchase | None:
    return db.scalar(
        select(StarterPurchase).where(
            StarterPurchase.user_id == user_id, StarterPurchase.request_key == key
        )
    )


def buy_commander(
    db: Session, request: Request, principal: Principal, offer: str, purchase_id: UUID
) -> tuple[Deck, str, int, list[DeckCard]]:
    """Leng's starter deck, bought for a table: its price, every copy of its cards under the
    purchase's own key (so one already owned is granted again), and a deck of it."""
    user = principal.user
    starter = starters_of(request).get(offer)
    if starter is None:
        raise not_found()
    price = deck_prices(settings_of(request).content_dir).get(starter.id)
    if price is None:
        raise ApiError(409, "not_on_sale", f"{starter.title} is not on sale.")
    entries, missing = starter_entries(db, starter)
    if missing:
        raise ApiError(
            503,
            "starters_unavailable",
            "The card catalog is not ready for the starter decks yet. Try again later.",
        )
    spend(db, user.id, price, f"starter-table:{purchase_id}", f"Starter deck: {starter.title}")
    cards = revealed_deck(db, entries, user)
    grant_deck(db, user, f"starter-table:{purchase_id}", entries, "starter")
    db.flush()
    library = library_of(db, user, principal.permissions, roster_of(request))
    deck, _ = create_deck(
        db,
        principal,
        free_title(db, user.id, starter.title),
        "commander",
        entries,
        library,
        source="starter",
    )
    return deck, starter.title, price, cards


def buy_legacy(
    db: Session, request: Request, principal: Principal, offer: str
) -> tuple[Deck, str, int, bool, PackOpening]:
    """A Legacy deck product, bought for a table as the shop sells it (the week's sale price where
    it is on sale), opened at once, and its cards kept together as a deck."""
    user = principal.user
    try:
        product_id = UUID(offer)
    except ValueError:
        raise not_found() from None
    product = db.get(ShopProduct, product_id)
    if product is None or DECK_KINDS.get(kind_of(product.booster)) != "legacy":
        raise not_found()
    if not selling(product, utcnow().date()):
        raise ApiError(409, "not_on_sale", f"{product.name} is not on sale.")
    refuse_sold_out(db, request, user, product, 1)
    sale = weekly_sale(db, products_of(request, db), utcnow())
    price, _ = price_of(product)
    discounted = sale.price(product.id, price)
    if discounted is not None:
        price = discounted
    pack = Pack(
        id=uuid4(),
        user_id=user.id,
        product_id=product.id,
        source="purchase",
        tokens=price,
        sale=discounted is not None,
        created_at=utcnow(),
    )
    db.add(pack)
    db.flush()
    reason = (
        product.name if discounted is None else f"{product.name} (weekly sale, {sale.percent}% off)"
    )
    spend(db, user.id, price, f"pack:{pack.id}", reason)
    opening = open_pack(request, db, principal, pack)
    # Packs opened earn achievements (v0.5.0). Imported here: api.achievements reaches far.
    from api.achievements import catch_up

    catch_up(db, user, opening.created_at)
    deck = opening_deck(db, request, principal, opening, product)
    return deck, product.name, price, discounted is not None, opening


def buy(
    db: Session, request: Request, principal: Principal, body: StarterPurchaseRequest
) -> StarterBought:
    user = principal.user
    # The week's sale is drawn (and committed) before the purchase's own transaction, if no
    # request has drawn it yet.
    weekly_sale(db, products_of(request, db), utcnow())
    # The account's row is locked first, so a retry waits for the request it repeats.
    lock_account(db, user.id)
    db.refresh(user)
    earlier = earlier_purchase(db, user.id, body.key)
    if earlier is not None:
        if earlier.offer != body.offer or earlier.format != body.format:
            raise ApiError(409, "key_reused", "That purchase key bought another deck.")
        return bought_view(db, earlier, [], True)
    if free_decks(user):
        raise ApiError(
            409, "starters_first", "Choose your two free starter decks first: they cost nothing."
        )
    purchase_id = uuid4()
    cards: list[DeckCard] = []
    opening: PackOpening | None = None
    on_sale = False
    if body.format == "commander":
        deck, title, price, cards = buy_commander(db, request, principal, body.offer, purchase_id)
    else:
        deck, title, price, on_sale, opening = buy_legacy(db, request, principal, body.offer)
    # The deck as it came: the revision a starter-deck table plays.
    library = library_of(db, user, principal.permissions, roster_of(request))
    revision = publish(db, deck, library)
    purchase = StarterPurchase(
        id=purchase_id,
        user_id=user.id,
        request_key=body.key,
        format=body.format,
        offer=body.offer,
        title=title[:160],
        deck_id=deck.id,
        revision_id=revision.id,
        opening_id=opening.id if opening is not None else None,
        tokens=price,
        sale=on_sale,
        created_at=utcnow(),
    )
    db.add(purchase)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        earlier = earlier_purchase(db, user.id, body.key)
        if earlier is None:
            raise
        return bought_view(db, earlier, [], True)
    return bought_view(db, purchase, cards, False)


@router.post("/starter-decks/purchases", response_model=StarterBought, status_code=201)
def buy_starter_deck(
    body: StarterPurchaseRequest, request: Request, principal: Builder, db: Db
) -> StarterBought:
    """Buys a starter deck to play at a starter-deck table, or against the bots from the Play
    wizard: the tokens are spent, the cards join the library and a deck is made of them, together.
    A Commander starter already owned is bought again. The deck then sits down by its ID."""
    return buy(db, request, principal, body)


# The deck at the table.


def purchase_of(db: Session, user_id: UUID, deck_id: UUID) -> StarterPurchase | None:
    """The purchase that made the deck, if one did."""
    return db.scalar(
        select(StarterPurchase)
        .where(StarterPurchase.user_id == user_id, StarterPurchase.deck_id == deck_id)
        .order_by(StarterPurchase.created_at.desc())
        .limit(1)
    )


def bought_for(db: Session, user: User, deck_id: UUID, fmt: str) -> StarterPurchase:
    """The purchase behind a deck brought to a starter-deck game of the format; refuses a deck
    that was not bought for one."""
    purchase = purchase_of(db, user.id, deck_id)
    if purchase is None or purchase.format != fmt:
        raise ApiError(
            422,
            "not_a_starter_deck",
            "A starter-deck table takes a starter deck bought for it: buy one to sit down.",
        )
    return purchase


def as_bought(purchase: StarterPurchase, revision_id: UUID) -> None:
    """Only the deck as it came plays at a starter-deck table: one changed since is refused."""
    if revision_id != purchase.revision_id:
        raise ApiError(
            409,
            "starter_deck_changed",
            f"{purchase.title} was changed since you bought it. A starter-deck table plays the "
            "deck as it came: buy another to sit down.",
        )


def claim(
    db: Session, user: User, deck_id: UUID, fmt: str, table: GameTable | None = None
) -> StarterPurchase:
    """The purchase a player sits down with at a starter-deck table of people. One table a
    purchase: once a table's game started with it, it sits at no other."""
    purchase = bought_for(db, user, deck_id, fmt)
    if purchase.table_id is not None and (table is None or purchase.table_id != table.id):
        earlier = db.get(GameTable, purchase.table_id)
        if earlier is not None and earlier.status == "started":
            raise ApiError(
                409,
                "starter_deck_played",
                f"{purchase.title} was bought for another table, which played it. Buy a starter "
                "deck for this one to sit down.",
            )
    return purchase


def casual_only(fmt: str, best_of: int) -> None:
    """What a starter-deck table or game may be: Legacy or Commander, one game."""
    if fmt not in FORMATS:
        raise ApiError(422, "invalid_table", "A starter-deck table plays Legacy or Commander.")
    if best_of != 1:
        raise ApiError(422, "invalid_table", "A starter-deck table plays one game.")


# The bots' decks.


def rolled_entries(
    db: Session, request: Request, product: ShopProduct, rng: random.Random
) -> list[DeckEntry] | None:
    """A Legacy deck product's cards as one pack of it would give them, for a bot: drawn, never
    recorded or granted, and counted against no print run. None when it cannot be drawn."""
    if product.collation_id is None:
        return None
    collation = load(db, product.collation_id)
    out = set(
        db.scalars(
            select(CardPrinting.id)
            .join(CardConcept, CardConcept.id == CardPrinting.concept_id)
            .where(CardPrinting.id.in_(collation.printings()), not_(in_game()))
        )
    )
    # A bot holds no printing a player could not be dealt: one of a kind, or a run all dealt.
    runs = limited(db, settings_of(request).content_dir, collation.printings())
    used = dealt(db, set(runs))
    withheld = (
        out
        | (one_of_a_kind(db) & collation.printings())
        | {printing for printing, copies in runs.items() if used[printing] >= copies}
    )
    _, pulled = draw(collation, rng, frozenset(withheld))
    concepts = dict(
        db.execute(
            select(CardPrinting.id, CardPrinting.concept_id).where(
                CardPrinting.id.in_({card.printing_id for card in pulled})
            )
        ).all()
    )
    quantities: dict[tuple[UUID, UUID], int] = {}
    for card in pulled:
        concept = concepts.get(card.printing_id)
        if concept is None:
            return None
        key = (concept, card.printing_id)
        quantities[key] = quantities.get(key, 0) + 1
    return [
        DeckEntry(card_id=card_id, printing_id=printing_id, quantity=quantity)
        for (card_id, printing_id), quantity in quantities.items()
    ]


def rolled_deck(db: Session, request: Request) -> tuple[dict[str, object], str] | None:
    """A Legacy starter rolled for a bot (the owner's decision): a product on the shelf chosen at
    random, as the engine's deck list, with the product's name. None when none can be dealt, and
    the engine's own deck plays instead."""
    # Imported here: api.games imports this module's gate where a game is made.
    from api.games import engine_deck_list, engine_names

    rng = secrets.SystemRandom()
    products = legacy_products(request, db)
    rng.shuffle(products)
    for product in products[:BOT_ROLLS]:
        entries = rolled_entries(db, request, product, rng)
        if not entries:
            continue
        names = engine_names(db, entries, False)
        deck_list = engine_deck_list(db, entries, names, "legacy")
        if deck_list is not None:
            return deck_list, product.name
    return None


def sit(purchase: StarterPurchase, table: GameTable) -> None:
    """The purchase sits down at the table."""
    purchase.table_id = table.id
