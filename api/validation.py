"""Deck validation for Legacy and Commander: authoritative, structured, explained (DECK07, DECK08).

The browser validates as you edit, but only this decides: on save, before a revision is made,
and when a game starts. Every problem carries a rule code, what it concerns (cards, quantity,
location), an explanation and a remedy, and its kind:
- format_illegal: the format's rules forbid it (deck size, copies, bans, identity, pairs);
- not_released: the card is not out yet;
- not_implemented: the game engine cannot play the card (its catalog status says why);
- collection_locked: the deck holds more copies of a card than the player owns (v0.3.1: players
  build from their own library; administrators and SysOp from the whole catalog);
- structure: the deck itself is malformed (a printing of another card, a sideboard in Commander).

Copies are counted by construction key, the card's English name, so another printing or another
Oracle version of a card is still that card (T03). Legality comes from the format version: its
banned list and Scryfall's legality of each card (CAT05). Application limits that are not Magic
rules (at most 250 cards in a main deck) say so.

Since v0.4.0 a deck may also hold the Godlike tier's custom cards (api/custom_cards.py), from a
table of their own, while its owner is at the Godlike tier. Each counts as legal in Legacy and
Commander; it may lead a Commander deck by the same rule as a catalog card; its color identity
comes from the mana symbols of its cost and rules text; it is playable only when the running
engine has loaded it. Below Godlike a deck holding one is collection-locked, and nothing about the
card is named.
"""

import re
from collections import defaultdict
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.models import CardConcept, CardPrinting, CustomCard, FormatVersion
from api.schemas import Contract
from catalog.formats import RULES, TECHNICAL_MAX_MAIN
from catalog.roles import roles
from catalog.text import ALL_COLORS, COLOR_BITS, colors_of, front, normalize, type_parts

GameFormatName = Literal["legacy", "commander"]
Location = Literal["main", "sideboard", "commander", "companion", "maybeboard"]
Kind = Literal[
    "format_illegal", "not_released", "not_implemented", "collection_locked", "structure"
]
# Problems that keep a legal deck from starting a game.
BLOCKING = frozenset({"not_implemented", "collection_locked"})
MAX_ENTRIES = 400
MAX_QUANTITY = 250
PERMANENTS = frozenset({"Artifact", "Creature", "Enchantment", "Land", "Planeswalker", "Battle"})
SYMBOL = re.compile(r"\{[^}]+\}")
KAHEERA_TYPES = frozenset({"Cat", "Elemental", "Nightmare", "Dinosaur", "Beast"})
# Reminder text, which a card's color identity ignores (rule 903.4).
REMINDER = re.compile(r"\([^()]*\)")
# A custom card's construction key: its ID, so it never meets a catalog card's name.
CUSTOM_KEY = "custom:"
CUSTOM_LEGAL = {"legacy": "legal", "commander": "legal"}


class DeckEntry(Contract):
    card_id: UUID
    printing_id: UUID | None = None
    quantity: int = Field(ge=1, le=MAX_QUANTITY)
    location: Location = "main"


class DeckContent(Contract):
    format: GameFormatName
    entries: list[DeckEntry] = Field(default_factory=list, max_length=MAX_ENTRIES)


class Problem(Contract):
    code: str
    kind: Kind
    message: str
    remedy: str
    card_ids: list[UUID] = Field(default_factory=list)
    location: Location | None = None
    quantity: int | None = None


class DeckCounts(Contract):
    main: int = 0
    sideboard: int = 0
    commander: int = 0
    companion: int = 0
    maybeboard: int = 0


class Validation(Contract):
    format: GameFormatName
    format_version: int | None
    legal: bool
    # Legal, and every card in it can be played by the engine: the deck may start a game.
    playable: bool
    errors: list[Problem]
    warnings: list[Problem]
    counts: DeckCounts


