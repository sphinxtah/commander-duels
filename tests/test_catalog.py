"""The catalog import (CAT01–CAT10): statuses, revisions and the acceptance cases of section 5."""

import gzip
import json
from datetime import timedelta
from uuid import UUID

import pytest
from catalog_fixtures import NOW, bulk, by_name, database, engine_list, import_bulk, records
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.models import (
    CardAlias,
    CardConcept,
    CardFace,
    CardPrinting,
    CardRuling,
    CardTagLink,
    CatalogChange,
    CatalogRevision,
    FormatVersion,
)
from catalog.importer import Fence, Fenced
from catalog.scryfall import Limits, Reader, SyncError
from catalog.text import normalize, type_parts


def concept(session: Session, name: str) -> CardConcept:
    found = session.scalar(select(CardConcept).where(CardConcept.name == name))
    assert found is not None, name
    return found


def changes(session: Session, revision: int, kind: str) -> list[CatalogChange]:
    return list(
        session.scalars(
            select(CatalogChange).where(
                CatalogChange.revision_id == revision, CatalogChange.kind == kind
            )
        )
    )


def test_initial_import_decides_every_status_with_its_reason(tmp_path):
    engine = database(tmp_path)
    applied = import_bulk(engine, tmp_path / "files", bulk(), engine_list())
    with Session(engine) as session:
        revision = session.get(CatalogRevision, applied.revision_id)
        assert revision.counts["oracle_cards"] == len(records("oracle_cards"))
        assert revision.counts["unknown_layouts"] == {"front_card": 1, "prepare": 1}
        assert revision.engine_build == "test-build-1"
        bolt = concept(session, "Lightning Bolt")
        assert (bolt.status, bolt.status_reason, bolt.engine_name) == (
            "certified",
            None,
            "Lightning Bolt",
        )
        assert bolt.capabilities == {
            "multiplayer": True,
            "ai": "untested",
            "campaign": False,
            "offline": False,
        }
        assert bolt.identity_mask == 8 and bolt.colors == ["R"]
        # Split cards play under their joined name; double-faced cards under their front face.
        assert concept(session, "Fire // Ice").status == "certified"
        valki = concept(session, "Valki, God of Lies // Tibalt, Cosmic Impostor")
        assert (valki.status, valki.engine_name) == ("certified", "Valki, God of Lies")
        # Quarantined: a layout this version does not know, though the engine has the name.
        eater = concept(session, "Adventurous Eater // Have a Bite")
        assert (eater.status, eater.status_reason) == ("unsupported", "unknown_layout")
        assert concept(session, "Goblin").status_reason == "not_a_deck_card"
        assert not concept(session, "Goblin").deck_card
        brisela = concept(session, "Brisela, Voice of Nightmares")
        assert (brisela.deck_card, brisela.status_reason) == (False, "not_a_deck_card")
        temple = concept(session, "Temple of Khonshu")
        assert (temple.status, temple.status_reason) == ("unsupported", "not_implemented")
        assert temple.first_released_at.isoformat() == "2027-04-09"
        # Faces, rulings, tags and aliases are kept with the card.
        faces = session.scalars(select(CardFace.name).where(CardFace.concept_id == valki.id))
        assert list(faces) == ["Valki, God of Lies", "Tibalt, Cosmic Impostor"]
        lurrus = concept(session, "Lurrus of the Dream-Den")
        assert session.scalar(
            select(func.count()).select_from(CardRuling).where(CardRuling.concept_id == lurrus.id)
        ) == len([r for r in records("rulings") if r["oracle_id"] == str(lurrus.oracle_id)])
        assert session.scalar(
            select(func.count()).select_from(CardTagLink).where(CardTagLink.concept_id == bolt.id)
        )
        stomp = session.scalar(select(CardAlias).where(CardAlias.alias == "stomp"))
        assert stomp is not None and stomp.kind == "face"
        # The printing shown by default is a regular English paper printing.
        default = session.get(CardPrinting, bolt.default_printing_id)
        assert (default.lang, default.digital, default.promo) == ("en", False, False)
        # One added change per card, and no status changes on top of them.
        assert len(changes(session, revision.id, "added")) == len(records("oracle_cards"))
        assert changes(session, revision.id, "status_changed") == []
        legacy = session.scalar(select(FormatVersion).where(FormatVersion.format == "legacy"))
        assert "black lotus" in legacy.banned and "sol ring" in legacy.banned
        commander = session.scalar(select(FormatVersion).where(FormatVersion.format == "commander"))
        assert "dockside extortionist" in commander.banned
        assert "companion:lutri, the spellchaser" in commander.banned


def test_engine_unavailable_leaves_new_cards_catalog_only_and_keeps_decisions(tmp_path):
    engine = database(tmp_path)
    import_bulk(engine, tmp_path / "a", bulk(), None)
    with Session(engine) as session:
        bolt = concept(session, "Lightning Bolt")
        assert (bolt.status, bolt.status_reason) == ("catalog_only", "engine_unchecked")
    import_bulk(engine, tmp_path / "b", bulk(), engine_list())
    third = import_bulk(engine, tmp_path / "c", bulk(), None)
    with Session(engine) as session:
        # A sync while the engine is down never unlocks or blocks a card.
        assert concept(session, "Lightning Bolt").status == "certified"
        assert changes(session, third.revision_id, "status_changed") == []


