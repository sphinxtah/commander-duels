"""Deck lists in and out: plain text and a versioned, lossless JSON format (DECK09–DECK11).

Text: one card per line, "4 Lightning Bolt", "4x Lightning Bolt" or just "Lightning Bolt";
a set and collector number after the name pick a printing ("Lightning Bolt (M10) 146",
"[M10]"). Headings switch sections: Commander, Deck or Main, Sideboard, Companion, Maybeboard
(Tokens are skipped); "SB:" before a line puts it in the sideboard, and "[Commander]" or
"*CMDR*" after one makes it a commander. With no headings, a Legacy list's second block, after a
blank line, is its sideboard, as MTGO writes it. Names keep their punctuation; split cards may be
written "Fire // Ice" or "Fire/Ice". Each name is matched exactly first (the whole name, then a
face, flavor or printed name, all ignoring case and accents); several matches are offered as
choices, and no match gets suggestions. Nothing is saved by a preview, and an import makes a
new deck: it never replaces one.

JSON: {"format": "commander-duels-deck", "version": 1, "game_format", "title", "entries": [{
"oracle_id", "scryfall_id", "name", "set", "number", "quantity", "location"}]}, read back by
identity, then by name. Notes are included only for the owner.

The Godlike tier's custom cards (v0.4.0) are written by name alone, in their Godlike owner's own
exports, and read back by exact name for a Godlike owner only.

Since v0.4.5 only cards a game can play resolve, or are offered as choices and suggestions. A line
naming a card the game cannot play (a token, an Un-card the engine lacks, a card Scryfall no
longer lists) is "unavailable", with the reason.
"""

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID

from pydantic import Field
from sqlalchemy import not_, or_, select
from sqlalchemy.orm import Session

from api.cards import CardSummary, summaries
from api.identity import ApiError
from api.models import CardAlias, CardConcept, CardPrinting
from api.schemas import Contract
from api.validation import MAX_ENTRIES, MAX_QUANTITY, DeckEntry, Location
from catalog.statuses import in_game as in_the_game
from catalog.statuses import stands_in, unplayable_reason
from catalog.text import normalize

MAX_TEXT_BYTES = 64 * 1024
MAX_JSON_BYTES = 256 * 1024
MAX_LINES = 600
MAX_SUGGESTIONS = 5
JSON_FORMAT = "commander-duels-deck"
JSON_VERSION = 1

LINE = re.compile(r"^(?:(?P<count>\d{1,4})\s*[xX]?\s+)?(?P<name>.+?)\s*$")
PRINTING = re.compile(
    r"\s+(?:\((?P<set>[A-Za-z0-9]{2,8})\)|\[(?P<set2>[A-Za-z0-9]{2,8})\])"
    r"(?:\s+(?P<number>[A-Za-z0-9★†-]{1,12}))?\s*$"
)
MARKERS = re.compile(r"\s+(?:\*[A-Za-z]+\*|\[(?:commander|cmdr)\]|\*CMDR\*)\s*", re.I)
COMMANDER_MARK = re.compile(r"\[(?:commander|cmdr)\]|\*CMDR\*", re.I)
HEADINGS: dict[str, Location | None] = {
    "commander": "commander",
    "commanders": "commander",
    "deck": "main",
    "main": "main",
    "maindeck": "main",
    "main deck": "main",
    "mainboard": "main",
    "library": "main",
    "sideboard": "sideboard",
    "side": "sideboard",
    "companion": "companion",
    "maybeboard": "maybeboard",
    "considering": "maybeboard",
    "maybe": "maybeboard",
    "tokens": None,
    "token": None,
}


class ImportLine(Contract):
    line: int
    text: str
    quantity: int
    location: Location
    name: str
    status: Literal["resolved", "ambiguous", "unresolved", "unavailable"]
    card_id: UUID | None = None
    printing_id: UUID | None = None
    candidates: list[CardSummary] = Field(default_factory=list)
    reason: str | None = Field(
        default=None,
        description="An unavailable line's card is one the game cannot play (v0.4.5): why.",
    )


class ImportRequest(Contract):
    format: Literal["legacy", "commander"]
    text: str = Field(default="", max_length=MAX_TEXT_BYTES)
    json_text: str = Field(default="", max_length=MAX_JSON_BYTES)


@dataclass
class Parsed:
    line: int
    text: str
    quantity: int
    location: Location
    name: str
    set_code: str | None = None
    number: str | None = None
    oracle_id: UUID | None = None
    scryfall_id: UUID | None = None


