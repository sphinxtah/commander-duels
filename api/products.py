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
"""

import hashlib
import json
import math
from dataclasses import dataclass
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
