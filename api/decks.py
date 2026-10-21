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
"""

import hashlib
import json
import secrets
from datetime import UTC, date, datetime
from typing import Annotated, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi import Path as PathParam
from fastapi.responses import PlainTextResponse, Response
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api import deckio, guided
from api.auth import INPUT_ERRORS
from api.cards import CardSummary, mark_owned, summaries_by_id
from api.identity import (
    Active,
    ApiError,
    Db,
    Principal,
    not_found,
    require_permission,
    settings_of,
)
from api.library import CurrentLibrary, Library, Starter, starter_entries, starters_in
from api.models import (
    CardConcept,
    CardPrinting,
    CatalogRevision,
    Deck,
    DeckEntryRow,
    DeckRevision,
    User,
)
from api.schemas import Contract, Error, StoredText
from api.validation import (
    MAX_ENTRIES,
    DeckContent,
    DeckEntry,
    GameFormatName,
    Validation,
    validate_deck,
)
from catalog.text import colors_of, normalize

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
Builder = Annotated[Principal, Depends(require_permission("decks.edit"))]
MAX_DECKS = 250
MAX_NOTES = 10_000
Title = Annotated[StoredText, Field(min_length=1, max_length=80)]
ShareCode = Annotated[str, PathParam(min_length=8, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")]


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
    # The commanders' color identity, or the deck's colors in Legacy, as letters.
    identity: str
    commanders: list[str]
    latest_revision: int | None
    source: str
    archived: bool
    deleted_at: datetime | None
    updated_at: datetime


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


def commanders_of(db: Session, entries: list[DeckEntry]) -> list[str]:
    ids = [entry.card_id for entry in entries if entry.location == "commander"]
    if not ids:
        return []
    names = dict(
        db.execute(select(CardConcept.id, CardConcept.name).where(CardConcept.id.in_(ids))).all()
    )
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
    for (mask,) in db.execute(select(column).where(CardConcept.id.in_(wanted))):
        bits |= mask
    return "".join(colors_of(bits))


def locked(validation: Validation) -> bool:
    return any(problem.kind == "collection_locked" for problem in validation.errors)


def store_draft(
    db: Session, deck: Deck, entries: list[DeckEntry], library: Library | None
) -> Validation:
    clean = normalized(entries)
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
    deck.legal = validation.legal
    deck.playable = validation.playable
    deck.collection_locked = locked(validation)
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
        identity=deck.identity,
        commanders=commanders_of(db, entries_of(deck)),
        latest_revision=deck.latest_revision,
        source=deck.source,
        archived=deck.archived_at is not None,
        deleted_at=deck.deleted_at,
        updated_at=deck.updated_at,
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
    cards = summaries_by_id(db, {entry.card_id for entry in entries})
    mark_owned(db, cards.values(), library)
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


def refresh_decks(db: Session, user_id: UUID, library: Library) -> None:
    """Revalidates the account's decks after its library changed, so each deck's stored flags
    say whether it can start a game now."""
    for deck in db.scalars(select(Deck).where(Deck.owner_id == user_id, Deck.deleted_at.is_(None))):
        validation = validate_deck(
            db,
            DeckContent(format=deck.format, entries=entries_of(deck)),  # type: ignore[arg-type]
            today(),
            library.collection(),
        )
        deck.legal, deck.playable = validation.legal, validation.playable
        deck.collection_locked = locked(validation)


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
    for entry in entries:
        db.add(
            DeckEntryRow(
                revision_id=revision.id,
                concept_id=entry.card_id,
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
                card_id=row.concept_id,
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
    leader = next((entry for entry in entries if entry.location == "commander"), None)
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
        commander_card_id=leader.card_id if leader else None,
        commander_printing_id=leader.printing_id if leader else None,
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
    decks = db.scalars(query.order_by(Deck.updated_at.desc()))
    return [deck_summary(db, deck) for deck in decks]


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
    cards = summaries_by_id(db, {entry.card_id for entry in body.entries})
    mark_owned(db, cards.values(), library)
    return DraftSaved(
        version=deck.draft_version,
        updated_at=deck.updated_at,
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
def read_revision(deck_id: UUID, number: int, principal: Builder, db: Db) -> RevisionDetail:
    deck = owned(db, principal, deck_id)
    revision = db.scalar(
        select(DeckRevision).where(DeckRevision.deck_id == deck.id, DeckRevision.number == number)
    )
    if revision is None:
        raise not_found()
    entries = revision_entries(db, revision)
    return RevisionDetail(
        **revision_summary(revision).model_dump(),
        format=revision.format,  # type: ignore[arg-type]
        entries=entries,
        cards=summaries_by_id(db, {entry.card_id for entry in entries}),
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
    """A proposed starting deck (DECK06), from the cards the player's library holds. Nothing is
    saved: create a deck from its entries."""
    proposal = guided.propose(db, body, library)
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
    """Reads a text list or a deck file and shows how each line resolves. Saves nothing."""
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
    lines = deckio.resolve(db, parsed)
    entries = deckio.merged(lines)
    validation = validate_deck(
        db, DeckContent(format=fmt, entries=entries), today(), library.collection()
    )
    cards = summaries_by_id(db, {entry.card_id for entry in entries})
    mark_owned(db, cards.values(), library)
    return ImportPreview(
        format=fmt,
        title=parsed.title,
        lines=lines,
        entries=entries,
        unresolved=sum(1 for line in lines if line.status == "unresolved"),
        ambiguous=sum(1 for line in lines if line.status == "ambiguous"),
        validation=validation,
        cards=cards,
    )


def export_data(
    db: Session, entries: list[DeckEntry]
) -> tuple[dict[UUID, CardConcept], dict[UUID, CardPrinting]]:
    ids = {entry.card_id for entry in entries}
    cards = {
        card.id: card for card in db.scalars(select(CardConcept).where(CardConcept.id.in_(ids)))
    }
    chosen = {entry.printing_id for entry in entries if entry.printing_id}
    printings = (
        {p.id: p for p in db.scalars(select(CardPrinting).where(CardPrinting.id.in_(chosen)))}
        if chosen
        else {}
    )
    return cards, printings


def exported(
    title: str, fmt: str, entries: list[DeckEntry], db: Session, notes: str | None, kind: str
) -> Response:
    cards, printings = export_data(db, entries)
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
    deck = owned(db, principal, deck_id)
    return exported(deck.title, deck.format, entries_of(deck), db, deck.notes, kind)


def shared(db: Session, code: str) -> Deck:
    deck = db.scalar(select(Deck).where(Deck.share_code == code))
    if deck is None or deck.visibility != "link" or deck.deleted_at is not None:
        raise not_found()
    return deck


@router.get("/shared-decks/{code}", response_model=SharedDeck)
def read_shared(code: ShareCode, principal: Active, library: CurrentLibrary, db: Db) -> SharedDeck:
    """A deck shared by link, for anyone signed in: its cards, not its notes (DECK11). It is
    validated against the viewer's library, as a copy of it would be."""
    deck = shared(db, code)
    owner = db.get(User, deck.owner_id)
    entries = entries_of(deck)
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
    return exported(deck.title, deck.format, entries_of(deck), db, None, kind)


@router.post("/shared-decks/{code}/copy", response_model=DeckDetail, status_code=201)
def copy_shared(code: ShareCode, principal: Builder, library: CurrentLibrary, db: Db) -> DeckDetail:
    """Copies a shared deck into the viewer's own decks, without its owner's notes."""
    deck = shared(db, code)
    copied, validation = create_deck(
        db,
        principal,
        deck.title[:73] + " (copy)",
        deck.format,
        entries_of(deck),
        library,
        source="duplicate",
    )
    db.commit()
    return deck_detail(db, copied, library, validation)
