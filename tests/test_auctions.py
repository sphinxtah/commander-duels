"""Tivit's Auction House (v0.6.0): listing takes the copy out of the library and an unsold one
brings it back, bids are held and returned, the next bid's increment, anti-snipe, Buy Now, the
seller paid exactly what the buyer paid, withdrawing before the first bid only, what may not be
sold, the market's filters and pages, the transfer list and targets, SysOp's cancellation and the
log, a reset or deletion ending an account's auctions, settlement by the worker and on reads, the
retried requests landing once, and migration 0028 (finishes and basic lands for past grants) on
SQLite and PostgreSQL, with bids racing each other and Buy Now on PostgreSQL. Lightning Bolt's
printings in the test catalog stand in for any card."""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
import sqlalchemy as sa
import test_progression
from alembic import command
from alembic.config import Config
from catalog_fixtures import bulk, engine_list, import_bulk
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, make_url, select, text, update
from sqlalchemy.orm import Session
from test_games import SERVICE_TOKEN, SYSOP_ADDRESS
from test_library_editions import (  # noqa: F401 (fixtures)
    SET_FILES,
    bolts,
    burn,
    collated,
    concept,
    content,
    grant,
    lands,
    printings,
    write_content,
)
from test_progression import Account
from test_shop import fixture_product, no_sale

from api import auctions as auctions_api
from api import library, print_runs
from api import shop as shop_api
from api.collation import Pulled
from api.config import Settings
from api.identity import utcnow
from api.main import create_app
from api.models import (
    Auction,
    AuctionBid,
    AuditEvent,
    CardPrinting,
    LibraryGrant,
    Notification,
    TokenEntry,
    User,
)
from catalog import boosters, worker

url = test_progression.url
engine = test_progression.engine
TABLES = (
    "auction_watches",
    "auction_bids",
    "auctions",
    "notifications",
    "shop_weekly_sales",
    "pack_cards",
    "pack_openings",
    "packs",
    "token_ledger",
    "audit_events",
    "library_grants",
    "site_settings",
    "deck_entries",
    "deck_revisions",
    "decks",
    "role_grants",
    "sessions",
    "progress_ledger",
    "users",
)


@pytest.fixture
def client(collated: str, content: Path, engine):  # noqa: F811
    app = create_app(
        Settings(
            database_url=collated,
            content_dir=str(content),
            sysop_networks="10.20.0.0/24",
            engine_service_token=SERVICE_TOKEN,
        )
    )
    app.state.engine_transport = httpx.MockTransport(engine)
    with TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS) as client:
        with Session(app.state.database) as db:
            no_sale(db)
        yield client
        with Session(app.state.database) as db:
            for table in TABLES:
                db.execute(text(f"DELETE FROM {table}"))
            db.commit()


def database(client: TestClient) -> Session:
    return Session(client.app.state.database)  # type: ignore[attr-defined]


def finished(client: TestClient, user: UUID, printing: CardPrinting, finish: str, n: int) -> None:
    """Copies of an edition in a finish, granted as a pack grants them."""
    with database(client) as db:
        db.add(
            LibraryGrant(
                user_id=user,
                concept_id=printing.concept_id,
                printing_id=printing.id,
                finish=finish,
                quantity=n,
                source="pack",
                grant_key=f"pack:{uuid4()}",
                created_at=utcnow(),
            )
        )
        db.commit()


def fund(client: TestClient, root: Account, handle: str, tokens: int) -> Account:
    """A player with tokens, from the one SysOp (PostgreSQL allows one)."""
    account = Account(client, handle)
    given = root.send(
        "POST", f"/api/v1/admin/users/{account.id}/tokens", {"amount": tokens, "reason": "Tests"}
    )
    assert given.status_code == 200, given.text
    return account


def sysop(client: TestClient) -> Account:
    """The one SysOp (the database allows one), made the first time it is asked for."""
    found = getattr(client, "test_sysop", None)
    if found is None:
        found = Account(client, "root", kind="sysop")
        client.test_sysop = found  # type: ignore[attr-defined]
    return found  # type: ignore[no-any-return]


def funded(client: TestClient, handle: str, tokens: int) -> Account:
    return fund(client, sysop(client), handle, tokens)


def foiled(client: TestClient) -> tuple[CardPrinting, CardPrinting]:
    """Two of Lightning Bolt's printings that were printed in foil."""
    found = [
        printing for printing in printings(client, "Lightning Bolt") if "foil" in printing.finishes
    ]
    assert len(found) >= 2
    return found[0], found[1]


def key() -> str:
    return uuid4().hex


def listing(
    printing: CardPrinting,
    finish: str = "nonfoil",
    starting: int = 100,
    buy_now: int | None = 500,
    duration: str = "1h",
    quantity: int = 1,
    request: str | None = None,
) -> dict[str, Any]:
    return {
        "printing_id": str(printing.id),
        "finish": finish,
        "starting_bid": starting,
        "buy_now": buy_now,
        "duration": duration,
        "quantity": quantity,
        "key": request or key(),
    }


def sell(who: Account, printing: CardPrinting, **options: Any) -> dict[str, Any]:
    answer = who.send("POST", "/api/v1/auctions", listing(printing, **options))
    assert answer.status_code == 201, answer.text
    (item,) = answer.json()["items"]
    return item  # type: ignore[no-any-return]