@dataclass
class ParsedDeck:
    lines: list[Parsed] = field(default_factory=list)
    title: str | None = None
    game_format: str | None = None
    notes: str | None = None


@dataclass(frozen=True)
class Exported:
    """A card as an export names it; a custom card has no Oracle ID."""

    name: str
    normalized_name: str
    oracle_id: UUID | None


def invalid(message: str) -> ApiError:
    return ApiError(422, "invalid_deck_list", message)


def parse_text(text: str, game_format: str) -> ParsedDeck:
    if len(text.encode()) > MAX_TEXT_BYTES:
        raise invalid(f"A deck list is at most {MAX_TEXT_BYTES // 1024} KB.")
    raw_lines = text.splitlines()
    if len(raw_lines) > MAX_LINES:
        raise invalid(f"A deck list is at most {MAX_LINES} lines.")
    parsed = ParsedDeck()
    headed = any(
        line.strip().rstrip(":").strip().casefold() in HEADINGS
        or line.strip().casefold().startswith("sb:")
        for line in raw_lines
    )
    section: Location | None = "main"
    seen_cards = False
    for number, raw in enumerate(raw_lines, 1):
        line = raw.strip()
        if not line:
            if not headed and seen_cards and game_format == "legacy" and section == "main":
                section = "sideboard"
            continue
        if line.startswith(("#", "//")):
            if parsed.title is None and line.startswith("//") and not seen_cards:
                parsed.title = line.lstrip("/ ").strip()[:80] or None
            continue
        heading = line.rstrip(":").strip().casefold()
        heading = re.sub(r"\s*\(\d+\)$", "", heading)
        if heading in HEADINGS:
            section = HEADINGS[heading]
            continue
        location: Location | None = section
        if line.casefold().startswith("sb:"):
            line, location = line[3:].strip(), "sideboard"
        if location is None:
            continue
        if COMMANDER_MARK.search(line):
            location = "commander"
        line = MARKERS.sub(" ", line).strip()
        match = LINE.match(line)
        if match is None:
            raise invalid(f"Line {number}: expected a count and a card name.")
        count = int(match["count"]) if match["count"] else 1
        if not 1 <= count <= MAX_QUANTITY:
            raise invalid(f"Line {number}: a count is from 1 to {MAX_QUANTITY}.")
        name = match["name"]
        set_code = card_number = None
        if found := PRINTING.search(name):
            set_code = (found["set"] or found["set2"]).casefold()
            card_number = found["number"]
            name = name[: found.start()].strip()
        if not name or len(name) > 200:
            raise invalid(f"Line {number}: a card name is 1 to 200 characters.")
        parsed.lines.append(
            Parsed(number, raw.strip()[:300], count, location, name, set_code, card_number)
        )
        seen_cards = True
    return parsed


def parse_json(text: str) -> ParsedDeck:
    if len(text.encode()) > MAX_JSON_BYTES:
        raise invalid(f"A deck file is at most {MAX_JSON_BYTES // 1024} KB.")
    try:
        data = json.loads(text)
    except (ValueError, RecursionError):
        raise invalid("The deck file is not valid JSON.") from None
    if not isinstance(data, dict) or data.get("format") != JSON_FORMAT:
        raise invalid(f'A deck file names "format": "{JSON_FORMAT}".')
    if data.get("version") != JSON_VERSION:
        raise invalid(f"This version reads deck files of version {JSON_VERSION}.")
    entries = data.get("entries")
    if not isinstance(entries, list) or len(entries) > MAX_ENTRIES:
        raise invalid(f"A deck file lists up to {MAX_ENTRIES} entries.")
    parsed = ParsedDeck(
        title=str(data.get("title") or "")[:80] or None,
        game_format=data.get("game_format") if isinstance(data.get("game_format"), str) else None,
        notes=str(data["notes"])[:10_000] if isinstance(data.get("notes"), str) else None,
    )
    for index, item in enumerate(entries, 1):
        if not isinstance(item, dict):
            raise invalid(f"Entry {index} is not an object.")
        name = str(item.get("name") or "").strip()
        quantity = item.get("quantity", 1)
        location = item.get("location", "main")
        if not isinstance(quantity, int) or not 1 <= quantity <= MAX_QUANTITY:
            raise invalid(f"Entry {index}: quantity is from 1 to {MAX_QUANTITY}.")
        if location not in ("main", "sideboard", "commander", "companion", "maybeboard"):
            raise invalid(f"Entry {index}: unknown location {location!r}.")
        parsed.lines.append(
            Parsed(
                index,
                name[:300],
                quantity,
                location,
                name[:200],
                str(item["set"]).casefold()[:16] if item.get("set") else None,
                str(item["number"])[:16] if item.get("number") else None,
                identity(item.get("oracle_id")),
                identity(item.get("scryfall_id")),
            )
        )
    return parsed


