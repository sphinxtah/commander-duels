"""Players' decks: lifecycle, drafts, revisions, sharing, import and export (DECK01, DECK02,
DECK08–DECK11).

A deck belongs to its owner, and every route but the shared view answers only them: anyone else
gets the same 404 as a deck that does not exist (T29). The draft autosaves: each save names the
draft version it edited, and a save from a stale tab gets 409 draft_conflict, with nothing lost,
so the editor can show both and let the player merge. Drafts may be incomplete or illegal; the
validation comes back with every save. A revision is an immutable copy of the draft, made when
the player saves one or when a game starts with the deck, and a game binds to it, so editing the
deck never changes a game. Deleting moves a deck to the trash, from which it can be restored;
archived decks leave the list but keep working.

Since v0.3.1 players build from their own library (api/library.py): every validation of a
player's deck counts the copies they own, and a deck holding more is collection-locked, saved but
kept from games until fixed. Each deck's stored flags are refreshed whenever its owner's library
changes (refresh_decks). The starter decks are the ten in content/starter-decks.json.

Since v0.4.0 a Godlike account's decks may hold the Godlike tier's custom cards
(api/custom_play.py): its owner sees, imports and exports them; shared decks, their exports and
copies leave them out.

Since v0.4.5 a deck holding banned cards, or cards not legal in its format, is legal and records
the table options it needs (needs); only tables that allow them take it. A deck last validated
before then is validated again when its owner's deck list is read.

Since v0.4.5 a draft holds only cards the game can play. A card the engine cannot play leaves
every draft when it becomes unplayable (a catalog sync, a staff suspension; withdraw_unplayable)
and whenever a save names it, and the deck notes what left and why until its owner dismisses the
note. Revisions keep their cards: games played them.

Since v0.5.0 a player's deck may hold only the editions their library holds, copy by copy
(api/validation.py). Every save gives the copies that name no edition one the library holds
(library.with_owned_editions); once, when v0.5.0 deployed, the worker switched every player's
drafts to the editions their library holds where it held enough (switch_editions), and the deck
notes what moved until its owner dismisses the note. What could not move stays, and the deck is
collection-locked until it is fixed. Revisions keep their editions.
"""

import hashlib
import json
import secrets
from collections import defaultdict
from collections.abc import Iterable
from datetime import UTC, date, datetime
from typing import Annotated, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi import Path as PathParam
from fastapi.responses import PlainTextResponse, Response
from pydantic import Field
from sqlalchemy import func, not_, select
from sqlalchemy.orm import Session