def bid(who: Account, auction: str, amount: int, request: str | None = None) -> httpx.Response:
    return who.send(
        "POST", f"/api/v1/auctions/{auction}/bids", {"amount": amount, "key": request or key()}
    )


def balance(who: Account) -> int:
    return int(who.get("/api/v1/me/tokens").json()["balance"])


def ends_in(client: TestClient, auction: str, seconds: float) -> None:
    with database(client) as db:
        db.execute(
            update(Auction)
            .where(Auction.id == UUID(auction))
            .values(ends_at=utcnow() + timedelta(seconds=seconds))
        )
        db.commit()


def held(who: Account, printing: CardPrinting) -> dict[str, Any] | None:
    items = who.get("/api/v1/library").json()["cards"]
    return next(
        (item for item in items if item["edition"]["printing_id"] == str(printing.id)), None
    )


def kinds(client: TestClient, user: UUID) -> list[str]:
    with database(client) as db:
        return list(
            db.scalars(
                select(Notification.kind)
                .where(Notification.user_id == user)
                .order_by(Notification.created_at)
            )
        )


def test_listing_takes_the_copy_out_and_withdrawing_brings_it_back(client):
    first, _ = foiled(client)
    ada = Account(client, "ada")
    finished(client, ada.id, first, "nonfoil", 2)
    finished(client, ada.id, first, "foil", 1)
    lands(client, ada.id)
    item = held(ada, first)
    assert item is not None
    assert item["copies"] == 3 and item["sellable"] == 3
    assert item["finishes"] == {"nonfoil": 2, "foil": 1, "etched": 0}
    deck = ada.send(
        "POST",
        "/api/v1/decks",
        {"title": "Burn", "format": "legacy", "entries": burn(client, (3, first))},
    ).json()
    assert deck["playable"] is True

    request = key()
    auction = sell(ada, first, finish="foil", request=request)
    assert (auction["status"], auction["finish"], auction["mine"]) == ("active", "foil", True)
    assert auction["card"]["image"] == f"/api/v1/card-images/printings/{first.id}?size=normal"
    assert auction["next_bid"] == 100 and auction["seller"] == "ada"
    # A retry lists nothing more.
    again = ada.send("POST", "/api/v1/auctions", listing(first, finish="foil", request=request))
    assert [found["id"] for found in again.json()["items"]] == [auction["id"]]
    item = held(ada, first)
    assert item is not None
    assert item["copies"] == 2 and item["finishes"]["foil"] == 0 and item["sellable"] == 2
    # The deck that relied on the copy is collection-locked now.
    listed = {found["id"]: found for found in ada.get("/api/v1/decks").json()}
    assert listed[deck["id"]]["collection_locked"] is True
    # No more foils to sell; the nonfoils sell two at once.
    short = ada.send("POST", "/api/v1/auctions", listing(first, finish="foil"))
    assert (short.status_code, short.json()["code"]) == (409, "not_enough_copies")
    two = ada.send("POST", "/api/v1/auctions", listing(first, quantity=2))
    assert two.status_code == 201 and len(two.json()["items"]) == 2
    assert held(ada, first) is None

    # Withdrawn before any bid: the copy comes back, and the deck plays again.
    withdrawn = ada.send("DELETE", f"/api/v1/auctions/{auction['id']}")
    assert withdrawn.status_code == 200 and withdrawn.json()["status"] == "withdrawn"
    for other in two.json()["items"]:
        ada.send("DELETE", f"/api/v1/auctions/{other['id']}")
    item = held(ada, first)
    assert item is not None and item["finishes"] == {"nonfoil": 2, "foil": 1, "etched": 0}
    listed = {found["id"]: found for found in ada.get("/api/v1/decks").json()}
    assert listed[deck["id"]]["collection_locked"] is False
    with database(client) as db:
        actions = [event.action for event in db.scalars(select(AuditEvent))]
    assert actions.count("auction.listed") == 3 and actions.count("auction.withdrawn") == 3


