"""Leng's basic land packs (v0.6.4, api/lands.py): the Basic Land Pack (40 of each basic, 200
tokens) and one pack per basic (40, 50 tokens); editions weighted by release, the newest likeliest;
1 to 5 foils per color; on the weekly sale like any product."""

import random
from collections import Counter
from datetime import date
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from test_progression import url  # noqa: F401
from test_shop import buy as buy_pack
from test_shop import client, collated, content, engine, funded  # noqa: F401

from api import lands
from api.collation import draw
from api.identity import utcnow
from api.lands import LandPrinting, land_collation, land_layout
from api.models import CardPrinting, LibraryGrant, ShopProduct, WeeklySale
from api.sales import week_of
from catalog import boosters

BASICS = {"Plains", "Island", "Swamp", "Mountain", "Forest"}


def printing(code: str, released: date, color: str, foil: bool = False) -> LandPrinting:
    return LandPrinting(
        uuid4(), code, released, ("nonfoil", "foil") if foil else ("nonfoil",), color
    )


def editions() -> list[LandPrinting]:
    return [
        printing("lea", date(1993, 8, 5), "R"),
        printing("tmp", date(1997, 10, 14), "R"),
        # Two Mountains in the newest set: they share its chance.
        printing("blb", date(2024, 8, 2), "R", foil=True),
        printing("blb", date(2024, 8, 2), "R", foil=True),
        printing("blb", date(2024, 8, 2), "U", foil=True),
    ]


def test_editions_are_weighted_by_release_the_newest_likeliest():
    printings = editions()
    collation = land_collation(printings, "R")
    assert collation is not None
    mountains = collation.sheets["mountain"]
    weights = {card.printing_id: card.weight for card in mountains.cards}
    by_set = Counter()
    for found in printings:
        if found.color == "R":
            by_set[found.set_code] += weights[found.printing_id]
    # Alpha ranks 1, Tempest 2, Bloomburrow 3, its share split between its two Mountains.
    assert by_set == {
        "lea": lands.SHARES,
        "tmp": 2 * lands.SHARES,
        "blb": 3 * lands.SHARES,
    }
    # Only Bloomburrow printed foils: the foil sheet is its alone.
    foils = collation.sheets["mountain-foil"]
    assert {card.finish for card in foils.cards} == {"foil"} and len(foils.cards) == 2
    assert mountains.allow_duplicates and foils.allow_duplicates
    assert [layout.contents for layout in collation.layouts] == [(("mountain", 40),)]
    # A color with no printing: the pack cannot be made.
    assert land_collation(printings, "W") is None


def test_a_pack_holds_40_of_each_color_with_1_to_5_foils():
    printings = [
        printing(code, date(2000 + index, 1, 1), color, foil=True)
        for index, code in enumerate(("aaa", "bbb", "ccc"))
        for color in "WUBRG"
    ]
    collation = land_collation(printings, "WUBRG")
    assert collation is not None and collation.pack_size() == 200
    colors = {found.printing_id: found.color for found in printings}
    seen = set()
    for seed in range(200):
        rng = random.Random(seed)
        _, pulled = draw(land_layout(collation, rng), rng)
        assert len(pulled) == 200
        for color in "WUBRG":
            mine = [card for card in pulled if colors[card.printing_id] == color]
            foils = sum(card.finish == "foil" for card in mine)
            assert len(mine) == 40 and 1 <= foils <= 5
            seen.add(foils)
    assert seen == {1, 2, 3, 4, 5}


def test_old_editions_are_rare_and_new_ones_common():
    printings = editions()
    collation = land_collation(printings, "R")
    assert collation is not None
    sets = {found.printing_id: found.set_code for found in printings}
    counts: Counter[str] = Counter()
    rng = random.Random(7)
    for _ in range(100):
        _, pulled = draw(land_layout(collation, rng), rng)
        counts.update(sets[card.printing_id] for card in pulled if card.finish == "nonfoil")
    total = sum(counts.values())
    # Weights 1 : 2 : 3, so a sixth, a third and a half of the nonfoils.
    assert abs(counts["lea"] / total - 1 / 6) < 0.03
    assert abs(counts["tmp"] / total - 2 / 6) < 0.03
    assert abs(counts["blb"] / total - 3 / 6) < 0.03


