"""Deck validation on the fixture catalog: T03 (printings), T04 (Legacy) and T05 (Commander)."""

from datetime import date

import pytest
from catalog_fixtures import bulk, database, engine_list, import_bulk
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.models import CardConcept, CardPrinting
from api.validation import DeckContent, DeckEntry, Validation, validate_deck

TODAY = date(2026, 10, 20)


@pytest.fixture(scope="module")
def catalog(tmp_path_factory):
    folder = tmp_path_factory.mktemp("validation")
    engine = database(folder)
    import_bulk(engine, folder / "files", bulk(), engine_list())
    yield engine
    engine.dispose()


@pytest.fixture
def session(catalog):
    with Session(catalog) as session:
        yield session


def card(session: Session, name: str) -> CardConcept:
    found = session.scalars(select(CardConcept).where(CardConcept.name == name)).all()
    assert found, name
    return found[0]


def entry(session: Session, name: str, quantity: int = 1, location: str = "main") -> DeckEntry:
    return DeckEntry(card_id=card(session, name).id, quantity=quantity, location=location)


def check(session: Session, fmt: str, *entries: DeckEntry) -> Validation:
    return validate_deck(session, DeckContent(format=fmt, entries=list(entries)), TODAY)


def codes(result: Validation) -> list[str]:
    return [problem.code for problem in result.errors]


def lands(session: Session, count: int) -> DeckEntry:
    return entry(session, "Mountain", count)


# T04: Legacy.


def test_legacy_deck_sizes_and_sideboard(session):
    assert codes(
        check(session, "legacy", entry(session, "Lightning Bolt", 4), lands(session, 55))
    ) == ["legacy.min_main"]
    sixty = check(session, "legacy", entry(session, "Lightning Bolt", 4), lands(session, 56))
    assert (sixty.legal, sixty.playable, sixty.errors) == (True, True, [])
    assert sixty.counts.main == 60
    eighty = check(session, "legacy", entry(session, "Lightning Bolt", 4), lands(session, 76))
    assert eighty.legal
    too_many = check(session, "legacy", lands(session, 200), entry(session, "Island", 51))
    assert codes(too_many) == ["deck.technical_max"]
    assert "technical limit" in too_many.errors[0].message
    sideboard = check(
        session,
        "legacy",
        lands(session, 60),
        entry(session, "Counterspell", 4, "sideboard"),
        entry(session, "Brainstorm", 4, "sideboard"),
        entry(session, "Swords to Plowshares", 4, "sideboard"),
        entry(session, "Thoughtseize", 4, "sideboard"),
    )
    assert codes(sideboard) == ["legacy.sideboard"]
    assert sideboard.errors[0].quantity == 16


def test_legacy_copy_limits_and_their_exceptions(session):
    assert codes(
        check(session, "legacy", entry(session, "Lightning Bolt", 5), lands(session, 55))
    ) == ["deck.copy_limit"]
    # Main deck and sideboard together.
    split = check(
        session,
        "legacy",
        entry(session, "Lightning Bolt", 4),
        entry(session, "Lightning Bolt", 1, "sideboard"),
        lands(session, 56),
    )
    assert codes(split) == ["deck.copy_limit"]
    rats = check(session, "legacy", entry(session, "Relentless Rats", 30), lands(session, 30))
    assert rats.legal
    dwarves = check(session, "legacy", entry(session, "Seven Dwarves", 7), lands(session, 53))
    assert dwarves.legal
    eight = check(session, "legacy", entry(session, "Seven Dwarves", 8), lands(session, 52))
    assert codes(eight) == ["deck.copy_limit"]
    assert "allows 7 copies" in eight.errors[0].message
    basics = check(session, "legacy", entry(session, "Snow-Covered Forest", 60))
    assert codes(basics) == []