def test_what_may_not_be_sold(client, monkeypatch):
    first, second, _ = bolts(client)
    ada = Account(client, "ada")
    finished(client, ada.id, first, "nonfoil", 1)
    # Prices.
    for starting, buy_now in ((0, None), (100, 100), (100, 50), (10**12, None)):
        refused = ada.send(
            "POST", "/api/v1/auctions", listing(first, starting=starting, buy_now=buy_now)
        )
        assert (refused.status_code, refused.json()["code"]) == (422, "invalid_price")
    # An alliance's cards stay with it.
    ada.send("PUT", "/api/v1/me/alliance", {"planeswalker": "tibalt"})
    valki = concept(client, "Valki, God of Lies // Tibalt, Cosmic Impostor")
    with database(client) as db:
        valki_printing = db.get_one(CardPrinting, valki.default_printing_id)
    refused = ada.send("POST", "/api/v1/auctions", listing(valki_printing))
    assert (refused.status_code, refused.json()["code"]) == (422, "not_sellable")
    assert "alliance" in refused.json()["message"]
    # A one-of-a-kind printing never.
    monkeypatch.setattr(auctions_api, "ONE_OF_A_KIND", {first.scryfall_id: "ada"})
    refused = ada.send("POST", "/api/v1/auctions", listing(first))
    assert (refused.status_code, refused.json()["code"]) == (422, "not_sellable")
    monkeypatch.undo()
    # An unknown printing is not found; a copy never granted is not there to sell.
    unknown = ada.send("POST", "/api/v1/auctions", {**listing(first), "printing_id": str(uuid4())})
    assert unknown.status_code == 404
    none = ada.send("POST", "/api/v1/auctions", listing(second))
    assert (none.status_code, none.json()["code"]) == (409, "not_enough_copies")
    # Basic lands are copies like any since v0.6.0, and are sold like any.
    lands(client, ada.id, quantity=2)
    mountain = printings(client, "Mountain")[0]
    assert sell(ada, mountain, buy_now=None)["card"]["name"] == "Mountain"
    # SysOp lists anything without holding it, in the finishes it was printed in; an
    # administrator only what was granted to it.
    root = sysop(client)
    assert sell(root, second, buy_now=None)["seller"] == "root"
    printed = list(second.finishes or []) or ["nonfoil"]
    missing = next(finish for finish in ("nonfoil", "foil", "etched") if finish not in printed)
    wrong = root.send("POST", "/api/v1/auctions", listing(second, finish=missing))
    assert (wrong.status_code, wrong.json()["code"]) == (422, "not_sellable")
    admin = Account(client, "admin", admin=True)
    refused = admin.send("POST", "/api/v1/auctions", listing(second))
    assert (refused.status_code, refused.json()["code"]) == (409, "not_enough_copies")
    # What the sell dialog offers.
    offered = ada.get("/api/v1/auctions/sellable").json()["items"]
    assert {(item["card"]["name"], item["finish"], item["sellable"]) for item in offered} == {
        ("Lightning Bolt", "nonfoil", 1),
        ("Mountain", "nonfoil", 1),
    }
    anything = root.get("/api/v1/auctions/sellable", q="lightning bolt", limit=2).json()
    assert anything["next_cursor"] == "2"
    assert {item["sellable"] for item in anything["items"]} == {auctions_api.MAX_QUANTITY}


def test_bids_are_held_and_returned_and_the_next_bid_grows(client):
    first, _ = foiled(client)
    ada = Account(client, "ada")
    finished(client, ada.id, first, "foil", 1)
    bob, cara = funded(client, "bob", 1_000), funded(client, "cara", 1_000)
    dan = funded(client, "dan", 50)
    auction = sell(ada, first, finish="foil")["id"]
    low = bid(bob, auction, 99)
    assert (low.status_code, low.json()["code"]) == (409, "bid_too_low")
    assert "100" in low.json()["message"]
    request = key()
    first_bid = bid(bob, auction, 100, request)
    assert first_bid.status_code == 200, first_bid.text
    assert first_bid.json()["leading"] is True and first_bid.json()["watching"] is True
    # A retry holds nothing more.
    assert bid(bob, auction, 100, request).status_code == 200
    assert balance(bob) == 900
    with database(client) as db:
        (entry,) = db.scalars(
            select(TokenEntry).where(TokenEntry.user_id == bob.id, TokenEntry.kind == "bid")
        ).all()
    assert entry.amount == -100
    assert (
        entry.reason == f"Bid on Lightning Bolt ({first.set_name} #{first.collector_number}, foil)"
    )
    leading = bid(bob, auction, 200)
    assert (leading.status_code, leading.json()["code"]) == (409, "already_leading")
    own = bid(ada, auction, 200)
    assert (own.status_code, own.json()["code"]) == (409, "own_auction")
    poor = bid(dan, auction, 105)
    assert (poor.status_code, poor.json()["code"]) == (409, "not_enough_tokens")
    # The next bid is the current one and 5%, at least 1 token.
    assert bid(cara, auction, 104).json()["code"] == "bid_too_low"
    outbid = bid(cara, auction, 105).json()
    assert (outbid["current_bid"], outbid["high_bidder"], outbid["next_bid"]) == (105, "cara", 111)
    assert balance(bob) == 1_000 and balance(cara) == 895
    seen = bob.get(f"/api/v1/auctions/{auction}").json()
    assert (seen["outbid"], seen["leading"], seen["my_bid"], seen["bids"]) == (True, False, 100, 2)
    assert kinds(client, bob.id) == ["auction_outbid"]
    bell = bob.get("/api/v1/notifications").json()["items"][0]
    assert bell["auction"]["id"] == auction and bell["auction"]["price"] == 105
    assert bell["actor"]["handle"] == "cara"
    tokens = bob.get("/api/v1/me/tokens").json()
    assert tokens["auctions"] == 0
    assert {line["kind"] for line in tokens["entries"]} >= {"bid", "bid_return"}


