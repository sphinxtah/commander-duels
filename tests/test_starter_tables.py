"""A starter deck bought at the table (v1.0.0, api/starter_tables.py; docs/tables.md): the gate,
the offers at Leng's price, the purchase, the deck that plays as it came against the bots and at
a table of people, and what such a table refuses."""

from typing import Any
from uuid import UUID, uuid4

import pytest
import test_shop
import test_tables
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from test_progression import Account
from test_shop import fixture_product

from api import shop as shop_api
from api import starter_tables
from api.decks import publish
from api.identity import utcnow
from api.library import Library
from api.models import (
    Deck,
    DeckRevision,
    LibraryGrant,
    Pack,
    PackOpening,
    StarterPurchase,
    TokenEntry,
)

# The shop's world: the test catalog with the fixture collation, four starter decks (three of
# them priced) and the fixture's one product, which stands in for a Starter Deck here.
url = test_shop.url
# The tables' engine: it starts and plays a table's game as the practice game's does.
engine = test_tables.engine
content = test_shop.content
collated = test_shop.collated
client = test_shop.client

OFFERS = "/api/v1/starter-decks"
PURCHASES = "/api/v1/starter-decks/purchases"


# The one SysOp an installation has, by the client it was made for.
ROOTS: dict[int, Account] = {}


def root_of(client: Any) -> Account:
    if id(client) not in ROOTS:
        ROOTS.clear()
        ROOTS[id(client)] = Account(client, "root-starter", kind="sysop")
    return ROOTS[id(client)]


def staged(client: Any, stage: str) -> Account:
    root = root_of(client)
    changed = root.send("PUT", "/api/v1/admin/rollout/starter_tables", {"stage": stage})
    assert changed.status_code == 200, changed.text
    return root


def funded(client: Any, handle: str, tokens: int) -> Account:
    """A player with tokens, given by the installation's SysOp."""
    account = Account(client, handle)
    given = root_of(client).send(
        "POST",
        f"/api/v1/admin/users/{account.id}/tokens",
        {"amount": tokens, "reason": "Testing the starter-deck tables"},
    )
    assert given.status_code == 200, given.text
    return account


def cleared(client: Any) -> None:
    with Session(client.app.state.database) as db:
        for name in (
            "starter_purchases",
            "table_seats",
            "game_seats",
            "games",
            "game_tables",
            "site_settings",
        ):
            db.execute(text(f"DELETE FROM {name}"))
        db.commit()


@pytest.fixture
def on(client, monkeypatch):
    """The workflow open to everyone, and the fixture's product a Starter Deck."""
    staged(client, "on")
    monkeypatch.setattr(shop_api, "kind_of", lambda booster: "starter")
    monkeypatch.setattr(starter_tables, "kind_of", lambda booster: "starter")
    yield client
    cleared(client)


def purchase(account: Account, fmt: str, offer: str, key: str | None = None) -> Any:
    return account.send(
        "POST", PURCHASES, {"format": fmt, "offer": offer, "key": key or uuid4().hex}
    )


def bought(account: Account, fmt: str, offer: str) -> dict[str, Any]:
    answer = purchase(account, fmt, offer)
    assert answer.status_code == 201, answer.text
    return answer.json()


def balance(account: Account) -> int:
    return account.get("/api/v1/shop").json()["balance"]