@dataclass(frozen=True)
class Card:
    """What validation reads of a card."""

    id: UUID
    name: str
    construction_key: str
    type_line: str
    mana_cost: str | None
    mana_value: float
    identity_mask: int
    legalities: dict[str, str]
    status: str
    status_detail: str | None
    deck_card: bool
    removed: bool
    released: date | None
    commander: bool
    partner: str | None
    companion: bool
    copy_limit: int | None
    activated: bool
    keywords: tuple[str, ...]
    printings: frozenset[UUID] = frozenset()

    @property
    def front_types(self) -> tuple[list[str], list[str], list[str]]:
        return type_parts(front(self.type_line))

    @property
    def land(self) -> bool:
        return "Land" in self.front_types[1]

    @property
    def permanent(self) -> bool:
        return bool(PERMANENTS & set(self.front_types[1]))


@dataclass(frozen=True)
class Collection:
    """What a deck's owner may build with.

    - copies: the copies of each card they own, by construction key, so another printing or
      Oracle version of a card counts as that card; basic lands are never limited. None for
      administrators and SysOp, who build from the whole catalog.
    - godlike: the owner is at the Godlike tier, which opens the custom cards to them (v0.4.0).
    - loaded: by custom card name, case aside, whether the running engine has loaded it; None
      when the engine was not asked."""

    copies: Mapping[str, int] | None
    godlike: bool = False
    loaded: Mapping[str, bool] | None = None


@dataclass(frozen=True)
class Rules:
    format: str
    version: int | None
    rules: dict[str, object]
    banned: frozenset[str]


@dataclass
class Report:
    errors: list[Problem] = field(default_factory=list)
    warnings: list[Problem] = field(default_factory=list)

    def error(
        self,
        code: str,
        message: str,
        remedy: str,
        *,
        kind: Kind = "format_illegal",
        card_ids: list[UUID] | None = None,
        location: Location | None = None,
        quantity: int | None = None,
    ) -> None:
        self.errors.append(
            Problem(
                code=code,
                kind=kind,
                message=message,
                remedy=remedy,
                card_ids=card_ids or [],
                location=location,
                quantity=quantity,
            )
        )

    def warning(
        self,
        code: str,
        message: str,
        remedy: str,
        *,
        card_ids: list[UUID] | None = None,
        location: Location | None = None,
    ) -> None:
        self.warnings.append(
            Problem(
                code=code,
                kind="format_illegal",
                message=message,
                remedy=remedy,
                card_ids=card_ids or [],
                location=location,
            )
        )


def number(rules: "Rules", key: str, default: int) -> int:
    value = rules.rules.get(key, default)
    return value if isinstance(value, int) else default


def cards_of(session: Session, ids: set[UUID]) -> dict[UUID, Card]:
    rows = session.scalars(select(CardConcept).where(CardConcept.id.in_(ids))).all()
    printings: dict[UUID, set[UUID]] = defaultdict(set)
    for concept_id, printing_id in session.execute(
        select(CardPrinting.concept_id, CardPrinting.id).where(CardPrinting.concept_id.in_(ids))
    ):
        printings[concept_id].add(printing_id)
    return {
        row.id: Card(
            id=row.id,
            name=row.name,
            construction_key=row.construction_key,
            type_line=row.type_line,
            mana_cost=row.mana_cost,
            mana_value=row.mana_value,
            identity_mask=row.identity_mask,
            legalities=dict(row.legalities or {}),
            status=row.status,
            status_detail=row.status_detail,
            deck_card=row.deck_card,
            removed=row.removed_revision is not None,
            released=row.first_released_at,
            commander=row.commander,
            partner=row.partner,
            companion=row.companion,
            copy_limit=row.copy_limit,
            activated=row.activated,
            keywords=tuple(row.keywords or ()),
            printings=frozenset(printings[row.id]),
        )
        for row in rows
    }


def custom_key(card_id: UUID) -> str:
    return f"{CUSTOM_KEY}{card_id}"