def test_buy_now_ends_it_and_pays_the_seller_exactly(client):
    first, second = foiled(client)
    ada = Account(client, "ada")
    finished(client, ada.id, first, "foil", 1)
    finished(client, ada.id, second, "nonfoil", 1)
    bob, cara = funded(client, "bob", 1_000), funded(client, "cara", 1_000)
    before = balance(ada)
    auction = sell(ada, first, finish="foil")["id"]
    bid(cara, auction, 100)
    no_key = bob.send("POST", f"/api/v1/auctions/{auction}/buy-now", {"key": "short"})
    assert no_key.status_code == 422
    bought = bob.send("POST", f"/api/v1/auctions/{auction}/buy-now", {"key": key()}).json()
    assert (bought["status"], bought["buyer"], bought["sold_price"]) == ("sold", "bob", 500)
    assert balance(bob) == 500 and balance(cara) == 1_000 and balance(ada) == before + 500
    with database(client) as db:
        sale = db.scalars(select(TokenEntry).where(TokenEntry.kind == "sale")).one()
        assert (sale.user_id, sale.amount, sale.key) == (ada.id, 500, f"sale:{auction}")
        assert sale.reason and sale.reason.endswith("to bob")
        grant_row = db.scalars(select(LibraryGrant).where(LibraryGrant.user_id == bob.id)).one()
        assert (grant_row.source, grant_row.finish, grant_row.grant_key) == (
            "auction",
            "foil",
            f"auction:{auction}",
        )
    item = held(bob, first)
    assert item is not None and item["sources"] == ["auction"] and item["finishes"]["foil"] == 1
    # The buyer may sell it on.
    assert item["sellable"] == 1
    assert held(ada, first) is None
    ended = bid(cara, auction, 600)
    assert (ended.status_code, ended.json()["code"]) == (409, "auction_ended")
    assert kinds(client, cara.id) == ["auction_outbid"]
    assert kinds(client, bob.id) == ["auction_won"] and kinds(client, ada.id) == ["auction_sold"]
    # A bid at or above Buy Now buys at Buy Now; none without a Buy Now price.
    other = sell(ada, second, buy_now=300)["id"]
    over = bid(cara, other, 10_000).json()
    assert (over["status"], over["sold_price"]) == ("sold", 300)
    assert balance(cara) == 700
    plain = sell(sysop(client), second, finish="foil", buy_now=None)["id"]
    refused = bob.send("POST", f"/api/v1/auctions/{plain}/buy-now", {"key": key()})
    assert (refused.status_code, refused.json()["code"]) == (409, "no_buy_now")


def test_withdrawing_only_before_the_first_bid_and_only_by_the_seller(client):
    first, _, _ = bolts(client)
    ada = Account(client, "ada")
    finished(client, ada.id, first, "nonfoil", 1)
    bob = funded(client, "bob", 1_000)
    auction = sell(ada, first)["id"]
    others = bob.send("DELETE", f"/api/v1/auctions/{auction}")
    assert (others.status_code, others.json()["code"]) == (403, "not_your_auction")
    bid(bob, auction, 100)
    refused = ada.send("DELETE", f"/api/v1/auctions/{auction}")
    assert (refused.status_code, refused.json()["code"]) == (409, "has_bids")


def test_a_late_bid_pushes_the_end_and_the_end_settles_on_a_read(client):
    first, _, _ = bolts(client)
    ada = Account(client, "ada")
    finished(client, ada.id, first, "nonfoil", 1)
    bob = funded(client, "bob", 1_000)
    auction = sell(ada, first, buy_now=None)["id"]
    ends_in(client, auction, 10)
    pushed = bid(bob, auction, 150).json()
    left = (auctions_api.AuctionItem.model_validate(pushed).ends_at - utcnow()).total_seconds()
    assert 25 < left <= 30
    # Past its end, any read settles it: sold to the leading bid.
    ends_in(client, auction, -1)
    seen = ada.get(f"/api/v1/auctions/{auction}").json()
    assert (seen["status"], seen["buyer"], seen["sold_price"]) == ("sold", "bob", 150)
    with database(client) as db:
        assert auctions_api.settle_due(db, {}) == 0
        assert (
            db.scalar(select(func.count()).select_from(TokenEntry).where(TokenEntry.kind == "sale"))
            == 1
        )
    assert balance(bob) == 850
    assert held(bob, first) is not None and held(ada, first) is None


def test_the_worker_settles_and_an_unsold_copy_comes_back(client, content):  # noqa: F811
    first, second, _ = bolts(client)
    ada = Account(client, "ada")
    finished(client, ada.id, first, "nonfoil", 1)
    finished(client, ada.id, second, "nonfoil", 1)
    bob = funded(client, "bob", 1_000)
    unsold = sell(ada, first)["id"]
    sold = sell(ada, second)["id"]
    bid(bob, sold, 120)
    for auction in (unsold, sold):
        ends_in(client, auction, -5)
    config = Settings(database_url=str(client.app.state.database.url), content_dir=str(content))  # type: ignore[attr-defined]
    assert worker.settle_auctions(client.app.state.database, config, force=True) == 2  # type: ignore[attr-defined]
    assert worker.settle_auctions(client.app.state.database, config, force=True) == 0  # type: ignore[attr-defined]
    assert ada.get(f"/api/v1/auctions/{unsold}").json()["status"] == "expired"
    assert held(ada, first) is not None
    assert "auction_unsold" in kinds(client, ada.id) and "auction_sold" in kinds(client, ada.id)
    # The transfer list: sold and unsold; an unsold one relists once, if the copy is still held.
    mine = ada.get("/api/v1/auctions/mine").json()
    assert [item["id"] for item in mine["sold"]] == [sold]
    assert [item["id"] for item in mine["unsold"]] == [unsold]
    request = key()
    body = {"starting_bid": 50, "buy_now": None, "duration": "3d", "key": request}
    relisted = ada.send("POST", f"/api/v1/auctions/{unsold}/relist", body)
    assert relisted.status_code == 201, relisted.text
    assert relisted.json()["duration"] == "3d" and relisted.json()["starting_bid"] == 50
    assert (
        ada.send("POST", f"/api/v1/auctions/{unsold}/relist", body).json()["id"]
        == (relisted.json()["id"])
    )
    twice = ada.send("POST", f"/api/v1/auctions/{unsold}/relist", {**body, "key": key()})
    assert (twice.status_code, twice.json()["code"]) == (409, "not_relistable")
    mine = ada.get("/api/v1/auctions/mine").json()
    assert mine["unsold"] == [] and [item["id"] for item in mine["active"]] == [
        relisted.json()["id"]
    ]
    assert ada.send("POST", "/api/v1/auctions/mine/clear", {"which": "sold"}).status_code == 204
    assert ada.get("/api/v1/auctions/mine").json()["sold"] == []
    # A sold copy cannot be relisted.
    refused = ada.send("POST", f"/api/v1/auctions/{sold}/relist", {**body, "key": key()})
    assert (refused.status_code, refused.json()["code"]) == (409, "not_relistable")


