"""Leng's basic land packs (v0.6.4, the owner's request).

- **Products.** Six packs of basic lands, set code LANDS in the shop: the Basic Land Pack, 200
  lands, 40 of each color, for 200 tokens; and one pack per color, 40 Plains, Islands, Swamps,
  Mountains or Forests, for 50 tokens each. Only the five basic land names: no Wastes, no
  snow-covered basics, nothing legendary, no dual or other nonbasic lands. They are shop products
  like any other (origin lands): bought, held, opened and granted as packs are (api/shop.py),
  staff may change their price or take them off sale, and they are in the weekly sale's draw
  (api/sales.py).
- **Editions.** A land pack draws from every English paper printing of the five basics in the
  sets Wizards sold as editions (EDITION_TYPES: core, expansion, masters, draft innovation,
  starter and Commander sets) already released, promotional printings aside. The editions are
  ranked by release, Alpha first: each edition's chance is its rank, so the newest edition is
  drawn about as often as the second newest and Alpha, rank 1, hardly ever. With the 133
  editions of October 2026, an Alpha Mountain comes about once in 8,900 Mountains, a Bloomburrow
  one about once in 77. An edition's chance is shared among its printings of that land, so a set
  with four Mountain arts is drawn no more often than one with one.
- **Foils.** Each color's 40 lands hold 1 to 5 foils, the number drawn at random for each color
  when the pack opens, from the editions that printed that land in foil, ranked the same way.
- **Collations.** Each product's collation is built from the catalog (a sheet per land and
  finish) and stored as a booster collation, a new revision only when the catalog's printings
  change it, so openings record what they drew from. The stored layout lists the 40 lands of each
  color as nonfoil; the foils are taken from those 40 when the pack opens (land_layout).
"""

import hashlib
import random
from dataclasses import dataclass
from datetime import date, datetime
from uuid import UUID
from weakref import WeakKeyDictionary

from sqlalchemy import Engine, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.collation import Collation, Layout, Sheet, SheetCard
from api.identity import utcnow
from api.models import BoosterCollation, CardConcept, CardPrinting, CatalogRevision, ShopProduct

LAND_SET = "LANDS"
LAND_SET_NAME = "Basic Lands"
ORIGIN = "lands"
LANDS = {"W": "Plains", "U": "Island", "B": "Swamp", "R": "Mountain", "G": "Forest"}
PER_COLOR = 40
FOILS = (1, 5)
EDITION_TYPES = frozenset(
    {"core", "expansion", "masters", "draft_innovation", "starter", "commander"}
)
# Each edition's weight, its rank, is shared among its printings of a land: multiplied by this
# (every count up to 16 divides it) so the shares stay whole numbers.
SHARES = 720_720


@dataclass(frozen=True)
class LandPack:
    booster: str
    name: str
    colors: str
    price: int


PACKS = (
    LandPack("basic-lands", "Basic Land Pack", "WUBRG", 200),
    *(
        LandPack(f"basic-lands-{color.lower()}", f"{LANDS[color]} Pack", color, 50)
        for color in LANDS
    ),
)
BY_BOOSTER = {pack.booster: pack for pack in PACKS}


def is_land_pack(product: ShopProduct) -> bool:
    return product.origin == ORIGIN


def land_price(product: ShopProduct) -> int | None:
    """A land pack's own price in tokens; None for any other product."""
    pack = BY_BOOSTER.get(product.booster) if is_land_pack(product) else None
    return pack.price if pack else None


def sheet_name(color: str, foil: bool) -> str:
    return LANDS[color].lower() + ("-foil" if foil else "")


@dataclass(frozen=True)
class LandPrinting:
    printing_id: UUID
    set_code: str
    released: date | None
    finishes: tuple[str, ...]
    color: str


def land_printings(db: Session, today: date) -> list[LandPrinting]:
    """The printings land packs draw from: English paper basics of the editions released by
    today, no promos."""
    names = {name: color for color, name in LANDS.items()}
    rows = db.execute(
        select(
            CardPrinting.id,
            CardPrinting.set_code,
            CardPrinting.released_at,
            CardPrinting.finishes,
            CardPrinting.games,
            CardConcept.name,
        )
        .join(CardConcept, CardConcept.id == CardPrinting.concept_id)
        .where(
            CardConcept.name.in_(names),
            CardConcept.type_line.like("Basic Land%"),
            CardConcept.removed_revision.is_(None),
            CardPrinting.removed_revision.is_(None),
            CardPrinting.lang == "en",
            CardPrinting.digital.is_(False),
            CardPrinting.promo.is_(False),
            CardPrinting.set_type.in_(EDITION_TYPES),
            CardPrinting.released_at <= today,
        )
    ).all()
    return [
        LandPrinting(printing_id, set_code.lower(), released, tuple(finishes or ()), names[name])
        for printing_id, set_code, released, finishes, games, name in rows
        if "paper" in (games or ())
    ]


def ranks(printings: list[LandPrinting]) -> dict[str, int]:
    """Each edition's rank by release, the oldest 1: its weight in a land pack."""
    first: dict[str, date] = {}
    for printing in printings:
        if printing.released is None:
            continue
        known = first.get(printing.set_code)
        if known is None or printing.released < known:
            first[printing.set_code] = printing.released
    ordered = sorted(first, key=lambda code: (first[code], code))
    return {code: rank for rank, code in enumerate(ordered, start=1)}


