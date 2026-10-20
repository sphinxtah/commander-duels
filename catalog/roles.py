"""Deck-building roles read from a card's types and Oracle text at import.

These are rules of construction, not of play, so the validator and search read them from columns
instead of parsing text on every request:
- Commander (rule 903.3): a legendary creature card, judged by its front face, or a card whose
  text says it can be your commander. A Background never leads alone.
- Pairs (rule 702.124 and its relatives): Partner pairs with Partner; "Partner with X" only with
  X; "Partner—group" only within its group; Choose a Background with a Background; a Doctor's
  companion with a Time Lord Doctor.
- Copy limits: basic lands and "A deck can have any number of cards named ..." have none; "A deck
  can have up to seven cards named ..." has seven.
- Companion: the Companion keyword. Activated abilities, for Zirda's condition: an ability of the
  form "cost: effect" (loyalty abilities, mana abilities, a basic land's intrinsic one), or an
  activated keyword ability such as equip or cycling.
"""

import re
from dataclasses import dataclass

from catalog.text import normalize, type_parts

ANY_NUMBER = re.compile(r"A deck can have any number of cards named", re.I)
UP_TO = re.compile(r"A deck can have up to (\w+) cards named", re.I)
NUMBER_WORDS = {
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
}
PARTNER_WITH = re.compile(r"^Partner with ([^\n(]+?)\s*(?:\(|$)", re.M)
PARTNER_GROUP = re.compile(r"^Partner[—-]([^\n(]+?)\s*(?:\(|$)", re.M)
CAN_BE_COMMANDER = re.compile(r"can be your commander", re.I)
QUOTED = re.compile(r'"[^"]*"')
REMINDER = re.compile(r"\([^()]*\)")
# "{T}: Add {G}." and the like, alone in parentheses: a basic land's intrinsic mana ability.
MANA_REMINDER = re.compile(r"^\((\{T\}: Add [^()]*)\)$", re.M)
ACTIVATED_KEYWORDS = frozenset(
    {
        "equip",
        "cycling",
        "crew",
        "ninjutsu",
        "reconfigure",
        "outlast",
        "unearth",
        "scavenge",
        "embalm",
        "eternalize",
        "transmute",
        "transfigure",
        "bloodrush",
        "fortify",
        "level up",
        "station",
        "craft",
        "encore",
        "saddle",
        "forecast",
        "reinforce",
        "auto",
    }
)


@dataclass(frozen=True)
class Roles:
    commander: bool
    partner: str | None
    companion: bool
    copy_limit: int | None
    activated: bool


def activated(text: str, keywords: list[str]) -> bool:
    if any(
        keyword.casefold() in ACTIVATED_KEYWORDS or keyword.casefold().endswith("cycling")
        for keyword in keywords
    ):
        return True
    body = MANA_REMINDER.sub(r"\1", text.strip())
    body = REMINDER.sub(" ", QUOTED.sub(" ", body))
    return any(":" in line for line in body.splitlines())


def roles(
    type_line: str,
    oracle_text: str,
    keywords: list[str],
    front_type_line: str | None = None,
) -> Roles:
    supertypes, types, _ = type_parts(front_type_line or type_line)
    _, _, subtypes = type_parts(type_line)
    commander = ("Legendary" in supertypes and "Creature" in types) or bool(
        CAN_BE_COMMANDER.search(oracle_text)
    )
    words = {keyword.casefold() for keyword in keywords}
    partner: str | None = None
    if found := PARTNER_WITH.search(oracle_text):
        partner = "partner_with:" + normalize(found.group(1))
    elif found := PARTNER_GROUP.search(oracle_text):
        partner = "partner_group:" + normalize(found.group(1))
    elif "partner" in words:
        partner = "partner"
    elif "choose a background" in words or "Choose a Background" in oracle_text:
        partner = "choose_background"
    elif "Background" in subtypes:
        partner = "background"
    elif "doctor's companion" in words:
        partner = "doctors_companion"
    elif "Time Lord" in " ".join(subtypes) or ("Time" in subtypes and "Doctor" in subtypes):
        partner = "time_lord_doctor"
    copy_limit: int | None = None
    if "Basic" in supertypes or ANY_NUMBER.search(oracle_text):
        copy_limit = 0
    elif found := UP_TO.search(oracle_text):
        copy_limit = NUMBER_WORDS.get(found.group(1).casefold())
    return Roles(
        commander=commander and partner != "background",
        partner=partner[:160] if partner else None,
        companion="companion" in words,
        copy_limit=copy_limit,
        activated=activated(oracle_text, keywords),
    )
