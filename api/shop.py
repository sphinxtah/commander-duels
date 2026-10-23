"""Leng's card shop (v0.4.0; PROG02, PROG03, SEC03): booster packs bought with tokens, opened in
the Magic Duels style, their cards the player's for good.

- **Products and prices** are api/products.py's; collations come from catalog/boosters.py.
  Players never see a price in dollars, only in tokens.
- **Buying** spends the pack's price from the account's balance (economy.spend, which locks the
  account and refuses a short balance) and puts an unopened pack in its inventory, in one
  transaction. The ledger entry's key is pack:<pack id>. The request carries a key of the client's
  making, so a retried request finds the pack it bought and buys nothing more.
- **Opening** a pack, in one transaction, draws its contents from the product's current collation
  with the operating system's secure randomness (nothing the client sends reaches it), records the
  opening (the collation revision, each card's printing, finish and sheet), grants the cards to the
  library for good (library_grants, source pack, key pack:<opening id>), and revalidates the
  account's decks. A pack opens once: asking again returns the same cards. The account's row is
  locked, so two requests at once open it once. Since v0.4.5 a card the game cannot play gives
  way to another from its sheet (api/collation.py), and the opening records the card it replaced;
  the history shows only cards the game can play.
- **SysOp gives packs** to any account, its own included, with a reason, audited
  (shop.packs_granted). Administrators and SysOp change prices and sale (shop.manage), each
  change audited, and see the booster data job's runs.
- **Starter decks** (v0.4.2). The ten starter decks are sold too, each once to an account, from
  when it has chosen its two free ones at onboarding: until then the shop shows them as free and
  sells none. Buying one, in one transaction, spends its price (api/products.py, from the value of
  its cards), makes it a deck of the player's own and grants every copy of its cards for good, as
  choosing it would have (library_grants, source starter, key starter:<deck>). The ledger entry's
  key is deck:<account>:<deck>, so a retried request buys it once. After a reset (v0.4.5) both
  keys carry the reset's time (library.reset_key), so each deck sells once more.
- **A reset** (v0.4.5, api/resets.py) clears the account's packs: those from before it, opened or
  not, no longer count (library.since_reset), and they stay recorded, as packs are append-only.
- **Pack artwork** (v0.4.3). Every answer that names a product (the shelves, the packs held,
  purchases, openings and their history, Administration) carries its pack's picture when
  content/pack-art.json names one, and its set's symbol; with no picture the browser draws the
  pack from the set's name, symbol, era and booster type.
- **The weekly sale** (v0.4.3, api/sales.py). Each week five products on the shelf cost 20% less,
  from Sunday midnight to Sunday midnight, Arizona time: the shelf and Leng's counter show the sale
  price, and a purchase pays it while the week lasts.
"""

import secrets
from collections import defaultdict
from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field
from sqlalchemy import func, not_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.auth import INPUT_ERRORS
from api.cards import SyncQueued, image_of
from api.collation import draw, load
from api.decks import create_deck, refresh_decks, starters_of
from api.economy import balance_of, lock_account, spend, target
from api.identity import (
    Active,
    ApiError,
    Db,
    Principal,
    audit,
    not_found,
    refuse_deleted,
    require_permission,
    settings_of,
    utcnow,
)
from api.library import (
    Starter,
    commander_printing,
    grant_starter,
    library_of,
    owned_starters,
    reset_key,
    since_reset,
    starter_entries,
)
from api.models import (
    BoosterCollation,
    BoosterSyncRun,
    CardConcept,
    CardPrinting,
    Deck,
    LibraryGrant,
    Pack,
    PackCard,
    PackOpening,
    ScheduledJob,
    ShopProduct,
    TokenEntry,
    User,
)
from api.products import (
    ERAS,
    NEVER_SOLD,
    ArtImage,
    ArtIndex,
    ArtOrigin,
    BoosterKind,
    EraId,
    PriceBasis,
    curve_price,
    deck_prices,
    ensure_products,
    era_of,
    kind_of,
    pack_art,
    price_list,
    price_of,
    selling,
)
from api.roster import roster_of
from api.sales import Sale, SaleInfo, weekly_sale
from api.schemas import Contract, StoredText
from catalog import boosters
from catalog.statuses import playable

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
Builder = Annotated[Principal, Depends(require_permission("decks.edit"))]
ShopManager = Annotated[Principal, Depends(require_permission("shop.manage"))]
EconomyManager = Annotated[Principal, Depends(require_permission("economy.manage"))]
MAX_PRICE = 10_000_000_000
MAX_GRANT = 100
HISTORY_SHOWN = 50
# The order a pack is revealed in: commons first, the rarest last, foils after the rest.
RARITY_ORDER = {"common": 0, "uncommon": 1, "rare": 2, "mythic": 3}
Finish = Literal["nonfoil", "foil", "etched"]
RequestKey = Annotated[str, Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]
Reason = Annotated[StoredText, Field(min_length=3, max_length=200)]


