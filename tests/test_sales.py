"""Leng's weekly sale (v0.4.3): the week from Sunday midnight to Sunday midnight, Arizona time;
the price 20% less; five products drawn once a week from those on sale and kept, the same for
every request; a product that leaves the shelf leaving the sale; and nothing kept while nothing is
on sale. The shop's own tests cover the sale on the shelf and at purchase."""

from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from api.models import ShopProduct, WeeklySale
from api.sales import SALE_SIZE, sale_price, week_of, weekly_sale


@pytest.fixture
def db(tmp_path, monkeypatch) -> Iterator[Session]:
    url = f"sqlite:///{tmp_path}/sales.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    engine = create_engine(url)
    with Session(engine, expire_on_commit=False) as session:
        yield session
    engine.dispose()


def shelf(db: Session, count: int) -> list[ShopProduct]:
    products = [
        ShopProduct(
            set_code=f"S{index:02d}",
            booster="draft",
            set_name=f"Set {index}",
            name=f"Set {index} Draft Booster",
            released=date(2020, 1, 1),
            origin="price_list",
            data_status="ready",
            collation_id=uuid4(),
            created_at=datetime(2026, 10, 1, tzinfo=UTC),
            updated_at=datetime(2026, 10, 1, tzinfo=UTC),
        )
        for index in range(count)
    ]
    db.add_all(products)
    db.commit()
    return products


def test_the_week_runs_sunday_to_sunday_arizona_time():
    # Saturday 2026-10-24, 23:59 in Arizona is Sunday 06:59 UTC: still the week of the 18th.
    sunday, start, end = week_of(datetime(2026, 10, 25, 6, 59, tzinfo=UTC))
    assert sunday == date(2026, 10, 18)
    assert start == datetime(2026, 10, 18, 7, 0, tzinfo=UTC)
    assert end == datetime(2026, 10, 25, 7, 0, tzinfo=UTC)
    # Sunday midnight in Arizona starts the next.
    assert week_of(datetime(2026, 10, 25, 7, 0, tzinfo=UTC))[0] == date(2026, 10, 25)
    # A Wednesday, and a Sunday afternoon, belong to their own Sunday's week.
    assert week_of(datetime(2026, 10, 22, 12, 0, tzinfo=UTC))[0] == date(2026, 10, 18)
    assert week_of(datetime(2026, 10, 25, 20, 0, tzinfo=UTC))[0] == date(2026, 10, 25)
    # Arizona keeps no daylight saving time: January's week starts at 07:00 UTC as well.
    assert week_of(datetime(2027, 1, 13, tzinfo=UTC))[1] == datetime(2027, 1, 10, 7, tzinfo=UTC)


def test_the_price_is_twenty_percent_less():
    assert sale_price(500) == 400
    assert sale_price(380) == 304
    assert sale_price(150_000) == 120_000
    assert sale_price(1) == 1
    assert sale_price(110) == 88


def test_five_products_are_drawn_once_a_week_and_kept(db):
    products = shelf(db, 12)
    now = datetime(2026, 10, 22, 12, 0, tzinfo=UTC)
    first = weekly_sale(db, products, now)
    assert len(first.products) == SALE_SIZE
    assert first.products <= {product.id for product in products}
    assert first.percent == 20
    # Every later request that week sees the same five.
    # (Thursday noon UTC; two days on is Saturday morning in Arizona, the same week.)
    for later in (now + timedelta(hours=1), now + timedelta(days=2)):
        assert weekly_sale(db, products, later).products == first.products
    assert db.scalar(select(func.count()).select_from(WeeklySale)) == 1
    chosen = next(iter(first.products))
    assert first.price(chosen, 500) == 400
    assert first.price(uuid4(), 500) is None
    info = first.info()
    assert info.ends_at - info.starts_at == timedelta(days=7)
    assert set(info.products) == first.products
    # The next week draws again.
    weekly_sale(db, products, now + timedelta(days=7))
    assert db.scalar(select(func.count()).select_from(WeeklySale)) == 2


def test_a_product_that_leaves_the_shelf_leaves_the_sale(db):
    products = shelf(db, 6)
    now = datetime(2026, 10, 22, 12, 0, tzinfo=UTC)
    sale = weekly_sale(db, products, now)
    gone = next(product for product in products if product.id in sale.products)
    gone.on_sale = False
    db.commit()
    later = weekly_sale(db, products, now)
    assert later.products == sale.products - {gone.id}
    stored = db.get(WeeklySale, date(2026, 10, 18))
    assert stored is not None and str(gone.id) in stored.product_ids


def test_nothing_is_kept_while_nothing_is_on_sale(db):
    now = datetime(2026, 10, 22, 12, 0, tzinfo=UTC)
    empty = weekly_sale(db, [], now)
    assert empty.products == frozenset()
    assert db.scalar(select(func.count()).select_from(WeeklySale)) == 0
    # Fewer products than a sale's five: all of them.
    products = shelf(db, 3)
    assert weekly_sale(db, products, now).products == {product.id for product in products}
    assert all(isinstance(value, UUID) for value in weekly_sale(db, products, now).products)
