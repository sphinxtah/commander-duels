"""Leng's card shop (v0.4.0): the price curve, drawing packs from a collation, the booster data job
against a fake MTGJSON, and buying, opening and giving packs through the API.

The test collation is tests/fixtures/mtgjson/ZNR.json: a made-up set file whose Zendikar Rising
draft booster draws from the test catalog's printings. No test reaches the network."""

import hashlib
import json
import lzma
import os
import random
import shutil
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
import test_progression
from alembic import command
from alembic.config import Config
from catalog_fixtures import FIXTURES, bulk, database, engine_list, import_bulk
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, make_url, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_decks_api import starter
from test_games import SERVICE_TOKEN, SYSOP_ADDRESS
from test_progression import Account

from api import collation as collations
from api import products, sales
from api import shop as shop_api
from api.collation import Collation, Layout, Sheet, SheetCard
from api.config import Settings
from api.identity import utcnow
from api.main import create_app
from api.models import (
    AuditEvent,
    BoosterCollation,
    BoosterSyncRun,
    CardConcept,
    LibraryGrant,
    Pack,
    PackCard,
    PackOpening,
    ScheduledJob,
    ShopProduct,
    TokenEntry,
    WeeklySale,
)
from catalog import boosters, sync

CONTENT = Path(__file__).resolve().parent.parent / "content"
SET_FILES = FIXTURES / "mtgjson"
SHOP_TABLES = ("pack_cards", "pack_openings", "packs")

url = test_progression.url
engine = test_progression.engine


@pytest.fixture(scope="module")
def content(tmp_path_factory) -> Path:
    folder = tmp_path_factory.mktemp("shop-content")
    for name in ("planeswalkers.json", "pack-prices.json"):
        shutil.copy(CONTENT / name, folder / name)
    # Starter decks from the test catalog (v0.4.2); the last has no price, so it is not sold.
    decks = [
        starter(
            "starter_red_test", 1, "Red Test", [(1, "Kenrith, the Returned King"), (99, "Mountain")]
        ),
        starter(
            "starter_blue_test", 2, "Blue Test", [(1, "Thrasios, Triton Hero"), (99, "Island")]
        ),
        starter(
            "starter_karlach_test",
            3,
            "Karlach Test",
            [(1, "Karlach, Fury of Avernus"), (1, "Lightning Bolt"), (98, "Mountain")],
        ),
        starter(
            "starter_pir_test", 4, "Pir Test", [(1, "Pir, Imaginative Rascal"), (99, "Forest")]
        ),
    ]
    (folder / "starter-decks.json").write_text(
        json.dumps({"version": 1, "source": "tests", "decks": decks}), encoding="utf-8"
    )
    prices = [
        ("starter_red_test", 6.07),
        ("starter_blue_test", 3.0),
        ("starter_karlach_test", 18.21),
    ]
    (folder / "starter-deck-prices.json").write_text(
        json.dumps({"decks": [{"id": ident, "usd": usd} for ident, usd in prices]}),
        encoding="utf-8",
    )
    # Pack artwork (v0.4.3): the draft booster has a picture; the collector booster's entry names
    # a file elsewhere, so it is drawn in the browser like the set booster, which has none.
    (folder / "pack-art.json").write_text(json.dumps(ART), encoding="utf-8")
    return folder


def picture(name: str, width: int, height: int) -> dict[str, Any]:
    return {"src": f"/packs/{name}.webp", "width": width, "height": height}


ZNR_ART = {
    "small": picture("znr-draft-160", 92, 160),
    "large": picture("znr-draft-480", 276, 480),
    "origin": "tcgplayer",
}
ART = {
    "as_of": "2026-10-22",
    "products": [
        {
            "set": "ZNR",
            "booster": "draft",
            **ZNR_ART,
            "page": "https://www.tcgplayer.com/product/1",
        },
        {
            "set": "ZNR",
            "booster": "collector",
            "small": {"src": "https://elsewhere.example/znr.webp", "width": 92, "height": 160},
            "large": picture("znr-collector-480", 276, 480),
            "origin": "tcgplayer",
        },
    ],
    "generated": [{"set": "ZNR", "booster": "set", "reason": "None found."}],
    "symbols": {"ZNR": "/sets/znr.svg", "KHM": "javascript:alert(1)"},
}


@pytest.fixture(scope="module")
def collated(url: str, content: Path) -> str:
    """The test catalog with the fixture collation, read as the job reads MTGJSON's files."""
    database = create_engine(url)
    counts = boosters.load_local(database, SET_FILES, str(content))
    assert (counts["ready"], counts["revisions"]) == (1, 1)
    database.dispose()
    return url


@pytest.fixture
def client(collated: str, content: Path, engine, tmp_path):
    app = create_app(
        Settings(
            database_url=collated,
            content_dir=str(content),
            catalog_dir=str(tmp_path / "catalog"),
            sysop_networks="10.20.0.0/24",
            engine_service_token=SERVICE_TOKEN,
        )
    )
    app.state.engine_transport = httpx.MockTransport(engine)
    with TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS) as client:
        # The fixture's one product would always be in the weekly sale (v0.4.3): this week's sale
        # is kept empty, so prices are the shelf's, unless a test draws the week itself.
        with Session(app.state.database) as db:
            no_sale(db)
        yield client
        with Session(app.state.database) as db:
            db.execute(text("DELETE FROM shop_weekly_sales"))
            for table in SHOP_TABLES:
                db.execute(text(f"DELETE FROM {table}"))
            db.execute(
                text(
                    "UPDATE shop_products SET price_override = NULL, price_reason = NULL, "
                    "on_sale = :yes, sale_reason = NULL, changed_by = NULL, changed_at = NULL"
                ),
                {"yes": True},
            )
            db.execute(text("DELETE FROM scheduled_jobs"))
            for table in ("token_ledger", "audit_events", "library_grants", "decks"):
                db.execute(text(f"DELETE FROM {table}"))
            for table in ("role_grants", "sessions", "progress_ledger", "users"):
                db.execute(text(f"DELETE FROM {table}"))
            db.commit()


def no_sale(db: Session) -> None:
    db.add(
        WeeklySale(
            week_start=sales.week_of(utcnow())[0], product_ids=[], percent=20, created_at=utcnow()
        )
    )
    db.commit()