def test_the_transfer_targets(client):
    first, second, third = bolts(client)
    ada = Account(client, "ada")
    for printing in (first, second, third):
        finished(client, ada.id, printing, "nonfoil", 1)
    bob, cara = funded(client, "bob", 1_000), funded(client, "cara", 1_000)
    won, lost, watched = (sell(ada, printing)["id"] for printing in (first, second, third))
    bid(bob, won, 100)
    bid(bob, lost, 100)
    bid(cara, lost, 105)
    assert bob.send("PUT", f"/api/v1/auctions/{watched}/watch").status_code == 204
    targets = bob.get("/api/v1/auctions/targets").json()
    assert {item["id"] for item in targets["active"]} == {won, lost, watched}
    marks = {item["id"]: (item["leading"], item["outbid"]) for item in targets["active"]}
    assert marks == {won: (True, False), lost: (False, True), watched: (False, False)}
    assert bob.send("DELETE", f"/api/v1/auctions/{watched}/watch").status_code == 204
    for auction in (won, lost):
        ends_in(client, auction, -1)
    targets = bob.get("/api/v1/auctions/targets").json()
    assert [item["id"] for item in targets["won"]] == [won]
    assert [item["id"] for item in targets["lost"]] == [lost]
    assert targets["active"] == []
    assert bob.send("POST", "/api/v1/auctions/targets/clear", {"which": "lost"}).status_code == 204
    targets = bob.get("/api/v1/auctions/targets").json()
    assert targets["lost"] == [] and len(targets["won"]) == 1


def test_the_market_filters_sorts_pages_and_compares(client):
    first, second = foiled(client)
    ada = Account(client, "ada")
    finished(client, ada.id, first, "nonfoil", 3)
    finished(client, ada.id, second, "foil", 1)
    lands(client, ada.id, quantity=1)
    bob = funded(client, "bob", 1_000)
    cheap = sell(ada, first, starting=10, buy_now=None)["id"]
    dear = sell(ada, first, starting=300, buy_now=900)["id"]
    foil = sell(ada, second, finish="foil", starting=50, buy_now=60)["id"]
    land = sell(ada, printings(client, "Mountain")[0], starting=5, buy_now=None)["id"]

    def ids(**params: Any) -> list[str]:
        return [item["id"] for item in bob.get("/api/v1/auctions", **params).json()["items"]]

    assert ids(sort="price_low") == [land, cheap, foil, dear]
    assert ids(sort="price_high") == [dear, foil, cheap, land]
    assert ids(sort="buy_now_low")[:2] == [foil, dear]
    assert ids(finish="foil") == [foil]
    assert set(ids(q="bolt")) == {cheap, dear, foil}
    assert ids(color="C") == [land]
    assert set(ids(color="R")) == {cheap, dear, foil}
    assert ids(type="land") == [land]
    assert set(ids(buy_now_only="true")) == {dear, foil}
    assert ids(min_bid=50, max_bid=100) == [foil]
    assert ids(max_buy_now=100) == [foil]
    assert set(ids(set=first.set_code.upper())) >= {cheap, dear}
    assert set(ids(rarity=first.rarity)) >= {cheap, dear}
    assert ids(max_time_left=60) == []
    # The seller's own are not in the market, unless asked.
    assert ada.get("/api/v1/auctions").json()["total"] == 0
    assert ada.get("/api/v1/auctions", include_mine="true").json()["total"] == 4
    # Pages.
    page = bob.get("/api/v1/auctions", sort="price_low", limit=3).json()
    assert page["total"] == 4 and page["next_cursor"] == "3"
    rest = bob.get("/api/v1/auctions", sort="price_low", limit=3, cursor="3").json()
    assert [item["id"] for item in rest["items"]] == [dear] and rest["next_cursor"] is None
    assert bob.get("/api/v1/auctions", cursor="nope").json()["code"] == "invalid_cursor"
    # Compare: the same edition and finish, the lowest first, and its last sales.
    bid(bob, cheap, 10)
    ends_in(client, cheap, -1)
    compared = bob.get(
        "/api/v1/auctions/compare", printing_id=str(first.id), finish="nonfoil"
    ).json()
    assert [item["id"] for item in compared["items"]] == [dear]
    assert [sale["price"] for sale in compared["recent_sales"]] == [10]


