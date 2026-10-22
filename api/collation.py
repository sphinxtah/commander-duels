"""Booster collations and drawing a pack from one (v0.4.0, PROG02).

A collation is what MTGJSON's booster data says of one product (MIT licence): a list of booster
layouts, each with a weight and how many cards it takes from each sheet, and the sheets, each a
weighted list of cards with its foil flag and rules. The job in catalog/boosters.py stores one per
product, every card resolved to a catalog printing. Drawing a pack:
- picks a layout by weight, then fills each of its slots from its sheet by weight;
- **fixed** sheets give their cards as listed, each as many times as its weight (a Jumpstart
  theme, a pair of cards always packed together);
- **color-balanced** sheets (MTGJSON's balanceColors) taking five or more cards give one card of
  each color first, then the rest from the whole sheet;
- **duplicates**: a pack never holds the same printing twice in the same finish, unless the sheet
  allows duplicates (or nothing else is left on it);
- a card's **finish** is the sheet's: foil sheets give foils (etched foils where the sheet or the
  printing says so);
- a card the game **cannot play** (v0.4.5) gives way to another from the same sheet, drawn by
  weight from the sheet's cards the game can play, so the pack keeps its size and each slot its
  rarity; the card drawn first is recorded beside the one given. A sheet holding no card the game
  can play (a token or art card slot) gives nothing.
The randomness is the caller's: the shop draws with the operating system's secure generator, tests
with a seeded one. Nothing the client sends reaches it.
"""

import hashlib
import json
import random
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass
from threading import Lock
from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from api.models import BoosterCollation

COLORS = "WUBRG"
FINISHES = ("nonfoil", "foil", "etched")
BALANCED_FROM = 5


@dataclass(frozen=True)
class SheetCard:
    printing_id: UUID
    weight: int
    colors: str
    finish: str


@dataclass(frozen=True)
class Sheet:
    foil: bool
    fixed: bool
    balance_colors: bool
    allow_duplicates: bool
    cards: tuple[SheetCard, ...]


@dataclass(frozen=True)
class Layout:
    contents: tuple[tuple[str, int], ...]
    weight: int

    @property
    def size(self) -> int:
        return sum(count for _, count in self.contents)


@dataclass(frozen=True)
class Collation:
    layouts: tuple[Layout, ...]
    sheets: dict[str, Sheet]

    def to_json(self) -> tuple[list[dict[str, object]], dict[str, object]]:
        """The layouts and sheets as stored: compact lists, in a stable order."""
        layouts: list[dict[str, object]] = [
            {"contents": dict(layout.contents), "weight": layout.weight} for layout in self.layouts
        ]
        sheets: dict[str, object] = {
            name: {
                "foil": sheet.foil,
                "fixed": sheet.fixed,
                "balance_colors": sheet.balance_colors,
                "allow_duplicates": sheet.allow_duplicates,
                "cards": [
                    [str(card.printing_id), card.weight, card.colors, card.finish]
                    for card in sheet.cards
                ],
            }
            for name, sheet in sorted(self.sheets.items())
        }
        return layouts, sheets

    def digest(self) -> str:
        layouts, sheets = self.to_json()
        text = json.dumps({"layouts": layouts, "sheets": sheets}, sort_keys=True)
        return hashlib.sha256(text.encode()).hexdigest()

    def printings(self) -> set[UUID]:
        return {card.printing_id for sheet in self.sheets.values() for card in sheet.cards}

    def pack_size(self) -> int:
        """The cards in the most likely layout (ties go to the larger pack)."""
        best = max(self.layouts, key=lambda layout: (layout.weight, layout.size))
        return best.size


def from_json(layouts: Sequence[Any], sheets: dict[str, Any]) -> Collation:
    """A stored collation, checked as it is read: every layout's sheet exists and has cards."""
    parsed = {
        str(name): Sheet(
            foil=bool(sheet["foil"]),
            fixed=bool(sheet.get("fixed", False)),
            balance_colors=bool(sheet.get("balance_colors", False)),
            allow_duplicates=bool(sheet.get("allow_duplicates", False)),
            cards=tuple(
                SheetCard(UUID(str(card[0])), int(card[1]), str(card[2]), str(card[3]))
                for card in sheet["cards"]
            ),
        )
        for name, sheet in sheets.items()
    }
    found = tuple(
        Layout(
            contents=tuple((str(name), int(count)) for name, count in layout["contents"].items()),
            weight=int(layout["weight"]),
        )
        for layout in layouts
    )
    for layout in found:
        for name, count in layout.contents:
            if name not in parsed or not parsed[name].cards or count < 0:
                raise ValueError(f"layout names an empty or unknown sheet {name!r}")
        if layout.weight <= 0:
            raise ValueError("a layout's weight must be positive")
    if not found:
        raise ValueError("a collation needs a layout")
    return Collation(found, parsed)