def fixture_product(client: TestClient, booster: str = "draft") -> ShopProduct:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return db.scalars(
            select(ShopProduct).where(ShopProduct.set_code == "ZNR", ShopProduct.booster == booster)
        ).one()


def funded(client: TestClient, handle: str, tokens: int) -> Account:
    account = Account(client, handle)
    root = Account(client, f"root-{handle}", kind="sysop")
    given = root.send(
        "POST",
        f"/api/v1/admin/users/{account.id}/tokens",
        {"amount": tokens, "reason": "Testing the shop"},
    )
    assert given.status_code == 200, given.text
    return account


def buy(account: Account, product: UUID | str, key: str | None = None) -> Any:
    return account.send(
        "POST", "/api/v1/shop/purchases", {"product": str(product), "key": key or uuid4().hex}
    )


# Prices.


def test_the_price_curve():
    assert products.curve_price(343.28) == 150_000
    assert products.curve_price(6.07) == 500
    assert products.curve_price(4.97) == 380
    assert products.curve_price(2.13) == 110
    assert products.two_figures(149_999.99) == 150_000
    assert products.two_figures(1_234_567) == 1_200_000
    assert products.two_figures(45) == 45
    assert products.two_figures(3) == products.LOWEST
    listing = products.price_list(str(CONTENT))
    assert listing is not None and len(listing.rows) == 392
    prices = {(row.set_code, row.booster): row for row in listing.rows}
    assert products.curve_price(prices["3ED", "default"].usd or 0) == 150_000
    assert products.curve_price(prices["FRA", "play"].usd or 0) == 500
    # The early sets are dearer still; Alpha and Beta are not listed at all.
    assert products.curve_price(prices["2ED", "default"].usd or 0) > 150_000
    assert not {"LEA", "LEB"} & listing.sets()
    assert products.kind_of("theme-w") == "theme"
    assert products.kind_of("collector-special") == "collector"
    assert products.kind_of("default") == "booster"
    assert products.kind_of("vip") == "special"
    assert products.era_of(date(1994, 4, 11)) == "first"
    assert products.era_of(date(2024, 2, 9)) == "play"
    assert products.era_of(date(2020, 9, 25)) == "collector"


# Drawing.


def sheet_of(
    *cards: tuple[UUID, int], foil: bool = False, colors: str = "", **flags: bool
) -> Sheet:
    finish = "foil" if foil else "nonfoil"
    return Sheet(
        foil=foil,
        fixed=flags.get("fixed", False),
        balance_colors=flags.get("balance_colors", False),
        allow_duplicates=flags.get("allow_duplicates", False),
        cards=tuple(SheetCard(card, weight, colors, finish) for card, weight in cards),
    )


def ids(count: int) -> list[UUID]:
    return [uuid4() for _ in range(count)]


def test_packs_follow_the_layout_and_sheet_weights():
    commons, (rare, mythic) = ids(4), ids(2)
    collation = Collation(
        layouts=(
            Layout((("common", 2), ("rare", 1)), 3),
            Layout((("common", 2), ("mythic", 1)), 1),
        ),
        sheets={
            "common": sheet_of(*((card, 1) for card in commons)),
            "rare": sheet_of((rare, 3), (mythic, 1)),
            "mythic": sheet_of((mythic, 1)),
        },
    )
    rng = random.Random(20261021)
    packs = 20_000
    layouts: Counter[int] = Counter()
    seen: Counter[UUID] = Counter()
    for _ in range(packs):
        layout, pulled = collations.draw(collation, rng)
        layouts[layout] += 1
        assert len(pulled) == 3
        assert len({card.printing_id for card in pulled}) == 3
        seen.update(card.printing_id for card in pulled)
    assert layouts[0] / packs == pytest.approx(0.75, abs=0.015)
    # The rare slot: 3 in 4 rare, 1 in 4 mythic; and the mythic layout always a mythic.
    assert seen[rare] / packs == pytest.approx(0.75 * 0.75, abs=0.015)
    assert seen[mythic] / packs == pytest.approx(0.75 * 0.25 + 0.25, abs=0.015)
    # Two commons a pack, never the same twice: each common is in half the packs.
    for card in commons:
        assert seen[card] / packs == pytest.approx(0.5, abs=0.015)


def test_duplicates_foils_fixed_and_balanced_sheets():
    shared, other = ids(2)
    rng = random.Random(7)
    overlapping = Collation(
        layouts=(Layout((("common", 1), ("commonUncommon", 1), ("foil", 1)), 1),),
        sheets={
            "common": sheet_of((shared, 1)),
            "commonUncommon": sheet_of((shared, 100), (other, 1)),
            "foil": sheet_of((shared, 1), foil=True),
        },
    )
    for _ in range(200):
        _, pulled = collations.draw(overlapping, rng)
        # The same printing never twice in one finish; a foil copy of it may come too.
        assert [(card.printing_id, card.finish) for card in pulled] == [
            (shared, "nonfoil"),
            (other, "nonfoil"),
            (shared, "foil"),
        ]
    repeated = Collation(
        layouts=(Layout((("land", 3),), 1),),
        sheets={"land": sheet_of((shared, 1), allow_duplicates=True)},
    )
    assert [card.printing_id for card in collations.draw(repeated, rng)[1]] == [shared] * 3
    pair = ids(2)
    fixed = Collation(
        layouts=(Layout((("pair", 2), ("common", 1)), 1),),
        sheets={
            "pair": sheet_of((pair[0], 1), (pair[1], 1), fixed=True),
            "common": sheet_of((pair[0], 1), (other, 1)),
        },
    )
    for _ in range(50):
        assert [card.printing_id for card in collations.draw(fixed, rng)[1]] == [*pair, other]
    by_color = {color: ids(3) for color in "WUBRG"}
    balanced = Collation(
        layouts=(Layout((("common", 5),), 1),),
        sheets={
            "common": Sheet(
                foil=False,
                fixed=False,
                balance_colors=True,
                allow_duplicates=False,
                cards=tuple(
                    SheetCard(card, 1, color, "nonfoil")
                    for color, cards in by_color.items()
                    for card in cards
                ),
            )
        },
    )
    color_of = {card: color for color, cards in by_color.items() for card in cards}
    for _ in range(200):
        _, pulled = collations.draw(balanced, rng)
        assert sorted(color_of[card.printing_id] for card in pulled) == sorted("WUBRG")
    # Stored and read back, a collation is the same, with the same digest.
    layouts, sheets = balanced.to_json()
    again = collations.from_json(json.loads(json.dumps(layouts)), json.loads(json.dumps(sheets)))
    assert again == balanced and again.digest() == balanced.digest()
    with pytest.raises(ValueError):
        collations.from_json([{"contents": {"missing": 1}, "weight": 1}], sheets)