def test_sysop_cancels_with_a_reason_and_the_log(client):
    first, _, _ = bolts(client)
    ada = Account(client, "ada")
    finished(client, ada.id, first, "nonfoil", 1)
    bob = funded(client, "bob", 1_000)
    auction = sell(ada, first)["id"]
    bid(bob, auction, 200)
    admin = Account(client, "admin", admin=True)
    log = admin.get("/api/v1/admin/auctions").json()
    assert [item["id"] for item in log["items"]] == [auction] and log["total"] == 1
    refused = admin.send(
        "POST", f"/api/v1/admin/auctions/{auction}/cancel", {"reason": "Testing it"}
    )
    assert refused.status_code == 403
    assert ada.get("/api/v1/admin/auctions").status_code == 403
    root = sysop(client)
    cancelled = root.send(
        "POST", f"/api/v1/admin/auctions/{auction}/cancel", {"reason": "A test of cancelling"}
    )
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
    assert balance(bob) == 1_000 and held(ada, first) is not None
    assert kinds(client, bob.id) == ["auction_cancelled"]
    assert kinds(client, ada.id) == ["auction_cancelled"]
    with database(client) as db:
        event = db.scalars(select(AuditEvent).where(AuditEvent.action == "auction.cancelled")).one()
    assert event.actor_id == root.id and event.details["reason"] == "A test of cancelling"
    again = root.send("POST", f"/api/v1/admin/auctions/{auction}/cancel", {"reason": "Again!"})
    assert (again.status_code, again.json()["code"]) == (409, "auction_ended")
    assert admin.get("/api/v1/admin/auctions", status="sold").json()["total"] == 0
    assert admin.get("/api/v1/admin/auctions", status="cancelled").json()["total"] == 1


def test_a_reset_or_a_deletion_ends_the_accounts_auctions(client):
    first, second, _ = bolts(client)
    ada, cara = Account(client, "ada"), Account(client, "cara")
    finished(client, ada.id, first, "nonfoil", 1)
    finished(client, cara.id, second, "nonfoil", 1)
    bob, dan = funded(client, "bob", 1_000), funded(client, "dan", 1_000)
    adas = sell(ada, first)["id"]
    caras = sell(cara, second)["id"]
    bid(bob, adas, 100)
    bid(dan, caras, 100)
    bid(bob, caras, 105)
    root = sysop(client)
    # Ada's reset cancels her auction: Bob's bid comes back.
    assert root.send("POST", f"/api/v1/admin/users/{ada.id}/reset").status_code == 200
    assert root.get(f"/api/v1/auctions/{adas}").json()["status"] == "cancelled"
    assert balance(bob) == 1_000 - 105
    # Bob's deletion returns his leading bid; Cara's auction runs on without a bid.
    deleted = root.send("POST", f"/api/v1/admin/users/{bob.id}/delete", {"reason": "Testing it"})
    assert deleted.status_code == 200, deleted.text
    with database(client) as db:
        bobs = int(
            db.scalar(
                select(func.coalesce(func.sum(TokenEntry.amount), 0)).where(
                    TokenEntry.user_id == bob.id
                )
            )
            or 0
        )
    assert bobs == 1_000
    seen = cara.get(f"/api/v1/auctions/{caras}").json()
    assert (seen["status"], seen["current_bid"], seen["high_bidder"]) == ("active", None, None)
    assert seen["next_bid"] == 100
    assert bid(dan, caras, 100).status_code == 200


def test_the_library_after_a_pack_keeps_finishes_apart(client, monkeypatch):
    first, second = foiled(client)
    ada = funded(client, "ada", 1_000)
    pulled = [
        Pulled(first.id, "nonfoil", "common"),
        Pulled(first.id, "foil", "foil"),
        Pulled(second.id, "etched", "foil"),
    ]
    monkeypatch.setattr(shop_api, "draw", lambda *_: (0, pulled))
    pack = ada.send(
        "POST",
        "/api/v1/shop/purchases",
        {"product": str(fixture_product(client).id), "key": uuid4().hex},
    ).json()["pack"]
    assert ada.send("POST", f"/api/v1/shop/packs/{pack}/open").status_code == 200
    item = held(ada, first)
    assert item is not None and item["finishes"] == {"nonfoil": 1, "foil": 1, "etched": 0}
    other = held(ada, second)
    assert other is not None and other["finishes"]["etched"] == 1
    # A copy bought at the auction house is not a copy printed again (print runs).
    bob = funded(client, "bob", 1_000)
    foil = sell(ada, first, finish="foil")["id"]
    assert bob.send("POST", f"/api/v1/auctions/{foil}/buy-now", {"key": key()}).status_code == 200
    with database(client) as db:
        assert print_runs.dealt(db, {first.id}) == {first.id: 2}


# Migration 0028.


