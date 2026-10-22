"""Leng's weekly sale (v0.4.3, the owner's request): each week SALE_SIZE packs, chosen at random
among those on sale, cost SALE_PERCENT less, from Sunday midnight to the next Sunday midnight in
SALE_ZONE, Arizona time, the owner's (UTC-7 all year: Arizona keeps no daylight saving time).

The first request that needs a week's sale draws its products, with the operating system's secure
randomness, and keeps them (shop_weekly_sales), so every player sees the same ones all week and a
restart changes nothing. A product that leaves the shelf during the week (taken off sale, or its
booster data unreadable) leaves the sale too; nothing replaces it. While no product is on sale at
all (a new installation before its first booster data), nothing is kept, and the next request
draws again. The shop shows the sale at Leng's counter and on the shelf, and a purchase pays the
sale's price while the week lasts (api/shop.py).
"""

import secrets
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from uuid import UUID

from pydantic import Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.models import ShopProduct, WeeklySale
from api.products import selling
from api.schemas import Contract

SALE_ZONE = timezone(timedelta(hours=-7), "Arizona")
SALE_SIZE = 5
SALE_PERCENT = 20


class SaleInfo(Contract):
    percent: int = Field(description="How much less the sale's packs cost.")
    starts_at: datetime = Field(description="Sunday midnight, Arizona time.")
    ends_at: datetime = Field(description="The next Sunday midnight.")
    products: list[UUID] = Field(description="This week's products still on the shelf.")


@dataclass(frozen=True)
class Sale:
    starts_at: datetime
    ends_at: datetime
    percent: int
    products: frozenset[UUID]

    def price(self, product_id: UUID, price: int) -> int | None:
        """The product's price this week, or None when it is not in the sale."""
        if product_id not in self.products:
            return None
        return sale_price(price, self.percent)

    def info(self) -> SaleInfo:
        return SaleInfo(
            percent=self.percent,
            starts_at=self.starts_at,
            ends_at=self.ends_at,
            products=sorted(self.products, key=str),
        )


def week_of(now: datetime) -> tuple[date, datetime, datetime]:
    """The week holding the moment: the Sunday it starts on, and its start and end."""
    local = now.astimezone(SALE_ZONE)
    # Monday is 0 and Sunday 6: a Sunday is its own week's first day.
    sunday = local.date() - timedelta(days=(local.weekday() + 1) % 7)
    start = datetime.combine(sunday, time(0), SALE_ZONE)
    return sunday, start, start + timedelta(days=7)


def sale_price(price: int, percent: int = SALE_PERCENT) -> int:
    """The price less the sale's share, to the nearest token, never below one."""
    return max(1, round(price * (100 - percent) / 100))


def weekly_sale(db: Session, products: list[ShopProduct], now: datetime) -> Sale:
    """This week's sale, drawn now if no request has drawn it yet. Commits when it draws, so call
    it before a transaction of the caller's own begins."""
    sunday, start, end = week_of(now)
    row = db.get(WeeklySale, sunday)
    shelf = {product.id for product in products if selling(product, now.date())}
    if row is None and shelf:
        picks = secrets.SystemRandom().sample(sorted(shelf, key=str), min(SALE_SIZE, len(shelf)))
        row = WeeklySale(
            week_start=sunday,
            product_ids=[str(product_id) for product_id in picks],
            percent=SALE_PERCENT,
            created_at=now,
        )
        db.add(row)
        try:
            db.commit()
        except IntegrityError:
            # Another request drew the week first: its draw stands.
            db.rollback()
            row = db.get(WeeklySale, sunday)
    if row is None:
        return Sale(start, end, SALE_PERCENT, frozenset())
    chosen = {UUID(value) for value in row.product_ids}
    return Sale(start, end, row.percent, frozenset(chosen & shelf))