from api import deckio, guided
from api.auth import INPUT_ERRORS
from api.cards import CardSummary, mark_owned, summaries_by_id
from api.custom_play import HIDDEN_NAME, custom_by_name, custom_ids, deck_cards, without_custom
from api.identity import (
    Active,
    ApiError,
    Db,
    Principal,
    not_found,
    permissions_for,
    require_permission,
    roles_of,
    settings_of,
)
from api.library import (
    CurrentLibrary,
    Library,
    Starter,
    Switch,
    at_godlike,
    commander_printing,
    library_of,
    starter_entries,
    starters_in,
    with_owned_editions,
)
from api.models import (
    CardConcept,
    CardPrinting,
    CatalogRevision,
    CustomCard,
    Deck,
    DeckEntryRow,
    DeckRevision,
    SiteSetting,
    User,
)
from api.roster import Planeswalker, roster_of
from api.schemas import Contract, Error, StoredText, TableOption
from api.validation import (
    MAX_ENTRIES,
    DeckContent,
    DeckEntry,
    GameFormatName,
    Validation,
    custom_identity,
    symbol_colors,
    validate_deck,
)
from catalog.statuses import in_game, unplayable_reason
from catalog.text import colors_of, normalize

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
Builder = Annotated[Principal, Depends(require_permission("decks.edit"))]
MAX_DECKS = 250
MAX_NOTES = 10_000
Title = Annotated[StoredText, Field(min_length=1, max_length=80)]
ShareCode = Annotated[str, PathParam(min_length=8, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")]
# The site setting that says the drafts were switched to owned editions (v0.5.0), once.
SWITCHED = "decks.editions_switched"


class RemovedCard(Contract):
    """A card that left the deck's draft because the game cannot play it (v0.4.5)."""

    name: str
    quantity: int = Field(description="The copies the draft held, every location together.")
    reason: str = Field(description="Why the game cannot play it, in a sentence.")
    removed_at: datetime


class SwitchedEdition(Contract):
    """Copies of a card the draft moved to an edition the library holds, when v0.5.0 deployed."""

    name: str
    quantity: int
    before: str = Field(description='The edition the copies named: "Seventh Edition (7ED #200)".')
    after: str = Field(description="The edition of the library's they name now.")
    switched_at: datetime


class DeckSummary(Contract):
    id: UUID
    title: str
    format: GameFormatName
    visibility: Literal["private", "link"]
    card_count: int
    legal: bool
    playable: bool
    collection_locked: bool = Field(
        description="Legal, but the player's library holds too few copies of a card (v0.3.1)."
    )
    needs: list[TableOption] = Field(
        description="The table options its cards need (v0.4.5): only tables that allow them "
        "take it."
    )
    # The commanders' color identity, or the deck's colors in Legacy, as letters.
    identity: str
    commanders: list[str]
    latest_revision: int | None
    source: str
    archived: bool
    deleted_at: datetime | None
    updated_at: datetime
    removed_cards: list[RemovedCard] = Field(
        description="Cards that left the draft because the game cannot play them (v0.4.5), "
        "until the owner dismisses the note."
    )
    switched_editions: list[SwitchedEdition] | None = Field(
        default=None,
        description="Copies switched to editions the library holds when v0.5.0 deployed, until "
        "the owner dismisses the note; null or empty: none.",
    )


class RevisionSummary(Contract):
    number: int
    title: str
    content_hash: str
    legal: bool
    playable: bool
    format_version: int | None
    catalog_revision: int | None
    created_at: datetime


class Draft(Contract):
    version: int
    entries: list[DeckEntry]


class DeckDetail(DeckSummary):
    notes: str
    share_code: str | None
    draft: Draft
    validation: Validation
    revisions: list[RevisionSummary]
    cards: dict[UUID, CardSummary]


class DeckSource(Contract):
    kind: Literal["empty", "starter", "duplicate", "imported", "guided"] = "empty"
    starter: str | None = Field(default=None, max_length=64)
    deck_id: UUID | None = None


class DeckCreate(Contract):
    title: Title
    format: GameFormatName
    entries: list[DeckEntry] = Field(default_factory=list, max_length=MAX_ENTRIES)
    notes: StoredText = Field(default="", max_length=MAX_NOTES)
    source: DeckSource = Field(default_factory=DeckSource)


class DeckUpdate(Contract):
    title: Title | None = None
    notes: StoredText | None = Field(default=None, max_length=MAX_NOTES)
    visibility: Literal["private", "link"] | None = None


class DraftSave(Contract):
    version: int = Field(ge=1)
    entries: list[DeckEntry] = Field(max_length=MAX_ENTRIES)


class DraftSaved(Contract):
    version: int
    updated_at: datetime
    entries: list[DeckEntry] = Field(
        description="The draft as saved: since v0.5.0 a copy naming no edition takes one the "
        "player's library holds."
    )
    validation: Validation
    cards: dict[UUID, CardSummary]


class RevisionDetail(RevisionSummary):
    format: GameFormatName
    entries: list[DeckEntry]
    cards: dict[UUID, CardSummary]


class SharedDeck(Contract):
    title: str
    format: GameFormatName
    owner: str
    entries: list[DeckEntry]
    cards: dict[UUID, CardSummary]
    validation: Validation
    updated_at: datetime


class StarterDeck(Contract):
    """One of the ten Commander starter decks (v0.3.1). Each player chooses two at onboarding."""

    name: str = Field(description="The starter deck's ID, such as starter_wu_v1.")
    title: str
    format: GameFormatName
    card_count: int
    commanders: list[str]
    playable: bool
    colors: str
    color_names: str
    guild: str
    description: str
    how_to_play: str
    teaches: str
    commander_card_id: UUID | None
    commander_printing_id: UUID | None
    chosen: bool = Field(description="One of the two the player chose.")


class ImportPreview(Contract):
    format: GameFormatName
    title: str | None
    lines: list[deckio.ImportLine]
    entries: list[DeckEntry]
    unresolved: int
    ambiguous: int
    unavailable: int = Field(
        default=0, description="Lines naming a card the game cannot play (v0.4.5)."
    )
    validation: Validation
    cards: dict[UUID, CardSummary]


class GuidedResult(guided.GuidedProposal):
    validation: Validation
    cards: dict[UUID, CardSummary]


class ValidateRequest(Contract):
    format: GameFormatName
    entries: list[DeckEntry] = Field(max_length=MAX_ENTRIES)


def today() -> date:
    return datetime.now(UTC).date()


def now() -> datetime:
    return datetime.now(UTC)


def normalized(entries: list[DeckEntry]) -> list[DeckEntry]:
    """One entry per card, printing and location, in a stable order."""
    totals: dict[tuple[UUID, UUID | None, str], int] = {}
    for entry in entries:
        key = (entry.card_id, entry.printing_id, entry.location)
        totals[key] = min(totals.get(key, 0) + entry.quantity, 250)
    ordered = sorted(
        totals.items(), key=lambda item: (item[0][2], str(item[0][0]), str(item[0][1]))
    )
    return [
        DeckEntry(card_id=card_id, printing_id=printing_id, quantity=quantity, location=location)  # type: ignore[arg-type]
        for (card_id, printing_id, location), quantity in ordered
    ]


def content_hash(fmt: str, entries: list[DeckEntry]) -> str:
    payload = {
        "format": fmt,
        "entries": [entry.model_dump(mode="json") for entry in normalized(entries)],
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def entries_of(deck: Deck) -> list[DeckEntry]:
    raw = (deck.draft or {}).get("entries") or []
    return [DeckEntry.model_validate(item) for item in cast(list[object], raw)]


def commanders_of(db: Session, entries: list[DeckEntry], owner_id: UUID | None = None) -> list[str]:
    """The commanders' names; a custom commander's only while the deck's owner is at the Godlike
    tier."""
    ids = [entry.card_id for entry in entries if entry.location == "commander"]
    if not ids:
        return []
    names = dict(
        db.execute(select(CardConcept.id, CardConcept.name).where(CardConcept.id.in_(ids))).all()
    )
    rest = [card_id for card_id in ids if card_id not in names]
    custom = (
        dict(
            db.execute(select(CustomCard.id, CustomCard.name).where(CustomCard.id.in_(rest))).all()
        )
        if rest
        else {}
    )
    if custom:
        shown = owner_id is not None and at_godlike(db, owner_id)
        names |= {card_id: name if shown else HIDDEN_NAME for card_id, name in custom.items()}
    return [names[card_id] for card_id in ids if card_id in names]


def identity_of(db: Session, fmt: str, entries: list[DeckEntry]) -> str:
    wanted = [
        entry.card_id
        for entry in entries
        if entry.location == ("commander" if fmt == "commander" else "main")
    ]
    if not wanted:
        return ""
    bits = 0
    column = CardConcept.identity_mask if fmt == "commander" else CardConcept.colors_mask
    found = set()
    for card_id, mask in db.execute(
        select(CardConcept.id, column).where(CardConcept.id.in_(wanted))
    ):
        bits |= mask
        found.add(card_id)
    rest = set(wanted) - found
    if rest:
        for cost, text in db.execute(
            select(CustomCard.mana_cost, CustomCard.oracle_text).where(CustomCard.id.in_(rest))
        ):
            bits |= custom_identity(cost, text) if fmt == "commander" else symbol_colors(cost or "")
    return "".join(colors_of(bits))


def locked(validation: Validation) -> bool:
    return any(problem.kind == "collection_locked" for problem in validation.errors)


def store_flags(deck: Deck, validation: Validation) -> None:
    """The draft's validation, kept so a deck list needs none."""
    deck.legal, deck.playable = validation.legal, validation.playable
    deck.collection_locked = locked(validation)
    deck.needs = list(validation.needs)


def without_unplayable(db: Session, deck: Deck, entries: list[DeckEntry]) -> list[DeckEntry]:
    """The entries in the game (since v0.6.2 the stand-ins too). A catalog card out of it leaves
    the draft, every location together, and the deck's note names it and why (the newest removal
    of each card). Custom cards are not the catalog's, and stay."""
    ids = {entry.card_id for entry in entries}
    gone = (
        {
            row.id: row
            for row in db.execute(
                select(
                    CardConcept.id,
                    CardConcept.name,
                    CardConcept.status,
                    CardConcept.status_detail,
                    CardConcept.removed_revision,
                ).where(CardConcept.id.in_(ids), not_(in_game()))
            )
        }
        if ids
        else {}
    )
    if not gone:
        return entries
    copies: dict[UUID, int] = defaultdict(int)
    for entry in entries:
        if entry.card_id in gone:
            copies[entry.card_id] += entry.quantity
    note = {str(item.get("card_id")): item for item in deck.removed_cards or []}
    stamp = now().isoformat()
    for card_id, quantity in copies.items():
        row = gone[card_id]
        note[str(card_id)] = {
            "card_id": str(card_id),
            "name": row.name,
            "quantity": quantity,
            "reason": unplayable_reason(
                row.status, row.status_detail, row.removed_revision is not None
            ),
            "removed_at": stamp,
        }
    deck.removed_cards = list(note.values())
    return [entry for entry in entries if entry.card_id not in gone]


def note_switched(deck: Deck, moved: list[Switch]) -> None:
    """The deck's note of copies switched to an edition the library holds (v0.5.0)."""
    stamp = now().isoformat()
    deck.switched_editions = [
        *(deck.switched_editions or []),
        *(
            {
                "card_id": str(item.card_id),
                "name": item.name,
                "quantity": item.quantity,
                "before": item.before,
                "after": item.after,
                "switched_at": stamp,
            }
            for item in moved
        ),
    ]


def store_draft(
    db: Session,
    deck: Deck,
    entries: list[DeckEntry],
    library: Library | None,
    *,
    switch: bool = False,
) -> Validation:
    """Saves the draft: only cards the game can play (v0.4.5), and for a player's deck the
    editions their library holds where a copy names none (v0.5.0); switch also moves copies of an
    edition the library holds too few of, and notes it (switch_editions)."""
    clean = without_unplayable(db, deck, normalized(entries))
    if library is not None:
        owned, moved = with_owned_editions(db, clean, library, switch=switch)
        clean = normalized(owned)
        if moved:
            note_switched(deck, moved)
    validation = validate_deck(
        db,
        DeckContent(format=deck.format, entries=clean),  # type: ignore[arg-type]
        today(),
        library.collection() if library else None,
    )
    deck.draft = {"entries": [entry.model_dump(mode="json") for entry in clean]}
    deck.draft_hash = content_hash(deck.format, clean)
    counts = validation.counts
    deck.card_count = counts.main + counts.commander
    store_flags(deck, validation)
    deck.identity = identity_of(db, deck.format, clean)
    deck.updated_at = now()
    return validation


def owned(db: Session, principal: Principal, deck_id: UUID, *, trashed: bool = False) -> Deck:
    deck = db.get(Deck, deck_id)
    if deck is None or deck.owner_id != principal.user.id:
        raise not_found()
    if (deck.deleted_at is not None) != trashed:
        raise not_found()
    return deck


def deck_summary(db: Session, deck: Deck) -> DeckSummary:
    return DeckSummary(
        id=deck.id,
        title=deck.title,
        format=deck.format,  # type: ignore[arg-type]
        visibility=deck.visibility,  # type: ignore[arg-type]
        card_count=deck.card_count,
        legal=deck.legal,
        playable=deck.playable,
        collection_locked=deck.collection_locked,
        needs=cast(list[TableOption], deck.needs or []),
        identity=deck.identity,
        commanders=commanders_of(db, entries_of(deck), deck.owner_id),
        latest_revision=deck.latest_revision,
        source=deck.source,
        archived=deck.archived_at is not None,
        deleted_at=deck.deleted_at,
        updated_at=deck.updated_at,
        removed_cards=[
            RemovedCard.model_validate({key: item.get(key) for key in RemovedCard.model_fields})
            for item in deck.removed_cards or []
        ],
        switched_editions=[
            SwitchedEdition.model_validate(
                {key: item.get(key) for key in SwitchedEdition.model_fields}
            )
            for item in deck.switched_editions or []
        ],
    )


def revision_summary(revision: DeckRevision) -> RevisionSummary:
    return RevisionSummary(
        number=revision.number,
        title=revision.title,
        content_hash=revision.content_hash,
        legal=revision.legal,
        playable=revision.playable,
        format_version=revision.format_version,
        catalog_revision=revision.catalog_revision_id,
        created_at=revision.created_at,
    )


def deck_detail(
    db: Session, deck: Deck, library: Library, validation: Validation | None = None
) -> DeckDetail:
    entries = entries_of(deck)
    if validation is None:
        validation = validate_deck(
            db,
            DeckContent(format=deck.format, entries=entries),  # type: ignore[arg-type]
            today(),
            library.collection(),
        )
    cards = deck_cards(db, {entry.card_id for entry in entries}, library)
    revisions = db.scalars(
        select(DeckRevision)
        .where(DeckRevision.deck_id == deck.id)
        .order_by(DeckRevision.number.desc())
    )
    return DeckDetail(
        **deck_summary(db, deck).model_dump(),
        notes=deck.notes,
        share_code=deck.share_code if deck.visibility == "link" else None,
        draft=Draft(version=deck.draft_version, entries=entries),
        validation=validation,
        revisions=[revision_summary(revision) for revision in revisions],
        cards=cards,
    )


def count_decks(db: Session, user_id: UUID) -> int:
    return db.scalar(select(func.count()).select_from(Deck).where(Deck.owner_id == user_id)) or 0


def create_deck(
    db: Session,
    principal: Principal,
    title: str,
    fmt: str,
    entries: list[DeckEntry],
    library: Library | None,
    *,
    notes: str = "",
    source: str = "empty",
) -> tuple[Deck, Validation]:
    if count_decks(db, principal.user.id) >= MAX_DECKS:
        raise ApiError(
            409, "deck_limit", f"An account keeps at most {MAX_DECKS} decks, the trash included."
        )
    stamp = now()
    deck = Deck(
        owner_id=principal.user.id,
        title=title,
        format=fmt,
        visibility="private",
        notes=notes,
        draft={},
        draft_version=1,
        draft_hash="",
        source=source,
        created_at=stamp,
        updated_at=stamp,
    )
    db.add(deck)
    validation = store_draft(db, deck, entries, library)
    db.flush()
    return deck, validation


def revalidate(db: Session, decks: Iterable[Deck], library: Library) -> None:
    """Validates the decks again with their owner's library, and keeps the flags."""
    for deck in decks:
        validation = validate_deck(
            db,
            DeckContent(format=deck.format, entries=entries_of(deck)),  # type: ignore[arg-type]
            today(),
            library.collection(),
        )
        store_flags(deck, validation)


def refresh_decks(db: Session, user_id: UUID, library: Library) -> None:
    """Revalidates the account's decks after its library changed, so each deck's stored flags
    say whether it can start a game now."""
    revalidate(
        db,
        db.scalars(select(Deck).where(Deck.owner_id == user_id, Deck.deleted_at.is_(None))),
        library,
    )


def withdraw_unplayable(db: Session, roster: dict[str, Planeswalker]) -> int:
    """Takes every card out of the game (since v0.6.2 a stand-in is in it) out of the decks'
    drafts, the archived and trashed ones too (v0.4.5): after a catalog sync, a staff suspension,
    and once each time the worker starts, which is each deploy. A deck that loses one notes it,
    gets a new draft version, so an editor open elsewhere shows the change rather than saving over
    it, and has its flags refreshed against its owner's library. Revisions keep their cards.
    Returns how many decks changed."""
    # Drafts store card IDs as text.
    unplayable = {str(card) for card in db.scalars(select(CardConcept.id).where(not_(in_game())))}
    holding = [
        deck_id
        for deck_id, draft in db.execute(select(Deck.id, Deck.draft))
        if any(
            str(entry.get("card_id")) in unplayable
            for entry in cast(list[dict[str, object]], (draft or {}).get("entries") or [])
        )
    ]
    libraries: dict[UUID, Library] = {}
    for deck_id in holding:
        deck = db.scalar(select(Deck).where(Deck.id == deck_id).with_for_update())
        if deck is None:
            continue
        if deck.owner_id not in libraries:
            owner = db.get_one(User, deck.owner_id)
            permissions = permissions_for(owner, roles_of(db, owner))
            libraries[deck.owner_id] = library_of(db, owner, permissions, roster)
        store_draft(db, deck, entries_of(deck), libraries[deck.owner_id])
        deck.draft_version += 1
    db.flush()
    return len(holding)


def switch_editions(db: Session, roster: dict[str, Planeswalker]) -> int | None:
    """Once, when v0.5.0 deployed (the worker's start): every deck draft of an account that builds
    from a library, the archived and trashed ones too, in the editions the library holds where it
    holds enough copies (library.with_owned_editions with switch). A deck that changes notes what
    moved, gets a new draft version, as withdraw_unplayable's do, and its flags; one that does not
    has its flags refreshed, so a deck that keeps an edition the library lacks shows as
    collection-locked. Revisions keep their editions. The site setting SWITCHED records that it ran,
    in the same transaction: a second worker starting at once waits on it, then fails to write it
    and changes nothing. Returns how many decks changed, or None when it ran before."""
    if db.get(SiteSetting, SWITCHED) is not None:
        return None
    marker = SiteSetting(key=SWITCHED, value={"at": now().isoformat()}, updated_at=now())
    db.add(marker)
    db.flush()
    libraries: dict[UUID, Library] = {}
    changed = 0
    for deck in db.scalars(select(Deck).order_by(Deck.created_at).with_for_update()):
        if deck.owner_id not in libraries:
            owner = db.get_one(User, deck.owner_id)
            permissions = permissions_for(owner, roles_of(db, owner))
            libraries[deck.owner_id] = library_of(db, owner, permissions, roster)
        library = libraries[deck.owner_id]
        if library.unlimited:
            continue
        entries = entries_of(deck)
        owned, _ = with_owned_editions(db, normalized(entries), library, switch=True)
        if content_hash(deck.format, owned) == content_hash(deck.format, entries):
            revalidate(db, [deck], library)
            continue
        store_draft(db, deck, entries, library, switch=True)
        deck.draft_version += 1
        changed += 1
    marker.value = {"at": now().isoformat(), "decks": changed}
    db.flush()
    return changed


def publish(db: Session, deck: Deck, library: Library) -> DeckRevision:
    """The draft as an immutable revision; the latest one when the draft has not changed. Its
    flags record the deck as it stood then; a game revalidates it against the library."""
    entries = normalized(entries_of(deck))
    digest = content_hash(deck.format, entries)
    if deck.latest_revision is not None:
        latest = db.scalar(
            select(DeckRevision).where(
                DeckRevision.deck_id == deck.id, DeckRevision.number == deck.latest_revision
            )
        )
        if latest is not None and latest.content_hash == digest and latest.title == deck.title:
            return latest
    validation = validate_deck(
        db,
        DeckContent(format=deck.format, entries=entries),  # type: ignore[arg-type]
        today(),
        library.collection(),
    )
    catalog = db.scalar(select(func.max(CatalogRevision.id)))
    revision = DeckRevision(
        deck_id=deck.id,
        number=(deck.latest_revision or 0) + 1,
        format=deck.format,
        title=deck.title,
        notes=deck.notes,
        content_hash=digest,
        catalog_revision_id=catalog,
        format_version=validation.format_version,
        legal=validation.legal,
        playable=validation.playable,
        created_at=now(),
    )
    db.add(revision)
    db.flush()
    custom = custom_ids(db, (entry.card_id for entry in entries))
    for entry in entries:
        held = entry.card_id in custom
        db.add(
            DeckEntryRow(
                revision_id=revision.id,
                concept_id=None if held else entry.card_id,
                custom_card_id=entry.card_id if held else None,
                printing_id=entry.printing_id,
                quantity=entry.quantity,
                location=entry.location,
            )
        )
    deck.latest_revision = revision.number
    db.flush()
    return revision


def revision_entries(db: Session, revision: DeckRevision) -> list[DeckEntry]:
    rows = db.scalars(select(DeckEntryRow).where(DeckEntryRow.revision_id == revision.id))
    return normalized(
        [
            DeckEntry(
                card_id=row.concept_id or row.custom_card_id,  # type: ignore[arg-type]
                printing_id=row.printing_id,
                quantity=row.quantity,
                location=row.location,  # type: ignore[arg-type]
            )
            for row in rows
        ]
    )


# Starter decks: the ten Commander decks players choose from (content/starter-decks.json).


def starters_of(request: Request) -> dict[str, Starter]:
    return starters_in(settings_of(request).content_dir)


def starter_deck(
    db: Session, starter: Starter, library: Library, chosen: list[str] | None
) -> StarterDeck:
    entries, missing = starter_entries(db, starter)
    validation = validate_deck(
        db, DeckContent(format="commander", entries=entries), today(), library.collection()
    )
    leader, printing = commander_printing(db, entries)
    return StarterDeck(
        name=starter.id,
        title=starter.title,
        format="commander",
        card_count=validation.counts.main + validation.counts.commander,
        commanders=commanders_of(db, entries),
        playable=validation.playable and not missing,
        colors=starter.colors,
        color_names=starter.color_names,
        guild=starter.guild,
        description=starter.description,
        how_to_play=starter.how_to_play,
        teaches=starter.teaches,
        commander_card_id=leader,
        commander_printing_id=printing,
        chosen=starter.id in (chosen or []),
    )


@router.get("/decks/starters", response_model=list[StarterDeck])
def starters(
    request: Request, principal: Builder, library: CurrentLibrary, db: Db
) -> list[StarterDeck]:
    """The ten starter decks. "playable" counts the player's own library: a deck they did not
    choose holds cards they do not own."""
    chosen = principal.user.starter_decks
    return [starter_deck(db, starter, library, chosen) for starter in starters_of(request).values()]


# Routes.


@router.get("/decks", response_model=list[DeckSummary])
def list_decks(
    request: Request,
    principal: Builder,
    db: Db,
    view: Literal["active", "archived", "trash"] = "active",
) -> list[DeckSummary]:
    query = select(Deck).where(Deck.owner_id == principal.user.id)
    if view == "trash":
        query = query.where(Deck.deleted_at.is_not(None))
    else:
        query = query.where(Deck.deleted_at.is_(None))
        query = query.where(
            Deck.archived_at.is_not(None) if view == "archived" else Deck.archived_at.is_(None)
        )
    decks = list(db.scalars(query.order_by(Deck.updated_at.desc())))
    # A deck last validated before v0.4.5 is validated again, once: a banned card, or one not
    # legal in the format, no longer makes it illegal, and the tables ask which options it needs.
    stale = [deck for deck in decks if deck.needs is None]
    if stale:
        roster = roster_of(request)
        revalidate(db, stale, library_of(db, principal.user, principal.permissions, roster))
    summaries = [deck_summary(db, deck) for deck in decks]
    if stale:
        db.commit()
    return summaries


@router.post("/decks", response_model=DeckDetail, status_code=201)
def create(
    body: DeckCreate, request: Request, principal: Builder, library: CurrentLibrary, db: Db
) -> DeckDetail:
    """A new deck: empty, from the given entries (an import or a guided build), a copy of a starter
    deck, or a duplicate of one of the player's own."""
    entries, notes, title, fmt = body.entries, body.notes, body.title, body.format
    kind = body.source.kind
    if kind == "starter":
        if body.source.starter is None:
            raise ApiError(422, "invalid_source", "Name the starter deck to copy.")
        starter = starters_of(request).get(body.source.starter)
        if starter is None:
            raise not_found()
        entries, _ = starter_entries(db, starter)
        fmt = "commander"
    elif kind == "duplicate":
        if body.source.deck_id is None:
            raise ApiError(422, "invalid_source", "Name the deck to duplicate.")
        original = owned(db, principal, body.source.deck_id)
        entries, notes, fmt = (
            entries_of(original),
            original.notes,
            cast(GameFormatName, original.format),
        )
    deck, validation = create_deck(
        db, principal, title, fmt, entries, library, notes=notes, source=kind
    )
    db.commit()
    return deck_detail(db, deck, library, validation)


@router.get("/decks/{deck_id}", response_model=DeckDetail)
def read_deck(deck_id: UUID, principal: Builder, library: CurrentLibrary, db: Db) -> DeckDetail:
    return deck_detail(db, owned(db, principal, deck_id), library)


@router.patch("/decks/{deck_id}", response_model=DeckDetail)
def update_deck(
    deck_id: UUID, body: DeckUpdate, principal: Builder, library: CurrentLibrary, db: Db
) -> DeckDetail:
    deck = owned(db, principal, deck_id)
    if body.title is not None:
        deck.title = body.title
    if body.notes is not None:
        deck.notes = body.notes
    if body.visibility is not None and body.visibility != deck.visibility:
        deck.visibility = body.visibility
        # A new link each time sharing starts, so turning it off and on again ends old links.
        deck.share_code = secrets.token_urlsafe(12) if body.visibility == "link" else None
    deck.updated_at = now()
    db.commit()
    return deck_detail(db, deck, library)


@router.put(
    "/decks/{deck_id}/draft",
    response_model=DraftSaved,
    responses={409: {"model": Error}},
)
def save_draft(
    deck_id: UUID, body: DraftSave, principal: Builder, library: CurrentLibrary, db: Db
) -> DraftSaved:
    """Autosave. version is the draft version this edit started from."""
    deck = db.scalar(select(Deck).where(Deck.id == deck_id).with_for_update())
    if deck is None or deck.owner_id != principal.user.id or deck.deleted_at is not None:
        raise not_found()
    if body.version != deck.draft_version:
        raise ApiError(
            409,
            "draft_conflict",
            "This deck changed in another tab or window. Your changes are kept here: compare "
            "them with the saved deck and choose what to keep.",
        )
    validation = store_draft(db, deck, body.entries, library)
    deck.draft_version += 1
    db.commit()
    cards = deck_cards(db, {entry.card_id for entry in body.entries}, library)
    return DraftSaved(
        version=deck.draft_version,
        updated_at=deck.updated_at,
        entries=entries_of(deck),
        validation=validation,
        cards=cards,
    )


@router.post("/decks/{deck_id}/revisions", response_model=RevisionSummary, status_code=201)
def save_revision(
    deck_id: UUID, principal: Builder, library: CurrentLibrary, db: Db
) -> RevisionSummary:
    revision = publish(db, owned(db, principal, deck_id), library)
    db.commit()
    return revision_summary(revision)


@router.get("/decks/{deck_id}/revisions/{number}", response_model=RevisionDetail)
def read_revision(
    deck_id: UUID, number: int, principal: Builder, library: CurrentLibrary, db: Db
) -> RevisionDetail:
    deck = owned(db, principal, deck_id)
    revision = db.scalar(
        select(DeckRevision).where(DeckRevision.deck_id == deck.id, DeckRevision.number == number)
    )
    if revision is None:
        raise not_found()
    entries = revision_entries(db, revision)
    cards = deck_cards(db, {entry.card_id for entry in entries}, library)
    for card in cards.values():
        card.owned = None
    return RevisionDetail(
        **revision_summary(revision).model_dump(),
        format=revision.format,  # type: ignore[arg-type]
        entries=entries,
        cards=cards,
    )


@router.post("/decks/{deck_id}/archive", response_model=DeckSummary)
def archive(deck_id: UUID, principal: Builder, db: Db) -> DeckSummary:
    deck = owned(db, principal, deck_id)
    deck.archived_at = deck.archived_at or now()
    db.commit()
    return deck_summary(db, deck)


@router.post("/decks/{deck_id}/unarchive", response_model=DeckSummary)
def unarchive(deck_id: UUID, principal: Builder, db: Db) -> DeckSummary:
    deck = owned(db, principal, deck_id)
    deck.archived_at = None
    db.commit()
    return deck_summary(db, deck)


@router.delete("/decks/{deck_id}", response_model=DeckSummary)
def delete(deck_id: UUID, principal: Builder, db: Db) -> DeckSummary:
    """Moves the deck to the trash. Its link stops working; games that used it keep their copy."""
    deck = owned(db, principal, deck_id)
    deck.deleted_at = now()
    deck.visibility, deck.share_code = "private", None
    db.commit()
    return deck_summary(db, deck)


@router.post("/decks/{deck_id}/restore", response_model=DeckSummary)
def restore(deck_id: UUID, principal: Builder, db: Db) -> DeckSummary:
    deck = owned(db, principal, deck_id, trashed=True)
    deck.deleted_at = None
    db.commit()
    return deck_summary(db, deck)


@router.delete("/decks/{deck_id}/removed-cards", response_model=DeckSummary)
def dismiss_removed(deck_id: UUID, principal: Builder, db: Db) -> DeckSummary:
    """Dismisses the deck's note of the cards that left its draft (v0.4.5)."""
    deck = owned(db, principal, deck_id)
    deck.removed_cards = []
    db.commit()
    return deck_summary(db, deck)


@router.delete("/decks/{deck_id}/switched-editions", response_model=DeckSummary)
def dismiss_switched(deck_id: UUID, principal: Builder, db: Db) -> DeckSummary:
    """Dismisses the deck's note of the copies switched to editions the library holds (v0.5.0)."""
    deck = owned(db, principal, deck_id)
    deck.switched_editions = []
    db.commit()
    return deck_summary(db, deck)


@router.post("/decks/validate", response_model=Validation)
def validate_entries(
    body: ValidateRequest, principal: Builder, library: CurrentLibrary, db: Db
) -> Validation:
    return validate_deck(
        db,
        DeckContent(format=body.format, entries=normalized(body.entries)),
        today(),
        library.collection(),
    )


@router.post("/decks/guided", response_model=GuidedResult)
def guided_deck(
    body: guided.GuidedRequest, principal: Builder, library: CurrentLibrary, db: Db
) -> GuidedResult:
    """A proposed starting deck (DECK06), from the cards the player's library holds, in the
    editions it holds (v0.5.0). Nothing is saved: create a deck from its entries."""
    proposal = guided.propose(db, body, library)
    proposal.entries, _ = with_owned_editions(db, proposal.entries, library)
    validation = validate_deck(
        db,
        DeckContent(format=body.format, entries=proposal.entries),
        today(),
        library.collection(),
    )
    cards = summaries_by_id(db, {entry.card_id for entry in proposal.entries})
    mark_owned(db, cards.values(), library)
    return GuidedResult(**proposal.model_dump(), validation=validation, cards=cards)


@router.post("/decks/import/preview", response_model=ImportPreview)
def import_preview(
    body: deckio.ImportRequest, principal: Builder, library: CurrentLibrary, db: Db
) -> ImportPreview:
    """Reads a text list or a deck file and shows how each line resolves. Saves nothing. Since
    v0.5.0 a player's copies naming no edition take the editions their library holds, as the deck
    made from them will; a line naming an edition it does not hold keeps it, and the validation
    says which to switch to."""
    if bool(body.text.strip()) == bool(body.json_text.strip()):
        raise ApiError(422, "invalid_deck_list", "Send a text list or a deck file.")
    parsed = (
        deckio.parse_text(body.text, body.format)
        if body.text.strip()
        else deckio.parse_json(body.json_text)
    )
    fmt = body.format
    if parsed.game_format in ("legacy", "commander"):
        fmt = cast(GameFormatName, parsed.game_format)
    # A Godlike owner's list may name custom cards; nobody else's ever matches one.
    lines = deckio.resolve(db, parsed, custom_by_name(db) if library.godlike else None)
    entries, _ = with_owned_editions(db, deckio.merged(lines), library)
    validation = validate_deck(
        db, DeckContent(format=fmt, entries=entries), today(), library.collection()
    )
    cards = deck_cards(db, {entry.card_id for entry in entries}, library)
    return ImportPreview(
        format=fmt,
        title=parsed.title,
        lines=lines,
        entries=entries,
        unresolved=sum(1 for line in lines if line.status == "unresolved"),
        ambiguous=sum(1 for line in lines if line.status == "ambiguous"),
        unavailable=sum(1 for line in lines if line.status == "unavailable"),
        validation=validation,
        cards=cards,
    )


def export_data(
    db: Session, entries: list[DeckEntry], custom: bool = False
) -> tuple[dict[UUID, deckio.Exported], dict[UUID, CardPrinting]]:
    """The cards and printings an export names; custom cards by name only, for their Godlike
    owner (custom), else not at all."""
    ids = {entry.card_id for entry in entries}
    cards = {
        card.id: deckio.Exported(card.name, card.normalized_name, card.oracle_id)
        for card in db.scalars(select(CardConcept).where(CardConcept.id.in_(ids)))
    }
    if custom and ids - cards.keys():
        for card_id, name in db.execute(
            select(CustomCard.id, CustomCard.name).where(CustomCard.id.in_(ids - cards.keys()))
        ):
            cards[card_id] = deckio.Exported(name, normalize(name), None)
    chosen = {entry.printing_id for entry in entries if entry.printing_id}
    printings = (
        {p.id: p for p in db.scalars(select(CardPrinting).where(CardPrinting.id.in_(chosen)))}
        if chosen
        else {}
    )
    return cards, printings


def exported(
    title: str,
    fmt: str,
    entries: list[DeckEntry],
    db: Session,
    notes: str | None,
    kind: str,
    custom: bool = False,
) -> Response:
    cards, printings = export_data(db, entries, custom)
    stem = normalize(title).replace(" ", "-")[:40] or "deck"
    if kind == "json":
        body = deckio.export_json(title, fmt, entries, cards, printings, notes)
        return Response(
            json.dumps(body, ensure_ascii=False, indent=2),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{stem}.json"'},
        )
    return PlainTextResponse(
        deckio.export_text(title, entries, cards, printings),
        headers={"Content-Disposition": f'attachment; filename="{stem}.txt"'},
    )


@router.get("/decks/{deck_id}/export", response_class=Response)
def export_deck(
    deck_id: UUID, principal: Builder, db: Db, kind: Literal["text", "json"] = "text"
) -> Response:
    """The owner's deck as a file, its custom cards by name while the owner is at the Godlike
    tier."""
    deck = owned(db, principal, deck_id)
    custom = at_godlike(db, principal.user.id)
    return exported(deck.title, deck.format, entries_of(deck), db, deck.notes, kind, custom)


def shared(db: Session, code: str) -> Deck:
    deck = db.scalar(select(Deck).where(Deck.share_code == code))
    if deck is None or deck.visibility != "link" or deck.deleted_at is not None:
        raise not_found()
    return deck


@router.get("/shared-decks/{code}", response_model=SharedDeck)
def read_shared(code: ShareCode, principal: Active, library: CurrentLibrary, db: Db) -> SharedDeck:
    """A deck shared by link, for anyone signed in: its cards, not its notes (DECK11), and never
    its custom cards. It is validated against the viewer's library, as a copy of it would be."""
    deck = shared(db, code)
    owner = db.get(User, deck.owner_id)
    entries = without_custom(db, entries_of(deck))
    cards = summaries_by_id(db, {entry.card_id for entry in entries})
    mark_owned(db, cards.values(), library)
    return SharedDeck(
        title=deck.title,
        format=deck.format,  # type: ignore[arg-type]
        owner=(owner.handle or owner.display_name) if owner else "",
        entries=entries,
        cards=cards,
        validation=validate_deck(
            db,
            DeckContent(format=deck.format, entries=entries),  # type: ignore[arg-type]
            today(),
            library.collection(),
        ),
        updated_at=deck.updated_at,
    )


@router.get("/shared-decks/{code}/export", response_class=Response)
def export_shared(
    code: ShareCode, principal: Active, db: Db, kind: Literal["text", "json"] = "text"
) -> Response:
    deck = shared(db, code)
    return exported(deck.title, deck.format, without_custom(db, entries_of(deck)), db, None, kind)


@router.post("/shared-decks/{code}/copy", response_model=DeckDetail, status_code=201)
def copy_shared(code: ShareCode, principal: Builder, library: CurrentLibrary, db: Db) -> DeckDetail:
    """Copies a shared deck into the viewer's own decks, without its owner's notes or custom
    cards."""
    deck = shared(db, code)
    copied, validation = create_deck(
        db,
        principal,
        deck.title[:73] + " (copy)",
        deck.format,
        without_custom(db, entries_of(deck)),
        library,
        source="duplicate",
    )
    db.commit()
    return deck_detail(db, copied, library, validation)