class EraInfo(Contract):
    id: EraId
    name: str
    since: date


class PackImage(Contract):
    src: str = Field(description="A WebP file on this site, under /packs/.")
    width: int
    height: int


class PackArt(Contract):
    """The picture of a sealed pack (v0.4.3), copied once and served from this site."""

    small: PackImage = Field(description="160 pixels tall.")
    large: PackImage = Field(
        description="480 pixels tall, or the picture's own height when it is smaller."
    )
    origin: ArtOrigin = Field(description="Where the picture came from (content/pack-art.json).")


class ProductRef(Contract):
    id: UUID
    set_code: str
    set_name: str
    name: str
    kind: BoosterKind
    released: date | None
    booster: str = Field(description="MTGJSON's booster name.")
    era: EraId
    art: PackArt | None = Field(
        description="The picture of its sealed pack; null: the browser draws one from its set "
        "(v0.4.3)."
    )
    symbol: str | None = Field(
        description="The set's symbol, an SVG file on this site under /sets/; null: none."
    )


class ProductInfo(ProductRef):
    price: int = Field(description="In tokens.")
    price_basis: PriceBasis = Field(
        description="market: from the pack's market price; set: set by the site's staff; "
        "unpriced: not priced yet."
    )
    pack_size: int | None = Field(description="Cards in the usual pack.")
    sale_price: int | None = Field(
        default=None,
        description="In tokens, while the product is in this week's sale; null otherwise.",
    )


class InventoryItem(Contract):
    product: ProductRef
    count: int
    next_pack: UUID = Field(description="The oldest unopened pack, the next to open.")
    openable: bool = Field(description="Whether its booster data has been read.")


class ShopData(Contract):
    mtgjson_version: str | None
    prices_as_of: date | None
    checked_at: datetime | None = Field(description="When the booster data was last read.")


class DeckOffer(Contract):
    """A starter deck in Leng's shop (v0.4.2)."""

    id: str
    title: str
    commander: str
    colors: str
    color_names: str
    guild: str
    description: str
    commander_card_id: UUID | None
    commander_printing_id: UUID | None = Field(description="The commander's picture.")
    price: int | None = Field(
        description="In tokens, from the value of its cards; null while the account's two free "
        "starter decks are still to choose, or when it is not priced."
    )
    owned: bool = Field(description="Chosen as a free starter deck, or bought: each sells once.")


class ShopView(Contract):
    balance: int
    products: list[ProductInfo] = Field(description="The products on sale, newest first.")
    eras: list[EraInfo]
    inventory: list[InventoryItem]
    data: ShopData
    decks: list[DeckOffer] = Field(default_factory=list, description="The ten starter decks.")
    free_decks: bool = Field(
        default=False,
        description="The account's two free starter decks are still to choose; the shop sells "
        "none until they are.",
    )
    sale: SaleInfo | None = Field(
        default=None, description="This week's sale at Leng's counter (v0.4.3)."
    )


class DeckPurchaseRequest(Contract):
    deck: str = Field(min_length=1, max_length=64)


class DeckPurchase(Contract):
    deck: UUID | None = Field(
        description="The new deck of the player's own; null on a retry once it has been deleted."
    )
    starter: str
    tokens: int = Field(description="The price paid.")
    balance: int
    repeated: bool = Field(description="A retry: the deck was bought already.")


class PurchaseRequest(Contract):
    product: UUID
    key: RequestKey = Field(
        description="The client's own key for this purchase: a retry buys once."
    )


class Purchase(Contract):
    pack: UUID
    product: ProductRef
    tokens: int = Field(description="The price paid.")
    balance: int
    repeated: bool = Field(description="The key had bought this pack already.")


class PulledCard(Contract):
    position: int
    card_id: UUID
    printing_id: UUID
    name: str
    mana_cost: str | None
    type_line: str
    rarity: str
    set_code: str
    collector_number: str
    finish: Finish
    sheet: str
    new: bool = Field(description="No copy of it was in the library for good before.")
    faces: int = Field(description="Faces with images of their own; 0 for one image.")
    replaced: bool = Field(
        default=False,
        description="Drawn from its sheet in place of a card the game cannot play (v0.4.5); the "
        "opening's record names that card.",
    )


class Opening(Contract):
    id: UUID
    pack: UUID
    product: ProductRef
    collation_revision: int
    mtgjson_version: str
    opened_at: datetime
    cards: list[PulledCard]


