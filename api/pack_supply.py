"""Pack supply (v0.8.9): a set printed in a known number of cards sells no more packs than that
run holds, and then shows SOLD OUT (docs/shop.md "Sold out").

The owner asked on 2026-11-06 for packs to sell out as the real ones did, with "the total in
circulation" matching "real life numbers", from researched counts. The counts are
content/pack-supply.json: each set whose print run a source of the time states, in cards (the
earliest sets, up to Fallen Empires, but Revised, whose run was only ever estimated from below).
Every product of the set takes its real size in cards out of that run, a starter deck 60 and a
booster 15 or 8, because both came off the same presses: a product is sold out once what is left
cannot fill one more. Packs bought and packs given count, from the first purchase on, before an
account's reset too, as print runs do (api/print_runs.py); SysOp's packs do not, as its cards do
not. A pack already held opens as before.
"""

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.models import Pack, ShopProduct, User


@dataclass(frozen=True)
class SetRun:
    set_code: str
    cards: int
    per_product: dict[str, int]


@lru_cache(maxsize=4)
def runs_in(folder: str) -> dict[str, SetRun]:
    """The limited sets by MTGJSON set code; none when the file is missing."""
    path = Path(folder) / "pack-supply.json"
    if not path.is_file():
        return {}
    listed = json.loads(path.read_text(encoding="utf-8"))["sets"]
    return {
        item["set"]: SetRun(item["set"], int(item["cards"]), dict(item["cards_per_product"]))
        for item in listed
    }


def size_of(run: SetRun, product: ShopProduct) -> int:
    """The cards one of the product takes out of its set's run: its real size, else the size
    MTGJSON gives it, else 15."""
    return run.per_product.get(product.booster) or product.pack_size or 15


def used(db: Session, run: SetRun) -> int:
    """The cards of the set's run that every account but SysOp has taken, as packs."""
    rows = db.execute(
        select(ShopProduct.booster, ShopProduct.pack_size, func.count(Pack.id))
        .join(Pack, Pack.product_id == ShopProduct.id)
        .join(User, User.id == Pack.user_id)
        .where(ShopProduct.set_code == run.set_code, User.kind != "sysop")
        .group_by(ShopProduct.booster, ShopProduct.pack_size)
    )
    return sum(
        (run.per_product.get(booster) or size or 15) * count for booster, size, count in rows
    )


def sold_out(db: Session, folder: str, products: list[ShopProduct]) -> set[str]:
    """The IDs (as text) of the products whose set cannot fill one more of them."""
    runs = runs_in(folder)
    found: set[str] = set()
    taken: dict[str, int] = {}
    for product in products:
        run = runs.get(product.set_code)
        if run is None:
            continue
        if run.set_code not in taken:
            taken[run.set_code] = used(db, run)
        if run.cards - taken[run.set_code] < size_of(run, product):
            found.add(str(product.id))
    return found


def take(db: Session, folder: str, product: ShopProduct, count: int) -> bool:
    """Whether the set's run holds `count` more of the product. The set's products' rows are
    locked first, in a fixed order, so two purchases at once never both take the last of it; the
    caller's transaction then adds its packs before the lock ends."""
    run = runs_in(folder).get(product.set_code)
    if run is None:
        return True
    db.execute(
        select(ShopProduct.id)
        .where(ShopProduct.set_code == run.set_code)
        .order_by(ShopProduct.id)
        .with_for_update()
    )
    return run.cards - used(db, run) >= size_of(run, product) * count
