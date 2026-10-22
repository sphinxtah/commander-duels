"""Deck lists as text, for SysOp's test decks from any card in the game (cards.any).

One card per line: an optional count ("4", "4x"), then the card's name. Blank lines and lines
starting with "#" or "//" are ignored, as are set annotations that deck sites export after a name
("Lightning Bolt (M10) 146"). A "Commander" heading, or a "Commander: Name" line, names the
commander; a "Sideboard" or "Maybeboard" heading skips what follows until the next heading. Names
are matched by the engine, which knows every card it implements; no format rules are checked.

Until v0.4.5 a list could name any card the engine implements. Since then only cards a game can
play are in the game, for SysOp too: a list naming another card is refused (cards_not_playable),
and the engine's name search offers only cards in the game.
"""

import re
from collections.abc import Iterable, Mapping

from sqlalchemy import select
from sqlalchemy.orm import Session

from api.identity import ApiError
from api.models import CardAlias, CardConcept, CustomCard
from catalog.statuses import playable
from catalog.text import normalize

MAX_ENTRIES = 250
MAX_COUNT = 250
MAX_CARDS = 1000
MAX_NAME = 200
MAX_COMMANDERS = 2

LINE = re.compile(r"^(?:(?P<count>\d{1,4})\s*[xX]?\s+)?(?P<name>.+)$")
SET_ANNOTATION = re.compile(r"\s+\([A-Za-z0-9]{2,8}\)(?:\s+[A-Za-z0-9-]+)?(?:\s+\*[A-Z]\*)?$")
MAIN_HEADINGS = {"deck", "main", "maindeck", "main deck", "library", "mainboard"}
SKIPPED_HEADINGS = {"sideboard", "maybeboard", "considering", "tokens"}
COMMANDER_HEADINGS = {"commander", "commanders"}


def invalid(line: int, message: str) -> ApiError:
    return ApiError(422, "invalid_deck_list", f"Line {line}: {message}")


def parse_deck_list(text: str, game_format: str) -> dict[str, object]:
    """The engine's deck_list object: {"cards": [{"name", "count"}], "commanders": [...]}."""
    counts: dict[str, int] = {}
    spelled: dict[str, str] = {}
    commanders: list[str] = []
    section = "main"
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith(("#", "//")):
            continue
        heading = line.rstrip(":").strip().casefold()
        if heading in MAIN_HEADINGS:
            section = "main"
            continue
        if heading in SKIPPED_HEADINGS:
            section = "skip"
            continue
        if heading in COMMANDER_HEADINGS:
            section = "commander"
            continue
        if line.casefold().startswith("commander:"):
            line, target = line.split(":", 1)[1].strip(), "commander"
        else:
            target = section
        if target == "skip":
            continue
        match = LINE.match(line)
        if match is None:
            raise invalid(number, "expected a count and a card name.")
        name = SET_ANNOTATION.sub("", match["name"]).strip()
        count = int(match["count"]) if match["count"] else 1
        if not name or len(name) > MAX_NAME:
            raise invalid(number, f"a card name has 1 to {MAX_NAME} characters.")
        if target == "commander":
            if count != 1:
                raise invalid(number, "a commander is a single card.")
            commanders.append(name)
            continue
        if not 1 <= count <= MAX_COUNT:
            raise invalid(number, f"a count is from 1 to {MAX_COUNT}.")
        key = name.casefold()
        spelled.setdefault(key, name)
        counts[key] = counts.get(key, 0) + count
        if counts[key] > MAX_COUNT:
            raise invalid(number, f"at most {MAX_COUNT} copies of one card.")
    if not counts:
        raise ApiError(422, "invalid_deck_list", "The deck list names no cards.")
    if len(counts) > MAX_ENTRIES:
        raise ApiError(
            422, "invalid_deck_list", f"A deck list has at most {MAX_ENTRIES} different cards."
        )
    if sum(counts.values()) > MAX_CARDS:
        raise ApiError(422, "invalid_deck_list", f"A deck list holds at most {MAX_CARDS} cards.")
    if game_format == "commander" and not 1 <= len(commanders) <= MAX_COMMANDERS:
        raise ApiError(
            422,
            "invalid_deck_list",
            'A Commander deck list names one or two commanders, under a "Commander" heading.',
        )
    if game_format != "commander" and commanders:
        raise ApiError(422, "invalid_deck_list", "Only Commander deck lists have a commander.")
    deck: dict[str, object] = {
        "cards": [{"name": spelled[key], "count": count} for key, count in counts.items()]
    }
    if commanders:
        deck["commanders"] = commanders
    return deck


def in_game(db: Session, names: Iterable[str]) -> set[str]:
    """The names, normalized, that name a card a game can play: its own name or one of its faces
    (the engine names a double-faced card by its front). The Godlike tier's custom cards count:
    the engine checks them when the game starts (api/custom_play.py)."""
    wanted = {normalize(name) for name in names}
    if not wanted:
        return set()
    found = set(
        db.scalars(
            select(CardConcept.normalized_name).where(
                CardConcept.normalized_name.in_(wanted), playable()
            )
        )
    )
    found |= set(
        db.scalars(
            select(CardAlias.alias)
            .join(CardConcept, CardConcept.id == CardAlias.concept_id)
            .where(CardAlias.alias.in_(wanted - found), playable())
        )
    )
    custom = {normalize(name) for name in db.scalars(select(CustomCard.name))}
    return found | (wanted & custom)


def refuse_unplayable(db: Session, deck: Mapping[str, object]) -> None:
    """Refuses a parsed deck list naming a card the game cannot play, or a name no card has."""
    cards = deck.get("cards")
    written = [
        str(card["name"])
        for card in (cards if isinstance(cards, list) else [])
        if isinstance(card, dict)
    ]
    commanders = deck.get("commanders")
    written += [str(name) for name in (commanders if isinstance(commanders, list) else [])]
    found = in_game(db, written)
    names = [name for name in dict.fromkeys(written) if normalize(name) not in found]
    if names:
        one = len(names) == 1
        raise ApiError(
            422,
            "cards_not_playable",
            ", ".join(names) + (" is not a card" if one else " are not cards") + " in the game.",
            names=names,
        )
