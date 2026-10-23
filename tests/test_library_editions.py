"""The library by edition (v0.5.0): grants name the edition they give, the library lists each card
by edition, card details list the editions asked for, decks may hold only the editions the
library holds, copy by copy, saves give copies naming none an owned one, the deploy switches every
player's drafts once, and migration 0025 gives the grants made before it their editions and goes
back. Lightning Bolt's six printings in the test catalog stand in for Goblin King's 27."""

import json
import os
import shutil
from collections import Counter
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
import sqlalchemy as sa
import test_progression
from alembic import command
from alembic.config import Config
from catalog_fixtures import FIXTURES, bulk, engine_list, import_bulk
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, make_url, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from test_decks_api import starter
from test_games import SERVICE_TOKEN, SYSOP_ADDRESS
from test_progression import Account
from test_shop import fixture_product, funded, no_sale

from api import decks as decks_api
from api import shop as shop_api
from api.collation import Pulled
from api.config import Settings
from api.identity import utcnow
from api.main import create_app
from api.models import (
    CardConcept,
    CardPrinting,
    Deck,
    DeckRevision,
    LibraryGrant,
    PackOpening,
    SiteSetting,
    User,
)
from api.roster import load
from catalog import boosters, worker

CONTENT = Path(__file__).resolve().parent.parent / "content"
SET_FILES = FIXTURES / "mtgjson"
# The starter deck's own Lightning Bolt: the Pro Tour Collector Set's, the test catalog's oldest.
STARTER_BOLT = ("ptc", "et208")
# The revision before 0025.
PREVIOUS = "0024_two_headed_giant"

url = test_progression.url
engine = test_progression.engine


def write_content(folder: Path) -> Path:
    for name in ("planeswalkers.json", "pack-prices.json"):
        shutil.copy(CONTENT / name, folder / name)
    red = starter(
        "starter_red_test",
        1,
        "Red Test",
        [
            (1, "Kenrith, the Returned King"),
            (1, "Lightning Bolt"),
            (1, "Sol Ring"),
            (97, "Mountain"),
        ],
    )
    for card in red["cards"]:
        if card["name"] == "Lightning Bolt":
            card["set"], card["collector_number"] = STARTER_BOLT
    blue = starter(
        "starter_blue_test",
        2,
        "Blue Test",
        [(1, "Thrasios, Triton Hero"), (1, "Counterspell"), (98, "Island")],
    )
    (folder / "starter-decks.json").write_text(
        json.dumps({"version": 1, "source": "tests", "decks": [red, blue]}), encoding="utf-8"
    )
    return folder


@pytest.fixture(scope="module")
def content(tmp_path_factory) -> Path:
    return write_content(tmp_path_factory.mktemp("editions-content"))


@pytest.fixture(scope="module")
def collated(url: str, content: Path) -> str:
    database = create_engine(url)
    assert boosters.load_local(database, SET_FILES, str(content))["ready"] == 1
    database.dispose()
    return url


@pytest.fixture
def client(collated: str, content: Path, engine):
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
            for table in (
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
            ):
                db.execute(text(f"DELETE FROM {table}"))
            db.commit()


def database(client: TestClient) -> Session:
    return Session(client.app.state.database)  # type: ignore[attr-defined]


def concept(client: TestClient, name: str) -> CardConcept:
    with database(client) as db:
        return db.scalars(select(CardConcept).where(CardConcept.name == name)).one()


def printings(client: TestClient, name: str) -> list[CardPrinting]:
    """A card's printings, its default first, then by set and number."""
    found = concept(client, name)
    with database(client) as db:
        rows = list(db.scalars(select(CardPrinting).where(CardPrinting.concept_id == found.id)))
    return sorted(
        rows,
        key=lambda row: (row.id != found.default_printing_id, row.set_code, row.collector_number),
    )


