"""The shop's products and their prices (v0.4.0).

- **Products** are MTGJSON's booster products: content/pack-prices.json lists 392 of them, from
  Unlimited to the current set, each with the market price of one sealed pack in US dollars, its
  method and its source (docs/pack-prices.md). The booster data job adds the expansions, core sets,
  Masters and draft sets MTGJSON lists after that file (catalog/boosters.py). Alpha and Beta are
  never products: they are kept for tournaments.
- **Prices** follow the market price on a curve anchored at the current set's Play Booster (FRA
  play, $6.07: 500 tokens) and Revised (3ED, $343.28: 150,000 tokens), `500 x (usd / 6.07) ^ k`
  with `k = ln 300 / ln(343.28 / 6.07)`, rounded to two significant figures. A product with no
  market price costs 500 until it is priced. SysOp and administrators may set any product's price
  and take any product off sale; those settings live in the database, apart from the content file,
  and each change is audited.
- A product is **sold** while staff keep it on sale, its booster data is ready (every card found in
  the catalog) and it has been released.
- **Starter decks** (v0.4.2) are priced from the market value of the cards they grant, basic lands
  aside (content/starter-deck-prices.json), at the current pack's rate, rounded the same way.
- **Pack artwork** (v0.4.3): content/pack-art.json, made by scripts/pack_art.py, names the
  picture of each product's sealed pack (two WebP sizes under web/public/packs/) and each set's
  symbol (web/public/sets/). A product it does not picture, and every set the booster data job
  adds later, is drawn in the browser from its set instead.
"""

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Literal
from weakref import WeakKeyDictionary

from sqlalchemy import Engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.identity import utcnow
from api.models import ShopProduct

PRICE_LIST = "pack-prices.json"
DECK_PRICES = "starter-deck-prices.json"
PACK_ART = "pack-art.json"
# Only files the site serves itself: a manifest naming anything else is ignored there.
ART_FILE = re.compile(r"^/packs/[a-z0-9][a-z0-9_-]*\.webp$")
SYMBOL_FILE = re.compile(r"^/sets/[a-z0-9][a-z0-9_-]*\.svg$")
ArtOrigin = Literal["tcgplayer", "wizards"]
ART_ORIGINS: frozenset[str] = frozenset({"tcgplayer", "wizards"})
ANCHOR_USD = 6.07
ANCHOR_TOKENS = 500
TOP_USD = 343.28
TOP_TOKENS = 150_000
EXPONENT = math.log(TOP_TOKENS / ANCHOR_TOKENS) / math.log(TOP_USD / ANCHOR_USD)
UNPRICED = 500
LOWEST = 10
# Alpha and Beta are won in tournaments, many versions from now; never sold.
NEVER_SOLD = frozenset({"LEA", "LEB"})

BoosterKind = Literal[
    "booster",
    "draft",
    "set",
    "collector",
    "play",
    "jumpstart",
    "theme",
    "six",
    "starter",
    "tournament",
    "special",
]
EraId = Literal["play", "collector", "frame15", "mythic", "modern", "oldborder", "first"]
PriceBasis = Literal["market", "set", "unpriced"]
PLAIN_KINDS = frozenset({"draft", "set", "play", "six", "starter", "tournament"})


@dataclass(frozen=True)
class Era:
    id: EraId
    name: str
    since: date


# Newest first; each runs until the next one starts.
ERAS = (
    Era("play", "Play Boosters", date(2024, 2, 9)),
    Era("collector", "Set and Collector Boosters", date(2020, 9, 25)),
    Era("frame15", "The M15 frame", date(2014, 7, 18)),
    Era("mythic", "Mythic rares", date(2008, 10, 3)),
    Era("modern", "The modern frame", date(2003, 7, 28)),
    Era("oldborder", "The old border", date(1997, 1, 1)),
    Era("first", "The first years", date(1993, 1, 1)),
)


def era_of(released: date | None) -> EraId:
    if released is None:
        return ERAS[0].id
    return next((era.id for era in ERAS if released >= era.since), ERAS[-1].id)


