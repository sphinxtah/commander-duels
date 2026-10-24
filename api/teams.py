"""Two-Headed Giant's teams (v0.5.0, early): seats 0 and 1 play seats 2 and 3, with Legacy decks.

The player sits in seat 0 with a bot teammate in seat 1, against two bots. Each deck must be
Legacy-legal on its own, as the table's rules allow (api/games.py), and a team's two decks follow
the Magic Tournament Rules for Two-Headed Giant Constructed (effective 2026-02-27): section 9.5
uses Unified Deck Construction (section 8.4), so no two decks on a team may hold the same card,
by its English name, except cards with the basic supertype. Section 9.5 also bans Erayo, Soratami
Ascendant in every Two-Headed Giant Constructed tournament, which a table refusing banned cards
refuses. A bot whose deck is not chosen plays one of the engine's four Legacy fixture decks, which
share no card: the teammate's shares none with the player's deck either, and two bots on a team
play one of the measured pairs (v0.5.1). Since v0.5.1 the decks are dealt by a search, so only a
player whose deck shares a card with every fixture deck stops a bot teammate, and a pair gives way
when it would leave another bot no deck.
"""

from collections.abc import Iterable
from typing import cast

from api.identity import ApiError

FORMAT = "two_headed_giant"
# The decks' format: what a deck must be built for, and whose legality and versions apply.
DECK_FORMAT = "legacy"
SEATS = 4
# The engine's Legacy fixture decks (engine/decks), each with every card but its basic lands.
# test_two_headed_giant.py checks these against the deck files.
FIXTURES: dict[str, frozenset[str]] = {
    "legacy-mono-red-burn": frozenset(
        {
            "Goblin Guide",
            "Monastery Swiftspear",
            "Jackal Pup",
            "Goblin Piker",
            "Lightning Bolt",
            "Chain Lightning",
            "Lava Spike",
            "Searing Spear",
            "Incinerate",
            "Shock",
        }
    ),
    "legacy-mono-green-creatures": frozenset(
        {
            "Llanowar Elves",
            "Elvish Mystic",
            "Grizzly Bears",
            "Kalonian Tusker",
            "Garruk's Companion",
            "Centaur Courser",
            "Leatherback Baloth",
            "Craw Wurm",
            "Giant Growth",
            "Titanic Growth",
        }
    ),
    "legacy-mono-white-weenie": frozenset(
        {
            "Eager Cadet",
            "Squire",
            "Sanctuary Cat",
            "Healer's Hawk",
            "Veteran Cavalier",
            "Knight of Meadowgrain",
            "White Knight",
            "Ajani's Pridemate",
            "Glorious Charge",
            "Moment of Heroism",
        }
    ),
    "legacy-mono-blue-skies": frozenset(
        {
            "Coral Merfolk",
            "Cloud Sprite",
            "Vaporkin",
            "Welkin Tern",
            "Phantom Warrior",
            "Mist Raven",
            "Air Servant",
            "Vapor Snag",
            "Remove Soul",
            "Think Twice",
        }
    ),
}
# Cards with the basic supertype, which every deck on a team may hold (MTR 8.4).
BASICS = frozenset(
    {"Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes"}
    | {f"Snow-Covered {name}" for name in ("Plains", "Island", "Swamp", "Mountain", "Forest")}
    | {"Snow-Covered Wastes"}
)
# MTR 9.5: banned in Two-Headed Giant Constructed, besides the format's own banned cards.
BANNED = frozenset({"Erayo, Soratami Ascendant"})
TEAMS = ((0, 1), (2, 3))
# The bot decks' pairs (v0.5.1): red and white against green and blue, the most even of the three
# pairings in bot-versus-bot games (docs/engine/two-headed-giant.md#fixture-decks). A team whose two
# decks are both left to the table plays a pair, its own first (the first team's is red and white).
PAIRS = (
    ("legacy-mono-red-burn", "legacy-mono-white-weenie"),
    ("legacy-mono-green-creatures", "legacy-mono-blue-skies"),
)


def teammate(seat: int) -> int:
    return seat ^ 1


def cards_of(seat: dict[str, object]) -> set[str] | None:
    """The engine seat's card names other than basic lands, or None for a bot whose deck the
    engine would choose."""
    deck = seat.get("deck")
    if isinstance(deck, str):
        return set(FIXTURES[deck])
    deck_list = seat.get("deck_list")
    if isinstance(deck_list, dict):
        entries = cast(list[dict[str, object]], deck_list.get("cards", []))
        return {str(entry["name"]) for entry in entries} - BASICS
    return None


def folded(names: Iterable[str]) -> dict[str, str]:
    return {name.casefold(): name for name in names}


def shared(first: set[str], second: set[str]) -> list[str]:
    """The cards in both decks, by name without regard to case, in name order."""
    theirs = folded(second)
    return sorted(name for key, name in folded(first).items() if key in theirs)