def grant(client: TestClient, user: UUID, printing: CardPrinting, quantity: int, key: str) -> None:
    with database(client) as db:
        db.add(
            LibraryGrant(
                user_id=user,
                concept_id=printing.concept_id,
                printing_id=printing.id,
                quantity=quantity,
                source="pack",
                grant_key=key,
                created_at=utcnow(),
            )
        )
        db.commit()


def entry(card: CardConcept, quantity: int, printing: CardPrinting | None = None) -> dict:
    return {
        "card_id": str(card.id),
        "printing_id": str(printing.id) if printing else None,
        "quantity": quantity,
        "location": "main",
    }


def burn(client: TestClient, *bolts: tuple[int, CardPrinting | None]) -> list[dict]:
    bolt, mountain = concept(client, "Lightning Bolt"), concept(client, "Mountain")
    count = sum(quantity for quantity, _ in bolts)
    return [entry(bolt, quantity, printing) for quantity, printing in bolts] + [
        entry(mountain, 60 - count)
    ]


def editions(entries: list[dict]) -> Counter[tuple[str, str | None]]:
    return Counter({(item["card_id"], item["printing_id"]): item["quantity"] for item in entries})


def bolts(client: TestClient) -> tuple[CardPrinting, CardPrinting, CardPrinting]:
    """Three of Lightning Bolt's printings: the default and two others."""
    first, second, third, *_ = printings(client, "Lightning Bolt")
    return first, second, third


def test_a_pack_grants_each_edition_it_pulled_and_new_is_by_edition(client, monkeypatch):
    first, second, _ = bolts(client)
    ada = funded(client, "ada", 1_000)
    grant(client, ada.id, first, 1, "pack:earlier")
    pulled = [
        Pulled(first.id, "nonfoil", "common"),
        Pulled(second.id, "nonfoil", "common"),
        Pulled(second.id, "foil", "foil"),
    ]
    monkeypatch.setattr(shop_api, "draw", lambda *_: (0, pulled))
    pack = ada.send(
        "POST",
        "/api/v1/shop/purchases",
        {"product": str(fixture_product(client).id), "key": uuid4().hex},
    ).json()["pack"]
    opening = ada.send("POST", f"/api/v1/shop/packs/{pack}/open").json()
    # The library held the first edition already; the second is new, once.
    assert [(card["printing_id"], card["new"]) for card in opening["cards"]] == [
        (str(first.id), False),
        (str(second.id), True),
        (str(second.id), False),
    ]
    with database(client) as db:
        rows = db.execute(
            select(LibraryGrant.printing_id, LibraryGrant.quantity).where(
                LibraryGrant.grant_key == f"pack:{opening['id']}"
            )
        ).all()
    assert sorted(rows, key=str) == sorted([(first.id, 1), (second.id, 2)], key=str)

    # The library lists the card once per edition, each with its own picture and copies.
    library = ada.get("/api/v1/library").json()
    items = {item["edition"]["printing_id"]: item for item in library["cards"]}
    assert set(items) == {str(first.id), str(second.id)}
    held = items[str(second.id)]
    assert held["copies"] == 2 and held["sources"] == ["pack"]
    assert held["card"]["image"]["printing_id"] == str(second.id)
    assert held["card"]["owned"] == 4
    assert (held["edition"]["set_code"], held["edition"]["collector_number"]) == (
        second.set_code,
        second.collector_number,
    )
    assert items[str(first.id)]["copies"] == 2


