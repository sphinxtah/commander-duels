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

Since v0.4.5 SysOp may reset an account to a new one's state (api/resets.py). Grants are
append-only, so those before the reset stay recorded, and the library counts only those made
after it (since_reset), as the shop does the account's packs.

The Godlike tier's custom cards (v0.4.0) are open only to an account at that tier: an alliance
with their Planeswalker then holds a playset of each, kept apart from the catalog's copies, and
administrators and SysOp build with them as with any card. Below Godlike the account's library
holds none, whatever its alliance. Which of them the running engine has loaded is asked once per
engine start (api/engine_cards.py), for Godlike accounts and SysOp only.

The ten starter decks are content/starter-decks.json, made from the owner's workbook by
scripts/starter_decks.py. Each card keeps the printing the owner chose for it.
"""

import json
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Request
from sqlalchemy import ColumnElement, func, select, true
from sqlalchemy.orm import InstrumentedAttribute, Session
from starlette.concurrency import run_in_threadpool

from api.engine_cards import engine_cards_of
from api.identity import Active, Db, utcnow
from api.models import CardConcept, CardPrinting, CustomCard, LibraryGrant, ProgressEntry, User
from api.roster import ALLIANCE_COPIES, GODLIKE, Planeswalker, alliance_cards, roster_of
from api.validation import CUSTOM_KEY, Collection, DeckEntry, custom_key
from catalog.text import normalize

UNLIMITED = "library.unlimited"


@dataclass
class Library:
    """An account's library: owned copies by construction key, and where each came from; the
    custom cards' copies by their own keys (custom:<id>), whether the account is at the Godlike
    tier, and which custom cards the running engine has loaded (by name, case aside; None when
    not asked)."""

    unlimited: bool
    copies: dict[str, int] = field(default_factory=dict)
    sources: dict[str, set[str]] = field(default_factory=dict)
    alliance: str | None = None
    godlike: bool = False
    custom: dict[str, int] = field(default_factory=dict)
    loaded: Mapping[str, bool] | None = None

    def collection(self) -> Collection:
        return Collection(
            None if self.unlimited else {**self.copies, **self.custom},
            godlike=self.godlike,
            loaded=self.loaded,
        )

    def owned(self, key: str) -> int | None:
        """Copies owned, or None when the account builds from the whole catalog."""
        if self.unlimited:
            return None
        return self.custom.get(key, 0) if key.startswith(CUSTOM_KEY) else self.copies.get(key, 0)


def at_godlike(db: Session, user_id: UUID) -> bool:
    """Whether the account's wins, counted and set, reach the Godlike tier (api/progression.py)."""
    wins = db.scalar(
        select(func.coalesce(func.sum(ProgressEntry.wins), 0)).where(
            ProgressEntry.user_id == user_id
        )
    )
    return int(wins or 0) >= GODLIKE.wins


def since_reset(user: User, created: InstrumentedAttribute[datetime]) -> ColumnElement[bool]:
    """The account's grants, packs or openings that count: those made since SysOp last reset it
    (v0.4.5), or all of them when it never was."""
    return created > user.reset_at if user.reset_at is not None else true()


def reset_key(user: User, key: str) -> str:
    """The key of a grant or purchase that a reset lets happen once more (a starter deck chosen
    or bought): after a reset it carries the reset's time, so it is a new fact."""
    if user.reset_at is None:
        return key
    return f"{key}:{user.reset_at.astimezone(UTC):%Y%m%dT%H%M%S%f}"


def library_of(
    db: Session, user: User, permissions: frozenset[str], roster: dict[str, Planeswalker]
) -> Library:
    godlike = at_godlike(db, user.id)
    if UNLIMITED in permissions:
        return Library(unlimited=True, alliance=user.alliance, godlike=godlike)
    library = Library(unlimited=False, alliance=user.alliance, godlike=godlike)
    copies: dict[str, int] = defaultdict(int)
    sources: dict[str, set[str]] = defaultdict(set)
    granted = db.execute(
        select(CardConcept.construction_key, LibraryGrant.source, func.sum(LibraryGrant.quantity))
        .join(CardConcept, CardConcept.id == LibraryGrant.concept_id)
        .where(LibraryGrant.user_id == user.id, since_reset(user, LibraryGrant.created_at))
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
    elif planeswalker is not None and godlike:
        # The Godlike tier's Planeswalker: a playset of each of its custom cards.
        for card_id in db.scalars(
            select(CustomCard.id).where(CustomCard.planeswalker == planeswalker.id)
        ):
            library.custom[custom_key(card_id)] = ALLIANCE_COPIES
    library.copies, library.sources = (
        dict(copies),
        {key: set(found) for key, found in sources.items()},
    )
    return library


def custom_names(db: Session) -> list[str]:
    return list(db.scalars(select(CustomCard.name)))


async def current_library(request: Request, principal: Active, db: Db) -> Library:
    """The account's library; for a Godlike account or SysOp, with which custom cards the running
    engine has loaded, so the deck builder can say so."""
    library = await run_in_threadpool(
        library_of, db, principal.user, principal.permissions, roster_of(request)
    )
    if library.godlike or principal.can("custom_cards.manage"):
        names = await run_in_threadpool(custom_names, db)
        cards = engine_cards_of(request)
        library.loaded = await cards.loaded(names) if cards is not None and names else None
    return library


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


def commander_printing(db: Session, entries: list[DeckEntry]) -> tuple[UUID | None, UUID | None]:
    """The deck's commander and the printing whose image stands for the deck: the one the owner
    chose, or, where the catalog lacks it, the card's own default printing (v0.4.2), so the
    commander's picture shows whenever the catalog has one."""
    leader = next((entry for entry in entries if entry.location == "commander"), None)
    if leader is None:
        return None, None
    if leader.printing_id is not None:
        return leader.card_id, leader.printing_id
    return leader.card_id, db.scalar(
        select(CardConcept.default_printing_id).where(CardConcept.id == leader.card_id)
    )


def owned_starters(db: Session, user: User) -> set[str]:
    """The starter decks the account has: the two it chose, and those it bought in Leng's shop
    (v0.4.2), since any reset. Both grant their cards under the deck's own key."""
    keys = db.scalars(
        select(LibraryGrant.grant_key)
        .where(
            LibraryGrant.user_id == user.id,
            LibraryGrant.grant_key.startswith("starter:"),
            since_reset(user, LibraryGrant.created_at),
        )
        .distinct()
    )
    # starter:<deck>, or starter:<deck>:<time> after a reset (reset_key).
    return set(user.starter_decks or []) | {key.split(":")[1] for key in keys}


def grant_starter(db: Session, user: User, starter: Starter, entries: list[DeckEntry]) -> None:
    """Every copy of the deck's cards, for good; the grant is keyed by the deck, so it is made
    once whatever retries (once more after a reset). Basic lands need no grant."""
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
    key = reset_key(user, f"starter:{starter.id}")
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