class OpeningSummary(Contract):
    id: UUID
    product: ProductRef
    opened_at: datetime
    cards: int
    new_cards: int
    foils: int
    best: str = Field(description="The rarest card's rarity.")


class UnresolvedCard(Contract):
    sheet: str
    name: str | None
    scryfall_id: str | None
    mtgjson_uuid: str | None


class AdminProduct(ProductInfo):
    usd: float | None
    usd_method: str | None
    usd_source: str | None
    curve_price: int | None = Field(description="The market price's tokens on the curve.")
    price_override: int | None
    price_reason: str | None
    on_sale: bool = Field(description="Staff's setting; selling needs the booster data too.")
    sale_reason: str | None
    selling: bool
    origin: Literal["price_list", "mtgjson"]
    data_status: Literal["waiting", "ready", "unresolved", "missing"]
    unresolved_count: int
    unresolved: list[UnresolvedCard]
    collation_revision: int | None
    mtgjson_version: str | None
    checked_at: datetime | None
    changed_at: datetime | None


class BoosterRun(Contract):
    id: UUID
    trigger: str
    status: str
    started_at: datetime
    finished_at: datetime | None
    error_code: str | None
    error_message: str | None
    next_attempt_at: datetime | None
    stats: dict[str, object]


class ShopAdminView(Contract):
    enabled: bool = Field(description="The booster data job runs (the catalog folder is set).")
    products: list[AdminProduct]
    last_run: BoosterRun | None
    next_run_at: datetime | None
    prices_as_of: date | None


class PriceChange(Contract):
    tokens: int | None = Field(ge=1, le=MAX_PRICE, description="null: back to the curve.")
    reason: Reason


class SaleChange(Contract):
    on_sale: bool
    reason: Reason


class PackGrant(Contract):
    product: UUID
    count: int = Field(ge=1, le=MAX_GRANT)
    reason: Reason


class PacksGranted(Contract):
    granted: int
    inventory: list[InventoryItem]


def art_of(request: Request) -> ArtIndex:
    """The pictures of the packs and the set symbols (api/products.py)."""
    return pack_art(settings_of(request).content_dir)


def image_of_pack(image: ArtImage) -> PackImage:
    return PackImage(src=image.src, width=image.width, height=image.height)


def ref_of(product: ShopProduct, art: ArtIndex) -> ProductRef:
    picture = art.picture(product.set_code, product.booster)
    return ProductRef(
        id=product.id,
        set_code=product.set_code,
        set_name=product.set_name,
        name=product.name,
        kind=kind_of(product.booster),
        released=product.released,
        booster=product.booster,
        era=era_of(product.released),
        art=PackArt(
            small=image_of_pack(picture.small),
            large=image_of_pack(picture.large),
            origin=picture.origin,
        )
        if picture
        else None,
        symbol=art.symbol(product.set_code),
    )


def info_of(product: ShopProduct, art: ArtIndex, sale: Sale | None = None) -> ProductInfo:
    price, basis = price_of(product)
    return ProductInfo(
        **ref_of(product, art).model_dump(),
        price=price,
        price_basis=basis,
        pack_size=product.pack_size,
        sale_price=sale.price(product.id, price) if sale else None,
    )


def newest_first(product: ShopProduct) -> tuple[date, str, str]:
    return (product.released or date.max, product.set_code, product.booster)


def ensured(request: Request) -> None:
    """The products brought up to the price list (api/products.py), once per list."""
    ensure_products(request.app.state.database, settings_of(request).content_dir)


def products_of(request: Request, db: Session) -> list[ShopProduct]:
    ensured(request)
    return list(db.scalars(select(ShopProduct)))


def inventory_of(db: Session, user: User, art: ArtIndex) -> list[InventoryItem]:
    unopened = db.execute(
        select(Pack.id, Pack.product_id)
        .outerjoin(PackOpening, PackOpening.pack_id == Pack.id)
        .where(
            Pack.user_id == user.id,
            PackOpening.id.is_(None),
            since_reset(user, Pack.created_at),
        )
        .order_by(Pack.created_at, Pack.id)
    ).all()
    counts: dict[UUID, int] = defaultdict(int)
    first: dict[UUID, UUID] = {}
    for pack_id, product_id in unopened:
        counts[product_id] += 1
        first.setdefault(product_id, pack_id)
    products = {
        product.id: product
        for product in db.scalars(select(ShopProduct).where(ShopProduct.id.in_(counts)))
    }
    items = [
        InventoryItem(
            product=ref_of(products[product_id], art),
            count=count,
            next_pack=first[product_id],
            openable=products[product_id].collation_id is not None,
        )
        for product_id, count in counts.items()
    ]
    items.sort(key=lambda item: item.product.name)
    return items