def test_finishes_follow_the_sheet_and_the_printing():
    assert boosters.finish_of(False, "common", ("nonfoil", "foil")) == "nonfoil"
    assert boosters.finish_of(False, "specialGuest", ("foil",)) == "foil"
    assert boosters.finish_of(True, "foil", ("nonfoil", "foil")) == "foil"
    assert boosters.finish_of(True, "etchedFoil", ("etched",)) == "etched"
    assert boosters.finish_of(True, "foilRare", ("etched",)) == "etched"
    # Conflux's code is a reserved file name on Windows; MTGJSON serves it with an underscore.
    base = "https://mtgjson.com/api/v5"
    assert boosters.file_url(base, "CON") == f"{base}/CON_.json.xz"
    assert boosters.file_url(base, "ZNR") == f"{base}/ZNR.json.xz"


# The booster data job.


def compressed(content: dict[str, Any]) -> bytes:
    return lzma.compress(json.dumps(content).encode())


def fixture_set() -> dict[str, Any]:
    return json.loads((SET_FILES / "ZNR.json").read_text(encoding="utf-8"))


class FakeMtgjson:
    """MTGJSON's file host: .json.xz files by name, with ETags, answering If-None-Match."""

    def __init__(self, files: dict[str, dict[str, Any]]) -> None:
        self.files = {f"{name}.json.xz": compressed(content) for name, content in files.items()}
        self.requests: list[httpx.Request] = []
        self.status: int | None = None

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert request.url.host == "mtgjson.com"
        if self.status is not None:
            return httpx.Response(self.status)
        body = self.files.get(request.url.path.rsplit("/", 1)[-1])
        if body is None:
            return httpx.Response(404)
        tag = f'"{hashlib.sha256(body).hexdigest()[:16]}"'
        if request.headers.get("if-none-match") == tag:
            return httpx.Response(304, headers={"etag": tag})
        return httpx.Response(
            200,
            stream=httpx.ByteStream(body),
            headers={"etag": tag, "last-modified": "Wed, 21 Oct 2026 08:00:00 GMT"},
        )


@pytest.fixture
def job_content(tmp_path) -> Path:
    """A short price list from an earlier day, so a set released since can be found."""
    folder = tmp_path / "content"
    folder.mkdir()
    rows = [
        ("ZNR", "Zendikar Rising", "2020-09-25", "draft", 4.97),
        ("ZNR", "Zendikar Rising", "2020-09-25", "set", 7.94),
        ("3ED", "Revised Edition", "1994-04-11", "default", 343.28),
        ("LEA", "Limited Edition Alpha", "1993-08-05", "default", 30000.0),
    ]
    listing = {
        "as_of": "2026-01-01",
        "products": [
            {
                "set": code,
                "set_name": name,
                "released": released,
                "booster": booster,
                "name": f"{name} {booster}",
                "usd": usd,
                "method": "pack",
                "source": None,
            }
            for code, name, released, booster, usd in rows
        ],
    }
    (folder / "pack-prices.json").write_text(json.dumps(listing), encoding="utf-8")
    return folder


def job_world(tmp_path: Path, job_content: Path) -> tuple[Any, Settings]:
    engine = database(tmp_path)
    import_bulk(engine, tmp_path / "files", bulk(), engine_list())
    settings = Settings(
        database_url=f"sqlite:///{tmp_path}/catalog.db",
        catalog_dir=str(tmp_path / "catalog"),
        content_dir=str(job_content),
    )
    return engine, settings


def run_job(engine: Any, settings: Settings, host: FakeMtgjson) -> sync.Outcome:
    now = datetime.now(UTC)
    with Session(engine) as session, session.begin():
        job = boosters.request_now(session, uuid4(), now)
        assert job is not None
        session.flush()
        job.status, job.generation, job.lease_until = "running", 1, now + timedelta(minutes=5)
        claimed = sync.Claimed(job.id, 1, dict(job.payload))
    with httpx.Client(transport=httpx.MockTransport(host)) as http:
        outcome = boosters.handle(engine, settings, http, claimed, None, pause=0)
    sync.settle(engine, claimed, outcome, datetime.now(UTC))
    return outcome


def set_list(*sets: tuple[str, str, str]) -> dict[str, Any]:
    return {
        "meta": {"version": "5.3.0+fixture"},
        "data": [
            {"code": code, "name": code, "releaseDate": released, "type": kind}
            for code, released, kind in sets
        ],
    }


