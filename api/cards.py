"""The card catalog through the API: search, card details, sets, the catalog's state and its
administration (CAT07, DECK03, DECK04).

Every search runs against the local catalog; no request reaches Scryfall. Results are card
concepts, one per card whatever its printings, with the printing shown by default; a card's
printings are listed with it. Every card shows its status, and a card the engine cannot play
says why (CAT07). Search takes structured filters, the search syntax (api/search.py), or both.
"""

import time
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field
from sqlalchemy import ColumnElement, Select, and_, func, select
from sqlalchemy.orm import Session

from api.auth import INPUT_ERRORS
from api.identity import Active, ApiError, Db, Principal, audit, not_found, require_permission
from api.models import (
    CardConcept,
    CardFace,
    CardPrinting,
    CardRelation,
    CardRuling,
    CardTag,
    CardTagLink,
    CatalogChange,
    CatalogRevision,
    CatalogSyncRun,
    FormatVersion,
    ScheduledJob,
)
from api.schemas import Contract
from api.search import Compiler, Leaf, SearchError, condition
from catalog import sync

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
Manager = Annotated[Principal, Depends(require_permission("catalog.manage"))]
PAGE_SIZE = 60
MAX_PAGE_SIZE = 100
MAX_PRINTINGS = 60
# A catalog without a successful sync for this long is shown as stale.
STALE_AFTER = timedelta(hours=48)


class FaceSummary(Contract):
    name: str
    mana_cost: str | None = None
    type_line: str | None = None
    oracle_text: str | None = None
    power: str | None = None
    toughness: str | None = None
    loyalty: str | None = None
    defense: str | None = None


class CardImageRef(Contract):
    """The printing whose image stands for the card, how many faces have their own, and the
    artist of the image shown first (the card's, or its front face's)."""

    printing_id: UUID
    faces: int = 0
    artist: str | None = None


class CardSummary(Contract):
    id: UUID
    name: str
    layout: str
    mana_cost: str | None
    mana_value: float
    type_line: str
    oracle_text: str
    power: str | None
    toughness: str | None
    loyalty: str | None
    defense: str | None
    colors: list[str]
    color_identity: list[str]
    keywords: list[str]
    produced_mana: list[str]
    faces: list[FaceSummary]
    rarity: str | None
    set_code: str | None
    released_at: date | None
    status: str
    status_reason: str | None
    status_detail: str | None
    # Certified: a game can be started with it.
    playable: bool
    # The engine's wording may differ from today's Oracle text (CAT08).
    text_differs: bool
    legalities: dict[str, str]
    commander: bool
    partner: str | None
    companion: bool
    copy_limit: int | None
    edhrec_rank: int | None
    image: CardImageRef | None


class CardPage(Contract):
    items: list[CardSummary]
    total: int
    page: int
    page_size: int
    milliseconds: int


class PrintingSummary(Contract):
    id: UUID
    set_code: str
    set_name: str
    collector_number: str
    lang: str
    released_at: date | None
    rarity: str
    finishes: list[str]
    frame: str | None
    promo: bool
    digital: bool
    artist: str | None
    faces: int
    removed: bool


class Ruling(Contract):
    source: str
    published_at: date
    comment: str


class Related(Contract):
    component: str
    name: str
    type_line: str | None


class CardDetail(CardSummary):
    engine_name: str | None
    review: bool
    capabilities: dict[str, object]
    all_legalities: dict[str, str]
    printings: list[PrintingSummary]
    printing_count: int
    rulings: list[Ruling]
    tags: list[str]
    related: list[Related]
    removed: bool


class SetSummary(Contract):
    code: str
    name: str
    type: str
    released_at: date | None
    cards: int


class RevisionInfo(Contract):
    id: int
    created_at: datetime
    engine_build: str | None
    counts: dict[str, object]
    changes: dict[str, object]


class SyncRunInfo(Contract):
    id: UUID
    trigger: str
    status: str
    started_at: datetime
    finished_at: datetime | None
    error_code: str | None
    error_message: str | None
    next_attempt_at: datetime | None
    revision_id: int | None
    stats: dict[str, object]