def symbol_value(symbol: str) -> float:
    """A mana symbol's share of a mana value: {3} is 3, {X} 0, {2/W} 2, any other 1."""
    inner = symbol.strip("{}").upper()
    if inner in ("X", "Y", "Z"):
        return 0.0
    first = inner.split("/", 1)[0]
    return float(first) if first.isdigit() else 1.0


def mana_value_of(cost: str | None) -> float:
    return sum(symbol_value(symbol) for symbol in SYMBOL.findall(cost or ""))


def symbol_colors(text: str) -> int:
    """The colors of the mana symbols in a text, as bits: {W/U} is both, {G/P} green."""
    bits = 0
    for symbol in SYMBOL.findall(text):
        for part in symbol.strip("{}").upper().split("/"):
            bits |= COLOR_BITS.get(part, 0)
    return bits


def custom_identity(mana_cost: str | None, oracle_text: str) -> int:
    """A custom card's color identity: the mana symbols of its cost and of its rules text,
    reminder text aside (rule 903.4)."""
    return symbol_colors(mana_cost or "") | symbol_colors(REMINDER.sub(" ", oracle_text))


def custom_rules(row: CustomCard, loaded: bool | None) -> Card:
    """A custom card as validation reads it: legal in both formats, a commander by the catalog's
    rule, and not playable when the running engine has not loaded it (None: not known)."""
    found = roles(row.type_line, row.oracle_text, [])
    return Card(
        id=row.id,
        name=row.name,
        construction_key=custom_key(row.id),
        type_line=row.type_line,
        mana_cost=row.mana_cost,
        mana_value=mana_value_of(row.mana_cost),
        identity_mask=custom_identity(row.mana_cost, row.oracle_text),
        legalities=dict(CUSTOM_LEGAL),
        status="not_loaded" if loaded is False else "certified",
        status_detail="it is not loaded by this engine." if loaded is False else None,
        deck_card=True,
        removed=False,
        released=None,
        commander=found.commander,
        partner=found.partner,
        companion=found.companion,
        copy_limit=found.copy_limit,
        activated=found.activated,
        keywords=(),
    )


def custom_cards_of(
    session: Session, ids: set[UUID], collection: Collection | None
) -> tuple[dict[UUID, Card], frozenset[UUID]]:
    """The custom cards among ids: as validation reads them while the deck's owner is at the
    Godlike tier; below it, only their IDs, which hold the deck back without naming them."""
    if not ids:
        return {}, frozenset()
    rows = session.scalars(select(CustomCard).where(CustomCard.id.in_(ids))).all()
    if collection is None or not collection.godlike:
        return {}, frozenset(row.id for row in rows)
    loaded = collection.loaded
    return {
        row.id: custom_rules(row, None if loaded is None else loaded.get(row.name.casefold()))
        for row in rows
    }, frozenset()


def rules_of(session: Session, fmt: str) -> Rules:
    version = session.scalar(
        select(FormatVersion)
        .where(FormatVersion.format == fmt)
        .order_by(FormatVersion.version.desc())
        .limit(1)
    )
    if version is None:
        return Rules(fmt, None, RULES[fmt], frozenset())
    return Rules(fmt, version.version, dict(version.rules), frozenset(version.banned))


def validate_deck(
    session: Session, content: DeckContent, today: date, collection: Collection | None = None
) -> Validation:
    """The deck by its format's rules and, given the player's collection, the copies they own;
    without copies (administrators, SysOp, or a deck shown without its player), every catalog
    card is open. Custom cards are open only to an owner at the Godlike tier."""
    ids = {entry.card_id for entry in content.entries}
    cards = cards_of(session, ids)
    custom, hidden = custom_cards_of(session, ids - cards.keys(), collection)
    return validate(
        content, cards | custom, rules_of(session, content.format), today, collection, hidden
    )


