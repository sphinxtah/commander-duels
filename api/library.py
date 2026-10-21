"""Players' card libraries and the starter decks (v0.3.1; PROG01, PROG03, DECK08).

Players build from their own library; administrators and SysOp from the whole catalog
(library.unlimited). A library holds:
- copies granted for good, each grant recorded with its source (api/models.py LibraryGrant):
  the two starter decks a player chose, every copy of each, and the cards of decks saved before
  libraries existed;
- while an alliance lasts, a playset of each of that Planeswalker's cards (api/roster.py);
- basic lands, without limit, which no grant needs to name.
Copies count, as in Magic Duels: a deck may hold no more copies of a card than the library does,
counting every printing and Oracle version of the card together. Copies are a limit per deck, not
spent by one: two decks may each hold the same owned card.

The ten starter decks are content/starter-decks.json, made from the owner's workbook by
scripts/starter_decks.py. Each card keeps the printing the owner chose for it.
"""

import json
from collections import defaultdict
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.identity import Active, Db, utcnow
from api.models import CardConcept, CardPrinting, LibraryGrant, User
from api.roster import ALLIANCE_COPIES, Planeswalker, alliance_cards, roster_of
from api.validation import Collection, DeckEntry
from catalog.text import normalize

UNLIMITED = "library.unlimited"


@dataclass
class Library:
    """An account's library: owned copies by construction key, and where each came from."""

    unlimited: bool
    copies: dict[str, int] = field(default_factory=dict)
    sources: dict[str, set[str]] = field(default_factory=dict)
    alliance: str | None = None

    def collection(self) -> Collection | None:
        return None if self.unlimited else Collection(self.copies)

    def owned(self, key: str) -> int | None:
        """Copies owned, or None when the account builds from the whole catalog."""
        return None if self.unlimited else self.copies.get(key, 0)


def library_of(
    db: Session, user: User, permissions: frozenset[str], roster: dict[str, Planeswalker]
) -> Library:
    if UNLIMITED in permissions:
        return Library(unlimited=True, alliance=user.alliance)
    library = Library(unlimited=False, alliance=user.alliance)
    copies: dict[str, int] = defaultdict(int)
    sources: dict[str, set[str]] = defaultdict(set)
    granted = db.execute(
        select(CardConcept.construction_key, LibraryGrant.source, func.sum(LibraryGrant.quantity))
        .join(CardConcept, CardConcept.id == LibraryGrant.concept_id)
        .where(LibraryGrant.user_id == user.id)
        .group_by(CardConcept.construction_key, LibraryGrant.source)
    )
    for key, source, quantity in granted:
        copies[key] += int(quantity)
        sources[key].add(source)
    planeswalker = roster.get(user.alliance) if user.alliance else None
    if planeswalker is not None and not planeswalker.custom:
        ids = alliance_cards(db, roster).get(planeswalker.id, [])
        keys = set(db.scalars(select(CardConcept.construction_key).where(CardConcept.id.in_(ids))))
        for key in keys:
            copies[key] += ALLIANCE_COPIES
            sources[key].add("alliance")
    library.copies, library.sources = (
        dict(copies),
        {key: set(found) for key, found in sources.items()},
    )
    return library


def current_library(request: Request, principal: Active, db: Db) -> Library:
    return library_of(db, principal.user, principal.permissions, roster_of(request))


CurrentLibrary = Annotated[Library, Depends(current_library)]


# The starter decks.


@dataclass(frozen=True)
class StarterCard:
    quantity: int
    name: str
    role: str
    set_code: str
    collector_number: str


@dataclass(frozen=True)
class Starter:
    id: str
    number: int
    title: str
    commander: str
    colors: str
    color_names: str
    guild: str
    description: str
    how_to_play: str
    teaches: str
    cards: tuple[StarterCard, ...]


@lru_cache(maxsize=4)
def starters_in(folder: str) -> dict[str, Starter]:
    path = Path(folder) / "starter-decks.json"
    if not path.is_file():
        return {}
    content = json.loads(path.read_text(encoding="utf-8"))
    return {
        deck["id"]: Starter(
            id=deck["id"],
            number=deck["number"],
            title=deck["title"],
            commander=deck["commander"],
            colors=deck["colors"],
            color_names=deck["color_names"],
            guild=deck["guild"],
            description=deck["description"],
            how_to_play=deck["how_to_play"],
            teaches=deck["teaches"],
            cards=tuple(
                StarterCard(
                    quantity=card["quantity"],
                    name=card["name"],
                    role=card["role"],
                    set_code=card["set"],
                    collector_number=card["collector_number"],
                )
                for card in deck["cards"]
            ),
        )
        for deck in sorted(content["decks"], key=lambda deck: deck["number"])
    }


def starter_entries(db: Session, starter: Starter) -> tuple[list[DeckEntry], list[str]]:
    """The deck's entries, each with the printing the owner chose where the catalog has it, and
    the names the catalog does not know."""
    names = {normalize(card.name) for card in starter.cards}
    concepts = {
        concept.normalized_name: concept
        for concept in db.scalars(
            select(CardConcept).where(
                CardConcept.normalized_name.in_(names),
                CardConcept.deck_card.is_(True),
                CardConcept.removed_revision.is_(None),
            )
        )
    }
    ids = [concept.id for concept in concepts.values()]
    printings = {
        (concept_id, set_code, number): printing_id
        for printing_id, concept_id, set_code, number in db.execute(
            select(
                CardPrinting.id,
                CardPrinting.concept_id,
                CardPrinting.set_code,
                CardPrinting.collector_number,
            ).where(CardPrinting.concept_id.in_(ids))
        )
    }
    entries: list[DeckEntry] = []
    missing: list[str] = []
    for index, card in enumerate(starter.cards):
        concept = concepts.get(normalize(card.name))
        if concept is None:
            missing.append(card.name)
            continue
        entries.append(
            DeckEntry(
                card_id=concept.id,
                printing_id=printings.get((concept.id, card.set_code, card.collector_number)),
                quantity=card.quantity,
                # The first card of every list is its commander.
                location="commander" if index == 0 else "main",
            )
        )
    return entries, missing


def grant_starter(db: Session, user: User, starter: Starter, entries: list[DeckEntry]) -> None:
    """Every copy of the deck's cards, for good; the grant is keyed by the deck, so it is made
    once whatever retries. Basic lands need no grant."""
    quantities: dict[UUID, int] = defaultdict(int)
    for entry in entries:
        quantities[entry.card_id] += entry.quantity
    basics = set(
        db.scalars(
            select(CardConcept.id).where(
                CardConcept.id.in_(quantities), CardConcept.type_line.startswith("Basic ")
            )
        )
    )
    key = f"starter:{starter.id}"
    done = db.scalar(
        select(LibraryGrant.id).where(
            LibraryGrant.user_id == user.id, LibraryGrant.grant_key == key
        )
    )
    if done is not None:
        return
    now = utcnow()
    for card_id, quantity in quantities.items():
        if card_id in basics:
            continue
        db.add(
            LibraryGrant(
                user_id=user.id,
                concept_id=card_id,
                quantity=quantity,
                source="starter",
                grant_key=key,
                created_at=now,
            )
        )