def test_t03_other_printings_count_as_the_same_card(session):
    bolt = card(session, "Lightning Bolt")
    printings = session.scalars(
        select(CardPrinting.id).where(CardPrinting.concept_id == bolt.id).limit(2)
    ).all()
    assert len(printings) == 2
    result = check(
        session,
        "legacy",
        DeckEntry(card_id=bolt.id, printing_id=printings[0], quantity=3),
        DeckEntry(card_id=bolt.id, printing_id=printings[1], quantity=2),
        lands(session, 55),
    )
    assert codes(result) == ["deck.copy_limit"]
    assert "counting every printing" not in result.errors[0].message
    # Oracle versions that share a name (the Everythingamajigs) are one card too.
    versions = session.scalars(
        select(CardConcept).where(CardConcept.name == "Everythingamajig")
    ).all()
    assert len(versions) >= 2
    mixed = check(
        session,
        "legacy",
        DeckEntry(card_id=versions[0].id, quantity=3),
        DeckEntry(card_id=versions[1].id, quantity=2),
        lands(session, 55),
    )
    assert "deck.copy_limit" in codes(mixed)
    limit = next(p for p in mixed.errors if p.code == "deck.copy_limit")
    assert set(limit.card_ids) == {versions[0].id, versions[1].id}
    # A printing of another card is refused.
    other = session.scalar(
        select(CardPrinting.id).where(CardPrinting.concept_id != bolt.id).limit(1)
    )
    wrong = check(
        session,
        "legacy",
        DeckEntry(card_id=bolt.id, printing_id=other, quantity=4),
        lands(session, 56),
    )
    assert codes(wrong) == ["printing.mismatch"]
    assert wrong.errors[0].kind == "structure"


def test_bans_releases_and_engine_support_are_told_apart(session):
    banned = check(session, "legacy", entry(session, "Black Lotus"), lands(session, 59))
    assert codes(banned) == ["card.banned"] and banned.errors[0].kind == "format_illegal"
    future = check(session, "legacy", entry(session, "Temple of Khonshu"), lands(session, 59))
    kinds = {problem.code: problem.kind for problem in future.errors}
    assert kinds == {"card.not_released": "not_released", "card.not_implemented": "not_implemented"}
    quarantined = check(
        session, "legacy", entry(session, "Adventurous Eater // Have a Bite"), lands(session, 59)
    )
    assert codes(quarantined) == ["card.not_implemented"]
    assert (quarantined.legal, quarantined.playable) == (True, False)
    assert "layout is new" in quarantined.errors[0].message
    # The maybeboard holds anything without blocking.
    maybe = check(
        session,
        "legacy",
        lands(session, 60),
        entry(session, "Black Lotus", 1, "maybeboard"),
        entry(session, "Temple of Khonshu", 1, "maybeboard"),
    )
    assert maybe.playable


def test_legacy_companions(session):
    odd = [entry(session, "Lightning Bolt", 4), entry(session, "Llanowar Elves", 4)]
    obosh = check(
        session,
        "legacy",
        *odd,
        lands(session, 52),
        entry(session, "Obosh, the Preypiercer", 1, "companion"),
    )
    assert obosh.legal and obosh.counts.companion == 1
    broken = check(
        session,
        "legacy",
        *odd,
        entry(session, "Counterspell", 4),
        lands(session, 48),
        entry(session, "Obosh, the Preypiercer", 1, "companion"),
    )
    assert codes(broken) == ["companion.condition"]
    assert card(session, "Counterspell").id in broken.errors[0].card_ids
    # Lurrus is banned in Legacy, as a companion too.
    lurrus = check(
        session,
        "legacy",
        lands(session, 60),
        entry(session, "Lurrus of the Dream-Den", 1, "companion"),
    )
    assert codes(lurrus) == ["card.banned"]
    yorion = check(
        session, "legacy", lands(session, 60), entry(session, "Yorion, Sky Nomad", 1, "companion")
    )
    assert codes(yorion) == ["companion.condition"]
    assert check(
        session, "legacy", lands(session, 80), entry(session, "Yorion, Sky Nomad", 1, "companion")
    ).legal
    jegantha = check(
        session,
        "legacy",
        entry(session, "Counterspell", 4),
        lands(session, 56),
        entry(session, "Jegantha, the Wellspring", 1, "companion"),
    )
    assert codes(jegantha) == ["companion.condition"]
    # The companion counts as one of the fifteen.
    full = check(
        session,
        "legacy",
        lands(session, 60),
        entry(session, "Counterspell", 4, "sideboard"),
        entry(session, "Brainstorm", 4, "sideboard"),
        entry(session, "Thoughtseize", 4, "sideboard"),
        entry(session, "Swords to Plowshares", 4, "sideboard"),
        entry(session, "Obosh, the Preypiercer", 1, "companion"),
    )
    assert codes(full) == ["legacy.sideboard"]
    assert codes(
        check(session, "legacy", lands(session, 60), entry(session, "Hill Giant", 1, "companion"))
    ) == ["companion.not_a_companion"]


# T05: Commander.


def commander_deck(
    session: Session, *leaders: str, rest: list[DeckEntry] | None = None
) -> list[DeckEntry]:
    chosen = [entry(session, name, 1, "commander") for name in leaders]
    body = rest or []
    filler = 100 - len(leaders) - sum(item.quantity for item in body)
    return [*chosen, *body, entry(session, "Wastes", filler)]