def test_the_workflow_is_off_until_sysop_stages_it(client):
    """Off, it looks like nothing; at staff, SysOp and administrators alone; on, everyone."""
    ada = funded(client, "ada-gate", 5_000)
    eve = Account(client, "eve-gate", admin=True)
    body = {"format": "commander", "offer": "starter_red_test", "key": uuid4().hex}
    for account in (ada, eve):
        assert account.get(OFFERS).status_code == 404
        assert account.send("POST", PURCHASES, body).status_code == 404
    # Nor is a table or a game made as one.
    game = {"format": "commander", "deck_id": str(uuid4()), "starter": True}
    assert ada.send("POST", "/api/v1/practice-games", game).status_code == 404
    table = {"format": "commander", "seats": 2, "deck_id": str(uuid4()), "starter": True}
    assert ada.send("POST", "/api/v1/tables", table).status_code == 404
    listed = {found["id"]: found for found in ada.get("/api/v1/rollout").json()["workflows"]}
    assert listed["starter_tables"]["available"] is False

    root = staged(client, "staff")
    assert ada.get(OFFERS).status_code == 404
    assert eve.get(OFFERS).status_code == 200
    assert root.get(OFFERS).status_code == 200
    staged(client, "on")
    assert ada.get(OFFERS).status_code == 200
    cleared(client)


def test_the_offers_are_lengs_decks_of_the_format_at_lengs_price(on):
    ada = funded(on, "ada-offers", 600)
    commander = ada.get(OFFERS, format="commander").json()
    # The three Leng prices; the one he does not price is not sold. The two an account chose for
    # nothing at its start are its own already, and are bought again here.
    assert [
        (offer["id"], offer["price"], offer["affordable"], offer["on_sale"])
        for offer in commander["offers"]
    ] == [
        ("starter_red_test", 500, True, False),
        ("starter_blue_test", 250, True, False),
        ("starter_karlach_test", 1_500, False, False),
    ]
    assert (commander["format"], commander["balance"], commander["short"]) == (
        "commander",
        600,
        0,
    )
    assert all(offer["commander_printing_id"] for offer in commander["offers"])
    assert "Kenrith, the Returned King" in commander["offers"][0]["detail"]

    # A Legacy table offers the products that are decks, each as the shop shows and prices it.
    product = fixture_product(on)
    legacy = ada.get(OFFERS, format="legacy").json()
    shelf = {found["id"]: found["price"] for found in ada.get("/api/v1/shop").json()["products"]}
    assert [(offer["id"], offer["price"], offer["list_price"]) for offer in legacy["offers"]] == [
        (str(product.id), shelf[str(product.id)], shelf[str(product.id)])
    ]
    assert legacy["offers"][0]["product"]["id"] == str(product.id)
    assert legacy["offers"][0]["title"] == product.name

    # A player who can buy none is told what they lack for the cheapest.
    poor = funded(on, "bob-offers", 100)
    short = poor.get(OFFERS, format="commander").json()
    assert (short["balance"], short["short"]) == (100, 150)
    assert not any(offer["affordable"] for offer in short["offers"])


def test_the_weeks_sale_is_the_only_discount(on):
    """Leng's price, unless the product is in this week's sale: then the sale's price, which the
    purchase pays."""
    ada = funded(on, "ada-sale", 50_000)
    product = fixture_product(on)
    with Session(on.app.state.database) as db:
        db.execute(text("DELETE FROM shop_weekly_sales"))
        db.commit()
    # The fixture's one product is the whole shelf, so the week's sale holds it.
    offer = ada.get(OFFERS, format="legacy").json()["offers"][0]
    view = ada.get("/api/v1/shop").json()
    listed = next(found for found in view["products"] if found["id"] == str(product.id))
    assert listed["sale_price"] is not None
    assert (offer["price"], offer["list_price"], offer["on_sale"]) == (
        listed["sale_price"],
        listed["price"],
        True,
    )
    paid = bought(ada, "legacy", str(product.id))
    assert (paid["tokens"], paid["sale"]) == (listed["sale_price"], True)
    with Session(on.app.state.database) as db:
        spent = db.scalars(
            select(TokenEntry.amount).where(TokenEntry.user_id == ada.id, TokenEntry.amount < 0)
        ).all()
        assert spent == [-listed["sale_price"]]