def test_card_details_list_the_editions_asked_for(client):
    first, second, third = bolts(client)
    ada = Account(client, "ada")
    grant(client, ada.id, first, 2, "pack:one")
    grant(client, ada.id, second, 1, "pack:two")
    bolt = concept(client, "Lightning Bolt")
    path = f"/api/v1/cards/{bolt.id}"
    # From a pack: only the edition pulled (the owner's screenshot of 27 printings).
    chosen = ada.get(path, printings="chosen", printing=str(third.id)).json()
    assert [item["id"] for item in chosen["printings"]] == [str(third.id)]
    assert chosen["printing_count"] == 1
    # From the library: only the editions it holds.
    owned = ada.get(path, printings="owned").json()
    assert {item["id"] for item in owned["printings"]} == {str(first.id), str(second.id)}
    assert owned["printing_count"] == 2
    # The catalog keeps every printing, and says which editions the library holds.
    every = ada.get(path).json()
    assert every["printing_count"] == 6 and len(every["printings"]) == 6
    assert [(item["printing_id"], item["copies"]) for item in every["editions"]] == [
        (str(first.id), 2),
        (str(second.id), 1),
    ]
    # A basic land is in every library in every edition; an administrator builds from them all.
    mountain = concept(client, "Mountain")
    basic = ada.get(f"/api/v1/cards/{mountain.id}", printings="owned").json()
    assert basic["printing_count"] == 2 and basic["editions"] is None
    root = Account(client, "root", admin=True)
    theirs = root.get(path, printings="owned").json()
    assert theirs["printing_count"] == 6 and theirs["editions"] is None


def test_decks_hold_only_the_editions_the_library_holds(client):
    first, second, third = bolts(client)
    ada = Account(client, "ada")
    grant(client, ada.id, first, 2, "pack:one")
    grant(client, ada.id, second, 1, "pack:two")

    def check(*held: tuple[int, CardPrinting | None]) -> dict:
        return ada.send(
            "POST", "/api/v1/decks/validate", {"format": "legacy", "entries": burn(client, *held)}
        ).json()

    assert check((2, first), (1, second))["playable"] is True
    # Copies naming no edition take what the named ones leave over.
    assert check((2, first), (1, None))["playable"] is True
    assert check((3, None))["playable"] is True
    # More copies of an edition than the library holds of it: switch them, here to the other.
    over = check((3, first))
    assert over["legal"] is True and over["playable"] is False
    (problem,) = over["errors"]
    assert (problem["code"], problem["kind"], problem["quantity"]) == (
        "collection.locked",
        "collection_locked",
        3,
    )
    assert problem["message"] == (
        f"This deck holds 3 copies of Lightning Bolt from {first.set_name}; your library has 2 "
        "copies of that edition."
    )
    assert (
        problem["remedy"]
        == f"You own Lightning Bolt from {second.set_name}: switch 1 of them to it."
    )
    one = check((1, third), (2, first))["errors"][0]
    assert one["message"].endswith("your library has none of that edition.")
    assert (
        one["remedy"] == f"You own Lightning Bolt from {second.set_name}: switch this copy to it."
    )
    # Too many copies in all says what the library holds, every edition named.
    many = check((4, None))["errors"][0]
    assert many["message"] == (
        f"This deck holds 4 copies of Lightning Bolt; your library has 3 copies "
        f"({first.set_name} and {second.set_name})."
    )
    assert many["remedy"].startswith("Remove 1, or wait until your library holds more")
    # The format's limit still counts every edition together.
    five = check((2, first), (1, second), (2, third))["errors"]
    assert {item["code"] for item in five} >= {"deck.copy_limit", "collection.locked"}
    # Basic lands stay unlimited in every edition.
    mountain = concept(client, "Mountain")
    lands = [entry(mountain, 60, printings(client, "Mountain")[-1])]
    valid = ada.send("POST", "/api/v1/decks/validate", {"format": "legacy", "entries": lands})
    assert valid.json()["playable"] is True
    # Administrators and SysOp build from the whole catalog in any edition.
    root = Account(client, "root", admin=True)
    theirs = root.send(
        "POST", "/api/v1/decks/validate", {"format": "legacy", "entries": burn(client, (4, third))}
    )
    assert theirs.json()["playable"] is True