def latest_version(db: Session) -> tuple[str | None, datetime | None]:
    row = db.execute(
        select(BoosterSyncRun.stats, BoosterSyncRun.finished_at)
        .where(BoosterSyncRun.status.in_(("succeeded", "unchanged")))
        .order_by(BoosterSyncRun.started_at.desc())
        .limit(1)
    ).first()
    if row is None:
        version = db.scalar(
            select(BoosterCollation.mtgjson_version)
            .order_by(BoosterCollation.created_at.desc())
            .limit(1)
        )
        return version, None
    stats, finished = row
    found = stats.get("mtgjson_version") if isinstance(stats, dict) else None
    return (str(found) if found else None), finished


# Players.


@router.get("/shop", response_model=ShopView)
def shop(request: Request, principal: Active, db: Db) -> ShopView:
    """What Leng sells, the account's tokens and unopened packs, and where the data comes from."""
    products = products_of(request, db)
    now = utcnow()
    today = now.date()
    sale = weekly_sale(db, products, now)
    on_sale = sorted(
        (product for product in products if selling(product, today)),
        key=newest_first,
        reverse=True,
    )
    listing = price_list(settings_of(request).content_dir)
    version, checked = latest_version(db)
    free = free_decks(principal.user)
    art = art_of(request)
    return ShopView(
        balance=balance_of(db, principal.user.id),
        products=[info_of(product, art, sale) for product in on_sale],
        eras=[EraInfo(id=era.id, name=era.name, since=era.since) for era in ERAS],
        inventory=inventory_of(db, principal.user, art),
        data=ShopData(
            mtgjson_version=version,
            prices_as_of=listing.as_of if listing else None,
            checked_at=checked,
        ),
        decks=deck_offers(request, db, principal.user),
        free_decks=free,
        sale=sale.info(),
    )


# Starter decks (v0.4.2).


def free_decks(user: User) -> bool:
    """Whether the account's two free starter decks are still to choose (onboarding)."""
    return user.onboarding != "complete"


def deck_offers(request: Request, db: Session, user: User) -> list[DeckOffer]:
    prices = deck_prices(settings_of(request).content_dir)
    owned = owned_starters(db, user)
    free = free_decks(user)
    offers = []
    for starter in starters_of(request).values():
        entries, _ = starter_entries(db, starter)
        card, printing = commander_printing(db, entries)
        offers.append(
            DeckOffer(
                id=starter.id,
                title=starter.title,
                commander=starter.commander,
                colors=starter.colors,
                color_names=starter.color_names,
                guild=starter.guild,
                description=starter.description,
                commander_card_id=card,
                commander_printing_id=printing,
                price=None if free else prices.get(starter.id),
                owned=starter.id in owned,
            )
        )
    return offers


def deck_bought(
    db: Session, user: User, starter: Starter, entry: TokenEntry, deck: UUID | None = None
) -> DeckPurchase:
    repeated = deck is None
    if repeated:
        # A retry: the newest deck of the account's made from it is the one the purchase made.
        deck = db.scalar(
            select(Deck.id)
            .where(Deck.owner_id == user.id, Deck.source == "starter", Deck.title == starter.title)
            .order_by(Deck.created_at.desc())
            .limit(1)
        )
    return DeckPurchase(
        deck=deck,
        starter=starter.id,
        tokens=-entry.amount,
        balance=balance_of(db, user.id),
        repeated=repeated,
    )


@router.post("/shop/decks", response_model=DeckPurchase, status_code=201)
def buy_deck(
    body: DeckPurchaseRequest, request: Request, principal: Builder, db: Db
) -> DeckPurchase:
    """Buys a starter deck, once: its price leaves the balance, it becomes a deck of the player's
    own, and every copy of its cards joins the library for good, together."""
    user = principal.user
    starter = starters_of(request).get(body.deck)
    if starter is None:
        raise not_found()
    # The account's row is locked first, so a retry waits for the request it repeats.
    lock_account(db, user.id)
    db.refresh(user)
    key = reset_key(user, f"deck:{user.id}:{starter.id}")
    earlier = db.scalar(select(TokenEntry).where(TokenEntry.key == key))
    if earlier is not None:
        return deck_bought(db, user, starter, earlier)
    if free_decks(user):
        raise ApiError(
            409, "starters_first", "Choose your two free starter decks first: they cost nothing."
        )
    if starter.id in owned_starters(db, user):
        raise ApiError(409, "deck_owned", f"{starter.title} is yours already.")
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
    entry = spend(db, user.id, price, key, f"Starter deck: {starter.title}")
    grant_starter(db, user, starter, entries)
    db.flush()
    roster = roster_of(request)
    deck, _ = create_deck(
        db,
        principal,
        starter.title,
        "commander",
        entries,
        library_of(db, user, principal.permissions, roster),
        source="starter",
    )
    refresh_decks(db, user.id, library_of(db, user, principal.permissions, roster))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        earlier = db.scalar(select(TokenEntry).where(TokenEntry.key == key))
        if earlier is None:
            raise
        return deck_bought(db, user, starter, earlier)
    return deck_bought(db, user, starter, entry, deck.id)