def identity(value: Any) -> UUID | None:
    try:
        return UUID(str(value)) if value else None
    except ValueError:
        return None


def candidates_by_name(
    db: Session, names: set[str], in_game: bool = True
) -> dict[str, list[CardConcept]]:
    """Exact matches for each normalized name: the card's name, then its aliases. in_game: the
    cards in the game (since v0.6.2 the stand-ins too); otherwise the others, deck cards first."""
    found: dict[str, list[CardConcept]] = {name: [] for name in names}
    if not names:
        return found
    current = in_the_game() if in_game else not_(in_the_game())
    for concept in db.scalars(
        select(CardConcept)
        .where(CardConcept.normalized_name.in_(names), current)
        .order_by(CardConcept.deck_card.desc())
    ):
        found[concept.normalized_name].append(concept)
    missing = {name for name, cards in found.items() if not cards}
    if missing:
        rows = db.execute(
            select(CardAlias.alias, CardConcept)
            .join(CardConcept, CardConcept.id == CardAlias.concept_id)
            .where(CardAlias.alias.in_(missing), current)
            .order_by(CardConcept.deck_card.desc())
        )
        for alias, concept in rows:
            if concept not in found[alias]:
                found[alias].append(concept)
    return found


def spellings(name: str) -> list[str]:
    """The name, and the split-card spellings deck sites use ("Fire/Ice", "Fire // Ice")."""
    found = [normalize(name)]
    if "//" not in name and "/" in name:
        found.append(normalize(" // ".join(part.strip() for part in name.split("/"))))
    return found


def suggestions(db: Session, name: str) -> list[CardConcept]:
    words = [word for word in normalize(name).split() if len(word) > 2][:4]
    if not words:
        return []
    return list(
        db.scalars(
            select(CardConcept)
            .where(
                in_the_game(),
                or_(*(CardConcept.name_search.contains(word, autoescape=True) for word in words)),
            )
            .order_by(CardConcept.edhrec_rank.is_(None), CardConcept.edhrec_rank)
            .limit(MAX_SUGGESTIONS)
        )
    )


def resolve(
    db: Session, parsed: ParsedDeck, custom: Mapping[str, tuple[UUID, str]] | None = None
) -> list[ImportLine]:
    """Each line as a card: by identity, then by exact name; custom (a Godlike owner's custom
    cards by normalized name) matches what the catalog does not. A line naming only a card out of
    the game is unavailable; since v0.6.2 a stand-in is in the game."""
    identities = [line.oracle_id for line in parsed.lines if line.oracle_id]
    by_oracle: dict[UUID, CardConcept] = {}
    out_of_game: dict[UUID, CardConcept] = {}
    for found in db.scalars(select(CardConcept).where(CardConcept.oracle_id.in_(identities))):
        in_game = (found.status == "certified" and found.removed_revision is None) or stands_in(
            found.status, found.status_reason, found.deck_card, found.removed_revision is not None
        )
        (by_oracle if in_game else out_of_game)[found.oracle_id] = found
    printings = {
        printing.scryfall_id: printing
        for printing in db.scalars(
            select(CardPrinting).where(
                CardPrinting.scryfall_id.in_(
                    [line.scryfall_id for line in parsed.lines if line.scryfall_id]
                )
            )
        )
    }
    names = {spelling for line in parsed.lines for spelling in spellings(line.name)}
    exact = candidates_by_name(db, names)
    withdrawn = candidates_by_name(db, {name for name, cards in exact.items() if not cards}, False)
    resolved: list[ImportLine] = []
    for line in parsed.lines:
        concept = by_oracle.get(line.oracle_id) if line.oracle_id else None
        options: list[CardConcept] = []
        if concept is None:
            for spelling in spellings(line.name):
                if exact.get(spelling):
                    options = exact[spelling]
                    break
            if len(options) == 1:
                concept = options[0]
        printing_id = choose_printing(db, line, concept, printings)
        if concept is not None:
            resolved.append(
                ImportLine(
                    line=line.line,
                    text=line.text,
                    quantity=line.quantity,
                    location=line.location,
                    name=concept.name,
                    status="resolved",
                    card_id=concept.id,
                    printing_id=printing_id,
                )
            )
            continue
        held = custom.get(normalize(line.name)) if custom and not options else None
        if held is not None:
            resolved.append(
                ImportLine(
                    line=line.line,
                    text=line.text,
                    quantity=line.quantity,
                    location=line.location,
                    name=held[1],
                    status="resolved",
                    card_id=held[0],
                )
            )
            continue
        gone = out_of_game.get(line.oracle_id) if line.oracle_id else None
        for spelling in spellings(line.name):
            gone = gone or next(iter(withdrawn.get(spelling) or []), None)
        if gone is not None and not options:
            resolved.append(
                ImportLine(
                    line=line.line,
                    text=line.text,
                    quantity=line.quantity,
                    location=line.location,
                    name=gone.name,
                    status="unavailable",
                    reason=unplayable_reason(
                        gone.status, gone.status_detail, gone.removed_revision is not None
                    ),
                )
            )
            continue
        status: Literal["ambiguous", "unresolved"] = "ambiguous" if options else "unresolved"
        shown = options or suggestions(db, line.name)
        resolved.append(
            ImportLine(
                line=line.line,
                text=line.text,
                quantity=line.quantity,
                location=line.location,
                name=line.name,
                status=status,
                candidates=summaries(db, shown),
            )
        )
    return resolved


