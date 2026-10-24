"""Boosted cards in a pack (v0.6.2): the owner's five times the chance of Alpha's and Beta's
Power Nine and dual lands."""

from fractions import Fraction
from uuid import uuid4

from api.collation import Collation, Layout, Sheet, SheetCard, boost_sheet, boosted
from api.shop import BOOSTED


def sheet_of(count: int, weight: int = 1) -> Sheet:
    cards = tuple(SheetCard(uuid4(), weight, "W", "nonfoil") for _ in range(count))
    return Sheet(foil=False, fixed=False, balance_colors=False, allow_duplicates=False, cards=cards)


def chances(sheet: Sheet) -> list[Fraction]:
    total = sum(card.weight for card in sheet.cards)
    return [Fraction(card.weight, total) for card in sheet.cards]


def test_each_boosted_card_is_exactly_five_times_as_likely_and_the_rest_share_what_is_left() -> (
    None
):
    sheet = sheet_of(116, weight=3)
    lifted = {card.printing_id: 5 for card in sheet.cards[:19]}
    before = chances(sheet)
    after = chances(boost_sheet(sheet, lifted))
    assert all(after[i] == 5 * before[i] for i in range(19))
    rest = after[19:]
    assert len(set(rest)) == 1
    assert sum(after) == 1
    assert sum(after[:19]) == Fraction(95, 116)


def test_a_sheet_the_boosts_would_fill_multiplies_the_weights_instead() -> None:
    sheet = sheet_of(10)
    lifted = {card.printing_id: 5 for card in sheet.cards[:3]}
    after = boost_sheet(sheet, lifted)
    assert [card.weight for card in after.cards] == [5, 5, 5] + [1] * 7


def test_fixed_sheets_and_collations_without_the_cards_are_unchanged() -> None:
    sheet = sheet_of(5)
    fixed = Sheet(
        foil=False, fixed=True, balance_colors=False, allow_duplicates=False, cards=sheet.cards
    )
    lifted = {sheet.cards[0].printing_id: 5}
    assert boost_sheet(fixed, lifted) is fixed
    collation = Collation((Layout((("rare", 1),), 1),), {"rare": sheet})
    assert boosted(collation, {uuid4(): 5}) is collation
    assert boosted(collation, lifted).sheets["rare"].cards[0].weight > sheet.cards[0].weight


def test_the_power_nine_and_the_duals_of_alpha_and_beta_are_boosted_five_times() -> None:
    assert len(BOOSTED) == 38
    assert BOOSTED[("lea", "Black Lotus")] == 5
    assert BOOSTED[("leb", "Volcanic Island")] == 5
    assert ("2ed", "Black Lotus") not in BOOSTED