def land_sheet(printings: list[LandPrinting], rank: dict[str, int], foil: bool) -> Sheet:
    finish = "foil" if foil else "nonfoil"
    chosen = [p for p in printings if finish in p.finishes and p.set_code in rank]
    per_set: dict[str, int] = {}
    for printing in chosen:
        per_set[printing.set_code] = per_set.get(printing.set_code, 0) + 1
    cards = tuple(
        SheetCard(
            printing.printing_id,
            max(1, round(rank[printing.set_code] * SHARES / per_set[printing.set_code])),
            printing.color,
            finish,
        )
        for printing in sorted(chosen, key=lambda p: str(p.printing_id))
    )
    return Sheet(foil=foil, fixed=False, balance_colors=False, allow_duplicates=True, cards=cards)


def land_collation(printings: list[LandPrinting], colors: str) -> Collation | None:
    """A land pack's collation: a nonfoil and a foil sheet for each of its colors, and one layout
    of 40 nonfoil lands per color. None when a color has no printing to draw."""
    rank = ranks(printings)
    sheets: dict[str, Sheet] = {}
    contents: list[tuple[str, int]] = []
    for color in colors:
        mine = [printing for printing in printings if printing.color == color]
        plain = land_sheet(mine, rank, foil=False)
        if not plain.cards:
            return None
        sheets[sheet_name(color, False)] = plain
        contents.append((sheet_name(color, False), PER_COLOR))
        shiny = land_sheet(mine, rank, foil=True)
        if shiny.cards:
            sheets[sheet_name(color, True)] = shiny
    return Collation((Layout(tuple(contents), 1),), sheets)


def land_layout(collation: Collation, rng: random.Random) -> Collation:
    """The collation to draw one land pack from: of each color's 40 lands, 1 to 5 (drawn here)
    come from its foil sheet; a land no edition printed in foil gives 40 nonfoils."""
    contents: list[tuple[str, int]] = []
    for name, count in collation.layouts[0].contents:
        foil = f"{name}-foil"
        foils = rng.randint(*FOILS) if foil in collation.sheets else 0
        contents.append((name, count - foils))
        if foils:
            contents.append((foil, foils))
    return Collation((Layout(tuple(contents), 1),), collation.sheets)


# The catalog revision each database's land packs were last built from.
_built: WeakKeyDictionary[Engine, int] = WeakKeyDictionary()


def ensure_land_packs(bind: Engine) -> None:
    """The land packs on the shelf, their collations brought up to the catalog: once per catalog
    revision (a set released since joins at the catalog's next revision). Its own transaction;
    another process adding the same rows at once leaves them to it."""
    with Session(bind) as session:
        revision = session.scalar(select(func.max(CatalogRevision.id)))
    if revision is not None and _built.get(bind) == revision:
        return
    now = utcnow()
    try:
        with Session(bind) as session, session.begin():
            existing = {
                product.booster: product
                for product in session.scalars(
                    select(ShopProduct).where(ShopProduct.set_code == LAND_SET)
                )
            }
            printings = land_printings(session, now.date()) if revision is not None else []
            for pack in PACKS:
                product = existing.get(pack.booster)
                if product is None:
                    product = ShopProduct(
                        set_code=LAND_SET,
                        booster=pack.booster,
                        set_name=LAND_SET_NAME,
                        name=pack.name,
                        released=None,
                        origin=ORIGIN,
                        on_sale=True,
                        data_status="waiting",
                        unresolved=[],
                        unresolved_count=0,
                        created_at=now,
                        updated_at=now,
                    )
                    session.add(product)
                    session.flush()
                elif product.origin != ORIGIN:
                    product.origin = ORIGIN
                if revision is None:
                    continue
                store(session, product, land_collation(printings, pack.colors), revision, now)
    except IntegrityError:
        return
    if revision is not None:
        _built[bind] = revision


def store(
    session: Session,
    product: ShopProduct,
    collation: Collation | None,
    revision: int,
    now: datetime,
) -> None:
    if collation is None:
        if product.data_status != "missing":
            product.data_status = "missing"
            product.checked_at = now
            product.updated_at = now
        return
    digest = collation.digest()
    current = session.get(BoosterCollation, product.collation_id) if product.collation_id else None
    if current is None or current.digest != digest:
        layouts, sheets = collation.to_json()
        last = session.scalar(
            select(func.max(BoosterCollation.revision)).where(
                BoosterCollation.product_id == product.id
            )
        )
        row = BoosterCollation(
            product_id=product.id,
            revision=(last or 0) + 1,
            mtgjson_version=f"catalog-{revision}",
            source_sha256=hashlib.sha256(digest.encode()).hexdigest(),
            digest=digest,
            layouts=layouts,
            sheets=sheets,
            cards=sum(len(sheet.cards) for sheet in collation.sheets.values()),
            catalog_revision_id=revision,
            created_at=now,
        )
        session.add(row)
        session.flush()
        product.collation_id = row.id
    product.data_status = "ready"
    product.pack_size = collation.pack_size()
    product.checked_at = now
    product.updated_at = now