def test_the_job_collates_resolves_and_asks_only_for_changes(tmp_path, job_content):
    engine, settings = job_world(tmp_path, job_content)
    later = fixture_set()
    later["data"].update(code="TRK", name="Star Trek", releaseDate="2026-03-01")
    later["data"]["booster"] = {"play": later["data"]["booster"]["draft"]}
    later["data"]["booster"]["play"]["name"] = "Star Trek Play Booster"
    host = FakeMtgjson(
        {
            "ZNR": fixture_set(),
            "TRK": later,
            "SetList": set_list(
                ("TRK", "2026-03-01", "expansion"),
                ("YTRK", "2026-03-02", "alchemy"),
                ("OLD", "2025-12-01", "expansion"),
                ("FUT", "2099-01-01", "expansion"),
            ),
        }
    )
    assert run_job(engine, settings, host).code == "imported"
    with Session(engine) as db:
        found = {(row.set_code, row.booster): row for row in db.scalars(select(ShopProduct))}
        assert set(found) == {("ZNR", "draft"), ("ZNR", "set"), ("3ED", "default"), ("TRK", "play")}
        draft, play = found["ZNR", "draft"], found["TRK", "play"]
        assert (draft.data_status, draft.pack_size, draft.origin) == ("ready", 15, "price_list")
        assert found["ZNR", "set"].data_status == found["3ED", "default"].data_status == "missing"
        # A set after the price list is sold at 500 until priced.
        assert (play.origin, play.name, play.data_status) == (
            "mtgjson",
            "Star Trek Play Booster",
            "ready",
        )
        assert products.price_of(play) == (500, "unpriced")
        collation = db.get_one(BoosterCollation, draft.collation_id)
        assert (collation.revision, collation.mtgjson_version, collation.cards) == (
            1,
            "5.3.0+fixture",
            44,
        )
        assert collation.sheets["foil"]["foil"] is True  # type: ignore[index]
        run = db.scalars(select(BoosterSyncRun)).one()
        assert run.status == "succeeded"
        assert run.stats["revisions"] == 2 and run.stats["discovered"] == ["TRK/play"]
    first = [request.url.path for request in host.requests]
    assert first[0] == "/api/v5/SetList.json.xz"
    assert {"/api/v5/ZNR.json.xz", "/api/v5/TRK.json.xz", "/api/v5/3ED.json.xz"} <= set(first)
    assert all(
        request.headers["user-agent"].startswith("CommanderDuels/") for request in host.requests
    )
    assert not any("if-none-match" in request.headers for request in host.requests)
    # The next run asks only for changes, and nothing changed: no new revision.
    host.requests.clear()
    assert run_job(engine, settings, host).code == "unchanged"
    asked = [request for request in host.requests if request.url.path.endswith("ZNR.json.xz")]
    assert asked and all("if-none-match" in request.headers for request in asked)
    with Session(engine) as db:
        assert (
            db.scalar(
                select(BoosterCollation.revision)
                .order_by(BoosterCollation.revision.desc())
                .limit(1)
            )
            == 1
        )
        latest = db.scalars(
            select(BoosterSyncRun).order_by(BoosterSyncRun.started_at.desc())
        ).first()
        assert latest is not None and latest.status == "unchanged"
        assert latest.stats["downloaded"] == [] and latest.stats["unchanged"] >= 2
    # A changed booster is a new revision; the old one stays for the packs it opened.
    changed = fixture_set()
    changed["data"]["booster"]["draft"]["boosters"][0]["weight"] = 5
    host.files["ZNR.json.xz"] = compressed(changed)
    assert run_job(engine, settings, host).code == "imported"
    with Session(engine) as db:
        revisions = db.scalars(
            select(BoosterCollation.revision)
            .join(ShopProduct, ShopProduct.id == BoosterCollation.product_id)
            .where(ShopProduct.set_code == "ZNR")
        ).all()
        assert sorted(revisions) == [1, 2]
    engine.dispose()


def test_unresolved_cards_keep_a_product_off_sale(tmp_path, job_content):
    engine, settings = job_world(tmp_path, job_content)
    broken = fixture_set()
    broken["data"]["cards"].append(
        {
            "uuid": "made-up-uuid",
            "name": "A Card From Tomorrow",
            "identifiers": {"scryfallId": str(uuid4())},
        }
    )
    broken["data"]["booster"]["draft"]["sheets"]["rareMythic"]["cards"]["made-up-uuid"] = 1
    host = FakeMtgjson({"ZNR": broken})
    run_job(engine, settings, host)
    with Session(engine) as db:
        draft = db.scalars(
            select(ShopProduct).where(ShopProduct.set_code == "ZNR", ShopProduct.booster == "draft")
        ).one()
        assert (draft.data_status, draft.unresolved_count, draft.collation_id) == (
            "unresolved",
            1,
            None,
        )
        assert draft.unresolved[0]["name"] == "A Card From Tomorrow"
        assert not products.selling(draft, date.today())
    engine.dispose()


def test_the_job_waits_retries_and_is_scheduled_weekly(tmp_path, job_content):
    empty = database(tmp_path)
    settings = Settings(
        database_url=f"sqlite:///{tmp_path}/catalog.db",
        catalog_dir=str(tmp_path / "catalog"),
        content_dir=str(job_content),
    )
    # Before the catalog's first import, the run waits without counting an attempt.
    outcome = run_job(empty, settings, FakeMtgjson({}))
    assert (outcome.status, outcome.code) == ("pending", "waiting_for_catalog")
    with Session(empty) as db:
        assert db.scalars(select(BoosterSyncRun)).all() == []
        assert db.scalars(select(ScheduledJob)).one().payload.get("attempt", 1) == 1
    empty.dispose()
    (tmp_path / "world").mkdir()
    engine, settings = job_world(tmp_path / "world", job_content)
    host = FakeMtgjson({"ZNR": fixture_set()})
    host.status = 503
    outcome = run_job(engine, settings, host)
    assert (outcome.status, outcome.code) == ("pending", "mtgjson_unavailable")
    with Session(engine) as db:
        run = db.scalars(select(BoosterSyncRun)).one()
        assert run.status == "failed" and run.next_attempt_at is not None
    # Weekly: this week's run and next week's, each once, due on Monday.
    now = datetime(2026, 10, 21, 12, tzinfo=UTC)
    boosters.ensure_scheduled(engine, settings, now)
    boosters.ensure_scheduled(engine, settings, now)
    with Session(engine) as db:
        weekly = db.scalars(
            select(ScheduledJob)
            .where(ScheduledJob.deduplication_key.like("booster_sync:2026-W%"))
            .order_by(ScheduledJob.due_at)
        ).all()
        assert [job.deduplication_key for job in weekly] == [
            "booster_sync:2026-W43",
            "booster_sync:2026-W44",
        ]
        assert [job.due_at.date() for job in weekly] == [date(2026, 10, 19), date(2026, 10, 26)]
        assert boosters.request_now(db, uuid4(), now) is None
    engine.dispose()


# Through the API.