def test_a_commander_starter_is_bought_again_and_becomes_a_deck(on):
    ada = funded(on, "ada-buy", 5_000)
    # The account owns the red starter already: Leng's shop sells it once.
    chosen = ada.send("POST", "/api/v1/shop/decks", {"deck": "starter_red_test"})
    assert chosen.status_code == 201, chosen.text
    again = ada.send("POST", "/api/v1/shop/decks", {"deck": "starter_red_test"})
    assert again.json()["repeated"] is True
    offers = ada.get(OFFERS, format="commander").json()["offers"]
    assert offers[0]["owned"] is True

    # Bought for a table, it is bought again: the price leaves, the cards join the library once
    # more, and a deck is made of them, named beside the one the account has.
    before = balance(ada)
    key = uuid4().hex
    first = purchase(ada, "commander", "starter_red_test", key)
    assert first.status_code == 201, first.text
    paid = first.json()
    assert (paid["tokens"], paid["balance"], paid["repeated"]) == (500, before - 500, False)
    assert (paid["title"], paid["opening_id"], paid["sale"]) == ("Red Test", None, False)
    # Revealed as a pack is: one card a copy, the commander last.
    assert len(paid["cards"]) == 100
    assert paid["cards"][-1]["commander"] is True
    assert paid["cards"][-1]["name"] == "Kenrith, the Returned King"
    deck = ada.get(f"/api/v1/decks/{paid['deck_id']}").json()
    assert (deck["title"], deck["format"], deck["playable"]) == ("Red Test 2", "commander", True)
    with Session(on.app.state.database) as db:
        keys = set(db.scalars(select(LibraryGrant.grant_key).where(LibraryGrant.user_id == ada.id)))
        assert f"starter-table:{paid['id']}" in keys
        row = db.get_one(StarterPurchase, UUID(paid["id"]))
        assert (row.format, row.offer, row.tokens, row.table_id) == (
            "commander",
            "starter_red_test",
            500,
            None,
        )
        # The deck as it came is a revision of its own.
        assert str(row.deck_id) == paid["deck_id"]

    # A retry with the same key buys once, and reveals nothing again.
    retry = purchase(ada, "commander", "starter_red_test", key).json()
    assert (retry["id"], retry["deck_id"], retry["repeated"]) == (
        paid["id"],
        paid["deck_id"],
        True,
    )
    assert retry["cards"] == []
    assert balance(ada) == before - 500
    # The key is one purchase's.
    other = purchase(ada, "commander", "starter_blue_test", key)
    assert (other.status_code, other.json()["code"]) == (409, "key_reused")

    # What is not on offer is not sold, and what costs more than the account holds is refused.
    assert purchase(ada, "commander", "starter_pir_test").json()["code"] == "not_on_sale"
    assert purchase(ada, "commander", "starter_nothing").status_code == 404
    assert purchase(ada, "legacy", "starter_red_test").status_code == 404
    poor = funded(on, "bob-buy", 100)
    refused = purchase(poor, "commander", "starter_blue_test")
    assert refused.status_code == 409
    assert balance(poor) == 100
    with Session(on.app.state.database) as db:
        assert (
            db.scalar(select(StarterPurchase.id).where(StarterPurchase.user_id == poor.id)) is None
        )


def test_a_new_account_chooses_its_free_starter_decks_first(on):
    new = Account(on, "newcomer-starter", onboarding="starters")
    refused = purchase(new, "commander", "starter_red_test")
    assert (refused.status_code, refused.json()["code"]) == (409, "starters_first")


