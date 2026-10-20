"""Card text as the catalog compares and searches it.

One normalization serves card names, deck-list lines, aliases and search: accents and ligatures
become plain letters, curly quotes become straight, case and repeated spaces are dropped. So
"Lim-Dûl's Vault", "lim-dul’s vault" and "LIM-DUL'S  VAULT" are one name, and a deck list cannot
count one card as two by spelling it differently (CAT02).
"""

import re
import unicodedata

COLORS = ("W", "U", "B", "R", "G")
COLOR_BITS = {color: 1 << index for index, color in enumerate(COLORS)}
ALL_COLORS = (1 << len(COLORS)) - 1

LIGATURES = str.maketrans({"æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe", "ß": "ss"})
QUOTES = str.maketrans({"’": "'", "‘": "'", "“": '"', "”": '"', "−": "-", "—": "-", "–": "-"})
SPACES = re.compile(r"\s+")
FACE_SEPARATOR = " // "
SUPERTYPES = frozenset({"basic", "legendary", "ongoing", "snow", "world", "elite", "host"})


def normalize(value: str) -> str:
    """Lower-case, accent-free, with straight quotes and single spaces."""
    text = value.translate(LIGATURES).translate(QUOTES)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(char for char in text if not unicodedata.combining(char))
    return SPACES.sub(" ", text).strip().casefold()


def mask(colors: list[str] | None) -> int:
    """W, U, B, R and G as bits; anything else (colorless markers) has none."""
    return sum(COLOR_BITS.get(color, 0) for color in set(colors or []))


def colors_of(bits: int) -> list[str]:
    return [color for color in COLORS if bits & COLOR_BITS[color]]


def type_parts(type_line: str) -> tuple[list[str], list[str], list[str]]:
    """Supertypes, card types and subtypes of every face, in order and without repeats.
    "Legendary Creature — Elf Druid // Sorcery" gives (["Legendary"], ["Creature", "Sorcery"],
    ["Elf", "Druid"])."""
    supertypes: list[str] = []
    types: list[str] = []
    subtypes: list[str] = []
    for face in type_line.split(FACE_SEPARATOR):
        left, _, right = face.translate(QUOTES).partition(" - ")
        for word in left.split():
            target = supertypes if word.casefold() in SUPERTYPES else types
            if word not in target:
                target.append(word)
        for word in right.split():
            if word not in subtypes:
                subtypes.append(word)
    return supertypes, types, subtypes


def front(type_line: str) -> str:
    """The front face's part of a type line."""
    return type_line.split(FACE_SEPARATOR, 1)[0]