def columns(finish: bool) -> list[Any]:
    """library_grants' columns as read without the model, which knows the finish (0028)."""
    table = sa.table(
        "library_grants",
        sa.column("user_id", sa.Uuid()),
        sa.column("grant_key", sa.String()),
        sa.column("printing_id", sa.Uuid()),
        sa.column("finish", sa.String()),
        sa.column("quantity", sa.Integer()),
        sa.column("source", sa.String()),
    )
    names = ["user_id", "grant_key", "printing_id", "finish", "quantity", "source"]
    return [table.c[name] for name in names if finish or name != "finish"]


def round_trip(database_url: str, folder: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A pack's grants split by the finishes its opening pulled, the basic lands of packs and
    starter decks granted, an auction sold and one running; then back to 0027 and up again."""
    (folder / "content").mkdir()
    content_dir = write_content(folder / "content")
    monkeypatch.setenv("CD_DATABASE_URL", database_url)
    monkeypatch.setenv("CD_CONTENT_DIR", str(content_dir))
    config = Config("alembic.ini")
    command.upgrade(config, "head")
    engine_ = create_engine(database_url)
    try:
        import_bulk(engine_, folder / "files", bulk(), engine_list())
        assert boosters.load_local(engine_, SET_FILES, str(content_dir))["ready"] == 1
        app = create_app(
            Settings(
                database_url=database_url,
                content_dir=str(content_dir),
                sysop_networks="10.20.0.0/24",
            )
        )
        with TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS) as http:
            first, second = foiled(http)
            mountain = printings(http, "Mountain")[0]
            root = sysop(http)
            ada = fund(http, root, "ada", 1_000)
            with Session(engine_) as db:
                db.get_one(User, ada.id).onboarding = "starters"
                db.commit()
            chosen = ada.send(
                "POST", "/api/v1/me/starters", {"decks": ["starter_red_test", "starter_blue_test"]}
            )
            assert chosen.status_code == 201, chosen.text
            pulled = [
                Pulled(first.id, "nonfoil", "common"),
                Pulled(first.id, "foil", "foil"),
                Pulled(mountain.id, "foil", "land"),
            ]
            with pytest.MonkeyPatch.context() as patch:
                patch.setattr(shop_api, "draw", lambda *_: (0, pulled))
                pack = ada.send(
                    "POST",
                    "/api/v1/shop/purchases",
                    {"product": str(fixture_product(http).id), "key": uuid4().hex},
                ).json()["pack"]
                opened = ada.send("POST", f"/api/v1/shop/packs/{pack}/open").json()
            bob = fund(http, root, "bob", 1_000)
            sold = sell(ada, first, finish="foil")["id"]
            assert (
                bob.send("POST", f"/api/v1/auctions/{sold}/buy-now", {"key": key()}).json()[
                    "status"
                ]
                == "sold"
            )
            finished(http, ada.id, second, "nonfoil", 1)
            running = sell(ada, second)["id"]
            assert bid(bob, running, 100).status_code == 200

        def grants() -> list[tuple[UUID, str, UUID, str, int, str]]:
            with engine_.connect() as connection:
                return sorted(
                    (tuple(row) for row in connection.execute(select(*columns(True)))),  # type: ignore[misc]
                    key=str,
                )

        made = grants()
        pack_key = f"pack:{opened['id']}"
        assert sorted(
            (finish, quantity)
            for _, key_, printing, finish, quantity, _ in made
            if key_ == pack_key and printing == first.id
        ) == [("foil", 1), ("nonfoil", 1)]
        assert any(key_ == pack_key and printing == mountain.id for _, key_, printing, *_ in made)

        command.downgrade(config, "0027_one_of_a_kind")
        with engine_.connect() as connection:
            rows = connection.execute(select(*columns(False))).all()
            # Basic lands were unlimited: their grants went. The sold copy left the seller and
            # stayed the buyer's; the running auction's bid went back.
            assert all(printing != mountain.id for _, _, printing, _, _ in rows)
            assert (bob.id, f"auction:{sold}", first.id, 1, "grandfathered") in [
                tuple(row) for row in rows
            ]
            assert [
                quantity
                for user, key_, printing, quantity, _ in rows
                if user == ada.id and key_ == pack_key and printing == first.id
            ] == [1]
            # Bob's bid on the running auction came back; his Buy Now stays paid.
            assert (
                connection.scalar(
                    select(func.sum(TokenEntry.amount)).where(TokenEntry.user_id == bob.id)
                )
                == 500
            )
        command.upgrade(config, "head")
        again = grants()
        # The pack's finishes come back as its opening pulled them: the copy left after the sold
        # foil went is taken for the foil the opening recorded (the downgrade kept no finish).
        assert sorted(
            (finish, quantity)
            for _, key_, printing, finish, quantity, _ in again
            if key_ == pack_key and printing == first.id
        ) == [("foil", 1)]
        # The basic lands of the pack and of the starter decks come back.
        assert any(key_ == pack_key and printing == mountain.id for _, key_, printing, *_ in again)
        starters = [row for row in again if row[0] == ada.id and row[5] == "starter"]
        assert sum(row[4] for row in starters) == sum(
            row[4] for row in made if row[0] == ada.id and row[5] == "starter"
        )
        command.downgrade(config, "0027_one_of_a_kind")
        command.upgrade(config, "head")
    finally:
        engine_.dispose()


def test_the_migration_gives_grants_finishes_and_basic_lands_and_goes_back(tmp_path, monkeypatch):
    round_trip(f"sqlite:///{tmp_path}/auctions.db", tmp_path, monkeypatch)


def scoped_postgres() -> tuple[str, Any, str]:
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
    return scoped, admin, schema


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_the_migration_on_postgresql(tmp_path, monkeypatch):
    scoped, admin, schema = scoped_postgres()
    try:
        round_trip(scoped, tmp_path, monkeypatch)
    finally:
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_bids_racing_each_other_buy_now_and_the_end_on_postgresql(tmp_path, monkeypatch):
    scoped, admin, schema = scoped_postgres()
    monkeypatch.setenv("CD_DATABASE_URL", scoped)
    content_dir = write_content(tmp_path)
    engine_ = create_engine(scoped, connect_args={"connect_timeout": 3})
    try:
        command.upgrade(Config("alembic.ini"), "head")
        import_bulk(engine_, tmp_path / "files", bulk(), engine_list())
        app = create_app(
            Settings(
                database_url=scoped, content_dir=str(content_dir), sysop_networks="10.20.0.0/24"
            )
        )
        with TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS) as http:
            first, second, third = bolts(http)
            ada = Account(http, "ada")
            for printing in (first, second, third):
                finished(http, ada.id, printing, "nonfoil", 1)
            root = sysop(http)
            bidders = [fund(http, root, f"bidder{index}", 1_000) for index in range(4)]
            # Four bids of the same amount at once: one leads, the rest are too low; each balance
            # holds at most what leads.
            auction = sell(ada, first, buy_now=None)["id"]
            with ThreadPoolExecutor(max_workers=4) as workers:
                codes = sorted(workers.map(lambda who: bid(who, auction, 100).status_code, bidders))
            assert codes == [200, 409, 409, 409]
            assert sum(balance(who) for who in bidders) == 4_000 - 100
            # A retry of one bid four times at once holds once.
            request = key()
            trailing = next(
                who
                for who in bidders
                if not who.get(f"/api/v1/auctions/{auction}").json()["leading"]
            )
            with ThreadPoolExecutor(max_workers=4) as workers:
                codes = list(
                    workers.map(
                        lambda _: bid(trailing, auction, 200, request).status_code, range(4)
                    )
                )
            assert codes == [200, 200, 200, 200]
            with Session(engine_) as db:
                made = db.scalar(
                    select(func.count())
                    .select_from(AuctionBid)
                    .where(AuctionBid.request_key == request)
                )
            assert made == 1 and balance(trailing) == 800
            # Bids racing Buy Now: one sale, every other bid back.
            racing = sell(ada, second, buy_now=400)["id"]

            def go(index: int) -> int:
                who = bidders[index]
                if index % 2:
                    return who.send(
                        "POST", f"/api/v1/auctions/{racing}/buy-now", {"key": key()}
                    ).status_code
                return bid(who, racing, 150 + index).status_code

            with ThreadPoolExecutor(max_workers=4) as workers:
                list(workers.map(go, range(4)))
            seen = ada.get(f"/api/v1/auctions/{racing}").json()
            with Session(engine_) as db:
                sales = db.scalars(
                    select(TokenEntry.amount).where(TokenEntry.key == f"sale:{racing}")
                ).all()
                held_bids = db.scalar(
                    text(
                        "SELECT count(*) FROM auction_bids WHERE auction_id = :id AND status = "
                        "'held'"
                    ),
                    {"id": UUID(racing)},
                )
            if seen["status"] == "sold":
                assert sales == [seen["sold_price"]] and held_bids == 0
            else:
                assert sales == [] and held_bids == 1
            # A bid racing the end, and settlement racing reads: settled once.
            ending = sell(ada, third, buy_now=None)["id"]
            bid(bidders[2], ending, 100)
            with Session(engine_) as db:
                db.execute(
                    update(Auction)
                    .where(Auction.id == UUID(ending))
                    .values(ends_at=utcnow() - timedelta(seconds=1))
                )
                db.commit()
            with ThreadPoolExecutor(max_workers=4) as workers:
                answers = list(
                    workers.map(
                        lambda index: bid(bidders[3], ending, 200).status_code
                        if index == 0
                        else ada.get(f"/api/v1/auctions/{ending}").status_code,
                        range(4),
                    )
                )
            assert answers[0] == 409 and set(answers[1:]) == {200}
            with Session(engine_) as db:
                assert db.scalars(
                    select(TokenEntry.amount).where(TokenEntry.key == f"sale:{ending}")
                ).all() == [100]
            total = sum(balance(who) for who in bidders) + balance(ada)
            with Session(engine_) as db:
                everything = int(db.scalar(select(func.sum(TokenEntry.amount))) or 0)
            # Tokens moved, none made: what the bidders hold now and the seller earned add up to
            # what was given (SysOp's grants to the bidders), less the bids still held.
            assert total <= everything
        command.downgrade(Config("alembic.ini"), "0027_one_of_a_kind")
        command.upgrade(Config("alembic.ini"), "head")
    finally:
        engine_.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def test_the_one_of_a_kind_rule_is_shared(monkeypatch):
    assert auctions_api.ONE_OF_A_KIND is library.ONE_OF_A_KIND