def test_failed_gates_and_differing_characteristics_block_play(tmp_path):
    export = engine_list()
    for card in export["cards"]:
        if card["name"] == "Counterspell":
            card["gates"]["creates"] = False
            card["gates"]["error"] = "NullPointerException"
            card["passed"] = False
        if card["name"] == "Grizzly Bears":
            card["gates"]["copies"] = False
            card["passed"] = False
        if card["name"] == "Hill Giant":
            card["power"] = "4"
    engine = database(tmp_path)
    import_bulk(engine, tmp_path / "files", bulk(), export)
    with Session(engine) as session:
        counterspell = concept(session, "Counterspell")
        assert (counterspell.status, counterspell.status_reason) == ("mapped", "engine_load_failed")
        assert "NullPointerException" in counterspell.status_detail
        bears = concept(session, "Grizzly Bears")
        assert (bears.status, bears.status_reason) == ("implemented", "engine_gate_failed")
        giant = concept(session, "Hill Giant")
        assert (giant.status, giant.status_reason) == ("implemented", "characteristics_differ")
        assert "power and toughness 4/3 against 3/3" in giant.status_detail


def test_no_change_import_changes_nothing(tmp_path):
    engine = database(tmp_path)
    import_bulk(engine, tmp_path / "a", bulk(), engine_list())
    second = import_bulk(engine, tmp_path / "b", bulk(), engine_list())
    assert {kind: count for kind, count in second.changes.items() if count} == {}


def test_new_card_reprint_oracle_change_ban_and_removed_printing(tmp_path):
    engine = database(tmp_path)
    first = import_bulk(engine, tmp_path / "a", bulk(), engine_list())
    oracle = records("oracle_cards")
    printings = records("default_cards")
    with Session(engine) as session:
        bolt_before = concept(session, "Lightning Bolt")
        bolt_id, bolt_hash = bolt_before.id, bolt_before.gameplay_hash
    # A new card (T18): searchable, labelled, blocked.
    new = json.loads(json.dumps(by_name(oracle, "Grizzly Bears")))
    new.update(
        id="00000000-0000-4000-8000-000000000001",
        oracle_id="00000000-0000-4000-8000-000000000002",
        name="Commander Duels Test Card",
    )
    oracle.append(new)
    # A reprint of a supported card (T19): selectable at once, no new implementation.
    reprint = json.loads(json.dumps(by_name(printings, "Counterspell")))
    reprint.update(id="00000000-0000-4000-8000-000000000003", set="tst", collector_number="7★")
    printings.append(reprint)
    # Changed Oracle text on a certified card (CAT08): it keeps playing, under review.
    bolt = by_name(oracle, "Lightning Bolt")
    bolt["oracle_text"] = "Lightning Bolt deals 4 damage to any target."
    # A ban (CAT05): a new dated format version.
    by_name(oracle, "Brainstorm")["legalities"]["legacy"] = "banned"
    # A removed printing: its row stays, marked removed.
    removed = next(p for p in printings if p["name"] == "Lightning Bolt")
    printings.remove(removed)
    second = import_bulk(
        engine,
        tmp_path / "b",
        bulk(oracle_cards=oracle, default_cards=printings),
        engine_list(),
        NOW + timedelta(days=1),
    )
    revision = second.revision_id
    with Session(engine) as session:
        test_card = concept(session, "Commander Duels Test Card")
        assert (test_card.status, test_card.status_reason) == ("unsupported", "not_implemented")
        assert [c.concept_id for c in changes(session, revision, "added")] == [test_card.id]
        counterspell = concept(session, "Counterspell")
        added = changes(session, revision, "printing_added")
        assert [c.concept_id for c in added] == [counterspell.id]
        assert added[0].details == {"set": "tst", "number": "7★"}
        assert counterspell.status == "certified"
        bolt_now = session.get(CardConcept, bolt_id)
        assert bolt_now.gameplay_hash != bolt_hash
        assert (bolt_now.status, bolt_now.review, bolt_now.certified_hash) == (
            "certified",
            "pending",
            bolt_hash,
        )
        assert bolt_now.text_differs
        reworded = changes(session, revision, "oracle_changed")
        assert [c.concept_id for c in reworded] == [bolt_id]
        assert "4 damage" in reworded[0].details["after"]["oracle_text"]
        assert len(changes(session, revision, "legality_changed")) == 1
        versions = session.scalars(
            select(FormatVersion.version).where(FormatVersion.format == "legacy")
        ).all()
        assert sorted(versions) == [1, 2]
        gone = session.scalar(
            select(CardPrinting).where(CardPrinting.scryfall_id == UUID(removed["id"]))
        )
        assert gone is not None and gone.removed_revision == revision
        assert len(changes(session, revision, "printing_removed")) == 1
        assert first.revision_id < revision


