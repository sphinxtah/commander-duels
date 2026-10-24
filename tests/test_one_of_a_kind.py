"""One-of-a-kind cards (v0.5.1): the owner asked for the only copy of The One Ring ever printed
(LTR #0, 001/001, in the Black Speech of Mordor) to be Sphinx's alone. Packs never deal a
one-of-a-kind printing, no deck but its owner's (and SysOp's) may hold it, and migration 0027
grants it to the player whose handle is Sphinx, once. The test catalog has no One Ring: a Lightning
Bolt printing stands in for it. And print runs (v0.5.1): packs never deal a printing made in a known
number of copies more often than it was printed, across every account."""

import json
import os
from collections.abc import Iterator
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from catalog_fixtures import bulk, engine_list, import_bulk
from sqlalchemy import create_engine, make_url, select, text, update
from test_library_editions import (  # noqa: F401 (fixtures)
    bolts,
    burn,
    client,
    collated,
    content,
    database,
    engine,
    url,
    write_content,
)
from test_progression import Account
from test_shop import CONTENT, fixture_product, funded

from api import library, print_runs
from api import shop as shop_api
from api.collation import Pulled, load
from api.identity import utcnow
from api.models import CardPrinting, LibraryGrant, User

# The 1-of-1's Scryfall ID, as api/library.py and migration 0027 name it.
ONE_RING = UUID("93de9042-cc62-4ade-8d8d-68fdbc84bfae")


def test_the_rule_and_the_migration_name_the_same_card():
    assert library.ONE_OF_A_KIND == {ONE_RING: "sphinx"}


def test_a_pack_never_deals_a_one_of_a_kind_printing(client, monkeypatch):  # noqa: F811
    product = fixture_product(client)
    with database(client) as db:
        assert product.collation_id is not None
        dealt = load(db, product.collation_id).printings()
        unique = db.scalars(select(CardPrinting).where(CardPrinting.id.in_(dealt))).first()
    assert unique is not None
    monkeypatch.setattr(library, "ONE_OF_A_KIND", {unique.scryfall_id: "someone"})
    removed: list[frozenset[UUID]] = []
    real = shop_api.draw

    def draw(collation, rng, withheld):  # type: ignore[no-untyped-def]
        removed.append(withheld)
        return real(collation, rng, withheld)

    monkeypatch.setattr(shop_api, "draw", draw)
    ada = funded(client, "ada", 10_000)
    for _ in range(5):
        pack = ada.send(
            "POST",
            "/api/v1/shop/purchases",
            {"product": str(product.id), "key": uuid4().hex},
        ).json()["pack"]
        opening = ada.send("POST", f"/api/v1/shop/packs/{pack}/open").json()
        assert str(unique.id) not in {card["printing_id"] for card in opening["cards"]}
    # Every opening gave it way, as it does a card the game cannot play, but unnamed.
    assert removed and all(unique.id in gone for gone in removed)


def test_only_its_owner_and_sysop_may_hold_a_one_of_a_kind_edition(client, monkeypatch):  # noqa: F811
    _, ring, other = bolts(client)
    monkeypatch.setattr(library, "ONE_OF_A_KIND", {ring.scryfall_id: "sphinx"})
    sphinx = Account(client, "Sphinx", admin=True)
    root = Account(client, "root", admin=True)
    sysop = Account(client, "sysop", kind="sysop")
    with database(client) as db:
        db.add(
            LibraryGrant(
                user_id=sphinx.id,
                concept_id=ring.concept_id,
                printing_id=ring.id,
                quantity=1,
                source="unique",
                grant_key=f"unique:{ring.scryfall_id}",
                created_at=utcnow(),
            )
        )
        db.commit()

    def check(who: Account, *held: tuple[int, CardPrinting | None]) -> dict:
        answer = who.send(
            "POST", "/api/v1/decks/validate", {"format": "legacy", "entries": burn(client, *held)}
        )
        assert answer.status_code == 200, answer.text
        return answer.json()  # type: ignore[no-any-return]

    # An administrator who builds from the whole catalog may not hold the one copy.
    refused = check(root, (1, ring), (3, other))
    assert refused["playable"] is False
    (problem,) = refused["errors"]
    assert (problem["code"], problem["kind"], problem["quantity"]) == (
        "collection.locked",
        "collection_locked",
        1,
    )
    assert problem["message"] == (
        f"Lightning Bolt from {ring.set_name} ({ring.set_code.upper()} "
        f"#{ring.collector_number}) is one of a kind: another player owns the only copy."
    )
    assert problem["remedy"] == "Switch this copy to another edition."
    assert check(root, (4, other))["playable"] is True
    # Its owner and SysOp may.
    assert check(sphinx, (1, ring), (3, other))["playable"] is True
    assert check(sysop, (1, ring), (3, other))["playable"] is True
    # A player who builds from a library holds no copy of it: the library's own rule refuses it.
    ada = Account(client, "ada")
    assert check(ada, (1, ring))["playable"] is False