def test_the_shop_lists_what_is_on_sale(client):
    ada = Account(client, "ada")
    view = ada.get("/api/v1/shop")
    assert view.status_code == 200
    shop = view.json()
    assert shop["balance"] == 0 and shop["inventory"] == []
    # Only the fixture's product is ready; the others wait for their booster data.
    [product] = shop["products"]
    assert product | {"id": None} == {
        "id": None,
        "set_code": "ZNR",
        "set_name": "Zendikar Rising",
        "name": "Zendikar Rising Draft Booster",
        "kind": "draft",
        "released": "2020-09-25",
        "booster": "draft",
        "era": "collector",
        "art": ZNR_ART,
        "symbol": "/sets/znr.svg",
        "price": 380,
        "price_basis": "market",
        "pack_size": 15,
        "sale_price": None,
    }
    assert [era["id"] for era in shop["eras"]][:2] == ["play", "collector"]
    assert shop["data"] == {
        "mtgjson_version": "5.3.0+fixture",
        "prices_as_of": "2026-10-21",
        "checked_at": None,
    }
    # Players never see a price in dollars.
    assert "usd" not in view.text


def test_buying_spends_once_per_key(client):
    ada = funded(client, "ada", 1_000)
    product = fixture_product(client).id
    first = buy(ada, product, "first-purchase")
    assert first.status_code == 201, first.text
    bought = first.json()
    assert (bought["tokens"], bought["balance"], bought["repeated"]) == (380, 620, False)
    again = buy(ada, product, "first-purchase").json()
    assert (again["pack"], again["balance"], again["repeated"]) == (bought["pack"], 620, True)
    assert buy(ada, product).json()["balance"] == 240
    short = buy(ada, product)
    assert (short.status_code, short.json()["code"]) == (409, "not_enough_tokens")
    reused = buy(ada, uuid4(), "first-purchase")
    assert (reused.status_code, reused.json()["code"]) == (409, "key_reused")
    assert buy(ada, uuid4()).status_code == 404
    assert (
        ada.send(
            "POST", "/api/v1/shop/purchases", {"product": str(product), "key": "x"}
        ).status_code
        == 422
    )
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        packs = db.scalars(select(Pack).where(Pack.user_id == ada.id)).all()
        assert len(packs) == 2
        spent = db.scalars(
            select(TokenEntry).where(TokenEntry.user_id == ada.id, TokenEntry.kind == "pack")
        ).all()
        assert {(entry.key, entry.amount) for entry in spent} == {
            (f"pack:{pack.id}", -380) for pack in packs
        }
    inventory = ada.get("/api/v1/shop").json()["inventory"]
    assert [
        (item["product"]["set_code"], item["count"], item["openable"]) for item in inventory
    ] == [("ZNR", 2, True)]


def test_the_weekly_sale(client):
    # v0.4.3: this week's five products (here the fixture's one) cost 20% less, shown at the
    # counter and on the shelf, and paid at purchase; a product off the shelf leaves the sale.
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(text("DELETE FROM shop_weekly_sales"))
        db.commit()
    ada = funded(client, "ada", 1_000)
    product = fixture_product(client)
    shop = ada.get("/api/v1/shop").json()
    sale = shop["sale"]
    assert sale["percent"] == 20 and sale["products"] == [str(product.id)]
    starts, ends = (datetime.fromisoformat(sale[key]) for key in ("starts_at", "ends_at"))
    assert ends - starts == timedelta(days=7)
    # Sunday midnight in Arizona: 07:00 UTC.
    assert starts.astimezone(UTC).weekday() == 6 and starts.astimezone(UTC).hour == 7
    [shown] = shop["products"]
    assert (shown["price"], shown["sale_price"]) == (380, 304)
    bought = buy(ada, product.id).json()
    assert (bought["tokens"], bought["balance"]) == (304, 696)
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        entry = db.scalars(
            select(TokenEntry).where(TokenEntry.user_id == ada.id, TokenEntry.kind == "pack")
        ).one()
        assert (entry.amount, entry.reason) == (
            -304,
            "Zendikar Rising Draft Booster (weekly sale, 20% off)",
        )
        assert db.scalar(select(func.count()).select_from(WeeklySale)) == 1
    # Taken off sale by the staff, it leaves the shelf and the sale.
    staff = Account(client, "staff", admin=True)
    off = staff.send(
        "PUT",
        f"/api/v1/admin/shop/products/{product.id}/sale",
        {"on_sale": False, "reason": "Testing the sale"},
    )
    assert off.status_code == 200, off.text
    after = ada.get("/api/v1/shop").json()
    assert after["sale"]["products"] == [] and after["products"] == []


def buy_deck(account: Account, deck: str) -> httpx.Response:
    return account.send("POST", "/api/v1/shop/decks", {"deck": deck})


def test_starter_decks_are_free_first_then_sold_once_each(client):
    # v0.4.2: the two starter decks chosen at onboarding cost nothing; after them, Leng sells the
    # others, each once, priced from the value of its cards.
    new = Account(client, "newcomer", onboarding="starters")
    root = Account(client, "root-newcomer", kind="sysop")
    give = {"amount": 1_000, "reason": "Stands in for the welcome grant"}
    root.send("POST", f"/api/v1/admin/users/{new.id}/tokens", give)
    view = new.get("/api/v1/shop").json()
    assert view["free_decks"] is True
    assert [(deck["id"], deck["price"], deck["owned"]) for deck in view["decks"]] == [
        ("starter_red_test", None, False),
        ("starter_blue_test", None, False),
        ("starter_karlach_test", None, False),
        ("starter_pir_test", None, False),
    ]
    # The commander's picture: the catalog's own printing where the chosen one is missing.
    assert all(deck["commander_printing_id"] for deck in view["decks"])
    refused = buy_deck(new, "starter_karlach_test")
    assert (refused.status_code, refused.json()["code"]) == (409, "starters_first")

    chosen = new.send(
        "POST", "/api/v1/me/starters", {"decks": ["starter_red_test", "starter_blue_test"]}
    )
    assert chosen.status_code == 201, chosen.text
    view = new.get("/api/v1/shop").json()
    assert (view["free_decks"], view["balance"]) == (False, 1_000)
    assert [(deck["id"], deck["price"], deck["owned"]) for deck in view["decks"]] == [
        ("starter_red_test", 500, True),
        ("starter_blue_test", 250, True),
        ("starter_karlach_test", 1_500, False),
        ("starter_pir_test", None, False),
    ]
    owned = buy_deck(new, "starter_red_test")
    assert (owned.status_code, owned.json()["code"]) == (409, "deck_owned")
    unpriced = buy_deck(new, "starter_pir_test")
    assert (unpriced.status_code, unpriced.json()["code"]) == (409, "not_on_sale")
    assert buy_deck(new, "starter_nobody").status_code == 404
    short = buy_deck(new, "starter_karlach_test")
    assert (short.status_code, short.json()["code"]) == (409, "not_enough_tokens")

    root.send("POST", f"/api/v1/admin/users/{new.id}/tokens", give)
    bought = buy_deck(new, "starter_karlach_test")
    assert bought.status_code == 201, bought.text
    purchase = bought.json()
    assert (purchase["tokens"], purchase["balance"], purchase["repeated"]) == (1_500, 500, False)
    decks = {deck["id"]: deck for deck in new.get("/api/v1/decks").json()}
    assert decks[purchase["deck"]]["title"] == "Karlach Test"
    library = {item["card"]["name"]: item for item in new.get("/api/v1/library").json()["cards"]}
    assert library["Karlach, Fury of Avernus"]["sources"] == ["starter"]
    assert library["Lightning Bolt"]["copies"] == 1
    # A retry buys nothing more; the deck is owned from now on.
    again = buy_deck(new, "starter_karlach_test").json()
    assert (again["deck"], again["balance"], again["repeated"]) == (purchase["deck"], 500, True)
    view = new.get("/api/v1/shop").json()
    assert [deck["owned"] for deck in view["decks"]] == [True, True, True, False]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        spent = db.scalars(
            select(TokenEntry).where(TokenEntry.user_id == new.id, TokenEntry.amount < 0)
        ).all()
        assert [(entry.kind, entry.key, entry.amount, entry.reason) for entry in spent] == [
            ("pack", f"deck:{new.id}:starter_karlach_test", -1_500, "Starter deck: Karlach Test")
        ]