def validate(
    content: DeckContent,
    cards: dict[UUID, Card],
    rules: Rules,
    today: date,
    collection: Collection | None = None,
    hidden: frozenset[UUID] = frozenset(),
) -> Validation:
    """hidden: custom cards the deck holds while its owner is below the Godlike tier."""
    report = Report()
    counts = DeckCounts()
    for entry in content.entries:
        setattr(counts, entry.location, getattr(counts, entry.location) + entry.quantity)
    present = [entry for entry in content.entries if entry.card_id in cards]
    held_back = list(
        dict.fromkeys(
            entry.card_id
            for entry in content.entries
            if entry.card_id in hidden and entry.location != "maybeboard"
        )
    )
    if held_back:
        many = len(held_back) > 1
        report.error(
            "custom.godlike_only",
            f"This deck holds {len(held_back)} Godlike card{'s' if many else ''}: only an "
            "account at the Godlike tier (100,000 wins) may play " + ("them." if many else "it."),
            "Remove " + ("them" if many else "it") + ", or reach the Godlike tier again.",
            kind="collection_locked",
            card_ids=held_back,
        )
    for entry in content.entries:
        if entry.card_id not in cards and entry.card_id not in hidden:
            report.error(
                "card.unknown",
                "A card in this deck is not in the catalog.",
                "Remove it, or choose the card again from the catalog.",
                kind="structure",
                card_ids=[entry.card_id],
                location=entry.location,
            )
    for entry in present:
        card = cards[entry.card_id]
        if entry.printing_id is not None and entry.printing_id not in card.printings:
            report.error(
                "printing.mismatch",
                f"The printing chosen for {card.name} is a printing of another card.",
                "Choose one of this card's own printings, or none.",
                kind="structure",
                card_ids=[card.id],
                location=entry.location,
            )
    playing = [entry for entry in present if entry.location != "maybeboard"]
    for card_id in dict.fromkeys(entry.card_id for entry in playing):
        card_problems(report, cards[card_id], rules, today)
    copies(report, playing, cards, rules)
    if collection is not None and collection.copies is not None:
        owned_copies(report, playing, cards, collection.copies)
    if rules.format == "legacy":
        legacy(report, playing, cards, rules, counts)
    else:
        # A hidden custom commander still leads: the deck is held back, not missing one.
        hidden_leaders = any(
            entry.card_id in hidden and entry.location == "commander" for entry in content.entries
        )
        commander(report, playing, cards, rules, counts, hidden_leaders)
    # Legal by the format's rules; playable also needs every card supported by the engine and
    # owned in the copies the deck holds.
    legal = all(problem.kind in BLOCKING for problem in report.errors)
    blocked = any(problem.kind in BLOCKING for problem in report.errors)
    return Validation(
        format=content.format,
        format_version=rules.version,
        legal=legal,
        playable=legal and not blocked,
        errors=report.errors,
        warnings=report.warnings,
        counts=counts,
    )


def card_problems(report: Report, card: Card, rules: Rules, today: date) -> None:
    name = rules.format.title()
    if not card.deck_card:
        report.error(
            "card.not_a_deck_card",
            f"{card.name} is not a card a deck holds.",
            "Remove it from the deck.",
            card_ids=[card.id],
        )
        return
    if card.removed:
        report.error(
            "card.removed",
            f"{card.name} is no longer in Scryfall's catalog.",
            "Replace it with the card that took its place.",
            card_ids=[card.id],
        )
    legality = card.legalities.get(rules.format, "not_legal")
    if card.construction_key in rules.banned or legality == "banned":
        report.error(
            "card.banned",
            f"{card.name} is banned in {name}.",
            "Remove it from the deck.",
            card_ids=[card.id],
        )
    elif legality == "restricted":
        report.warning(
            "card.restricted",
            f"{card.name} is restricted in {name}: one copy at most.",
            "Keep a single copy.",
            card_ids=[card.id],
        )
    elif legality != "legal":
        if card.released is not None and card.released > today:
            report.error(
                "card.not_released",
                f"{card.name} is released on {card.released.isoformat()}.",
                "Wait for its release, or remove it.",
                kind="not_released",
                card_ids=[card.id],
            )
        else:
            report.error(
                "card.not_legal",
                f"{card.name} is not legal in {name}.",
                "Remove it from the deck.",
                card_ids=[card.id],
            )
    if card.status != "certified":
        report.error(
            "card.not_implemented",
            f"{card.name} cannot be played yet: "
            + (card.status_detail or "the game engine does not support it."),
            "Take it out of the deck, or replace it.",
            kind="not_implemented",
            card_ids=[card.id],
        )