def test_commander_size_identity_and_singleton(session):
    kenrith = check(session, "commander", *commander_deck(session, "Kenrith, the Returned King"))
    assert (kenrith.legal, kenrith.playable) == (True, True)
    short = commander_deck(session, "Kenrith, the Returned King")
    short[-1] = entry(session, "Wastes", 98)
    assert codes(check(session, "commander", *short)) == ["commander.size"]
    twice = check(
        session,
        "commander",
        *commander_deck(
            session, "Kenrith, the Returned King", rest=[entry(session, "Lightning Bolt", 2)]
        ),
    )
    assert codes(twice) == ["deck.copy_limit"]
    rats = check(
        session,
        "commander",
        *commander_deck(
            session, "Kenrith, the Returned King", rest=[entry(session, "Relentless Rats", 40)]
        ),
    )
    assert rats.legal
    red_green = check(
        session,
        "commander",
        *commander_deck(
            session,
            "Karlach, Fury of Avernus",
            "Raised by Giants",
            rest=[entry(session, "Counterspell"), entry(session, "Lightning Bolt")],
        ),
    )
    assert codes(red_green) == ["commander.identity"]
    assert red_green.errors[0].card_ids == [card(session, "Counterspell").id]
    assert "(RG)" in red_green.errors[0].message
    banned = check(
        session,
        "commander",
        *commander_deck(
            session, "Kenrith, the Returned King", rest=[entry(session, "Dockside Extortionist")]
        ),
    )
    assert codes(banned) == ["card.banned"]
    side = commander_deck(session, "Kenrith, the Returned King")
    side.append(entry(session, "Sol Ring", 1, "sideboard"))
    assert codes(check(session, "commander", *side)) == ["commander.sideboard"]


@pytest.mark.parametrize(
    ("leaders", "ok"),
    [
        (("Thrasios, Triton Hero", "Tymna the Weaver"), True),
        (("Pir, Imaginative Rascal", "Toothy, Imaginary Friend"), True),
        (("Karlach, Fury of Avernus", "Raised by Giants"), True),
        (("The Tenth Doctor", "Rose Tyler"), True),
        (("Cecily, Haunted Mage", "Bjorna, Nightfall Alchemist"), True),
        (("Pir, Imaginative Rascal", "Thrasios, Triton Hero"), False),
        (("Cecily, Haunted Mage", "Thrasios, Triton Hero"), False),
        (("Kenrith, the Returned King", "Thrasios, Triton Hero"), False),
        (("Karlach, Fury of Avernus", "Tymna the Weaver"), False),
    ],
)
def test_commander_pairs(session, leaders, ok):
    result = check(session, "commander", *commander_deck(session, *leaders))
    assert ("commander.pair" not in codes(result)) is ok, codes(result)
    if not ok:
        assert result.errors[0].card_ids == [card(session, name).id for name in leaders]


def test_who_may_lead(session):
    assert check(session, "commander", *commander_deck(session, "Teferi, Temporal Archmage")).legal
    bears = check(session, "commander", *commander_deck(session, "Grizzly Bears"))
    assert codes(bears) == ["commander.eligible"]
    background = check(session, "commander", *commander_deck(session, "Raised by Giants"))
    assert codes(background) == ["commander.eligible"]
    assert "Choose a Background" in background.errors[0].message
    none = check(session, "commander", entry(session, "Wastes", 100))
    assert codes(none) == ["commander.missing"]


def test_commander_companions(session):
    lutri = commander_deck(session, "Kenrith, the Returned King")
    lutri.append(entry(session, "Lutri, the Spellchaser", 1, "companion"))
    assert codes(check(session, "commander", *lutri)) == ["companion.banned"]
    kaheera = commander_deck(
        session, "Kenrith, the Returned King", rest=[entry(session, "Llanowar Elves")]
    )
    kaheera.append(entry(session, "Kaheera, the Orphanguard", 1, "companion"))
    result = check(session, "commander", *kaheera)
    assert codes(result) == ["companion.condition"]
    assert card(session, "Llanowar Elves").id in result.errors[0].card_ids
    yorion = commander_deck(session, "Kenrith, the Returned King")
    yorion.append(entry(session, "Yorion, Sky Nomad", 1, "companion"))
    assert codes(check(session, "commander", *yorion)) == ["companion.condition"]
    # Outside the commander's identity.
    jegantha = commander_deck(session, "Karlach, Fury of Avernus", "Raised by Giants")
    jegantha.append(entry(session, "Lurrus of the Dream-Den", 1, "companion"))
    assert "commander.identity" in codes(check(session, "commander", *jegantha))