def test_opening_draws_once_and_grants_the_cards(client, monkeypatch):
    refreshed = []
    real = shop_api.refresh_decks

    def refresh(db: Session, user_id: UUID, library: Any) -> None:
        refreshed.append(user_id)
        real(db, user_id, library)

    monkeypatch.setattr(shop_api, "refresh_decks", refresh)
    ada = funded(client, "ada", 1_000)
    bob = Account(client, "bob")
    pack = buy(ada, fixture_product(client).id).json()["pack"]
    assert bob.send("POST", f"/api/v1/shop/packs/{pack}/open").status_code == 404
    opened = ada.send("POST", f"/api/v1/shop/packs/{pack}/open")
    assert opened.status_code == 200, opened.text
    opening = opened.json()
    cards = opening["cards"]
    assert len(cards) == 15 and opening["collation_revision"] == 1
    assert [card["position"] for card in cards] == list(range(15))
    # Revealed commons first, the rarest last, any foil after them.
    order = {"common": 0, "uncommon": 1, "rare": 2, "mythic": 3}
    plain = [order[card["rarity"]] for card in cards if card["finish"] == "nonfoil"]
    assert plain == sorted(plain)
    assert sum(1 for card in cards if card["sheet"] == "rareMythic") == 1
    lands = [card for card in cards if card["sheet"] == "land"]
    assert len(lands) == 1 and not lands[0]["new"]
    assert refreshed == [ada.id]
    # The same pack asked for again is the same pack.
    again = ada.send("POST", f"/api/v1/shop/packs/{pack}/open").json()
    assert again == opening
    assert ada.get(f"/api/v1/shop/openings/{opening['id']}").json() == opening
    assert bob.get(f"/api/v1/shop/openings/{opening['id']}").status_code == 404
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        assert db.scalars(select(PackOpening)).one().id == UUID(opening["id"])
        grants = db.scalars(select(LibraryGrant).where(LibraryGrant.user_id == ada.id)).all()
        assert {grant.grant_key for grant in grants} == {f"pack:{opening['id']}"}
        assert {grant.source for grant in grants} == {"pack"}
        # Every card a deck may hold, basic lands aside: they are in every library already.
        kept = db.scalar(
            select(func.count())
            .select_from(PackCard)
            .join(CardConcept, CardConcept.id == PackCard.concept_id)
            .where(
                PackCard.opening_id == UUID(opening["id"]),
                CardConcept.deck_card.is_(True),
                CardConcept.type_line.not_like("Basic %"),
            )
        )
        assert kept and sum(grant.quantity for grant in grants) == kept
    library = ada.get("/api/v1/library").json()
    assert library["cards"] and all("pack" in card["sources"] for card in library["cards"])
    history = ada.get("/api/v1/shop/openings").json()
    assert [(item["id"], item["cards"]) for item in history] == [(opening["id"], 15)]
    assert history[0]["new_cards"] == sum(1 for card in cards if card["new"])
    assert ada.get("/api/v1/shop").json()["inventory"] == []
    # A second pack: cards the first pack brought are no longer new.
    second = buy(ada, fixture_product(client).id).json()["pack"]
    more = ada.send("POST", f"/api/v1/shop/packs/{second}/open").json()["cards"]
    before = {card["card_id"] for card in cards if card["sheet"] != "land"}
    for card in more:
        if card["card_id"] in before:
            assert not card["new"]


def test_every_answer_naming_a_product_carries_its_pack_art(client):
    """v0.4.3: the shelf, the packs held, a purchase, an opening, the history and Administration
    all carry the product's picture and its set's symbol; a product without one carries null."""
    ada = funded(client, "ada", 1_000)
    bought = buy(ada, fixture_product(client).id).json()
    assert (bought["product"]["art"], bought["product"]["symbol"]) == (ZNR_ART, "/sets/znr.svg")
    assert bought["product"]["era"] == "collector" and bought["product"]["booster"] == "draft"
    [held] = ada.get("/api/v1/shop").json()["inventory"]
    assert held["product"]["art"] == ZNR_ART
    opening = ada.send("POST", f"/api/v1/shop/packs/{bought['pack']}/open").json()
    assert opening["product"]["art"] == ZNR_ART
    assert ada.get(f"/api/v1/shop/openings/{opening['id']}").json()["product"]["art"] == ZNR_ART
    [summary] = ada.get("/api/v1/shop/openings").json()
    assert (summary["product"]["art"], summary["product"]["symbol"]) == (ZNR_ART, "/sets/znr.svg")
    admin = Account(client, "admin", admin=True)
    everything = admin.get("/api/v1/admin/shop").json()["products"]
    listed = {item["booster"]: item for item in everything if item["set_code"] == "ZNR"}
    assert listed["draft"]["art"] == ZNR_ART
    # No picture, or one that is not a file of this site: the browser draws the pack.
    assert listed["set"]["art"] is None and listed["collector"]["art"] is None
    assert listed["set"]["symbol"] == "/sets/znr.svg"
    khm = [item["symbol"] for item in everything if item["set_code"] == "KHM"]
    assert khm and set(khm) == {None}