def copies(report: Report, entries: list[DeckEntry], cards: dict[UUID, Card], rules: Rules) -> None:
    """Copies per construction key, printings and Oracle versions together (T03)."""
    limit = number(rules, "copy_limit", 4)
    counted: dict[str, int] = defaultdict(int)
    holders: dict[str, list[UUID]] = defaultdict(list)
    for entry in entries:
        if rules.format == "commander" and entry.location == "companion":
            continue
        card = cards[entry.card_id]
        counted[card.construction_key] += entry.quantity
        if card.id not in holders[card.construction_key]:
            holders[card.construction_key].append(card.id)
    for key, count in counted.items():
        card = cards[holders[key][0]]
        allowed = limit if card.copy_limit is None else card.copy_limit
        if card.legalities.get(rules.format) == "restricted":
            allowed = 1
        if allowed and count > allowed:
            where = "copy" if allowed == 1 else "copies"
            report.error(
                "deck.copy_limit",
                f"{count} copies of {card.name}: {rules.format.title()} allows {allowed} {where}"
                + (", counting every printing." if len(holders[key]) > 1 else "."),
                f"Remove {count - allowed}.",
                card_ids=holders[key],
                quantity=count,
            )


def basic_land(card: Card) -> bool:
    supertypes, types, _ = type_parts(front(card.type_line))
    return "Basic" in supertypes and "Land" in types


def owned_copies(
    report: Report, entries: list[DeckEntry], cards: dict[UUID, Card], copies: Mapping[str, int]
) -> None:
    """Copies the player owns, per construction key, outside the maybeboard (DECK08). Copies are a
    limit per deck: two decks may each hold the same owned card."""
    counted: dict[str, int] = defaultdict(int)
    holders: dict[str, list[UUID]] = defaultdict(list)
    for entry in entries:
        card = cards[entry.card_id]
        if basic_land(card):
            continue
        counted[card.construction_key] += entry.quantity
        if card.id not in holders[card.construction_key]:
            holders[card.construction_key].append(card.id)
    for key, count in counted.items():
        have = copies.get(key, 0)
        if count <= have:
            continue
        card = cards[holders[key][0]]
        owned = "none" if have == 0 else f"{have} {'copy' if have == 1 else 'copies'}"
        report.error(
            "collection.locked",
            f"This deck holds {count} {'copy' if count == 1 else 'copies'} of {card.name}; your "
            f"library has {owned}.",
            f"Remove {count - have}, or wait until your library holds more: starter decks, "
            "your alliance and packs add cards to it.",
            kind="collection_locked",
            card_ids=holders[key],
            quantity=count,
        )


