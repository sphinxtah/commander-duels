"""One-of-a-kind cards (v0.5.1): the owner asked for the only copy of The One Ring ever printed
(LTR #0, 001/001, in the Black Speech of Mordor) to be Sphinx's alone. Packs never deal a
one-of-a-kind printing, no deck but its owner's (and SysOp's) may hold it, and migration 0027
grants it to the player whose handle is Sphinx, once. The test catalog has no One Ring: a Lightning
Bolt printing stands in for it."""

import os
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
from test_shop import fixture_product, funded

from api import library
from api import shop as shop_api
from api.collation import load
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

    def draw(collation, rng, gone):  # type: ignore[no-untyped-def]
        removed.append(gone)
        return real(collation, rng, gone)

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
    # Every opening gave it way, as it does a card the game cannot play.
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