def purchase_of(db: Session, pack: Pack, repeated: bool, art: ArtIndex) -> Purchase:
    product = db.get_one(ShopProduct, pack.product_id)
    return Purchase(
        pack=pack.id,
        product=ref_of(product, art),
        tokens=pack.tokens,
        balance=balance_of(db, pack.user_id),
        repeated=repeated,
    )


def bought(db: Session, user_id: UUID, key: str) -> Pack | None:
    return db.scalar(select(Pack).where(Pack.user_id == user_id, Pack.request_key == key))


@router.post("/shop/purchases", response_model=Purchase, status_code=201)
def buy(body: PurchaseRequest, request: Request, principal: Active, db: Db) -> Purchase:
    """Buys one pack: its price leaves the balance and the pack joins the inventory, together."""
    user_id = principal.user.id
    art = art_of(request)
    # Drawn (and committed) before the purchase's own transaction, if no request has yet.
    sale = weekly_sale(db, products_of(request, db), utcnow())
    # The account's row is locked first, so a retry waits for the request it repeats.
    lock_account(db, user_id)
    earlier = bought(db, user_id, body.key)
    if earlier is not None:
        if earlier.product_id != body.product:
            raise ApiError(409, "key_reused", "That purchase key bought another product.")
        return purchase_of(db, earlier, True, art)
    product = db.get(ShopProduct, body.product)
    if product is None:
        raise not_found()
    if not selling(product, utcnow().date()):
        raise ApiError(409, "not_on_sale", f"{product.name} is not on sale.")
    price, _ = price_of(product)
    discounted = sale.price(product.id, price)
    if discounted is not None:
        price = discounted
    pack = Pack(
        id=uuid4(),
        user_id=user_id,
        product_id=product.id,
        source="purchase",
        tokens=price,
        request_key=body.key,
        created_at=utcnow(),
    )
    db.add(pack)
    db.flush()
    reason = (
        product.name if discounted is None else f"{product.name} (weekly sale, {sale.percent}% off)"
    )
    spend(db, user_id, price, f"pack:{pack.id}", reason)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        earlier = bought(db, user_id, body.key)
        if earlier is None:
            raise
        return purchase_of(db, earlier, True, art)
    return purchase_of(db, pack, False, art)


def reveal_order(rarity: str, finish: str) -> tuple[int, int]:
    return (finish != "nonfoil", RARITY_ORDER.get(rarity, 4))


def opening_of(db: Session, opening: PackOpening, art: ArtIndex) -> Opening:
    """An opened pack's cards; one the game cannot play now (a pack opened before v0.4.5, or a
    card removed since) stays recorded but is not shown."""
    product = db.get_one(ShopProduct, opening.product_id)
    collation = db.get_one(BoosterCollation, opening.collation_id)
    rows = db.execute(
        select(PackCard, CardPrinting, CardConcept)
        .join(CardPrinting, CardPrinting.id == PackCard.printing_id)
        .join(CardConcept, CardConcept.id == PackCard.concept_id)
        .where(PackCard.opening_id == opening.id, playable())
        .order_by(PackCard.position)
    ).all()
    cards = []
    for card, printing, concept in rows:
        image = image_of(printing)
        cards.append(
            PulledCard(
                position=card.position,
                card_id=concept.id,
                printing_id=printing.id,
                name=concept.name,
                mana_cost=concept.mana_cost,
                type_line=concept.type_line,
                rarity=printing.rarity,
                set_code=printing.set_code,
                collector_number=printing.collector_number,
                finish=card.finish,  # type: ignore[arg-type]
                sheet=card.sheet,
                new=card.new,
                faces=image.faces if image else 0,
                replaced=card.replaced_printing_id is not None,
            )
        )
    return Opening(
        id=opening.id,
        pack=opening.pack_id,
        product=ref_of(product, art),
        collation_revision=collation.revision,
        mtgjson_version=collation.mtgjson_version,
        opened_at=opening.created_at,
        cards=cards,
    )


def granted_keys(db: Session, user: User, keys: set[str]) -> set[str]:
    """The construction keys among these that the account holds copies of for good."""
    if not keys:
        return set()
    return set(
        db.scalars(
            select(CardConcept.construction_key)
            .join(LibraryGrant, LibraryGrant.concept_id == CardConcept.id)
            .where(
                LibraryGrant.user_id == user.id,
                CardConcept.construction_key.in_(keys),
                since_reset(user, LibraryGrant.created_at),
            )
            .distinct()
        )
    )