def test_a_card_scryfall_drops_is_kept_as_removed(tmp_path):
    engine = database(tmp_path)
    import_bulk(engine, tmp_path / "a", bulk(), engine_list())
    oracle = [card for card in records("oracle_cards") if card["name"] != "Hill Giant"]
    printings = [card for card in records("default_cards") if card["name"] != "Hill Giant"]
    second = import_bulk(
        engine, tmp_path / "b", bulk(oracle_cards=oracle, default_cards=printings), engine_list()
    )
    with Session(engine) as session:
        giant = concept(session, "Hill Giant")
        assert giant.removed_revision == second.revision_id
    third = import_bulk(engine, tmp_path / "c", bulk(), engine_list())
    with Session(engine) as session:
        assert concept(session, "Hill Giant").removed_revision is None
        assert len(changes(session, third.revision_id, "restored")) == 1


def test_malformed_and_shrunken_files_leave_the_last_good_catalog(tmp_path):
    engine = database(tmp_path)
    good = import_bulk(engine, tmp_path / "a", bulk(), engine_list())
    broken = records("oracle_cards")
    broken[3] = {**broken[3], "oracle_id": "not-an-id"}
    with pytest.raises(SyncError) as error:
        import_bulk(engine, tmp_path / "b", bulk(oracle_cards=broken), engine_list())
    assert error.value.code == "record_malformed" and not error.value.transient
    orphan = records("default_cards")
    orphan[0] = {**orphan[0], "oracle_id": "00000000-0000-4000-8000-0000000000ff"}
    with pytest.raises(SyncError) as error:
        import_bulk(engine, tmp_path / "c", bulk(default_cards=orphan), engine_list())
    assert error.value.code == "orphan_printing"
    with pytest.raises(SyncError) as error:
        import_bulk(
            engine,
            tmp_path / "d",
            bulk(rulings=records("rulings")[:10]),
            engine_list(),
            previous={"rulings": len(records("rulings"))},
        )
    assert error.value.code == "unexpected_record_count"
    with Session(engine) as session:
        latest = session.scalar(select(func.max(CatalogRevision.id)))
        assert latest == good.revision_id
        assert session.scalar(select(func.count()).select_from(CardConcept)) == len(
            records("oracle_cards")
        )


def test_a_fenced_worker_cannot_hold_the_job(tmp_path):
    from api.models import ScheduledJob

    engine = database(tmp_path)
    with Session(engine) as session, session.begin():
        job = ScheduledJob(
            kind="catalog_sync",
            deduplication_key="k",
            due_at=NOW,
            status="running",
            generation=2,
        )
        session.add(job)
        session.flush()
        job_id = job.id
    with Session(engine) as session, session.begin():
        Fence(job_id, 2).hold(session)
        with pytest.raises(Fenced):
            Fence(job_id, 1).hold(session)


def test_reader_bounds_and_formats(tmp_path):
    rows = [{"object": "card", "n": index, "text": "x" * 50} for index in range(500)]
    array = tmp_path / "cards.json"
    array.write_text(json.dumps(rows), encoding="utf-8")
    assert [row["n"] for row in Reader(array, "json", Limits(), "test")] == list(range(500))
    zipped = tmp_path / "cards.json.gz"
    with gzip.open(zipped, "wt", encoding="utf-8") as f:
        f.write(json.dumps(rows, indent=2))
    assert len(list(Reader(zipped, "json", Limits(), "test"))) == 500
    with pytest.raises(SyncError, match="unpacks to more than 1000 bytes"):
        list(Reader(array, "json", Limits(decompressed_bytes=1000), "test"))
    lines = tmp_path / "cards.jsonl"
    lines.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
    assert len(list(Reader(lines, "jsonl", Limits(), "test"))) == 500
    with pytest.raises(SyncError, match="record is too large"):
        list(Reader(lines, "jsonl", Limits(record_bytes=40), "test"))
    lines.write_text('{"a": 1}\n[1, 2]\n', encoding="utf-8")
    with pytest.raises(SyncError, match="line 2: not an object"):
        list(Reader(lines, "jsonl", Limits(), "test"))
    unclosed = tmp_path / "unclosed.json"
    unclosed.write_text('[{"a": 1}, {"b": 2}', encoding="utf-8")
    with pytest.raises(SyncError, match="not closed|invalid JSON"):
        list(Reader(unclosed, "json", Limits(), "test"))


def test_text_normalization_and_type_lines():
    assert normalize("Lim-Dûl’s  Vault") == normalize("LIM-DUL'S VAULT") == "lim-dul's vault"
    assert normalize("Æther Vial") == "aether vial"
    assert type_parts("Legendary Creature — Elf Druid // Sorcery — Adventure") == (
        ["Legendary"],
        ["Creature", "Sorcery"],
        ["Elf", "Druid", "Adventure"],
    )