def test_the_pack_art_manifest_is_read_with_care(tmp_path):
    assert products.pack_art(str(tmp_path)) == products.ArtIndex()
    (tmp_path / "pack-art.json").write_text("{not json", encoding="utf-8")
    assert products.pack_art(str(tmp_path)).pictures == {}
    entries = [
        {"set": "ZNR", "booster": "draft", **ZNR_ART},
        {"set": "ZNR", "booster": "set", **ZNR_ART, "origin": "elsewhere"},
        {"set": "ZNR", "booster": "play", **ZNR_ART, "large": picture("../../x", 1, 1)},
        {"set": "ZNR", "booster": "six", **ZNR_ART, "small": picture("znr-six", 0, 160)},
        "not an entry",
    ]
    symbols = {"ZNR": "/sets/znr.svg", "CON": "/sets/con_.svg", "KHM": "/sets/../khm.svg"}
    path = tmp_path / "pack-art.json"
    path.write_text(json.dumps({"products": entries, "symbols": symbols}), encoding="utf-8")
    os.utime(path, (1, 2))
    art = products.pack_art(str(tmp_path))
    assert list(art.pictures) == [("ZNR", "draft")]
    found = art.picture("ZNR", "draft")
    assert found is not None and found.small.src == "/packs/znr-draft-160.webp"
    assert (found.large.width, found.large.height, found.origin) == (276, 480, "tcgplayer")
    assert art.picture("ZNR", "set") is None
    assert art.symbols == {"ZNR": "/sets/znr.svg", "CON": "/sets/con_.svg"}
    assert art.symbol("KHM") is None


def test_the_pack_art_covers_every_product_with_its_files():
    """content/pack-art.json (scripts/pack_art.py) names a picture, or the reason for none, for
    every product on the price list, and every file it names is in web/public."""
    public = CONTENT.parent / "web" / "public"
    manifest = json.loads((CONTENT / "pack-art.json").read_text(encoding="utf-8"))
    listing = json.loads((CONTENT / "pack-prices.json").read_text(encoding="utf-8"))
    wanted = Counter((item["set"], item["booster"]) for item in listing["products"])
    pictured = Counter((item["set"], item["booster"]) for item in manifest["products"])
    drawn = Counter((item["set"], item["booster"]) for item in manifest["generated"])
    assert pictured + drawn == wanted
    assert all(item["reason"] for item in manifest["generated"])
    total = 0
    for item in manifest["products"]:
        assert item["origin"] in ("tcgplayer", "wizards")
        assert item["page"].startswith("https://") and item["image"].startswith("https://")
        assert item["product_name"]
        assert item["small"]["height"] == 160 and 160 <= item["large"]["height"] <= 480
        for size in ("small", "large"):
            assert products.ART_FILE.match(item[size]["src"])
            file = public / item[size]["src"].lstrip("/")
            assert file.is_file(), file
            total += file.stat().st_size
    # About 20 MB at most for both sizes of every picture.
    assert total < 20_000_000
    named = {
        public / item[size]["src"].lstrip("/")
        for item in manifest["products"]
        for size in ("small", "large")
    }
    assert set((public / "packs").glob("*.webp")) == named
    for code, path in manifest["symbols"].items():
        assert code in {item["set"] for item in listing["products"]}
        assert products.SYMBOL_FILE.match(path)
        svg = (public / path.lstrip("/")).read_text(encoding="utf-8")
        assert svg.startswith("<svg") and "<script" not in svg and "href" not in svg


def test_sysop_gives_packs(client):
    ada = Account(client, "ada")
    root = Account(client, "sysop", kind="sysop")
    admin = Account(client, "admin", admin=True)
    product = str(fixture_product(client).id)
    path = f"/api/v1/admin/users/{ada.id}/packs"
    gift = {"product": product, "count": 3, "reason": "Testing the shop"}
    assert ada.send("POST", path, gift).status_code == 403
    assert admin.send("POST", path, gift).status_code == 403
    assert root.send("POST", path, gift | {"count": 101}).status_code == 422
    assert root.send("POST", path, gift | {"reason": "no"}).status_code == 422
    unread = str(fixture_product(client, "set").id)
    refused = root.send("POST", path, gift | {"product": unread})
    assert (refused.status_code, refused.json()["code"]) == (409, "pack_unavailable")
    given = root.send("POST", path, gift)
    assert given.status_code == 201
    assert given.json()["granted"] == 3 and given.json()["inventory"][0]["count"] == 3
    assert root.send("POST", f"/api/v1/admin/users/{root.id}/packs", gift).status_code == 201
    assert root.get(path).json()[0]["count"] == 3
    inventory = ada.get("/api/v1/shop").json()["inventory"]
    opened = ada.send("POST", f"/api/v1/shop/packs/{inventory[0]['next_pack']}/open")
    assert len(opened.json()["cards"]) == 15
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        events = [
            (event.target_user_id, event.details)
            for event in db.scalars(
                select(AuditEvent).where(AuditEvent.action == "shop.packs_granted")
            )
        ]
        assert len(events) == 2
        assert events[0][0] == ada.id
        assert {key: events[0][1][key] for key in ("count", "reason", "set", "booster")} == {
            "count": 3,
            "reason": "Testing the shop",
            "set": "ZNR",
            "booster": "draft",
        }
        packs = db.scalars(select(Pack).where(Pack.user_id == ada.id)).all()
        assert {(pack.source, pack.tokens, pack.actor_id) for pack in packs} == {
            ("grant", 0, root.id)
        }