def kind_of(booster: str) -> BoosterKind:
    """The kind of product an MTGJSON booster name stands for."""
    if booster == "default":
        return "booster"
    if booster in PLAIN_KINDS:
        return booster  # type: ignore[return-value]
    for prefix in ("collector", "jumpstart", "theme"):
        if booster.startswith(prefix):
            return prefix
    return "special"


def two_figures(value: float) -> int:
    """Rounded half up to two significant figures, and never below LOWEST."""
    if value < LOWEST:
        return LOWEST
    step = int(10 ** max(0, math.floor(math.log10(value)) - 1))
    return max(LOWEST, int(math.floor(value / step + 0.5)) * step)


def curve_price(usd: float) -> int:
    """Tokens for a pack whose market price is usd: 500 at $6.07, 150,000 at $343.28."""
    return two_figures(ANCHOR_TOKENS * (usd / ANCHOR_USD) ** EXPONENT)


def deck_price(usd: float) -> int:
    """Tokens for a starter deck whose cards are worth usd (v0.4.2): at the current pack's rate,
    500 tokens for $6.07, so a dollar of cards costs what a dollar of a current pack does."""
    return two_figures(ANCHOR_TOKENS * usd / ANCHOR_USD)


@lru_cache(maxsize=4)
def deck_prices_at(path: str, modified: float) -> dict[str, int]:
    content = json.loads(Path(path).read_bytes())
    return {
        str(item["id"]): deck_price(float(item["usd"]))
        for item in content["decks"]
        if isinstance(item.get("usd"), int | float) and item["usd"] > 0
    }


def deck_prices(content_dir: str) -> dict[str, int]:
    """Each starter deck's price in tokens, by its ID, from content/starter-deck-prices.json
    (scripts/starter_deck_prices.py); a deck it does not price is not sold."""
    path = Path(content_dir) / DECK_PRICES
    if not path.is_file():
        return {}
    return deck_prices_at(str(path), path.stat().st_mtime)


def price_of(product: ShopProduct) -> tuple[int, PriceBasis]:
    if product.price_override is not None:
        return product.price_override, "set"
    if product.usd is not None and product.usd > 0:
        return curve_price(product.usd), "market"
    return UNPRICED, "unpriced"


def selling(product: ShopProduct, today: date) -> bool:
    return (
        product.on_sale
        and product.data_status == "ready"
        and product.collation_id is not None
        and product.set_code not in NEVER_SOLD
        and (product.released is None or product.released <= today)
    )


# The price list.


@dataclass(frozen=True)
class PriceRow:
    set_code: str
    set_name: str
    released: date | None
    booster: str
    name: str
    usd: float | None
    method: str | None
    source: str | None


@dataclass(frozen=True)
class PriceList:
    as_of: date | None
    digest: str
    rows: tuple[PriceRow, ...]

    def sets(self) -> frozenset[str]:
        return frozenset(row.set_code for row in self.rows)


def parsed_date(value: object) -> date | None:
    try:
        return date.fromisoformat(str(value)) if value else None
    except ValueError:
        return None


@lru_cache(maxsize=4)
def price_list_at(path: str, modified: float) -> PriceList:
    raw = Path(path).read_bytes()
    content = json.loads(raw)
    rows = []
    for item in content["products"]:
        usd = item.get("usd")
        rows.append(
            PriceRow(
                set_code=str(item["set"]),
                set_name=str(item["set_name"]),
                released=parsed_date(item.get("released")),
                booster=str(item["booster"]),
                name=str(item["name"]),
                usd=float(usd) if isinstance(usd, int | float) and usd > 0 else None,
                method=str(item["method"]) if item.get("method") else None,
                source=str(item["source"]) if item.get("source") else None,
            )
        )
    return PriceList(
        as_of=parsed_date(content.get("as_of")),
        digest=hashlib.sha256(raw).hexdigest(),
        rows=tuple(rows),
    )


def price_list(content_dir: str) -> PriceList | None:
    path = Path(content_dir) / PRICE_LIST
    if not path.is_file():
        return None
    return price_list_at(str(path), path.stat().st_mtime)