def test_a_legacy_starter_is_bought_opened_and_kept_as_a_deck(on):
    ada = funded(on, "ada-legacy", 50_000)
    product = fixture_product(on)
    paid = bought(ada, "legacy", str(product.id))
    assert paid["title"] == product.name
    # What the account holds now: the price is gone (and a first pack's badge may have paid).
    assert paid["balance"] == balance(ada)
    # Its opening is one of the account's opened packs, to reveal as a pack is.
    opening = ada.get(f"/api/v1/shop/openings/{paid['opening_id']}").json()
    assert opening["deck"] == {
        "format": "legacy",
        "deck": paid["deck_id"],
        "deck_title": product.name,
    }
    deck = ada.get(f"/api/v1/decks/{paid['deck_id']}").json()
    assert (deck["format"], deck["source"]) == ("legacy", "pack")
    assert deck["card_count"] == len(opening["cards"])
    with Session(on.app.state.database) as db:
        pack = db.scalars(select(Pack).where(Pack.user_id == ada.id)).one()
        assert (pack.source, pack.tokens, pack.product_id) == (
            "purchase",
            paid["tokens"],
            product.id,
        )
        assert db.scalars(select(PackOpening).where(PackOpening.pack_id == pack.id)).one()
        # One entry in the ledger: the pack's own.
        spent = db.scalars(
            select(TokenEntry.key).where(TokenEntry.user_id == ada.id, TokenEntry.amount < 0)
        ).all()
        assert spent == [f"pack:{pack.id}"]
    # A product that is no deck, or none at all, is not on offer.
    assert purchase(ada, "legacy", str(uuid4())).status_code == 404
    assert purchase(ada, "legacy", "not-a-product").status_code == 404


def test_the_deck_plays_as_it_came_against_the_bots(on, engine):
    """From the Play wizard: the deck just bought, casual rules whatever was asked, and for each
    bot a starter of the same kind that costs nothing."""
    ada = funded(on, "ada-bots", 50_000)
    paid = bought(ada, "commander", "starter_karlach_test")
    started = ada.send(
        "POST",
        "/api/v1/practice-games",
        {
            "format": "commander",
            "deck_id": paid["deck_id"],
            "starter": True,
            "bots": [{}, {}],
            # Tournament rules are not a starter-deck game's: it plays by casual rules.
            "rules": {"banned": False, "not_legal": False, "stand_in": False},
        },
    )
    assert started.status_code == 201, started.text
    seats = engine.created[-1]["seats"]
    assert [seat["player"] for seat in seats] == ["human", "bot", "bot"]
    assert seats[0]["deck_list"]["commanders"] == ["Karlach, Fury of Avernus"]
    # Each bot plays one of Leng's starter decks.
    assert all(seat["deck_list"]["commanders"] for seat in seats[1:])
    assert balance(ada) == paid["balance"]

    # It may be played against the bots again, as a rematch plays it, at no cost.
    ada.send("POST", f"/api/v1/games/{started.json()['id']}/close")
    again = ada.send(
        "POST",
        "/api/v1/practice-games",
        {"format": "commander", "deck_id": paid["deck_id"], "starter": True},
    )
    assert again.status_code == 201, again.text
    ada.send("POST", f"/api/v1/games/{again.json()['id']}/close")
    assert balance(ada) == paid["balance"]

    # A deck that was not bought for one is not a starter deck; nor one of the other format.
    own = ada.send("POST", "/api/v1/shop/decks", {"deck": "starter_blue_test"}).json()["deck"]
    refused = ada.send(
        "POST",
        "/api/v1/practice-games",
        {"format": "commander", "deck_id": own, "starter": True},
    )
    assert (refused.status_code, refused.json()["code"]) == (422, "not_a_starter_deck")
    # The table deals the bots' decks, and such a game is one game of Legacy or Commander.
    for body, code in (
        ({"bots": [{"deck_id": own}]}, "invalid_seat"),
        ({"format": "two_headed_giant"}, "invalid_table"),
    ):
        asked = {"format": "commander", "deck_id": paid["deck_id"], "starter": True, **body}
        answer = ada.send("POST", "/api/v1/practice-games", asked)
        assert (answer.status_code, answer.json()["code"]) == (422, code), answer.text