def open_pack(request: Request, db: Session, principal: Principal, pack: Pack) -> PackOpening:
    """Draws the pack, records it, and grants its cards: in the caller's transaction, with the
    account's row locked."""
    product = db.get_one(ShopProduct, pack.product_id)
    if product.collation_id is None:
        raise ApiError(
            409, "pack_unavailable", f"{product.name} cannot be opened until its data is read."
        )
    collation = load(db, product.collation_id)
    # A card the game cannot play gives way to another from its sheet (v0.4.5).
    removed = frozenset(
        db.scalars(
            select(CardPrinting.id)
            .join(CardConcept, CardConcept.id == CardPrinting.concept_id)
            .where(CardPrinting.id.in_(collation.printings()), not_(playable()))
        )
    )
    layout, pulled = draw(collation, secrets.SystemRandom(), removed)
    printings = {
        printing.id: printing
        for printing in db.scalars(
            select(CardPrinting).where(CardPrinting.id.in_({card.printing_id for card in pulled}))
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
    ordered = sorted(
        pulled,
        key=lambda card: reveal_order(printings[card.printing_id].rarity, card.finish),
    )
    user_id = principal.user.id
    owned = granted_keys(
        db, principal.user, {concept.construction_key for concept in concepts.values()}
    )
    opening = PackOpening(
        id=uuid4(),
        pack_id=pack.id,
        user_id=user_id,
        product_id=product.id,
        collation_id=product.collation_id,
        layout=layout,
        created_at=utcnow(),
    )
    db.add(opening)
    db.flush()
    quantities: dict[UUID, int] = defaultdict(int)
    for position, card in enumerate(ordered):
        concept = concepts[printings[card.printing_id].concept_id]
        # Basic lands are in every library already.
        kept = not concept.type_line.startswith("Basic ")
        new = kept and concept.construction_key not in owned
        if kept:
            quantities[concept.id] += 1
            owned.add(concept.construction_key)
        db.add(
            PackCard(
                opening_id=opening.id,
                position=position,
                printing_id=card.printing_id,
                concept_id=concept.id,
                finish=card.finish,
                sheet=card.sheet[:64],
                new=new,
                replaced_printing_id=card.replaced,
            )
        )
    for concept_id, quantity in quantities.items():
        db.add(
            LibraryGrant(
                user_id=user_id,
                concept_id=concept_id,
                quantity=quantity,
                source="pack",
                grant_key=f"pack:{opening.id}",
                created_at=opening.created_at,
            )
        )
    db.flush()
    library = library_of(db, principal.user, principal.permissions, roster_of(request))
    refresh_decks(db, user_id, library)
    return opening


@router.post("/shop/packs/{pack_id}/open", response_model=Opening)
def open_one(pack_id: UUID, request: Request, principal: Active, db: Db) -> Opening:
    """Opens one of the account's packs. A pack opens once: asking again returns its cards."""
    lock_account(db, principal.user.id)
    # Read again under the lock, so a reset that got there first leaves its packs behind.
    db.refresh(principal.user)
    pack = db.scalar(
        select(Pack).where(
            Pack.id == pack_id,
            Pack.user_id == principal.user.id,
            since_reset(principal.user, Pack.created_at),
        )
    )
    if pack is None:
        raise not_found()
    opened = db.scalar(select(PackOpening).where(PackOpening.pack_id == pack.id))
    if opened is None:
        opened = open_pack(request, db, principal, pack)
        # Packs opened earn achievements (v0.5.0). Imported here: api.achievements reaches
        # api.social, which imports far.
        from api.achievements import catch_up

        catch_up(db, principal.user, opened.created_at)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            opened = db.scalar(select(PackOpening).where(PackOpening.pack_id == pack.id))
            if opened is None:
                raise
    return opening_of(db, opened, art_of(request))


@router.get("/shop/openings", response_model=list[OpeningSummary])
def openings(
    request: Request,
    principal: Active,
    db: Db,
    limit: Annotated[int, Query(ge=1, le=200)] = HISTORY_SHOWN,
    before: datetime | None = None,
) -> list[OpeningSummary]:
    """The account's opened packs, newest first: since its latest reset, if any."""
    query = select(PackOpening).where(
        PackOpening.user_id == principal.user.id,
        since_reset(principal.user, PackOpening.created_at),
    )
    if before is not None:
        query = query.where(PackOpening.created_at < before)
    found = list(db.scalars(query.order_by(PackOpening.created_at.desc()).limit(limit)))
    if not found:
        return []
    products = {
        product.id: product
        for product in db.scalars(
            select(ShopProduct).where(ShopProduct.id.in_({row.product_id for row in found}))
        )
    }
    cards: dict[UUID, list[tuple[str, str, bool]]] = defaultdict(list)
    for opening_id, rarity, finish, new in db.execute(
        select(PackCard.opening_id, CardPrinting.rarity, PackCard.finish, PackCard.new)
        .join(CardPrinting, CardPrinting.id == PackCard.printing_id)
        .join(CardConcept, CardConcept.id == PackCard.concept_id)
        .where(PackCard.opening_id.in_([row.id for row in found]), playable())
    ):
        cards[opening_id].append((rarity, finish, new))
    art = art_of(request)
    return [
        OpeningSummary(
            id=row.id,
            product=ref_of(products[row.product_id], art),
            opened_at=row.created_at,
            cards=len(cards[row.id]),
            new_cards=sum(1 for _, _, new in cards[row.id] if new),
            foils=sum(1 for _, finish, _ in cards[row.id] if finish != "nonfoil"),
            best=max(
                (rarity for rarity, _, _ in cards[row.id]),
                key=lambda rarity: RARITY_ORDER.get(rarity, -1),
                default="common",
            ),
        )
        for row in found
    ]


@router.get("/shop/openings/{opening_id}", response_model=Opening)
def opening(opening_id: UUID, request: Request, principal: Active, db: Db) -> Opening:
    found = db.scalar(
        select(PackOpening).where(
            PackOpening.id == opening_id,
            PackOpening.user_id == principal.user.id,
            since_reset(principal.user, PackOpening.created_at),
        )
    )
    if found is None:
        raise not_found()
    return opening_of(db, found, art_of(request))


# SysOp's grants.


@router.post("/admin/users/{user_id}/packs", response_model=PacksGranted, status_code=201)
def give_packs(
    user_id: UUID, body: PackGrant, request: Request, principal: EconomyManager, db: Db
) -> PacksGranted:
    """SysOp gives unopened packs to any account, its own included: with a reason, audited."""
    ensured(request)
    user = target(db, user_id, principal)
    refuse_deleted(user)
    product = db.get(ShopProduct, body.product)
    if product is None:
        raise not_found()
    if product.collation_id is None:
        raise ApiError(
            409, "pack_unavailable", f"{product.name} has no booster data yet; it cannot be opened."
        )
    grant = uuid4()
    now = utcnow()
    for _ in range(body.count):
        db.add(
            Pack(
                user_id=user.id,
                product_id=product.id,
                source="grant",
                tokens=0,
                grant_id=grant,
                actor_id=principal.user.id,
                reason=body.reason,
                created_at=now,
            )
        )
    audit(
        db,
        request,
        "shop.packs_granted",
        actor_id=principal.user.id,
        target_user_id=user.id,
        details={
            "product": str(product.id),
            "set": product.set_code,
            "booster": product.booster,
            "count": body.count,
            "reason": body.reason,
            "grant": str(grant),
        },
    )
    db.commit()
    return PacksGranted(granted=body.count, inventory=inventory_of(db, user, art_of(request)))


@router.get("/admin/users/{user_id}/packs", response_model=list[InventoryItem])
def account_packs(
    user_id: UUID, request: Request, principal: EconomyManager, db: Db
) -> list[InventoryItem]:
    return inventory_of(db, target(db, user_id, principal), art_of(request))


# Administration (shop.manage: administrators and SysOp).


def admin_products(db: Session, products: list[ShopProduct], art: ArtIndex) -> list[AdminProduct]:
    today = utcnow().date()
    revisions = {
        row.id: (row.revision, row.mtgjson_version)
        for row in db.execute(
            select(
                BoosterCollation.id, BoosterCollation.revision, BoosterCollation.mtgjson_version
            ).where(
                BoosterCollation.id.in_(
                    {product.collation_id for product in products if product.collation_id}
                )
            )
        )
    }
    found = []
    for product in sorted(products, key=newest_first, reverse=True):
        revision, version = revisions.get(product.collation_id or uuid4(), (None, None))
        found.append(
            AdminProduct(
                **info_of(product, art).model_dump(),
                usd=product.usd,
                usd_method=product.usd_method,
                usd_source=product.usd_source,
                curve_price=curve_price(product.usd) if product.usd else None,
                price_override=product.price_override,
                price_reason=product.price_reason,
                on_sale=product.on_sale,
                sale_reason=product.sale_reason,
                selling=selling(product, today),
                origin=product.origin,  # type: ignore[arg-type]
                data_status=product.data_status,  # type: ignore[arg-type]
                unresolved_count=product.unresolved_count,
                unresolved=[
                    UnresolvedCard.model_validate(item) for item in product.unresolved or []
                ],
                collation_revision=revision,
                mtgjson_version=version,
                checked_at=product.checked_at,
                changed_at=product.changed_at,
            )
        )
    return found


def run_of(run: BoosterSyncRun) -> BoosterRun:
    return BoosterRun(
        id=run.id,
        trigger=run.trigger,
        status=run.status,
        started_at=run.started_at,
        finished_at=run.finished_at,
        error_code=run.error_code,
        error_message=run.error_message,
        next_attempt_at=run.next_attempt_at,
        stats=dict(run.stats or {}),
    )


@router.get("/admin/shop", response_model=ShopAdminView)
def shop_admin(request: Request, principal: ShopManager, db: Db) -> ShopAdminView:
    """Every product with its price, sale and booster data, and the job's state."""
    products = products_of(request, db)
    last = db.scalar(select(BoosterSyncRun).order_by(BoosterSyncRun.started_at.desc()).limit(1))
    upcoming = db.scalar(
        select(func.min(ScheduledJob.due_at)).where(
            ScheduledJob.kind == boosters.KIND, ScheduledJob.status == "pending"
        )
    )
    listing = price_list(settings_of(request).content_dir)
    return ShopAdminView(
        enabled=bool(settings_of(request).catalog_dir),
        products=admin_products(db, products, art_of(request)),
        last_run=run_of(last) if last else None,
        next_run_at=upcoming,
        prices_as_of=listing.as_of if listing else None,
    )


@router.get("/admin/shop/runs", response_model=list[BoosterRun])
def shop_runs(
    principal: ShopManager, db: Db, limit: Annotated[int, Query(ge=1, le=100)] = 20
) -> list[BoosterRun]:
    runs = db.scalars(
        select(BoosterSyncRun).order_by(BoosterSyncRun.started_at.desc()).limit(limit)
    )
    return [run_of(run) for run in runs]


@router.post("/admin/shop/sync", response_model=SyncQueued, status_code=202)
def request_booster_sync(request: Request, principal: ShopManager, db: Db) -> SyncQueued:
    """Queues a booster data run now; the worker starts it within seconds."""
    if not settings_of(request).catalog_dir:
        raise ApiError(409, "boosters_off", "The booster data job is turned off (CD_CATALOG_DIR).")
    now = utcnow()
    job = boosters.request_now(db, principal.user.id, now)
    if job is None:
        raise ApiError(409, "sync_busy", "A booster data run is already queued or running.")
    db.flush()
    audit(
        db, request, "shop.sync_requested", actor_id=principal.user.id, details={"job": str(job.id)}
    )
    db.commit()
    return SyncQueued(job_id=job.id, due_at=now)


def managed(db: Session, product_id: UUID) -> ShopProduct:
    product = db.scalar(select(ShopProduct).where(ShopProduct.id == product_id).with_for_update())
    if product is None or product.set_code in NEVER_SOLD:
        raise not_found()
    return product


def changed(product: ShopProduct, actor: User) -> None:
    product.changed_by = actor.id
    product.changed_at = utcnow()
    product.updated_at = utcnow()


@router.put("/admin/shop/products/{product_id}/price", response_model=AdminProduct)
def change_price(
    product_id: UUID, body: PriceChange, request: Request, principal: ShopManager, db: Db
) -> AdminProduct:
    """Sets a product's price in tokens, or returns it to the curve (null); audited."""
    product = managed(db, product_id)
    before, _ = price_of(product)
    previous = product.price_override
    product.price_override = body.tokens
    product.price_reason = body.reason
    changed(product, principal.user)
    after, _ = price_of(product)
    audit(
        db,
        request,
        "shop.price_changed",
        actor_id=principal.user.id,
        details={
            "product": str(product.id),
            "set": product.set_code,
            "booster": product.booster,
            "from": before,
            "to": after,
            "override": {"from": previous, "to": body.tokens},
            "reason": body.reason,
        },
    )
    db.commit()
    return admin_products(db, [product], art_of(request))[0]


@router.put("/admin/shop/products/{product_id}/sale", response_model=AdminProduct)
def change_sale(
    product_id: UUID, body: SaleChange, request: Request, principal: ShopManager, db: Db
) -> AdminProduct:
    """Takes a product off sale, or puts it back; audited. Packs already held still open."""
    product = managed(db, product_id)
    before = product.on_sale
    product.on_sale = body.on_sale
    product.sale_reason = body.reason
    changed(product, principal.user)
    audit(
        db,
        request,
        "shop.sale_changed",
        actor_id=principal.user.id,
        details={
            "product": str(product.id),
            "set": product.set_code,
            "booster": product.booster,
            "from": before,
            "to": body.on_sale,
            "reason": body.reason,
        },
    )
    db.commit()
    return admin_products(db, [product], art_of(request))[0]