# Pack artwork (v0.4.3).


@dataclass(frozen=True)
class ArtImage:
    src: str
    width: int
    height: int


@dataclass(frozen=True)
class ArtEntry:
    small: ArtImage
    large: ArtImage
    origin: ArtOrigin


@dataclass(frozen=True)
class ArtIndex:
    """Each product's picture by (set code, booster), and each set's symbol by set code."""

    pictures: dict[tuple[str, str], ArtEntry] = field(default_factory=dict)
    symbols: dict[str, str] = field(default_factory=dict)

    def picture(self, set_code: str, booster: str) -> ArtEntry | None:
        return self.pictures.get((set_code, booster))

    def symbol(self, set_code: str) -> str | None:
        return self.symbols.get(set_code)


def art_image(value: object) -> ArtImage | None:
    if not isinstance(value, dict):
        return None
    src, width, height = value.get("src"), value.get("width"), value.get("height")
    if not (isinstance(src, str) and ART_FILE.match(src)):
        return None
    if not (isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0):
        return None
    return ArtImage(src=src, width=width, height=height)


@lru_cache(maxsize=4)
def pack_art_at(path: str, modified: float) -> ArtIndex:
    try:
        content = json.loads(Path(path).read_bytes())
    except (OSError, ValueError):
        return ArtIndex()
    if not isinstance(content, dict):
        return ArtIndex()
    pictures = {}
    for item in content.get("products") or []:
        if not isinstance(item, dict):
            continue
        small, large = art_image(item.get("small")), art_image(item.get("large"))
        origin = item.get("origin")
        if small is None or large is None or origin not in ART_ORIGINS:
            continue
        key = (str(item.get("set")), str(item.get("booster")))
        pictures[key] = ArtEntry(small=small, large=large, origin=origin)
    symbols = {
        str(code): path
        for code, path in (content.get("symbols") or {}).items()
        if isinstance(path, str) and SYMBOL_FILE.match(path)
    }
    return ArtIndex(pictures=pictures, symbols=symbols)


def pack_art(content_dir: str) -> ArtIndex:
    """The pictures of the packs and the set symbols, from content/pack-art.json; none when the
    file is missing or unreadable, so every product is drawn in the browser."""
    path = Path(content_dir) / PACK_ART
    if not path.is_file():
        return ArtIndex()
    return pack_art_at(str(path), path.stat().st_mtime)


# The price list each database was last brought up to, so most requests skip the comparison.
_applied: WeakKeyDictionary[Engine, str] = WeakKeyDictionary()


def ensure_products(bind: Engine, content_dir: str) -> None:
    """Brings the products up to the price list: new rows added, market prices and names
    refreshed. Its own transaction, so a request's is never committed early; another process
    adding the same rows at once leaves them to it."""
    listing = price_list(content_dir)
    if listing is None or _applied.get(bind) == listing.digest:
        return
    now = utcnow()
    try:
        with Session(bind) as session, session.begin():
            existing = {
                (product.set_code, product.booster): product
                for product in session.scalars(select(ShopProduct))
            }
            for row in listing.rows:
                if row.set_code in NEVER_SOLD:
                    continue
                values = {
                    "set_name": row.set_name,
                    "name": row.name,
                    "released": row.released,
                    "usd": row.usd,
                    "usd_method": row.method,
                    "usd_source": row.source,
                    "origin": "price_list",
                }
                found = existing.get((row.set_code, row.booster))
                if found is None:
                    session.add(
                        ShopProduct(
                            set_code=row.set_code,
                            booster=row.booster,
                            on_sale=True,
                            data_status="waiting",
                            unresolved=[],
                            unresolved_count=0,
                            created_at=now,
                            updated_at=now,
                            **values,
                        )
                    )
                elif any(getattr(found, field) != value for field, value in values.items()):
                    for field, value in values.items():
                        setattr(found, field, value)
                    found.updated_at = now
    except IntegrityError:
        return
    _applied[bind] = listing.digest