def test_only_the_deck_as_it_came_plays(on, engine):
    ada = funded(on, "ada-changed", 50_000)
    paid = bought(ada, "commander", "starter_red_test")
    deck = ada.get(f"/api/v1/decks/{paid['deck_id']}").json()
    # The player takes a Mountain out and puts two in: the deck is theirs to change, but it is
    # no longer the deck they bought.
    entries = [dict(entry) for entry in deck["draft"]["entries"]]
    mountain = next(entry for entry in entries if entry["quantity"] > 1)
    mountain["quantity"] += 1
    saved = ada.send(
        "PUT",
        f"/api/v1/decks/{paid['deck_id']}/draft",
        {"entries": entries, "version": deck["draft"]["version"]},
    )
    assert saved.status_code == 200, saved.text
    game = {"format": "commander", "deck_id": paid["deck_id"], "starter": True}
    refused = ada.send("POST", "/api/v1/practice-games", game)
    assert refused.status_code != 201, refused.text
    # Put back as it came, it plays: the revision is the purchase's own again.
    current = ada.get(f"/api/v1/decks/{paid['deck_id']}").json()
    restored = ada.send(
        "PUT",
        f"/api/v1/decks/{paid['deck_id']}/draft",
        {"entries": deck["draft"]["entries"], "version": current["draft"]["version"]},
    )
    assert restored.status_code == 200, restored.text
    assert ada.send("POST", "/api/v1/practice-games", game).status_code == 201


def test_a_legacy_starter_plays_with_more_than_four_copies(on, engine):
    """A Legacy starter is random cards of its edition: such a game sets aside the limit of four
    copies, which any other game keeps, and deals each bot a starter rolled for it."""
    # An administrator builds from the whole catalog here (conftest), so the deck needs no grants.
    ada = Account(on, "ada-copies", admin=True)
    held = [
        {"card_id": test_tables.card(on, "Lightning Bolt"), "quantity": 6, "location": "main"},
        {"card_id": test_tables.card(on, "Mountain"), "quantity": 54, "location": "main"},
    ]
    made = ada.send(
        "POST", "/api/v1/decks", {"title": "Six Bolts", "format": "legacy", "entries": held}
    ).json()
    assert (made["legal"], made["playable"]) == (False, False)
    game = {"format": "legacy", "deck_id": made["id"]}
    # Six of a card is not a Legacy deck: no game takes it, a starter-deck game included while
    # the deck is not one that was bought for it.
    plain = ada.send("POST", "/api/v1/practice-games", game)
    assert (plain.status_code, plain.json()["code"]) == (422, "deck_not_playable")
    unbought = ada.send("POST", "/api/v1/practice-games", {**game, "starter": True})
    assert (unbought.status_code, unbought.json()["code"]) == (422, "not_a_starter_deck")

    # The same sixty cards as a starter bought for a table: the purchase's own revision.
    with Session(on.app.state.database) as db:
        revision = db.scalars(
            select(DeckRevision).where(DeckRevision.deck_id == UUID(made["id"]))
        ).first()
        if revision is None:
            revision = publish(db, db.get_one(Deck, UUID(made["id"])), Library(unlimited=True))
        db.add(
            StarterPurchase(
                user_id=ada.id,
                request_key=uuid4().hex,
                format="legacy",
                offer=str(fixture_product(on).id),
                title="Six Bolts",
                deck_id=UUID(made["id"]),
                revision_id=revision.id,
                tokens=380,
                created_at=utcnow(),
            )
        )
        db.commit()
    started = ada.send("POST", "/api/v1/practice-games", {**game, "starter": True})
    assert started.status_code == 201, started.text
    human, bot = engine.created[-1]["seats"]
    counts = {card["name"]: card["count"] for card in human["deck_list"]["cards"]}
    assert counts["Lightning Bolt"] == 6
    # The bot plays a starter rolled from the shelf: the fixture's product, fifteen cards of it.
    assert bot["player"] == "bot"
    assert sum(card["count"] for card in bot["deck_list"]["cards"]) == 15
    ada.send("POST", f"/api/v1/games/{started.json()['id']}/close")
    # Outside a starter-deck game the deck is what it was: not a Legacy deck.
    again = ada.send("POST", "/api/v1/practice-games", game)
    assert (again.status_code, again.json()["code"]) == (422, "deck_not_playable")