def choose_printing(
    db: Session,
    line: Parsed,
    concept: CardConcept | None,
    printings: dict[UUID, CardPrinting],
) -> UUID | None:
    if concept is None:
        return None
    if line.scryfall_id and line.scryfall_id in printings:
        printing = printings[line.scryfall_id]
        return printing.id if printing.concept_id == concept.id else None
    if line.set_code:
        query = select(CardPrinting.id).where(
            CardPrinting.concept_id == concept.id, CardPrinting.set_code == line.set_code
        )
        if line.number:
            query = query.where(CardPrinting.collector_number == line.number)
        return db.scalar(query.order_by(CardPrinting.lang != "en").limit(1))
    return None


def merged(lines: list[ImportLine]) -> list[DeckEntry]:
    """Resolved lines as deck entries, one per card, printing and location."""
    totals: dict[tuple[UUID, UUID | None, str], int] = {}
    for line in lines:
        if line.card_id is None:
            continue
        key = (line.card_id, line.printing_id, line.location)
        totals[key] = min(totals.get(key, 0) + line.quantity, MAX_QUANTITY)
    return [
        DeckEntry(card_id=card_id, printing_id=printing_id, quantity=quantity, location=location)  # type: ignore[arg-type]
        for (card_id, printing_id, location), quantity in totals.items()
    ]


def export_text(
    title: str,
    entries: list[DeckEntry],
    cards: Mapping[UUID, Exported],
    printings: dict[UUID, CardPrinting],
) -> str:
    sections = [
        ("commander", "Commander"),
        ("companion", "Companion"),
        ("main", "Deck"),
        ("sideboard", "Sideboard"),
        ("maybeboard", "Maybeboard"),
    ]
    lines = [f"// {title}"]
    for location, heading in sections:
        chosen = [
            entry for entry in entries if entry.location == location and entry.card_id in cards
        ]
        if not chosen:
            continue
        lines += ["", heading]
        for entry in sorted(chosen, key=lambda item: cards[item.card_id].normalized_name):
            text = f"{entry.quantity} {cards[entry.card_id].name}"
            printing = printings.get(entry.printing_id) if entry.printing_id else None
            if printing is not None:
                text += f" ({printing.set_code.upper()}) {printing.collector_number}"
            lines.append(text)
    return "\n".join(lines) + "\n"


def export_json(
    title: str,
    game_format: str,
    entries: list[DeckEntry],
    cards: Mapping[UUID, Exported],
    printings: dict[UUID, CardPrinting],
    notes: str | None,
) -> dict[str, object]:
    exported: dict[str, object] = {
        "format": JSON_FORMAT,
        "version": JSON_VERSION,
        "game_format": game_format,
        "title": title,
        "entries": [
            {
                **(
                    {"oracle_id": str(oracle_id)}
                    if (oracle_id := cards[entry.card_id].oracle_id)
                    else {}
                ),
                "name": cards[entry.card_id].name,
                "quantity": entry.quantity,
                "location": entry.location,
                **(
                    {
                        "scryfall_id": str(printing.scryfall_id),
                        "set": printing.set_code,
                        "number": printing.collector_number,
                    }
                    if entry.printing_id and (printing := printings.get(entry.printing_id))
                    else {}
                ),
            }
            for entry in entries
            if entry.card_id in cards
        ],
    }
    if notes is not None:
        exported["notes"] = notes
    return exported