def test_a_save_gives_copies_naming_no_edition_one_the_library_holds(client):
    first, second, third = bolts(client)
    ada = Account(client, "ada")
    grant(client, ada.id, first, 2, "pack:one")
    grant(client, ada.id, second, 1, "pack:two")
    bolt = concept(client, "Lightning Bolt")
    made = ada.send(
        "POST",
        "/api/v1/decks",
        {"title": "Burn", "format": "legacy", "entries": burn(client, (4, None))},
    ).json()
    held = editions(made["draft"]["entries"])
    # The edition with the most copies first, then the next; what is left names none.
    assert held[(str(bolt.id), str(first.id))] == 2
    assert held[(str(bolt.id), str(second.id))] == 1
    assert held[(str(bolt.id), None)] == 1
    assert made["collection_locked"] is True
    # A copy naming an edition the library lacks keeps it on a save: the player switches it.
    saved = ada.send(
        "PUT",
        f"/api/v1/decks/{made['id']}/draft",
        {"version": 1, "entries": burn(client, (1, third), (1, None))},
    ).json()
    assert editions(saved["entries"])[(str(bolt.id), str(third.id))] == 1
    assert editions(saved["entries"])[(str(bolt.id), str(first.id))] == 1
    (problem,) = saved["validation"]["errors"]
    assert problem["remedy"].startswith("You own Lightning Bolt from ")
    # The deck's cards say which editions the library holds.
    card = saved["cards"][str(bolt.id)]
    assert [item["printing_id"] for item in card["editions"]] == [str(first.id), str(second.id)]


def test_starter_decks_are_granted_in_their_editions_and_play_at_once(client):
    ada = Account(client, "ada", onboarding="starters")
    chosen = ada.send(
        "POST", "/api/v1/me/starters", {"decks": ["starter_red_test", "starter_blue_test"]}
    )
    assert chosen.status_code == 201, chosen.text
    assert all(deck["playable"] for deck in ada.get("/api/v1/decks").json())
    named = next(
        printing
        for printing in printings(client, "Lightning Bolt")
        if (printing.set_code, printing.collector_number) == STARTER_BOLT
    )
    sol = concept(client, "Sol Ring")
    with database(client) as db:
        rows = db.execute(
            select(LibraryGrant.concept_id, LibraryGrant.printing_id, LibraryGrant.quantity).where(
                LibraryGrant.user_id == ada.id
            )
        ).all()
    # The deck's own Bolt; where the catalog lacks the owner's printing, the card's default.
    assert (named.concept_id, named.id, 1) in rows
    assert (sol.id, sol.default_printing_id, 1) in rows
    library = {item["card"]["name"]: item for item in ada.get("/api/v1/library").json()["cards"]}
    assert library["Lightning Bolt"]["edition"]["set_code"] == STARTER_BOLT[0]


def test_the_alliance_playset_is_in_each_cards_default_printing(client):
    ada = Account(client, "ada")
    ada.send("PUT", "/api/v1/me/alliance", {"planeswalker": "tibalt"})
    valki = concept(client, "Valki, God of Lies // Tibalt, Cosmic Impostor")
    (item,) = ada.get("/api/v1/library").json()["cards"]
    assert item["edition"]["printing_id"] == str(valki.default_printing_id)
    assert (item["copies"], item["sources"]) == (4, ["alliance"])
    other = next(
        printing
        for printing in printings(client, valki.name)
        if printing.id != valki.default_printing_id
    )
    swamp = concept(client, "Swamp")
    deck = [entry(valki, 4, other), entry(swamp, 56)]
    found = ada.send("POST", "/api/v1/decks/validate", {"format": "legacy", "entries": deck})
    (problem,) = found.json()["errors"]
    # Two printings of one set: the numbers tell them apart.
    assert f"#{other.collector_number}" in problem["message"]
    assert problem["remedy"].startswith(f"You own {valki.name} from {other.set_name} #")