def listed(names: list[str]) -> str:
    shown = names[:5] + ([f"{len(names) - 5} more"] if len(names) > 5 else [])
    return shown[0] if len(shown) == 1 else ", ".join(shown[:-1]) + " and " + shown[-1]


def fits_a_fixture(names: set[str]) -> bool:
    """Whether a bot can be this deck's teammate: some fixture deck shares no card with it."""
    return any(not shared(set(fixture), names) for fixture in FIXTURES.values())


def without_fixture(seats: list[dict[str, object]]) -> list[int]:
    """The seats whose deck shares a card with every fixture deck while their teammate is a bot
    with no deck (v0.5.1): no fixture deck can be that bot's, which is the only way the decks
    cannot be dealt (``dealt``)."""
    return [
        index
        for index, seat in enumerate(seats)
        if (names := cards_of(seat)) is not None
        and cards_of(seats[teammate(index)]) is None
        and not fits_a_fixture(names)
    ]


def dealt(cards: list[set[str] | None], used: set[object], apart: bool) -> dict[int, str] | None:
    """A fixture deck for each seat without one, sharing no card with its teammate's deck, or
    None when there is no way (v0.5.1). It searches depth first, seats and fixtures in order, so
    it deals as taking the first deck that fits would, unless that leaves a later bot no deck:
    first-fit could refuse a start that another dealing allowed (at most four decks for three
    bots, so trying them all is cheap). With ``apart`` no deck is dealt twice; without it only a
    team's two decks differ, which sharing no card already means."""
    index = next((seat for seat, names in enumerate(cards) if names is None), None)
    if index is None:
        return {}
    mate = cards[teammate(index)]
    for deck, names in FIXTURES.items():
        if (apart and deck in used) or (mate and shared(set(names), mate)):
            continue
        rest = dealt(
            [set(names) if seat == index else other for seat, other in enumerate(cards)],
            used | {deck},
            apart,
        )
        if rest is not None:
            return {index: deck, **rest}
    return None


def paired(cards: list[set[str] | None], used: set[object]) -> dict[int, str] | None:
    """A dealing in which each team of two bots without decks plays one of PAIRS, its own first,
    and every other bot a deck (``dealt``); None when there is no such team or no such dealing,
    so a pair never refuses a start that another dealing allowed."""
    teams = [team for team, seats in enumerate(TEAMS) if all(cards[seat] is None for seat in seats)]

    def choose(
        left: list[int], cards: list[set[str] | None], used: set[object]
    ) -> dict[int, str] | None:
        if not left:
            return dealt(cards, used, apart=True)
        first, second = TEAMS[left[0]]
        for pair in PAIRS[left[0] :] + PAIRS[: left[0]]:
            if used & set(pair):
                continue
            given = list(cards)
            given[first], given[second] = set(FIXTURES[pair[0]]), set(FIXTURES[pair[1]])
            rest = choose(left[1:], given, used | set(pair))
            if rest is not None:
                return {first: pair[0], second: pair[1], **rest}
        return None

    return choose(teams, cards, used) if teams else None


def assign_and_check(seats: list[dict[str, object]], banned_allowed: bool) -> None:
    """Gives each bot without a deck a fixture deck its teammate's shares no card with (a team of
    two such bots a pair, PAIRS, when that leaves every other bot a deck), then refuses a team
    whose decks share a card, or a deck holding a card banned in Two-Headed Giant when the table
    refuses banned cards. Changes ``seats`` in place, and only when it deals."""
    cards = [cards_of(seat) for seat in seats]
    used = {seat.get("deck") for seat in seats}
    decks = paired(cards, used)
    if decks is None:
        decks = dealt(cards, used, apart=True)
    if decks is None:
        # Two players whose decks leave their bots only the same fixture deck (v0.5.1): both
        # teams' bots play it, as the rules allow, since only a team's own decks may share no card.
        decks = dealt(cards, used, apart=False)
    if decks is None:
        raise ApiError(
            422,
            "team_decks",
            "Every fixture deck shares a card with your teammate's deck: choose a deck for "
            "the bot.",
        )
    for index, deck in decks.items():
        seats[index]["deck"] = deck
        cards[index] = set(FIXTURES[deck])
    for first, second in TEAMS:
        both = shared(cards[first] or set(), cards[second] or set())
        if both:
            whose = "Your deck and your teammate's" if first == 0 else "The opponents' decks"
            raise ApiError(
                422,
                "team_decks",
                f"{whose} share {listed(both)}. In Two-Headed Giant teammates' decks may share "
                "only basic lands.",
            )
    if not banned_allowed:
        held = sorted({name for names in cards if names for name in names if name in BANNED})
        if held:
            raise ApiError(
                422,
                "deck_not_allowed",
                f"This table does not allow banned cards: {listed(held)} "
                f"{'is' if len(held) == 1 else 'are'} banned in Two-Headed Giant. Choose another "
                "deck, or take it out of this one.",
            )