class CatalogStatus(Contract):
    revision: RevisionInfo | None
    last_run: SyncRunInfo | None
    next_run_at: datetime | None
    # No successful sync for two days, or none at all.
    stale: bool
    format_versions: dict[str, int]
    playable: int
    cards: int


class CoverageRow(Contract):
    status: str
    reason: str | None
    cards: int


class Coverage(Contract):
    """How many cards of each format the engine can play, and why the rest cannot (CAT07)."""

    revision: int | None
    engine_build: str | None
    formats: dict[str, list[CoverageRow]]


class SyncQueued(Contract):
    job_id: UUID
    due_at: datetime


class ReviewCard(Contract):
    card: CardSummary
    changed: list[dict[str, object]]


class ReviewAction(Contract):
    action: Literal["accept", "suspend", "restore"]
    reason: str = Field(default="", max_length=500)


LEGALITY_FORMATS = ("legacy", "commander")


def default_printings(db: Session, ids: list[UUID]) -> dict[UUID, CardPrinting]:
    if not ids:
        return {}
    return {
        printing.id: printing
        for printing in db.scalars(select(CardPrinting).where(CardPrinting.id.in_(ids)))
    }


def faces_of(db: Session, ids: list[UUID]) -> dict[UUID, list[CardFace]]:
    found: dict[UUID, list[CardFace]] = {}
    if not ids:
        return found
    for face in db.scalars(
        select(CardFace).where(CardFace.concept_id.in_(ids)).order_by(CardFace.position)
    ):
        found.setdefault(face.concept_id, []).append(face)
    return found


def artist_of(printing: CardPrinting) -> str | None:
    """Who illustrated a printing: Scryfall's own credit (which joins the faces' artists when
    they differ), else its front face's."""
    faces = printing.faces or []
    front = faces[0].get("artist") if faces else None
    return printing.artist or (front if isinstance(front, str) and front else None)


def image_of(printing: CardPrinting | None) -> CardImageRef | None:
    if printing is None:
        return None
    faces = printing.faces or []
    artist = artist_of(printing)
    if printing.image_uris:
        return CardImageRef(printing_id=printing.id, artist=artist)
    with_images = sum(1 for face in faces if face.get("image_uris"))
    if not with_images:
        return None
    return CardImageRef(printing_id=printing.id, faces=with_images, artist=artist)


def summary(
    concept: CardConcept, faces: list[CardFace], printing: CardPrinting | None
) -> CardSummary:
    return CardSummary(
        id=concept.id,
        name=concept.name,
        layout=concept.layout,
        mana_cost=concept.mana_cost,
        mana_value=concept.mana_value,
        type_line=concept.type_line,
        oracle_text=concept.oracle_text,
        power=concept.power,
        toughness=concept.toughness,
        loyalty=concept.loyalty,
        defense=concept.defense,
        colors=list(concept.colors or []),
        color_identity=list(concept.color_identity or []),
        keywords=list(concept.keywords or []),
        produced_mana=list(concept.produced_mana or []),
        faces=[
            FaceSummary(
                name=face.name,
                mana_cost=face.mana_cost,
                type_line=face.type_line,
                oracle_text=face.oracle_text,
                power=face.power,
                toughness=face.toughness,
                loyalty=face.loyalty,
                defense=face.defense,
            )
            for face in faces
        ],
        rarity=printing.rarity if printing else None,
        set_code=printing.set_code if printing else None,
        released_at=concept.first_released_at,
        status=concept.status,
        status_reason=concept.status_reason,
        status_detail=concept.status_detail,
        playable=concept.status == "certified" and concept.removed_revision is None,
        text_differs=concept.text_differs,
        legalities={
            fmt: (concept.legalities or {}).get(fmt, "not_legal") for fmt in LEGALITY_FORMATS
        },
        commander=concept.commander,
        partner=concept.partner,
        companion=concept.companion,
        copy_limit=concept.copy_limit,
        edhrec_rank=concept.edhrec_rank,
        image=image_of(printing),
    )


def summaries(db: Session, concepts: list[CardConcept]) -> list[CardSummary]:
    ids = [concept.id for concept in concepts]
    faces = faces_of(db, ids)
    printings = default_printings(
        db, [concept.default_printing_id for concept in concepts if concept.default_printing_id]
    )
    return [
        summary(
            concept,
            faces.get(concept.id, []),
            printings.get(concept.default_printing_id) if concept.default_printing_id else None,
        )
        for concept in concepts
    ]