def legacy(
    report: Report,
    entries: list[DeckEntry],
    cards: dict[UUID, Card],
    rules: Rules,
    counts: DeckCounts,
) -> None:
    minimum = number(rules, "min_main", 60)
    maximum = number(rules, "max_main", TECHNICAL_MAX_MAIN)
    sideboard = number(rules, "max_sideboard", 15)
    if counts.main < minimum:
        report.error(
            "legacy.min_main",
            f"The main deck has {counts.main} cards; Legacy needs at least {minimum}.",
            f"Add {minimum - counts.main} more.",
            location="main",
            quantity=counts.main,
        )
    if counts.main > maximum:
        report.error(
            "deck.technical_max",
            f"The main deck has {counts.main} cards. Legacy has no maximum, but this "
            f"application plays at most {maximum}, a technical limit.",
            f"Remove {counts.main - maximum}.",
            location="main",
            quantity=counts.main,
        )
    side = counts.sideboard + counts.companion
    if side > sideboard:
        report.error(
            "legacy.sideboard",
            f"The sideboard has {side} cards"
            + (", counting the companion" if counts.companion else "")
            + f"; Legacy allows {sideboard}.",
            f"Remove {side - sideboard}.",
            location="sideboard",
            quantity=side,
        )
    for entry in entries:
        if entry.location == "commander":
            report.error(
                "legacy.commander",
                f"{cards[entry.card_id].name} is set as a commander, but Legacy has none.",
                "Move it to the main deck or the sideboard.",
                kind="structure",
                card_ids=[entry.card_id],
                location="commander",
            )
    deck = [entry for entry in entries if entry.location == "main"]
    companions(report, entries, deck, cards, rules, counts.main)


def commander(
    report: Report,
    entries: list[DeckEntry],
    cards: dict[UUID, Card],
    rules: Rules,
    counts: DeckCounts,
    hidden_leaders: bool = False,
) -> None:
    size = number(rules, "deck_size", 100)
    leaders = [cards[entry.card_id] for entry in entries if entry.location == "commander"]
    leader_count = sum(entry.quantity for entry in entries if entry.location == "commander")
    if leader_count == 0:
        if not hidden_leaders:
            report.error(
                "commander.missing",
                "A Commander deck needs a commander.",
                "Choose a legendary creature, or a card that can be your commander.",
                location="commander",
            )
    elif leader_count > 2 or len(leaders) != leader_count:
        report.error(
            "commander.count",
            f"{leader_count} commanders: a deck has one, or two that can pair.",
            "Keep one commander, or a valid pair.",
            location="commander",
            quantity=leader_count,
        )
    else:
        pairing(report, leaders)
    total = counts.main + counts.commander
    if total != size:
        report.error(
            "commander.size",
            f"The deck has {total} cards with its commander"
            + ("s" if counts.commander > 1 else "")
            + f"; Commander needs exactly {size}.",
            f"Add {size - total}." if total < size else f"Remove {total - size}.",
            location="main",
            quantity=total,
        )
    if counts.sideboard:
        report.error(
            "commander.sideboard",
            f"{counts.sideboard} cards are in a sideboard, which Commander does not have.",
            "Move them to the maybeboard, or into the deck.",
            kind="structure",
            location="sideboard",
            quantity=counts.sideboard,
        )
    identity = 0
    for leader in leaders:
        identity |= leader.identity_mask
    if leaders:
        allowed = "".join(colors_of(identity)) or "colorless"
        outside = sorted(
            {
                entry.card_id
                for entry in entries
                if entry.location in ("main", "companion")
                and cards[entry.card_id].identity_mask & (ALL_COLORS & ~identity)
            },
            key=lambda card_id: cards[card_id].name,
        )
        if outside:
            names = ", ".join(cards[card_id].name for card_id in outside[:5])
            more = f" and {len(outside) - 5} more" if len(outside) > 5 else ""
            report.error(
                "commander.identity",
                f"{names}{more} are outside the commander's color identity ({allowed}).",
                "Remove them, or choose a commander whose identity includes their colors.",
                card_ids=outside,
            )
    deck = [entry for entry in entries if entry.location in ("main", "commander")]
    companions(report, entries, deck, cards, rules, total)