def test_an_import_takes_owned_editions_and_keeps_a_named_one(client):
    first, second, third = bolts(client)
    ada = Account(client, "ada")
    grant(client, ada.id, first, 2, "pack:one")
    grant(client, ada.id, second, 1, "pack:two")
    bolt = concept(client, "Lightning Bolt")
    plain = ada.send(
        "POST",
        "/api/v1/decks/import/preview",
        {"format": "legacy", "text": "3 Lightning Bolt\n57 Mountain"},
    ).json()
    assert editions(plain["entries"])[(str(bolt.id), str(first.id))] == 2
    assert editions(plain["entries"])[(str(bolt.id), str(second.id))] == 1
    assert plain["validation"]["playable"] is True
    named = ada.send(
        "POST",
        "/api/v1/decks/import/preview",
        {
            "format": "legacy",
            "text": f"1 Lightning Bolt ({third.set_code.upper()}) {third.collector_number}\n"
            "59 Mountain",
        },
    ).json()
    assert editions(named["entries"])[(str(bolt.id), str(third.id))] == 1
    (problem,) = named["validation"]["errors"]
    assert problem["kind"] == "collection_locked"
    assert problem["remedy"] == (
        f"You own Lightning Bolt from {first.set_name} and {second.set_name}: switch this copy to "
        "them."
    )


def test_guided_creation_builds_with_owned_editions(client):
    ada = Account(client, "ada", onboarding="starters")
    ada.send("POST", "/api/v1/me/starters", {"decks": ["starter_red_test", "starter_blue_test"]})
    proposal = ada.send(
        "POST", "/api/v1/decks/guided", {"format": "legacy", "colors": "R", "theme": "aggro"}
    ).json()
    held = {
        (item["card"]["id"], item["edition"]["printing_id"])
        for item in ada.get("/api/v1/library").json()["cards"]
    }
    for item in proposal["entries"]:
        card = proposal["cards"][item["card_id"]]
        if card["owned"] is not None:
            assert (item["card_id"], item["printing_id"]) in held
    assert proposal["validation"]["errors"] == []


def plant(client: TestClient, owner: UUID, title: str, entries: list[dict]) -> UUID:
    """A deck saved as v0.4.5 left it: its draft as given, no edition given on a save."""
    now = utcnow()
    with database(client) as db:
        deck = Deck(
            owner_id=owner,
            title=title,
            format="legacy",
            visibility="private",
            notes="",
            draft={"entries": entries},
            draft_version=1,
            draft_hash="",
            source="empty",
            created_at=now,
            updated_at=now,
        )
        db.add(deck)
        db.commit()
        return deck.id


def test_the_deploy_switches_every_players_drafts_to_owned_editions_once(client, content):
    first, second, third = bolts(client)
    ada = Account(client, "ada")
    grant(client, ada.id, first, 2, "pack:one")
    grant(client, ada.id, second, 1, "pack:two")
    bolt = concept(client, "Lightning Bolt")
    # One switches fully; another holds more copies than the library and keeps the rest.
    fits = plant(client, ada.id, "Fits", burn(client, (1, first), (2, third)))
    short = plant(client, ada.id, "Short", burn(client, (4, third)))
    root = Account(client, "root", admin=True)
    theirs = plant(client, root.id, "Any edition", burn(client, (4, third)))
    # A version a game played keeps its editions.
    version = ada.send("POST", f"/api/v1/decks/{fits}/revisions").json()["number"]

    config = Settings(database_url=str(client.app.state.database.url), content_dir=str(content))  # type: ignore[attr-defined]
    worker.switch_editions(client.app.state.database, config)  # type: ignore[attr-defined]
    fitted = ada.get(f"/api/v1/decks/{fits}").json()
    assert editions(fitted["draft"]["entries"]) == editions(burn(client, (2, first), (1, second)))
    assert fitted["playable"] is True and fitted["draft"]["version"] == 2
    assert sorted(
        (item["quantity"], item["before"], item["after"]) for item in fitted["switched_editions"]
    ) == sorted(
        [
            (1, label(third), label(first)),
            (1, label(third), label(second)),
        ]
    )
    shorted = ada.get(f"/api/v1/decks/{short}").json()
    assert editions(shorted["draft"]["entries"]) == editions(
        burn(client, (2, first), (1, second), (1, third))
    )
    assert shorted["collection_locked"] is True
    listed = {item["title"]: item for item in ada.get("/api/v1/decks").json()}
    assert listed["Short"]["collection_locked"] is True
    assert sum(item["quantity"] for item in listed["Short"]["switched_editions"]) == 3
    revision = ada.get(f"/api/v1/decks/{fits}/revisions/{version}").json()
    assert editions(revision["entries"])[(str(bolt.id), str(third.id))] == 2
    with database(client) as db:
        assert db.get_one(Deck, theirs).draft["entries"] == burn(client, (4, third))
        marker = db.get_one(SiteSetting, decks_api.SWITCHED)
        assert marker.value["decks"] == 2  # type: ignore[index]
    # Once: a later start changes nothing, and the note stays until dismissed.
    with database(client) as db:
        assert decks_api.switch_editions(db, load(str(content))) is None
    dismissed = ada.send("DELETE", f"/api/v1/decks/{fits}/switched-editions").json()
    assert dismissed["switched_editions"] == []
    assert ada.get(f"/api/v1/decks/{fits}").json()["draft"]["version"] == 2