def summaries_by_id(db: Session, ids: set[UUID]) -> dict[UUID, CardSummary]:
    if not ids:
        return {}
    concepts = list(db.scalars(select(CardConcept).where(CardConcept.id.in_(ids))))
    return {card.id: card for card in summaries(db, concepts)}


def filters(
    db: Session,
    *,
    q: str,
    name: str | None,
    text: str | None,
    type_: str | None,
    colors: str | None,
    colors_mode: str,
    identity: str | None,
    mv_min: float | None,
    mv_max: float | None,
    rarity: str | None,
    set_code: str | None,
    legal: str | None,
    playable: bool | None,
    extras: bool,
) -> list[ColumnElement[bool]]:
    compiler = Compiler(db)
    conditions: list[ColumnElement[bool]] = [condition(db, q)]
    leaves: list[Leaf] = []
    if name:
        leaves.append(Leaf("name", ":", name))
    if text:
        leaves.append(Leaf("o", ":", text))
    if type_:
        leaves.append(Leaf("t", ":", type_))
    if colors:
        leaves.append(
            Leaf("c", {"exact": "=", "including": ">=", "within": "<="}[colors_mode], colors)
        )
    if identity:
        leaves.append(Leaf("id", "<=", identity))
    if mv_min is not None:
        leaves.append(Leaf("mv", ">=", str(mv_min)))
    if mv_max is not None:
        leaves.append(Leaf("mv", "<=", str(mv_max)))
    if rarity:
        leaves.append(Leaf("r", ":", rarity))
    if set_code:
        leaves.append(Leaf("s", ":", set_code))
    if legal:
        leaves.append(Leaf("f", ":", legal))
    if playable is not None:
        leaves.append(Leaf("is", ":", "playable" if playable else "unsupported"))
    conditions.extend(compiler.compile(leaf) for leaf in leaves)
    conditions.append(CardConcept.removed_revision.is_(None))
    if not extras:
        conditions.append(CardConcept.deck_card.is_(True))
    return conditions


Sort = Literal["name", "mana_value", "released", "popularity", "color"]


def order_of(sort: Sort, descending: bool) -> list[Any]:
    columns: dict[str, Any] = {
        "name": CardConcept.normalized_name,
        "mana_value": CardConcept.mana_value,
        "released": CardConcept.first_released_at,
        "popularity": func.coalesce(CardConcept.edhrec_rank, 10**9),
        "color": CardConcept.colors_mask,
    }
    column = columns[sort]
    first = column.desc() if descending else column.asc()
    return [first, CardConcept.normalized_name.asc(), CardConcept.id.asc()]