def test_a_rolled_bot_deck_grants_nothing(on):
    """A bot's Legacy starter is drawn as a pack of the product would be, and nothing of it is
    recorded: no pack, no opening, no grant."""
    with Session(on.app.state.database) as db:
        before = (
            db.scalar(select(Pack.id).limit(1)),
            db.scalar(select(PackOpening.id).limit(1)),
        )
        request = type("Request", (), {"app": on.app})()
        rolled = starter_tables.rolled_deck(db, request)  # type: ignore[arg-type]
        assert rolled is not None
        deck_list, title = rolled
        assert title == fixture_product(on).name
        assert sum(card["count"] for card in deck_list["cards"]) > 0  # type: ignore[union-attr]
        db.rollback()
        after = (
            db.scalar(select(Pack.id).limit(1)),
            db.scalar(select(PackOpening.id).limit(1)),
        )
    assert before == after == (None, None)


def table_body(deck_id: str, **more: Any) -> dict[str, Any]:
    return {"format": "commander", "seats": 2, "deck_id": deck_id, "starter": True, **more}


def test_a_table_of_people_each_with_a_deck_bought_for_it(on, engine):
    ada = funded(on, "ada-table", 50_000)
    bob = funded(on, "bob-table", 50_000)
    ada_deck = bought(ada, "commander", "starter_red_test")
    opened = ada.send(
        "POST",
        "/api/v1/tables",
        table_body(
            ada_deck["deck_id"],
            visibility="private",
            # Its rules are casual whatever is asked: the decks play as they came.
            rules={"banned": False, "not_legal": False, "stand_in": False},
        ),
    )
    assert opened.status_code == 201, opened.text
    table = opened.json()
    assert table["starter"] is True
    assert table["rules"] == {"banned": True, "not_legal": True, "stand_in": True}
    code = table["code"]

    # A deck of his own does not sit down there: he buys one for the table.
    own = bob.send("POST", "/api/v1/shop/decks", {"deck": "starter_blue_test"}).json()["deck"]
    refused = bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": own})
    assert (refused.status_code, refused.json()["code"]) == (422, "not_a_starter_deck")
    bob_deck = bought(bob, "commander", "starter_karlach_test")
    joined = bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": bob_deck["deck_id"]})
    assert joined.status_code == 200, joined.text
    # A seat is ready once it has bought.
    seats = {player["handle"]: player for player in joined.json()["players"]}
    assert seats["bob-table"]["ready"] is True
    assert ada.get(f"/api/v1/tables/{code}").json()["can_start"] is True
    # He plays the deck he bought for it, and no other.
    swap = bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"deck_id": own})
    assert (swap.status_code, swap.json()["code"]) == (409, "starter_table")

    started = ada.send("POST", f"/api/v1/tables/{code}/start")
    assert started.status_code == 200, started.text
    seats = engine.created[-1]["seats"]
    assert [seat["deck_list"]["commanders"] for seat in seats] == [
        ["Kenrith, the Returned King"],
        ["Karlach, Fury of Avernus"],
    ]
    with Session(on.app.state.database) as db:
        rows = db.scalars(select(StarterPurchase).where(StarterPurchase.table_id.is_not(None)))
        assert {str(row.deck_id) for row in rows} == {ada_deck["deck_id"], bob_deck["deck_id"]}

    # One table a purchase: once its game started, the deck sits at no other table.
    for account in (ada, bob):
        game = account.get(f"/api/v1/tables/{code}").json()["game_id"]
        account.send("POST", f"/api/v1/games/{game}/concede")
    again = ada.send("POST", "/api/v1/tables", table_body(ada_deck["deck_id"]))
    assert (again.status_code, again.json()["code"]) == (409, "starter_deck_played"), again.text