def label(printing: CardPrinting) -> str:
    return f"{printing.set_name} ({printing.set_code.upper()} #{printing.collector_number})"


def test_a_reset_empties_the_library_by_edition(client, content):
    first, _, _ = bolts(client)
    ada = Account(client, "ada")
    grant(client, ada.id, first, 2, "pack:one")
    assert ada.get("/api/v1/library").json()["cards"]
    with database(client) as db:
        db.get_one(User, ada.id).reset_at = utcnow()
        db.commit()
    assert ada.get("/api/v1/library").json()["cards"] == []
    bolt = concept(client, "Lightning Bolt")
    assert ada.get(f"/api/v1/cards/{bolt.id}").json()["editions"] == []


# Migration 0025: the grants made before it get their editions, and it goes back.


def grants_of(engine_: Any) -> Counter[tuple[UUID, str, UUID, UUID | None]]:
    """Every grant's copies by account, key, card and edition (None before 0025)."""
    edition = "printing_id" in {
        column["name"] for column in inspect(engine_).get_columns("library_grants")
    }
    table = sa.table(
        "library_grants",
        sa.column("user_id", sa.Uuid()),
        sa.column("grant_key", sa.String()),
        sa.column("concept_id", sa.Uuid()),
        sa.column("quantity", sa.Integer()),
        *([sa.column("printing_id", sa.Uuid())] if edition else []),
    )
    found: Counter[tuple[UUID, str, UUID, UUID | None]] = Counter()
    with engine_.connect() as connection:
        for row in connection.execute(sa.select(table)):
            printing = row.printing_id if edition else None
            found[(row.user_id, row.grant_key, row.concept_id, printing)] += row.quantity
    return found