@router.get("/cards", response_model=CardPage)
def search_cards(
    principal: Active,
    db: Db,
    q: Annotated[str, Query(max_length=500)] = "",
    name: Annotated[str | None, Query(max_length=200)] = None,
    text: Annotated[str | None, Query(max_length=200)] = None,
    type: Annotated[str | None, Query(max_length=100)] = None,
    colors: Annotated[str | None, Query(max_length=40)] = None,
    colors_mode: Literal["exact", "including", "within"] = "including",
    identity: Annotated[str | None, Query(max_length=40)] = None,
    mv_min: Annotated[float | None, Query(ge=0, le=1000)] = None,
    mv_max: Annotated[float | None, Query(ge=0, le=1000)] = None,
    rarity: Annotated[str | None, Query(max_length=20)] = None,
    set: Annotated[str | None, Query(max_length=16)] = None,
    legal: Annotated[str | None, Query(max_length=20)] = None,
    playable: bool | None = None,
    extras: bool = False,
    sort: Sort = "name",
    descending: bool = False,
    page: Annotated[int, Query(ge=1, le=10_000)] = 1,
    page_size: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = PAGE_SIZE,
) -> CardPage:
    """Cards by structured filters and the search syntax together; all must match."""
    started = time.monotonic()
    try:
        conditions = filters(
            db,
            q=q,
            name=name,
            text=text,
            type_=type,
            colors=colors,
            colors_mode=colors_mode,
            identity=identity,
            mv_min=mv_min,
            mv_max=mv_max,
            rarity=rarity,
            set_code=set,
            legal=legal,
            playable=playable,
            extras=extras,
        )
    except SearchError as error:
        raise ApiError(422, "invalid_search", error.message) from None
    where = and_(*conditions)
    total = db.scalar(select(func.count()).select_from(CardConcept).where(where)) or 0
    concepts = list(
        db.scalars(
            select(CardConcept)
            .where(where)
            .order_by(*order_of(sort, descending))
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    )
    items = summaries(db, concepts)
    return CardPage(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        milliseconds=int((time.monotonic() - started) * 1000),
    )


def printing_summary(printing: CardPrinting) -> PrintingSummary:
    return PrintingSummary(
        id=printing.id,
        set_code=printing.set_code,
        set_name=printing.set_name,
        collector_number=printing.collector_number,
        lang=printing.lang,
        released_at=printing.released_at,
        rarity=printing.rarity,
        finishes=list(printing.finishes or []),
        frame=printing.frame,
        promo=printing.promo,
        digital=printing.digital,
        artist=artist_of(printing),
        faces=len(printing.faces or []),
        removed=printing.removed_revision is not None,
    )


def printings_query(card_id: UUID) -> Select[CardPrinting]:
    return (
        select(CardPrinting)
        .where(CardPrinting.concept_id == card_id)
        .order_by(
            CardPrinting.released_at.desc(), CardPrinting.set_code, CardPrinting.collector_number
        )
    )


@router.get("/cards/{card_id}", response_model=CardDetail)
def card_detail(
    card_id: UUID,
    principal: Active,
    db: Db,
    printing: Annotated[UUID | None, Query()] = None,
) -> CardDetail:
    """A card's details, with its newest 60 printings. `printing` (a deck entry's chosen printing)
    is listed among them even when it is older, so the screen can show it and credit its artist."""
    concept = db.get(CardConcept, card_id)
    if concept is None:
        raise not_found()
    base = summaries(db, [concept])[0]
    printings = list(db.scalars(printings_query(card_id).limit(MAX_PRINTINGS)))
    if printing is not None and all(shown.id != printing for shown in printings):
        chosen = db.get(CardPrinting, printing)
        if chosen is not None and chosen.concept_id == card_id:
            printings.append(chosen)
    count = db.scalar(
        select(func.count()).select_from(CardPrinting).where(CardPrinting.concept_id == card_id)
    )
    rulings = db.scalars(
        select(CardRuling)
        .where(CardRuling.concept_id == card_id)
        .order_by(CardRuling.published_at, CardRuling.comment)
    )
    tags = db.scalars(
        select(CardTag.label)
        .join(CardTagLink, CardTagLink.tag_id == CardTag.id)
        .where(CardTagLink.concept_id == card_id)
        .order_by(CardTag.label)
    )
    related = db.scalars(select(CardRelation).where(CardRelation.concept_id == card_id))
    return CardDetail(
        **base.model_dump(),
        engine_name=concept.engine_name,
        review=concept.review == "pending",
        capabilities=dict(concept.capabilities or {}),
        all_legalities=dict(concept.legalities or {}),
        printings=[printing_summary(printing) for printing in printings],
        printing_count=count or 0,
        rulings=[
            Ruling(source=ruling.source, published_at=ruling.published_at, comment=ruling.comment)
            for ruling in rulings
        ],
        tags=list(tags),
        related=[
            Related(
                component=part.component, name=part.related_name, type_line=part.related_type_line
            )
            for part in related
        ],
        removed=concept.removed_revision is not None,
    )


@router.get("/cards/{card_id}/printings", response_model=list[PrintingSummary])
def card_printings(
    card_id: UUID,
    principal: Active,
    db: Db,
    offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> list[PrintingSummary]:
    if db.get(CardConcept, card_id) is None:
        raise not_found()
    printings = db.scalars(printings_query(card_id).offset(offset).limit(limit))
    return [printing_summary(printing) for printing in printings]


@router.get("/sets", response_model=list[SetSummary])
def sets(principal: Active, db: Db) -> list[SetSummary]:
    rows = db.execute(
        select(
            CardPrinting.set_code,
            func.max(CardPrinting.set_name),
            func.max(CardPrinting.set_type),
            func.min(CardPrinting.released_at),
            func.count(func.distinct(CardPrinting.concept_id)),
        )
        .where(CardPrinting.removed_revision.is_(None))
        .group_by(CardPrinting.set_code)
        .order_by(func.min(CardPrinting.released_at).desc(), CardPrinting.set_code)
    )
    return [
        SetSummary(code=code, name=name, type=kind, released_at=released, cards=count)
        for code, name, kind, released, count in rows
    ]


def run_info(run: CatalogSyncRun) -> SyncRunInfo:
    return SyncRunInfo(
        id=run.id,
        trigger=run.trigger,
        status=run.status,
        started_at=run.started_at,
        finished_at=run.finished_at,
        error_code=run.error_code,
        error_message=run.error_message,
        next_attempt_at=run.next_attempt_at,
        revision_id=run.revision_id,
        stats=dict(run.stats or {}),
    )


def latest_revision(db: Session) -> CatalogRevision | None:
    return db.scalar(select(CatalogRevision).order_by(CatalogRevision.id.desc()).limit(1))


@router.get("/catalog", response_model=CatalogStatus)
def catalog_status(principal: Active, db: Db) -> CatalogStatus:
    revision = latest_revision(db)
    last = db.scalar(select(CatalogSyncRun).order_by(CatalogSyncRun.started_at.desc()).limit(1))
    succeeded = db.scalar(
        select(func.max(CatalogSyncRun.finished_at)).where(
            CatalogSyncRun.status.in_(("succeeded", "unchanged"))
        )
    )
    upcoming = db.scalar(
        select(func.min(ScheduledJob.due_at)).where(
            ScheduledJob.kind == sync.KIND, ScheduledJob.status == "pending"
        )
    )
    versions = {
        fmt: version
        for fmt, version in db.execute(
            select(FormatVersion.format, func.max(FormatVersion.version)).group_by(
                FormatVersion.format
            )
        )
    }
    now = datetime.now(UTC)
    fresh = (
        succeeded is not None
        and now - succeeded.replace(tzinfo=succeeded.tzinfo or UTC) < STALE_AFTER
    )
    counted = db.scalar(
        select(func.count())
        .select_from(CardConcept)
        .where(CardConcept.deck_card.is_(True), CardConcept.removed_revision.is_(None))
    )
    playable = db.scalar(
        select(func.count())
        .select_from(CardConcept)
        .where(CardConcept.status == "certified", CardConcept.removed_revision.is_(None))
    )
    return CatalogStatus(
        revision=RevisionInfo(
            id=revision.id,
            created_at=revision.created_at,
            engine_build=revision.engine_build,
            counts=dict(revision.counts or {}),
            changes=dict(revision.changes or {}),
        )
        if revision
        else None,
        last_run=run_info(last) if last else None,
        next_run_at=upcoming,
        stale=not fresh,
        format_versions=versions,
        playable=playable or 0,
        cards=counted or 0,
    )


@router.get("/catalog/coverage", response_model=Coverage)
def coverage(principal: Active, db: Db) -> Coverage:
    revision = latest_revision(db)
    found: dict[str, list[CoverageRow]] = {}
    for fmt in LEGALITY_FORMATS:
        rows = db.execute(
            select(CardConcept.status, CardConcept.status_reason, func.count())
            .where(
                CardConcept.deck_card.is_(True),
                CardConcept.removed_revision.is_(None),
                CardConcept.legalities[fmt].as_string() == "legal",
            )
            .group_by(CardConcept.status, CardConcept.status_reason)
            .order_by(func.count().desc())
        )
        found[fmt] = [
            CoverageRow(status=status, reason=reason, cards=count) for status, reason, count in rows
        ]
    return Coverage(
        revision=revision.id if revision else None,
        engine_build=revision.engine_build if revision else None,
        formats=found,
    )


# Administration (catalog.manage: administrators and SysOp).


@router.get("/admin/catalog/runs", response_model=list[SyncRunInfo])
def catalog_runs(
    principal: Manager, db: Db, limit: Annotated[int, Query(ge=1, le=100)] = 20
) -> list[SyncRunInfo]:
    runs = db.scalars(
        select(CatalogSyncRun).order_by(CatalogSyncRun.started_at.desc()).limit(limit)
    )
    return [run_info(run) for run in runs]


@router.post("/admin/catalog/sync", response_model=SyncQueued, status_code=202)
def request_sync(request: Request, principal: Manager, db: Db) -> SyncQueued:
    """Queues a catalog run now; the worker starts it within seconds."""
    if not request.app.state.settings.catalog_dir:
        raise ApiError(409, "catalog_off", "The catalog sync is turned off (CD_CATALOG_DIR).")
    now = datetime.now(UTC)
    job = sync.request_now(db, principal.user.id, now)
    if job is None:
        raise ApiError(409, "sync_busy", "A catalog run is already queued or running.")
    db.flush()
    audit(
        db,
        request,
        "catalog.sync_requested",
        actor_id=principal.user.id,
        details={"job": str(job.id)},
    )
    db.commit()
    return SyncQueued(job_id=job.id, due_at=now)


@router.get("/admin/catalog/reviews", response_model=list[ReviewCard])
def reviews(principal: Manager, db: Db) -> list[ReviewCard]:
    """Cards whose Oracle text changed since they were certified, and suspended cards."""
    concepts = list(
        db.scalars(
            select(CardConcept)
            .where((CardConcept.review == "pending") | (CardConcept.status == "suspended"))
            .order_by(CardConcept.normalized_name)
            .limit(500)
        )
    )
    changes: dict[UUID, list[dict[str, object]]] = {}
    if concepts:
        for change in db.scalars(
            select(CatalogChange)
            .where(
                CatalogChange.concept_id.in_([concept.id for concept in concepts]),
                CatalogChange.kind == "oracle_changed",
            )
            .order_by(CatalogChange.revision_id.desc())
        ):
            assert change.concept_id is not None
            changes.setdefault(change.concept_id, []).append(
                {"revision": change.revision_id, **change.details}
            )
    return [
        ReviewCard(card=card, changed=changes.get(card.id, [])) for card in summaries(db, concepts)
    ]


@router.post("/admin/catalog/cards/{card_id}/review", response_model=CardSummary)
def review_card(
    card_id: UUID, body: ReviewAction, request: Request, principal: Manager, db: Db
) -> CardSummary:
    """accept: the engine's behaviour is right for today's text. suspend: no new game may start
    with the card. restore: undo a suspension."""
    concept = db.get(CardConcept, card_id)
    if concept is None:
        raise not_found()
    before = concept.status
    capabilities = dict(concept.capabilities or {})
    if body.action == "accept":
        if concept.status != "certified":
            raise ApiError(409, "not_certified", "Only a certified card's review can be accepted.")
        concept.certified_hash = concept.gameplay_hash
        concept.review = "none"
    elif body.action == "suspend":
        if concept.status == "suspended":
            raise ApiError(409, "already_suspended", "The card is suspended already.")
        capabilities["suspended_from"] = {
            "status": concept.status,
            "reason": concept.status_reason,
            "detail": concept.status_detail,
        }
        concept.status = "suspended"
        concept.status_reason = "suspended_by_staff"
        concept.status_detail = body.reason or "Suspended by the site's staff."
        capabilities["multiplayer"] = False
        capabilities["ai"] = False
    else:
        previous = capabilities.pop("suspended_from", None)
        if concept.status != "suspended" or not isinstance(previous, dict):
            raise ApiError(409, "not_suspended", "The card is not suspended.")
        concept.status = str(previous.get("status") or "catalog_only")
        reason, detail = previous.get("reason"), previous.get("detail")
        concept.status_reason = str(reason) if reason else None
        concept.status_detail = str(detail) if detail else None
        playable = concept.status == "certified"
        capabilities["multiplayer"] = playable
        capabilities["ai"] = "untested" if playable else False
    concept.capabilities = capabilities
    concept.updated_at = datetime.now(UTC)
    audit(
        db,
        request,
        f"catalog.card_{body.action}",
        actor_id=principal.user.id,
        details={
            "card": str(card_id),
            "name": concept.name,
            "from": before,
            "to": concept.status,
            "reason": body.reason,
        },
    )
    db.commit()
    return summaries(db, [concept])[0]
