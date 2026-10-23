"""Two-Headed Giant's teams (v0.5.0, early): seats 0 and 1 play seats 2 and 3, with Legacy decks.

The player sits in seat 0 with a bot teammate in seat 1, against two bots. Each deck must be
Legacy-legal on its own, as the table's rules allow (api/games.py), and a team's two decks follow
the Magic Tournament Rules for Two-Headed Giant Constructed (effective 2026-02-27): section 9.5
uses Unified Deck Construction (section 8.4), so no two decks on a team may hold the same card,
by its English name, except cards with the basic supertype. Section 9.5 also bans Erayo, Soratami
Ascendant in every Two-Headed Giant Constructed tournament, which a table refusing banned cards
refuses. A bot whose deck is not chosen plays one of the engine's four Legacy fixture decks, which
share no card: the teammate's shares none with the player's deck either, and two bots on a team
play one of the measured pairs (v0.5.1).
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


def assign_and_check(seats: list[dict[str, object]], banned_allowed: bool) -> None:
    """Gives each bot without a deck a fixture deck its teammate's shares no card with (a team of
    two such bots a pair, PAIRS), then refuses a team whose decks share a card, or a deck holding a
    card banned in Two-Headed Giant when the table refuses banned cards. Changes ``seats`` in
    place."""
    cards = [cards_of(seat) for seat in seats]
    used = {seat.get("deck") for seat in seats}
    for team, (first, second) in enumerate(TEAMS):
        if cards[first] is not None or cards[second] is not None:
            continue
        for pair in PAIRS[team:] + PAIRS[:team]:
            if not used & set(pair):
                for index, deck in zip((first, second), pair, strict=True):
                    seats[index]["deck"] = deck
                    cards[index] = set(FIXTURES[deck])
                used.update(pair)
                break
    for index, seat in enumerate(seats):
        if cards[index] is not None:
            continue
        mate = cards[teammate(index)]
        for deck, names in FIXTURES.items():
            if deck not in used and not (mate and shared(set(names), mate)):
                seat["deck"] = deck
                cards[index] = set(names)
                used.add(deck)
                break
        else:
            raise ApiError(
                422,
                "team_decks",
                "Every fixture deck shares a card with your teammate's deck: choose a deck for "
                "the bot.",
            )
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