def round_trip(database_url: str, folder: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Grants made at head, back to 0024 and up again: each grant gets back its editions,
    a grandfathered one those of the deck that held the most copies."""
    content = write_content(folder / "content")
    monkeypatch.setenv("CD_DATABASE_URL", database_url)
    monkeypatch.setenv("CD_CONTENT_DIR", str(content))
    config = Config("alembic.ini")
    command.upgrade(config, "head")
    engine_ = create_engine(database_url)
    try:
        import_bulk(engine_, folder / "files", bulk(), engine_list())
        assert boosters.load_local(engine_, SET_FILES, str(content))["ready"] == 1
        app = create_app(
            Settings(
                database_url=database_url, content_dir=str(content), sysop_networks="10.20.0.0/24"
            )
        )
        with TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS) as http:
            first, second, _ = bolts(http)
            counterspell = concept(http, "Counterspell")
            spells = printings(http, "Counterspell")
            hill = concept(http, "Hill Giant")
            other = next(item for item in spells if item.id != counterspell.default_printing_id)
            # A starter deck's grants, by its own editions.
            ada = funded(http, "ada", 1_000)
            with Session(engine_) as db:
                db.get_one(User, ada.id).onboarding = "starters"
                db.commit()
            chosen = ada.send(
                "POST", "/api/v1/me/starters", {"decks": ["starter_red_test", "starter_blue_test"]}
            )
            assert chosen.status_code == 201, chosen.text
            # A pack's, by the printings it pulled.
            pulled = [
                Pulled(first.id, "nonfoil", "common"),
                Pulled(second.id, "nonfoil", "common"),
                Pulled(second.id, "foil", "foil"),
            ]
            with pytest.MonkeyPatch.context() as patch:
                patch.setattr(shop_api, "draw", lambda *_: (0, pulled))
                pack = ada.send(
                    "POST",
                    "/api/v1/shop/purchases",
                    {"product": str(fixture_product(http).id), "key": uuid4().hex},
                ).json()["pack"]
                assert ada.send("POST", f"/api/v1/shop/packs/{pack}/open").status_code == 200
            # Grandfathered (v0.3.1): one card a deck held in two editions, one no deck holds.
            bea = Account(http, "bea")
            with Session(engine_) as db:
                for card, quantity in ((counterspell.id, 3), (hill.id, 2)):
                    db.add(
                        LibraryGrant(
                            user_id=bea.id,
                            concept_id=card,
                            printing_id=db.get_one(CardConcept, card).default_printing_id,
                            quantity=quantity,
                            source="grandfathered",
                            grant_key="grandfathered:0.3.1",
                            created_at=utcnow(),
                        )
                    )
                db.commit()
            plant(
                http,
                bea.id,
                "Old deck",
                [
                    entry(counterspell, 2, other),
                    entry(counterspell, 1),
                    entry(concept(http, "Island"), 57),
                ],
            )
            with Session(engine_) as db:
                db.add(SiteSetting(key=decks_api.SWITCHED, value={}, updated_at=utcnow()))
                db.commit()
        made = grants_of(engine_)
        with Session(engine_) as db:
            opening = db.scalars(select(PackOpening.id)).one()

        command.downgrade(config, PREVIOUS)
        columns = {column["name"] for column in inspect(engine_).get_columns("library_grants")}
        assert "printing_id" not in columns
        assert "switched_editions" not in {
            column["name"] for column in inspect(engine_).get_columns("decks")
        }
        back = grants_of(engine_)
        # One row per card again, every copy kept.
        assert back[(ada.id, f"pack:{opening}", first.concept_id, None)] == 3
        assert sum(back.values()) == sum(made.values())
        with Session(engine_) as db:
            assert db.scalar(text("SELECT count(*) FROM site_settings")) == 0

        command.upgrade(config, "head")
        again = grants_of(engine_)
        theirs = {key: count for key, count in again.items() if key[0] == bea.id}
        assert theirs == {
            (bea.id, "grandfathered:0.3.1", counterspell.id, other.id): 2,
            (bea.id, "grandfathered:0.3.1", counterspell.id, counterspell.default_printing_id): 1,
            (bea.id, "grandfathered:0.3.1", hill.id, hill.default_printing_id): 2,
        }
        # Packs and starter decks get back exactly the editions they gave.
        assert {key: count for key, count in again.items() if key[0] == ada.id} == {
            key: count for key, count in made.items() if key[0] == ada.id
        }
        if engine_.dialect.name == "postgresql":
            for statement in (
                "UPDATE library_grants SET quantity = 9",
                "DELETE FROM library_grants",
            ):
                with pytest.raises(DBAPIError, match="append-only"), engine_.begin() as connection:
                    connection.execute(text(statement))
        command.downgrade(config, PREVIOUS)
        command.upgrade(config, "head")
    finally:
        engine_.dispose()


def test_the_migration_gives_grants_their_editions_and_goes_back(tmp_path, monkeypatch):
    round_trip(f"sqlite:///{tmp_path}/editions.db", tmp_path, monkeypatch)


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_the_migration_on_postgresql(tmp_path, monkeypatch):
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
    try:
        round_trip(scoped, tmp_path, monkeypatch)
    finally:
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