def pairing(report: Report, leaders: list[Card]) -> None:
    if len(leaders) == 1:
        leader = leaders[0]
        if not leader.commander:
            reason = (
                "a Background leads only beside a commander that says Choose a Background"
                if leader.partner == "background"
                else "only a legendary creature, or a card that says it can be your "
                "commander, may lead"
            )
            report.error(
                "commander.eligible",
                f"{leader.name} cannot be your commander: {reason}.",
                "Choose another commander.",
                card_ids=[leader.id],
                location="commander",
            )
        return
    first, second = leaders
    for leader in leaders:
        if not leader.commander and leader.partner != "background":
            report.error(
                "commander.eligible",
                f"{leader.name} cannot be a commander.",
                "Choose another commander.",
                card_ids=[leader.id],
                location="commander",
            )
    if not pairs(first, second):
        report.error(
            "commander.pair",
            f"{first.name} and {second.name} cannot lead together. "
            + pair_reason(first)
            + " "
            + pair_reason(second),
            "Keep one of them, or choose a commander each can pair with.",
            card_ids=[first.id, second.id],
            location="commander",
        )


def pairs(first: Card, second: Card) -> bool:
    a, b = first.partner or "", second.partner or ""
    if a == b == "partner":
        return True
    if a.startswith("partner_with:") or b.startswith("partner_with:"):
        return a == "partner_with:" + normalize(second.name) and b == "partner_with:" + normalize(
            first.name
        )
    if a.startswith("partner_group:"):
        return a == b
    kinds = {a, b}
    return kinds in ({"choose_background", "background"}, {"doctors_companion", "time_lord_doctor"})


def pair_reason(card: Card) -> str:
    kind = card.partner or ""
    if kind == "partner":
        return f"{card.name} has partner, and pairs with another card that has partner."
    if kind.startswith("partner_with:"):
        return f"{card.name} pairs only with the card it names."
    if kind.startswith("partner_group:"):
        return f"{card.name} pairs only within “{kind.split(':', 1)[1]}”."
    if kind == "choose_background":
        return f"{card.name} pairs with a Background."
    if kind == "background":
        return f"{card.name} is a Background, for a commander that says Choose a Background."
    if kind == "doctors_companion":
        return f"{card.name} pairs with a Time Lord Doctor."
    if kind == "time_lord_doctor":
        return f"{card.name} pairs with a Doctor's companion."
    return f"{card.name} has no partner ability."


def companions(
    report: Report,
    entries: list[DeckEntry],
    deck: list[DeckEntry],
    cards: dict[UUID, Card],
    rules: Rules,
    deck_size: int,
) -> None:
    chosen = [entry for entry in entries if entry.location == "companion"]
    if sum(entry.quantity for entry in chosen) > 1:
        report.error(
            "companion.count",
            "A deck has at most one companion.",
            "Keep one.",
            location="companion",
        )
    for entry in chosen:
        card = cards[entry.card_id]
        if not card.companion:
            report.error(
                "companion.not_a_companion",
                f"{card.name} has no companion ability.",
                "Move it to the "
                + ("sideboard." if rules.format == "legacy" else "deck or the maybeboard."),
                card_ids=[card.id],
                location="companion",
            )
            continue
        if f"companion:{card.construction_key}" in rules.banned:
            report.error(
                "companion.banned",
                f"{card.name} is banned as a companion in {rules.format.title()}.",
                "Play it in the deck instead, or choose another companion.",
                card_ids=[card.id],
                location="companion",
            )
        condition = CONDITIONS.get(card.construction_key)
        if condition is None:
            report.warning(
                "companion.unchecked",
                f"{card.name}'s companion condition is not checked by this version.",
                "Check the condition yourself before playing.",
                card_ids=[card.id],
                location="companion",
            )
            continue
        failing = condition([cards[item.card_id] for item in deck], deck, rules, deck_size)
        if failing is not None:
            message, offenders = failing
            report.error(
                "companion.condition",
                f"{card.name}'s condition is not met: {message}",
                "Change the deck to meet it, or play without the companion.",
                card_ids=[card.id, *offenders[:20]],
                location="companion",
            )


