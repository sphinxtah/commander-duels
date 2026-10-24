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

Since v0.5.0 the library holds cards by edition (printing), as the owner asked on 2026-10-22: a
grant names the edition it gives (a pack's pulled printing, a starter deck's own), the alliance's
playset is in each card's default printing, and a deck may hold only editions the library holds,
copy by copy (api/validation.py). A deck's copies naming no edition take the editions the library
holds when the draft is saved (with_owned_editions); once, when v0.5.0 deployed, every player's
drafts were also switched to the editions their library holds where it held enough
(api/decks.py switch_editions). Basic lands stay unlimited in every edition.

The Godlike tier's custom cards (v0.4.0) are open only to an account at that tier: an alliance
with their Planeswalker then holds a playset of each, kept apart from the catalog's copies, and
administrators and SysOp build with them as with any card. Below Godlike the account's library
holds none, whatever its alliance. Which of them the running engine has loaded is asked once per
engine start (api/engine_cards.py), for Godlike accounts and SysOp only.

The ten starter decks are content/starter-decks.json, made from the owner's workbook by
scripts/starter_decks.py. Each card keeps the printing the owner chose for it.

One of a kind (v0.5.1): a printing made once in the world belongs to one account
(ONE_OF_A_KIND). The owner asked on 2026-10-23 for the only copy of The One Ring ever printed
(The Lord of the Rings: Tales of Middle-earth #0, serialized 001/001) to be Sphinx's: migration
0027 grants it, packs never deal it (api/shop.py), and no deck but its owner's may hold it
(Library.withheld), whatever the account builds from; SysOp, who builds with anything, excepted.
"""

import json
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from functools import lru_cache
from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Request
from sqlalchemy import ColumnElement, func, not_, select, true
from sqlalchemy.orm import InstrumentedAttribute, Session
from starlette.concurrency import run_in_threadpool

from api.engine_cards import engine_cards_of
from api.identity import Active, Db, utcnow
from api.models import CardConcept, CardPrinting, CustomCard, LibraryGrant, ProgressEntry, User
from api.roster import ALLIANCE_COPIES, GODLIKE, Planeswalker, alliance_cards, roster_of
from api.validation import (
    CUSTOM_KEY,
    Collection,
    DeckEntry,
    Edition,
    custom_key,
    edition_label,
)
from catalog.text import normalize

UNLIMITED = "library.unlimited"
# One-of-a-kind printings (v0.5.1): Scryfall ID and the normalized handle of the account that
# owns the only copy (migration 0027 grants it; keep the two the same).
ONE_OF_A_KIND: dict[UUID, str] = {UUID("93de9042-cc62-4ade-8d8d-68fdbc84bfae"): "sphinx"}
# The order in which a deck's copies are given editions: the commander first, then the deck.
LOCATION_ORDER = ("commander", "companion", "main", "sideboard")


@dataclass
class Library:
    """An account's library: owned copies by construction key, and where each came from; since
    v0.5.0 the same by edition (printing); the custom cards' copies by their own keys
    (custom:<id>), whether the account is at the Godlike tier, and which custom cards the running
    engine has loaded (by name, case aside; None when not asked)."""

    unlimited: bool
    copies: dict[str, int] = field(default_factory=dict)
    sources: dict[str, set[str]] = field(default_factory=dict)
    alliance: str | None = None
    godlike: bool = False
    custom: dict[str, int] = field(default_factory=dict)
    loaded: Mapping[str, bool] | None = None
    editions: dict[UUID, Edition] = field(default_factory=dict)
    # One-of-a-kind printings (v0.5.1) this account holds no copy of: no deck of its may hold them.
    withheld: frozenset[UUID] = frozenset()
    # The editions by card, made the first time they are asked for.
    by_card: dict[UUID, list[Edition]] | None = field(default=None, repr=False, compare=False)

    def collection(self) -> Collection:
        return Collection(
            None if self.unlimited else {**self.copies, **self.custom},
            godlike=self.godlike,
            loaded=self.loaded,
            editions=None if self.unlimited else self.editions,
            withheld=self.withheld,
        )

    def owned(self, key: str) -> int | None:
        """Copies owned, or None when the account builds from the whole catalog."""
        if self.unlimited:
            return None
        return self.custom.get(key, 0) if key.startswith(CUSTOM_KEY) else self.copies.get(key, 0)

    def editions_of(self, card_id: UUID) -> list[Edition]:
        """The editions of a card the library holds, the most copies first."""
        if self.by_card is None:
            self.by_card = defaultdict(list)
            for edition in sorted(
                self.editions.values(), key=lambda found: (-found.copies, found.label)
            ):
                self.by_card[edition.card_id].append(edition)
        return list(self.by_card.get(card_id, []))


def default_printings(db: Session, ids: set[UUID]) -> dict[UUID, UUID]:
    """Each card's default printing, the one shown when a deck names none, else its newest: the
    edition of an alliance's playset, and of a grant whose own printing the catalog lacks."""
    if not ids:
        return {}
    found = {
        card_id: printing_id
        for card_id, printing_id in db.execute(
            select(CardConcept.id, CardConcept.default_printing_id).where(
                CardConcept.id.in_(ids), CardConcept.default_printing_id.is_not(None)
            )
        )
        if printing_id is not None
    }
    if ids - found.keys():
        for card_id, printing_id in db.execute(
            select(CardPrinting.concept_id, CardPrinting.id)
            .where(CardPrinting.concept_id.in_(ids - found.keys()))
            .order_by(
                CardPrinting.released_at.desc().nulls_last(),
                CardPrinting.set_code,
                CardPrinting.collector_number,
            )
        ):
            found.setdefault(card_id, printing_id)
    return found


def at_godlike(db: Session, user_id: UUID) -> bool:
    """Whether the account's wins, counted and set, reach the Godlike tier (api/progression.py)."""
    wins = db.scalar(
        select(func.coalesce(func.sum(ProgressEntry.wins), 0)).where(
            ProgressEntry.user_id == user_id
        )
    )
    return int(wins or 0) >= GODLIKE.wins


def since_reset(
    user: User, created: InstrumentedAttribute[datetime] | InstrumentedAttribute[datetime | None]
) -> ColumnElement[bool]:
    """The account's grants, packs or openings that count: those made since SysOp last reset it
    (v0.4.5), or all of them when it never was."""
    return created > user.reset_at if user.reset_at is not None else true()


def reset_key(user: User, key: str) -> str:
    """The key of a grant or purchase that a reset lets happen once more (a starter deck chosen
    or bought): after a reset it carries the reset's time, so it is a new fact."""
    if user.reset_at is None:
        return key
    return f"{key}:{user.reset_at.astimezone(UTC):%Y%m%dT%H%M%S%f}"


def one_of_a_kind(db: Session) -> frozenset[UUID]:
    """The catalog's one-of-a-kind printings (v0.5.1)."""
    return frozenset(
        db.scalars(select(CardPrinting.id).where(CardPrinting.scryfall_id.in_(ONE_OF_A_KIND)))
    )


def withheld_from(db: Session, user: User) -> frozenset[UUID]:
    """The one-of-a-kind printings the account may not put in a deck: those it holds no copy of.
    SysOp builds with anything."""
    unique = one_of_a_kind(db)
    if not unique or user.kind == "sysop":
        return frozenset()
    held = db.scalars(
        select(LibraryGrant.printing_id).where(
            LibraryGrant.user_id == user.id,
            LibraryGrant.printing_id.in_(unique),
            since_reset(user, LibraryGrant.created_at),
        )
    )
    return unique - set(held)


def library_of(
    db: Session, user: User, permissions: frozenset[str], roster: dict[str, Planeswalker]
) -> Library:
    godlike = at_godlike(db, user.id)
    withheld = withheld_from(db, user)
    if UNLIMITED in permissions:
        return Library(unlimited=True, alliance=user.alliance, godlike=godlike, withheld=withheld)
    library = Library(unlimited=False, alliance=user.alliance, godlike=godlike, withheld=withheld)
    copies: dict[str, int] = defaultdict(int)
    sources: dict[str, set[str]] = defaultdict(set)
    # By edition: each printing's copies and sources, and the printing as validation names it.
    held: dict[UUID, int] = defaultdict(int)
    came: dict[UUID, set[str]] = defaultdict(set)
    printings: dict[UUID, tuple[UUID, str, str, str, str, date | None]] = {}
    columns = (
        CardPrinting.id,
        CardPrinting.concept_id,
        CardConcept.construction_key,
        CardPrinting.set_name,
        CardPrinting.set_code,
        CardPrinting.collector_number,
        CardPrinting.released_at,
    )
    # A printing's card is the card it is now (a catalog sync may move one to another).
    granted = db.execute(
        select(*columns, LibraryGrant.source, func.sum(LibraryGrant.quantity))
        .select_from(LibraryGrant)
        .join(CardPrinting, CardPrinting.id == LibraryGrant.printing_id)
        .join(CardConcept, CardConcept.id == CardPrinting.concept_id)
        .where(LibraryGrant.user_id == user.id, since_reset(user, LibraryGrant.created_at))
        .group_by(*columns, LibraryGrant.source)
    )
    for (
        printing_id,
        card_id,
        key,
        set_name,
        set_code,
        number,
        released,
        source,
        quantity,
    ) in granted:
        copies[key] += int(quantity)
        sources[key].add(source)
        held[printing_id] += int(quantity)
        came[printing_id].add(source)
        printings[printing_id] = (card_id, key, set_name, set_code, number, released)
    planeswalker = roster.get(user.alliance) if user.alliance else None
    if planeswalker is not None and not planeswalker.custom:
        ids = alliance_cards(db, roster).get(planeswalker.id, [])
        # A playset per card (one per construction key), in its default printing.
        cards: dict[str, UUID] = {}
        for card_id, key in db.execute(
            select(CardConcept.id, CardConcept.construction_key)
            .where(CardConcept.id.in_(ids))
            .order_by(CardConcept.default_printing_id.is_(None), CardConcept.normalized_name)
        ):
            cards.setdefault(key, card_id)
        chosen = default_printings(db, set(cards.values()))
        for printing_id, card_id, key, set_name, set_code, number, released in db.execute(
            select(*columns)
            .select_from(CardPrinting)
            .join(CardConcept, CardConcept.id == CardPrinting.concept_id)
            .where(CardPrinting.id.in_(set(chosen.values())))
        ):
            held[printing_id] += ALLIANCE_COPIES
            came[printing_id].add("alliance")
            printings[printing_id] = (card_id, key, set_name, set_code, number, released)
        for key in cards:
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
    library.editions = {
        printing_id: Edition(
            printing_id=printing_id,
            card_id=card_id,
            key=key,
            copies=held[printing_id],
            set_name=set_name,
            set_code=set_code,
            collector_number=number,
            released_at=released,
            sources=frozenset(came[printing_id]),
        )
        for printing_id, (card_id, key, set_name, set_code, number, released) in printings.items()
    }
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
    """Every copy of the deck's cards, for good, each in the edition the deck holds (v0.5.0; the
    card's default printing where the catalog lacks the owner's choice), so the deck plays at once;
    the grant is keyed by the deck, so it is made once whatever retries (once more after a reset).
    Basic lands need no grant."""
    cards = {entry.card_id for entry in entries}
    basics = set(
        db.scalars(
            select(CardConcept.id).where(
                CardConcept.id.in_(cards), CardConcept.type_line.startswith("Basic ")
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
    fallback = default_printings(
        db, {entry.card_id for entry in entries if entry.printing_id is None} - basics
    )
    quantities: dict[tuple[UUID, UUID], int] = defaultdict(int)
    for entry in entries:
        printing_id = entry.printing_id or fallback.get(entry.card_id)
        if entry.card_id in basics or printing_id is None:
            continue
        quantities[(entry.card_id, printing_id)] += entry.quantity
    now = utcnow()
    for (card_id, printing_id), quantity in quantities.items():
        db.add(
            LibraryGrant(
                user_id=user.id,
                concept_id=card_id,
                printing_id=printing_id,
                quantity=quantity,
                source="starter",
                grant_key=key,
                created_at=now,
            )
        )


# Decks in the editions the library holds (v0.5.0).


@dataclass(frozen=True)
class Switch:
    """Copies of a card a deck's draft moved from an edition the library does not hold to one it
    does, when v0.5.0 deployed: the deck's note names them (Deck.switched_editions)."""

    card_id: UUID
    name: str
    quantity: int
    before: str
    after: str


def with_owned_editions(
    db: Session, entries: list[DeckEntry], library: Library, *, switch: bool = False
) -> tuple[list[DeckEntry], list[Switch]]:
    """The entries with the editions the library holds, for an account that builds from one.

    A copy naming no edition takes one the library holds that the deck's other copies leave over:
    the edition with the most copies first, an entry split where one edition is not enough;
    what no edition is left for still names none, and validation says so. With switch (once, when
    v0.5.0 deployed), a copy naming an edition the library holds too few of moves the same way, to
    another of that card's editions; what cannot move stays. Only the card's own printings are
    chosen. The maybeboard, basic lands and the custom cards keep what they name. The order is the
    commander first, then the deck; the result is one entry per card, printing and location."""
    if library.unlimited or not entries:
        return entries, []
    ids = {entry.card_id for entry in entries}
    concepts = dict(
        db.execute(
            select(CardConcept.id, CardConcept.name).where(
                CardConcept.id.in_(ids), not_(CardConcept.type_line.startswith("Basic "))
            )
        ).all()
    )
    if not concepts:
        return entries, []
    spare = {
        printing_id: edition.copies
        for printing_id, edition in library.editions.items()
        if edition.card_id in concepts
    }

    def counted(entry: DeckEntry) -> bool:
        return entry.card_id in concepts and entry.location != "maybeboard"

    ordered = sorted(
        entries,
        key=lambda entry: (
            LOCATION_ORDER.index(entry.location) if entry.location in LOCATION_ORDER else 9
        ),
    )
    # The copies that name an edition the library holds keep it first.
    beyond: dict[int, int] = {}
    for index, entry in enumerate(ordered):
        if counted(entry) and entry.printing_id is not None:
            kept = min(entry.quantity, spare.get(entry.printing_id, 0))
            if entry.printing_id in spare:
                spare[entry.printing_id] -= kept
            beyond[index] = entry.quantity - kept
    result: list[DeckEntry] = []
    moved: dict[tuple[UUID, UUID, UUID], int] = defaultdict(int)
    for index, entry in enumerate(ordered):
        wanting = (
            entry.quantity if entry.printing_id is None else beyond.get(index, 0) if switch else 0
        )
        if not counted(entry) or wanting == 0:
            result.append(entry)
            continue
        if entry.printing_id is not None and entry.quantity > wanting:
            result.append(entry.model_copy(update={"quantity": entry.quantity - wanting}))
        for edition in library.editions_of(entry.card_id):
            if wanting == 0:
                break
            taken = min(wanting, spare.get(edition.printing_id, 0))
            if taken <= 0:
                continue
            spare[edition.printing_id] -= taken
            wanting -= taken
            result.append(
                entry.model_copy(update={"printing_id": edition.printing_id, "quantity": taken})
            )
            if entry.printing_id is not None:
                moved[(entry.card_id, entry.printing_id, edition.printing_id)] += taken
        if wanting:
            result.append(entry.model_copy(update={"quantity": wanting}))
    return merged_entries(result), switches(db, moved, concepts, library)


def merged_entries(entries: list[DeckEntry]) -> list[DeckEntry]:
    """One entry per card, printing and location, in their first order."""
    totals: dict[tuple[UUID, UUID | None, str], DeckEntry] = {}
    for entry in entries:
        key = (entry.card_id, entry.printing_id, entry.location)
        found = totals.get(key)
        totals[key] = (
            entry
            if found is None
            else found.model_copy(update={"quantity": min(found.quantity + entry.quantity, 250)})
        )
    return list(totals.values())


def switches(
    db: Session,
    moved: Mapping[tuple[UUID, UUID, UUID], int],
    names: Mapping[UUID, str],
    library: Library,
) -> list[Switch]:
    """The copies moved to another edition, with both editions named."""
    if not moved:
        return []
    labels = {
        printing_id: edition_label(set_name, set_code, number)
        for printing_id, set_name, set_code, number in db.execute(
            select(
                CardPrinting.id,
                CardPrinting.set_name,
                CardPrinting.set_code,
                CardPrinting.collector_number,
            ).where(CardPrinting.id.in_({printing for _, printing, _ in moved}))
        )
    }
    return [
        Switch(
            card_id=card_id,
            name=names[card_id],
            quantity=quantity,
            before=labels.get(printing, ""),
            after=library.editions[target].label,
        )
        for (card_id, printing, target), quantity in moved.items()
    ]