def test_a_purchase_moves_until_a_table_plays_it(on):
    """Before a table's game starts the purchase is not spent: the player may leave and sit down
    elsewhere with it."""
    ada = funded(on, "ada-moves", 50_000)
    paid = bought(ada, "commander", "starter_red_test")
    first = ada.send("POST", "/api/v1/tables", table_body(paid["deck_id"]))
    assert first.status_code == 201, first.text
    left = ada.send("POST", f"/api/v1/tables/{first.json()['code']}/leave")
    assert left.status_code == 200, left.text
    second = ada.send("POST", "/api/v1/tables", table_body(paid["deck_id"]))
    assert second.status_code == 201, second.text
    ada.send("POST", f"/api/v1/tables/{second.json()['code']}/leave")


def test_what_a_starter_table_may_be(on):
    ada = funded(on, "ada-shape", 50_000)
    paid = bought(ada, "commander", "starter_red_test")
    for more, code in (
        ({"format": "two_headed_giant", "seats": 4}, "invalid_table"),
        ({"format": "kings_table", "seats": 6}, "invalid_table"),
        ({"format": "legacy", "best_of": 3}, "invalid_table"),
    ):
        refused = ada.send("POST", "/api/v1/tables", table_body(paid["deck_id"], **more))
        assert (refused.status_code, refused.json()["code"]) == (422, code), refused.text
    # A Commander starter does not sit at a Legacy table.
    legacy = ada.send(
        "POST", "/api/v1/tables", table_body(paid["deck_id"], format="legacy", seats=2)
    )
    assert (legacy.status_code, legacy.json()["code"]) == (422, "not_a_starter_deck")
    # An ordinary table is what it was: any deck of the account's, and no purchase asked for.
    plain = ada.send(
        "POST",
        "/api/v1/tables",
        {"format": "commander", "seats": 2, "deck_id": paid["deck_id"]},
    )
    assert plain.status_code == 201, plain.text
    assert plain.json()["starter"] is False
    ada.send("POST", f"/api/v1/tables/{plain.json()['code']}/leave")


def test_a_deck_bought_for_a_table_leaves_the_trash_for_good(on, engine):
    """A deck made by a purchase is the account's own, to delete like any other: never played,
    it goes with its purchase; played, the game keeps the copy it played, purchase and all."""
    ada = funded(on, "ada-trash", 50_000)
    unplayed = bought(ada, "commander", "starter_red_test")
    played = bought(ada, "commander", "starter_blue_test")
    game = ada.send(
        "POST",
        "/api/v1/practice-games",
        {"format": "commander", "deck_id": played["deck_id"], "starter": True},
    )
    assert game.status_code == 201, game.text
    ada.send("POST", f"/api/v1/games/{game.json()['id']}/close")
    for deal in (unplayed, played):
        assert ada.send("DELETE", f"/api/v1/decks/{deal['deck_id']}").status_code in (200, 204)
        gone = ada.send("DELETE", f"/api/v1/decks/{deal['deck_id']}/forever")
        assert gone.status_code == 204, gone.text
    with Session(on.app.state.database) as db:
        left = set(db.scalars(select(StarterPurchase.id).where(StarterPurchase.user_id == ada.id)))
        assert left == {UUID(played["id"])}
        assert db.get(Deck, UUID(unplayed["deck_id"])) is None
        assert db.get_one(Deck, UUID(played["deck_id"])).purged_at is not None
    # What was spent stays spent.
    assert balance(ada) == played["balance"]


def test_a_deleted_account_takes_its_purchases_with_it(on):
    """Deleting an account removes the decks no game played: the purchases that made them go
    first, so nothing is left naming a deck that is gone."""
    ada = funded(on, "ada-leaves", 50_000)
    paid = bought(ada, "commander", "starter_red_test")
    gone = root_of(on).send(
        "POST",
        f"/api/v1/admin/users/{ada.id}/delete",
        {"reason": "Asked to leave, in a test of the starter-deck tables"},
    )
    assert gone.status_code == 200, gone.text
    with Session(on.app.state.database) as db:
        assert db.get(StarterPurchase, UUID(paid["id"])) is None
        assert db.get(Deck, UUID(paid["deck_id"])) is None