_parsed: OrderedDict[UUID, Collation] = OrderedDict()
_parsed_lock = Lock()
PARSED_KEPT = 64


def load(db: Session, collation_id: UUID) -> Collation:
    """A stored revision. Revisions never change, so each is read and parsed once per process."""
    with _parsed_lock:
        found = _parsed.get(collation_id)
        if found is not None:
            _parsed.move_to_end(collation_id)
            return found
    row = db.get(BoosterCollation, collation_id)
    if row is None:
        raise LookupError(f"no collation {collation_id}")
    collation = from_json(row.layouts, row.sheets)
    with _parsed_lock:
        _parsed[collation_id] = collation
        while len(_parsed) > PARSED_KEPT:
            _parsed.popitem(last=False)
    return collation


@dataclass(frozen=True)
class Pulled:
    printing_id: UUID
    finish: str
    sheet: str
    # The printing drawn first, which the game cannot play.
    replaced: UUID | None = None


def weighted(rng: random.Random, cards: Sequence[SheetCard]) -> SheetCard:
    point = rng.randrange(sum(card.weight for card in cards))
    for card in cards:
        point -= card.weight
        if point < 0:
            return card
    raise AssertionError("weights are positive")


def choose_layout(rng: random.Random, layouts: Sequence[Layout]) -> int:
    point = rng.randrange(sum(layout.weight for layout in layouts))
    for index, layout in enumerate(layouts):
        point -= layout.weight
        if point < 0:
            return index
    raise AssertionError("weights are positive")


def key(card: SheetCard) -> tuple[UUID, str]:
    return card.printing_id, card.finish


def pick(
    rng: random.Random, sheet: Sheet, taken: set[tuple[UUID, str]], pool: Sequence[SheetCard]
) -> SheetCard:
    """One card from the pool, by weight: one the pack does not hold yet when there is one."""
    if not sheet.allow_duplicates:
        fresh = [card for card in pool if key(card) not in taken]
        if fresh:
            pool = fresh
    return weighted(rng, pool)


def draw_sheet(
    rng: random.Random, sheet: Sheet, count: int, taken: set[tuple[UUID, str]]
) -> list[SheetCard]:
    if count <= 0:
        return []
    if sheet.fixed:
        listed = [card for card in sheet.cards for _ in range(card.weight)]
        given = [listed[index % len(listed)] for index in range(count)]
        taken.update(key(card) for card in given)
        return given
    picked: list[SheetCard] = []
    if sheet.balance_colors and count >= BALANCED_FROM:
        for color in COLORS:
            if len(picked) == count:
                break
            mono = [card for card in sheet.cards if card.colors == color]
            if mono:
                card = pick(rng, sheet, taken, mono)
                picked.append(card)
                taken.add(key(card))
    while len(picked) < count:
        card = pick(rng, sheet, taken, sheet.cards)
        picked.append(card)
        taken.add(key(card))
    if sheet.balance_colors:
        rng.shuffle(picked)
    return picked


def draw(
    collation: Collation, rng: random.Random, removed: frozenset[UUID] = frozenset()
) -> tuple[int, list[Pulled]]:
    """A pack: the layout drawn, and its cards, slot by slot in the layout's order. Fixed sheets
    are drawn first, so the random slots avoid duplicating them. removed: printings of cards the
    game cannot play, each replaced from its own sheet."""
    index = choose_layout(rng, collation.layouts)
    layout = collation.layouts[index]
    taken: set[tuple[UUID, str]] = set()
    drawn: dict[str, list[SheetCard]] = {}
    order = sorted(layout.contents, key=lambda slot: not collation.sheets[slot[0]].fixed)
    for name, count in order:
        drawn[name] = draw_sheet(rng, collation.sheets[name], count, taken)
    pulled: list[Pulled] = []
    for name, _ in layout.contents:
        sheet = collation.sheets[name]
        for card in drawn[name]:
            if card.printing_id not in removed:
                pulled.append(Pulled(card.printing_id, card.finish, name))
                continue
            others = [other for other in sheet.cards if other.printing_id not in removed]
            if not others:
                continue
            given = pick(rng, sheet, taken, others)
            taken.add(key(given))
            pulled.append(Pulled(given.printing_id, given.finish, name, card.printing_id))
    return index, pulled
