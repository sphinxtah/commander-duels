"""v0.8.9: packs sell out when their set's print run is spent (api/pack_supply.py), and a print run
counts every account's copies but SysOp's (api/print_runs.py), a testing grant past it refused."""

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import select
from test_library_editions import (  # noqa: F401 (fixtures)
    client,
    collated,
    content,
    database,
    engine,
    url,
)
from test_one_of_a_kind import limit, runs  # noqa: F401 (fixtures)
from test_progression import Account
from test_shop import buy, fixture_product

from api import pack_supply, print_runs
from api.collation import load
from api.models import CardPrinting, LibraryGrant

CONTENT = Path(__file__).resolve().parent.parent / "content"


@pytest.fixture
def supply(content: Path) -> Iterator[Path]:  # noqa: F811
    path = content / "pack-supply.json"
    pack_supply.runs_in.cache_clear()
    yield path
    path.unlink(missing_ok=True)
    pack_supply.runs_in.cache_clear()


def run_of(path: Path, cards: int) -> None:
    path.write_text(
        json.dumps({"sets": [{"set": "ZNR", "cards": cards, "cards_per_product": {"draft": 15}}]}),
        encoding="utf-8",
    )
    pack_supply.runs_in.cache_clear()


def give_tokens(root: Account, *accounts: Account) -> None:
    for who in accounts:
        given = root.send(
            "POST", f"/api/v1/admin/users/{who.id}/tokens", {"amount": 10_000, "reason": "Tests"}
        )
        assert given.status_code == 200, given.text


def test_a_set_sells_out_when_its_run_is_spent(client, supply):  # noqa: F811
    product = fixture_product(client)
    run_of(supply, 30)  # two packs of 15
    ada, bob = Account(client, "ada"), Account(client, "bob")
    root = Account(client, "root", kind="sysop")
    give_tokens(root, ada, bob, root)

    def listed(who: Account) -> dict[str, object]:
        [found] = [
            item
            for item in who.get("/api/v1/shop").json()["products"]
            if item["id"] == str(product.id)
        ]
        return found

    assert listed(ada)["sold_out"] is False
    assert buy(ada, product.id).status_code == 201
    # SysOp's packs come out of no run.
    assert buy(root, product.id).status_code == 201
    assert listed(ada)["sold_out"] is False
    # A grant of two would go past what is left; one fits.
    grant = {"product": str(product.id), "count": 2, "reason": "Tests"}
    refused = root.send("POST", f"/api/v1/admin/users/{bob.id}/packs", grant)
    assert (refused.status_code, refused.json()["code"]) == (409, "sold_out")
    given = root.send("POST", f"/api/v1/admin/users/{bob.id}/packs", {**grant, "count": 1})
    assert given.status_code == 201, given.text
    # Spent: shown sold out, and neither sold nor given, except to SysOp.
    assert listed(ada)["sold_out"] is True
    bought = buy(ada, product.id)
    assert (bought.status_code, bought.json()["code"]) == (409, "sold_out")
    more = root.send("POST", f"/api/v1/admin/users/{ada.id}/packs", {**grant, "count": 1})
    assert more.json()["code"] == "sold_out"
    assert buy(root, product.id).status_code == 201
    # A pack already held still opens.
    inventory = bob.get("/api/v1/shop").json()["inventory"]
    assert inventory and inventory[0]["count"] == 1


def test_the_supply_file_is_sourced_and_sized():
    listing = json.loads((CONTENT / "pack-supply.json").read_text(encoding="utf-8"))
    sources = listing["sources"]
    by_set = {item["set"]: item for item in listing["sets"]}
    assert by_set["LEA"]["cards"] == 2_600_000
    assert by_set["LEA"]["cards_per_product"] == {"default": 15, "starter": 60}
    assert by_set["ARN"]["cards_per_product"] == {"default": 8}
    # Revised's run was only ever estimated from below: unlimited.
    assert "3ED" not in by_set
    for item in listing["sets"]:
        assert item["source"] in sources and item["note"]
        assert item["cards"] > 0
    # Alpha and Beta's runs agree with their sheets' sums (docs/shop.md "Print runs").
    assert by_set["LEB"]["cards"] == 7_800_000


def test_sysops_copies_leave_the_run_and_grants_stop_at_it(client, runs):  # noqa: F811
    product = fixture_product(client)
    with database(client) as db:
        assert product.collation_id is not None
        printing = db.scalars(
            select(CardPrinting).where(
                CardPrinting.id.in_(load(db, product.collation_id).printings())
            )
        ).first()
        assert printing is not None
        card_id = printing.concept_id
    limit(runs, printing, 3)
    ada = Account(client, "ada")
    root = Account(client, "root", kind="sysop")
    body = {
        "card_id": str(card_id),
        "printing_id": str(printing.id),
        "finish": (printing.finishes or ["nonfoil"])[0],
        "reason": "Testing print runs",
    }
    # SysOp's own copies come out of no run.
    mine = root.send("POST", f"/api/v1/admin/users/{root.id}/cards", {**body, "quantity": 5})
    assert mine.status_code == 201, mine.text
    with database(client) as db:
        assert print_runs.dealt(db, {printing.id}) == {printing.id: 0}
    # Anyone else's do: a grant past what is left is refused, one within it given.
    past = root.send("POST", f"/api/v1/admin/users/{ada.id}/cards", {**body, "quantity": 4})
    assert (past.status_code, past.json()["code"]) == (409, "print_run")
    given = root.send("POST", f"/api/v1/admin/users/{ada.id}/cards", {**body, "quantity": 3})
    assert given.status_code == 201, given.text
    with database(client) as db:
        assert print_runs.dealt(db, {printing.id}) == {printing.id: 3}
        assert db.scalars(select(LibraryGrant).where(LibraryGrant.user_id == ada.id)).all()