def round_trip(database_url: str, folder: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Migration 0027 on a catalog whose printing is the One Ring: Sphinx gets the one copy,
    once; a second run gives nothing more; the downgrade takes it back."""
    (folder / "content").mkdir()
    monkeypatch.setenv("CD_DATABASE_URL", database_url)
    monkeypatch.setenv("CD_CONTENT_DIR", str(write_content(folder / "content")))
    config = Config("alembic.ini")
    command.upgrade(config, "head")
    engine_ = create_engine(database_url)
    try:
        import_bulk(engine_, folder / "files", bulk(), engine_list())
        with engine_.begin() as connection:
            stand_in = connection.scalars(select(CardPrinting.id).limit(1)).one()
            connection.execute(
                update(CardPrinting).where(CardPrinting.id == stand_in).values(scryfall_id=ONE_RING)
            )
            for handle, status in (("Sphinx", "active"), ("Sphinxy", "active")):
                connection.execute(
                    User.__table__.insert().values(
                        id=uuid4(),
                        handle=handle,
                        normalized_handle=handle.casefold(),
                        display_name=handle,
                        kind="player",
                        status=status,
                        onboarding="complete",
                        created_at=utcnow(),
                    )
                )
        command.downgrade(config, "0026_two_headed_giant_tables")
        command.upgrade(config, "head")

        def grants() -> list[tuple[str, UUID, int, str, str]]:
            with engine_.connect() as connection:
                return [
                    tuple(row)  # type: ignore[misc]
                    for row in connection.execute(
                        select(
                            User.handle,
                            LibraryGrant.printing_id,
                            LibraryGrant.quantity,
                            LibraryGrant.source,
                            LibraryGrant.grant_key,
                        ).join(User, User.id == LibraryGrant.user_id)
                    )
                ]

        assert grants() == [("Sphinx", stand_in, 1, "unique", f"unique:{ONE_RING}")]
        command.downgrade(config, "0026_two_headed_giant_tables")
        assert grants() == []
        command.upgrade(config, "head")
        command.downgrade(config, "0026_two_headed_giant_tables")
        command.upgrade(config, "head")
        assert len(grants()) == 1
    finally:
        engine_.dispose()


def test_the_migration_grants_the_one_ring_to_sphinx(tmp_path, monkeypatch):
    round_trip(f"sqlite:///{tmp_path}/ring.db", tmp_path, monkeypatch)


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


# Print runs.


@pytest.fixture
def runs(content: Path) -> Iterator[Path]:  # noqa: F811
    """The content folder's print-runs.json, written by the test, and gone after it."""
    path = content / "print-runs.json"
    print_runs.runs_in.cache_clear()
    yield path
    path.unlink(missing_ok=True)
    print_runs.runs_in.cache_clear()


def limit(path: Path, printing: CardPrinting, copies: int) -> None:
    path.write_text(
        json.dumps(
            {
                "printings": [
                    {"scryfall_id": str(printing.scryfall_id), "copies": copies},
                    {"scryfall_id": str(uuid4()), "copies": None},
                ]
            }
        ),
        encoding="utf-8",
    )
    print_runs.runs_in.cache_clear()


def test_a_pack_never_deals_a_printing_past_its_print_run(client, runs, monkeypatch):  # noqa: F811
    product = fixture_product(client)
    with database(client) as db:
        assert product.collation_id is not None
        collation = load(db, product.collation_id)
        limited, other = list(
            db.scalars(
                select(CardPrinting).where(CardPrinting.id.in_(collation.printings())).limit(2)
            )
        )
    limit(runs, limited, 2)
    # The draw deals the limited printing whenever it may, twice when asked to, else the other.
    twice = {"value": False}
    calls: list[frozenset[UUID]] = []

    def draw(collation, rng, withheld):  # type: ignore[no-untyped-def]
        calls.append(withheld)
        if limited.id in withheld:
            return 0, [Pulled(other.id, "nonfoil", "common")]
        cards = [Pulled(limited.id, "nonfoil", "common")]
        if twice["value"]:
            cards.append(Pulled(limited.id, "foil", "foil"))
        return 0, cards

    monkeypatch.setattr(shop_api, "draw", draw)
    ada, bob = Account(client, "ada"), Account(client, "bob")
    root = Account(client, "root", kind="sysop")
    for who in (ada, bob):
        given = root.send(
            "POST", f"/api/v1/admin/users/{who.id}/tokens", {"amount": 10_000, "reason": "Tests"}
        )
        assert given.status_code == 200, given.text

    def opened(who: Account) -> list[tuple[str, bool]]:
        pack = who.send(
            "POST", "/api/v1/shop/purchases", {"product": str(product.id), "key": uuid4().hex}
        ).json()["pack"]
        answer = who.send("POST", f"/api/v1/shop/packs/{pack}/open")
        assert answer.status_code == 200, answer.text
        return [(card["printing_id"], card["extra"]) for card in answer.json()["cards"]]

    # Two copies printed: one to Ada, then a pack that would take both is drawn again without it.
    assert opened(ada) == [(str(limited.id), False)]
    twice["value"] = True
    assert opened(bob) == [(str(other.id), False)]
    # One copy is left, and Bob's next pack takes it; then the run is dealt, for everyone, and
    # what gives way is not named.
    twice["value"] = False
    assert opened(bob) == [(str(limited.id), False)]
    for who in (ada, bob):
        assert opened(who) == [(str(other.id), False)]
    assert limited.id in calls[-1]
    with database(client) as db:
        assert print_runs.dealt(db, {limited.id}) == {limited.id: 2}


def test_the_print_runs_are_sourced_and_name_the_owners_examples():
    listed = json.loads(
        (Path(__file__).resolve().parent.parent / "content" / "print-runs.json").read_text(
            encoding="utf-8"
        )
    )["printings"]
    by_id = {UUID(item["scryfall_id"]): item for item in listed}
    assert len(by_id) == len(listed)
    assert by_id[ONE_RING]["copies"] == 1
    assert by_id[UUID("4e6fee52-33a8-4085-b632-bf95dfd2b16d")]["copies"] == 100
    for item in listed:
        assert item["source"], item
        assert item["copies"] is None or item["copies"] >= 1, item


def test_every_alpha_and_beta_printing_follows_its_sheets():
    """v0.6.1: each Alpha and Beta printing's copies are its places on the 121-card sheets times
    the copies of each sheet printed, and the runs come to the published totals."""
    listing = json.loads((CONTENT / "print-runs.json").read_text(encoding="utf-8"))
    sheet_runs = listing["sheet_runs"]
    assert sheet_runs["lea"]["sheets"] == {"rare": 1100, "uncommon": 4500, "common": 15900}
    assert sheet_runs["leb"]["sheets"] == {"rare": 3200, "uncommon": 13400, "common": 47800}
    for code, printings, total in (("lea", 295, 2_601_500), ("leb", 302, 7_792_400)):
        run = sheet_runs[code]
        listed = [item for item in listing["printings"] if item["set"] == code]
        assert len(listed) == len({item["number"] for item in listed}) == printings
        assert run["source"] and run["total"] == total
        places = {sheet: 0 for sheet in run["sheets"]}
        for item in listed:
            assert item["source"] == f"sheet_runs.{code}", item
            assert item["copies"] == sum(
                times * run["sheets"][sheet] for sheet, times in item["sheets"].items()
            ), item
            for sheet, times in item["sheets"].items():
                places[sheet] += times
        # Every sheet is full, so the printings' copies add up to the whole run.
        assert places == {"rare": 121, "uncommon": 121, "common": 121}
        assert sum(item["copies"] for item in listed) == total
    by_id = {UUID(item["scryfall_id"]): item["copies"] for item in listing["printings"]}
    assert by_id[UUID("b0faa7f2-b547-42c4-a810-839da50dadfe")] == 1_100  # Alpha's Black Lotus
    assert by_id[UUID("b3a69a1c-c80f-4413-a6fd-ae54cabbce28")] == 3_200  # Beta's Black Lotus
    assert by_id[UUID("0324641d-af55-4c53-b4dc-c8262e967da5")] == 3_200  # Volcanic Island
    # Beta's Island #292: twice on the rare sheet, once on the uncommon, four times on the common.
    assert by_id[UUID("d0c5cf64-9844-4b5b-8e6b-b97c50cce053")] == 2 * 3_200 + 13_400 + 4 * 47_800


def test_the_catalogs_alpha_and_beta_printings_are_limited(client):  # noqa: F811
    hill_giant = UUID("0ddb98e8-13fe-4786-83f7-b72c56db135a")  # Alpha, a common
    dark_ritual = UUID("0690f724-eb95-416b-b064-f1239e2a30e8")  # Beta, a common
    print_runs.runs_in.cache_clear()
    with database(client) as db:
        found = dict(
            db.execute(
                select(CardPrinting.scryfall_id, CardPrinting.id).where(
                    CardPrinting.scryfall_id.in_([hill_giant, dark_ritual])
                )
            ).all()
        )
        assert set(found) == {hill_giant, dark_ritual}
        assert print_runs.limited(db, str(CONTENT), set(found.values())) == {
            found[hill_giant]: 15_900,
            found[dark_ritual]: 47_800,
        }