def test_staff_set_prices_and_take_products_off_sale(client):
    ada = funded(client, "ada", 5_000)
    admin = Account(client, "admin", admin=True)
    assert ada.get("/api/v1/admin/shop").status_code == 403
    view = admin.get("/api/v1/admin/shop").json()
    assert view["enabled"] is True and view["prices_as_of"] == "2026-10-21"
    assert len(view["products"]) == 392
    row = next(
        item for item in view["products"] if (item["set_code"], item["booster"]) == ("ZNR", "draft")
    )
    assert (row["usd"], row["curve_price"], row["selling"], row["data_status"]) == (
        4.97,
        380,
        True,
        "ready",
    )
    assert (row["collation_revision"], row["mtgjson_version"]) == (1, "5.3.0+fixture")
    waiting = next(item for item in view["products"] if item["booster"] == "set")
    assert (waiting["selling"], waiting["data_status"]) == (False, "waiting")
    path = f"/api/v1/admin/shop/products/{row['id']}"
    assert admin.send("PUT", f"{path}/price", {"tokens": 1234, "reason": "no"}).status_code == 422
    assert (
        admin.send("PUT", f"{path}/price", {"tokens": 0, "reason": "Too cheap"}).status_code == 422
    )
    changed = admin.send("PUT", f"{path}/price", {"tokens": 1234, "reason": "A test price"})
    assert (changed.json()["price"], changed.json()["price_basis"]) == (1234, "set")
    assert ada.get("/api/v1/shop").json()["products"][0]["price"] == 1234
    assert buy(ada, row["id"]).json()["tokens"] == 1234
    back = admin.send("PUT", f"{path}/price", {"tokens": None, "reason": "Back to the curve"})
    assert (back.json()["price"], back.json()["price_basis"]) == (380, "market")
    off = admin.send("PUT", f"{path}/sale", {"on_sale": False, "reason": "Testing a sale stop"})
    assert (off.json()["on_sale"], off.json()["selling"]) == (False, False)
    assert ada.get("/api/v1/shop").json()["products"] == []
    refused = buy(ada, row["id"])
    assert (refused.status_code, refused.json()["code"]) == (409, "not_on_sale")
    # A pack already held still opens.
    held = ada.get("/api/v1/shop").json()["inventory"][0]["next_pack"]
    assert ada.send("POST", f"/api/v1/shop/packs/{held}/open").status_code == 200
    assert admin.send("PUT", f"{path}/sale", {"on_sale": True, "reason": "Back on sale"}).json()[
        "selling"
    ]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        changes = [
            (event.action, event.details["from"], event.details["to"], event.details["reason"])
            for event in db.scalars(
                select(AuditEvent)
                .where(AuditEvent.action.like("shop.%"))
                .order_by(AuditEvent.occurred_at)
            )
        ]
    assert changes == [
        ("shop.price_changed", 380, 1234, "A test price"),
        ("shop.price_changed", 1234, 380, "Back to the curve"),
        ("shop.sale_changed", True, False, "Testing a sale stop"),
        ("shop.sale_changed", False, True, "Back on sale"),
    ]
    queued = admin.send("POST", "/api/v1/admin/shop/sync")
    assert queued.status_code == 202
    busy = admin.send("POST", "/api/v1/admin/shop/sync")
    assert (busy.status_code, busy.json()["code"]) == (409, "sync_busy")
    assert admin.get("/api/v1/admin/shop/runs").json() == []


# PostgreSQL: a pack opens once however many ask at once; a key buys once.


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_concurrent_opens_and_purchases_on_postgresql(monkeypatch, tmp_path, content):
    base = os.environ["CD_TEST_POSTGRES_URL"]
    schema = f"test_{uuid4().hex}"
    admin = create_engine(base, connect_args={"connect_timeout": 3})
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    scoped = (
        make_url(base)
        .update_query_dict({"options": f"-csearch_path={schema}"})
        .render_as_string(hide_password=False)
    )
    monkeypatch.setenv("CD_DATABASE_URL", scoped)
    engine = create_engine(scoped, connect_args={"connect_timeout": 3})
    try:
        command.upgrade(Config("alembic.ini"), "head")
        import_bulk(engine, tmp_path / "files", bulk(), engine_list())
        assert boosters.load_local(engine, SET_FILES, str(content))["ready"] == 1
        app = create_app(
            Settings(database_url=scoped, content_dir=str(content), sysop_networks="10.20.0.0/24")
        )
        with TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS) as http:
            ada = funded(http, "ada", 1_000)
            product = fixture_product(http).id
            with ThreadPoolExecutor(max_workers=4) as workers:
                bought = list(workers.map(lambda _: buy(ada, product, "same-key").json(), range(4)))
            assert len({item["pack"] for item in bought}) == 1
            # The four requests drew the week's sale at once (v0.4.3): one draw stood, and the
            # fixture's one product is in it, at 304 tokens rather than 380.
            assert {item["balance"] for item in bought} == {696}
            with Session(engine) as db:
                assert db.scalar(select(func.count()).select_from(WeeklySale)) == 1
            # Different keys at once never spend below zero: 696 buys two more packs.
            with ThreadPoolExecutor(max_workers=4) as workers:
                codes = sorted(workers.map(lambda _: buy(ada, product).status_code, range(4)))
            assert codes == [201, 201, 409, 409]
            pack = bought[0]["pack"]
            with ThreadPoolExecutor(max_workers=4) as workers:
                opened = list(
                    workers.map(
                        lambda _: ada.send("POST", f"/api/v1/shop/packs/{pack}/open").json(),
                        range(4),
                    )
                )
            assert len({item["id"] for item in opened}) == 1
            with Session(engine) as db:
                assert db.scalar(select(func.count()).select_from(PackOpening)) == 1
                grants = db.scalars(
                    select(LibraryGrant.grant_key).where(LibraryGrant.user_id == ada.id).distinct()
                ).all()
                assert grants == [f"pack:{opened[0]['id']}"]
            # What a pack held stays recorded.
            for statement in (
                "UPDATE packs SET tokens = 0",
                "DELETE FROM pack_cards",
                "UPDATE pack_openings SET layout = 1",
                "DELETE FROM booster_collations",
            ):
                with pytest.raises(DBAPIError, match="append-only"), engine.begin() as connection:
                    connection.execute(text(statement))
        command.downgrade(Config("alembic.ini"), "base")
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