Failing = tuple[str, list[UUID]] | None
Condition = Callable[[list[Card], list[DeckEntry], Rules, int], Failing]


def offenders(cards: list[Card], test: Callable[[Card], bool]) -> list[UUID]:
    return list(dict.fromkeys(card.id for card in cards if test(card)))


def nonland(test: Callable[[Card], bool], message: str) -> Condition:
    def check(cards: list[Card], _entries: list[DeckEntry], _rules: Rules, _size: int) -> Failing:
        found = offenders(cards, lambda card: not card.land and not test(card))
        return (message, found) if found else None

    return check


def permanents(test: Callable[[Card], bool], message: str) -> Condition:
    def check(cards: list[Card], _entries: list[DeckEntry], _rules: Rules, _size: int) -> Failing:
        found = offenders(cards, lambda card: card.permanent and not test(card))
        return (message, found) if found else None

    return check


def repeated_symbol(card: Card) -> bool:
    symbols = [symbol.upper() for symbol in SYMBOL.findall(card.mana_cost or "")]
    return len(symbols) != len(set(symbols))


def kaheera(cards: list[Card], _entries: list[DeckEntry], _rules: Rules, _size: int) -> Failing:
    def fits(card: Card) -> bool:
        _, types, subtypes = card.front_types
        return (
            "Creature" not in types
            or bool(KAHEERA_TYPES & set(subtypes))
            or "Changeling" in card.keywords
        )

    found = offenders(cards, lambda card: not fits(card))
    return (
        ("each creature card must be a Cat, Elemental, Nightmare, Dinosaur or Beast.", found)
        if found
        else None
    )


def lutri(cards: list[Card], entries: list[DeckEntry], _rules: Rules, _size: int) -> Failing:
    counted: dict[str, int] = defaultdict(int)
    for card, entry in zip(cards, entries, strict=True):
        if not card.land:
            counted[card.construction_key] += entry.quantity
    found = [card.id for card in cards if not card.land and counted[card.construction_key] > 1]
    return (
        ("each nonland card must have a different name.", list(dict.fromkeys(found)))
        if found
        else None
    )


def umori(cards: list[Card], _entries: list[DeckEntry], _rules: Rules, _size: int) -> Failing:
    spells = [card for card in cards if not card.land]
    if not spells:
        return None
    shared = set(spells[0].front_types[1])
    for card in spells[1:]:
        shared &= set(card.front_types[1])
    return None if shared else ("every nonland card must share a card type.", [])


def yorion(_cards: list[Card], _entries: list[DeckEntry], rules: Rules, size: int) -> Failing:
    minimum = number(rules, "min_main", number(rules, "deck_size", 60))
    if size >= minimum + 20:
        return None
    return (f"the deck needs at least {minimum + 20} cards, twenty more than the minimum.", [])


CONDITIONS: dict[str, Condition] = {
    "gyruda, doom of depths": nonland(
        lambda card: card.mana_value % 2 == 0, "each nonland card must have an even mana value."
    ),
    "jegantha, the wellspring": lambda cards, entries, rules, size: (
        ("no card may have more than one of the same mana symbol in its cost.", found)
        if (found := offenders(cards, repeated_symbol))
        else None
    ),
    "kaheera, the orphanguard": kaheera,
    "keruga, the macrosage": nonland(
        lambda card: card.mana_value >= 3, "each nonland card must have mana value 3 or more."
    ),
    "lurrus of the dream-den": permanents(
        lambda card: card.mana_value <= 2, "each permanent card must have mana value 2 or less."
    ),
    "lutri, the spellchaser": lutri,
    "obosh, the preypiercer": nonland(
        lambda card: card.mana_value % 2 == 1, "each nonland card must have an odd mana value."
    ),
    "umori, the collector": umori,
    "yorion, sky nomad": yorion,
    "zirda, the dawnwaker": permanents(
        lambda card: card.activated, "each permanent card must have an activated ability."
    ),
}