def on_shelf(app: TestClient) -> dict[str, ShopProduct]:
    with Session(app.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(
            text("UPDATE shop_products SET on_sale = :yes WHERE origin = 'lands'"), {"yes": True}
        )
        db.commit()
        return {
            product.booster: product
            for product in db.scalars(select(ShopProduct).where(ShopProduct.origin == "lands"))
        }


def test_the_shop_sells_the_land_packs(client):  # noqa: F811
    packs = on_shelf(client)
    assert set(packs) == {pack.booster for pack in lands.PACKS}
    ada = funded(client, "ada", 1_000)
    shop = ada.get("/api/v1/shop").json()
    listed = {item["booster"]: item for item in shop["products"] if item["set_code"] == "LANDS"}
    assert {booster: item["price"] for booster, item in listed.items()} == {
        "basic-lands": 200,
        "basic-lands-w": 50,
        "basic-lands-u": 50,
        "basic-lands-b": 50,
        "basic-lands-r": 50,
        "basic-lands-g": 50,
    }
    everything = listed["basic-lands"]
    assert (everything["name"], everything["kind"], everything["era"]) == (
        "Basic Land Pack",
        "lands",
        "lands",
    )
    assert (everything["pack_size"], everything["price_basis"]) == (200, "fixed")
    assert listed["basic-lands-r"]["name"] == "Mountain Pack"
    assert listed["basic-lands-r"]["pack_size"] == 40
    assert shop["eras"][0] == {"id": "lands", "name": "Basic land packs", "since": "1993-08-05"}
    # The booster data job leaves them alone: they are built from the catalog.
    keys = boosters.product_keys(client.app.state.database)  # type: ignore[attr-defined]
    assert not any(key.set_code == "LANDS" for key in keys)


def names_of(app: TestClient) -> dict[str, str]:
    with Session(app.app.state.database) as db:  # type: ignore[attr-defined]
        rows = db.execute(select(CardPrinting.id, CardPrinting.set_code)).all()
    return {str(printing_id): code for printing_id, code in rows}


def test_opening_the_basic_land_pack(client):  # noqa: F811
    packs = on_shelf(client)
    ada = funded(client, "ada", 1_000)
    bought = buy_pack(ada, packs["basic-lands"].id).json()
    assert (bought["tokens"], bought["balance"]) == (200, 800)
    opened = ada.send("POST", f"/api/v1/shop/packs/{bought['pack']}/open")
    assert opened.status_code == 200, opened.text
    cards = opened.json()["cards"]
    assert len(cards) == 200 and {card["name"] for card in cards} == BASICS
    by_name = Counter(card["name"] for card in cards)
    assert set(by_name.values()) == {40}
    # The test catalog's Islands (Eldraine) and Forests (Bloomburrow) come in foil, 1 to 5 of
    # each; its Plains, Swamps and Mountains do not.
    foils = Counter(card["name"] for card in cards if card["finish"] == "foil")
    assert set(foils) <= {"Island", "Forest"}
    assert all(1 <= foils[name] <= 5 for name in ("Island", "Forest"))
    # Only the editions: not the box set's Plains, the World Championship Forest or the French
    # Island.
    sets = names_of(client)
    assert {sets[card["printing_id"]] for card in cards} <= {
        "2ed",
        "tmp",
        "ptk",
        "cma",
        "eld",
        "jmp",
        "blb",
    }
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        grants = db.scalars(select(LibraryGrant).where(LibraryGrant.user_id == ada.id)).all()
        assert sum(grant.quantity for grant in grants) == 200
        assert {grant.source for grant in grants} == {"pack"}


def test_a_pack_of_one_basic(client):  # noqa: F811
    packs = on_shelf(client)
    ada = funded(client, "ada", 100)
    bought = buy_pack(ada, packs["basic-lands-g"].id).json()
    assert (bought["tokens"], bought["balance"]) == (50, 50)
    cards = ada.send("POST", f"/api/v1/shop/packs/{bought['pack']}/open").json()["cards"]
    assert len(cards) == 40 and {card["name"] for card in cards} == {"Forest"}
    assert 1 <= sum(card["finish"] == "foil" for card in cards) <= 5
    # Foils are revealed last.
    finishes = [card["finish"] for card in cards]
    assert finishes == sorted(finishes, key=lambda finish: finish == "foil")


def test_land_packs_join_the_weekly_sale(client):  # noqa: F811
    packs = on_shelf(client)
    everything = packs["basic-lands"]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(text("DELETE FROM shop_weekly_sales"))
        db.add(
            WeeklySale(
                week_start=week_of(utcnow())[0],
                product_ids=[str(everything.id)],
                percent=20,
                created_at=utcnow(),
            )
        )
        db.commit()
    ada = funded(client, "ada", 1_000)
    shop = ada.get("/api/v1/shop").json()
    assert shop["sale"]["products"] == [str(everything.id)]
    [listed] = [item for item in shop["products"] if item["id"] == str(everything.id)]
    assert (listed["price"], listed["sale_price"]) == (200, 160)
    assert buy_pack(ada, everything.id).json()["tokens"] == 160
    # And the week's draw takes them as it takes any product on the shelf.
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(text("DELETE FROM shop_weekly_sales"))
        db.commit()
    drawn = {UUID(value) for value in ada.get("/api/v1/shop").json()["sale"]["products"]}
    shelf = {product.id for product in packs.values()}
    assert drawn and drawn <= shelf | {
        UUID(item["id"]) for item in ada.get("/api/v1/shop").json()["products"]
    }
