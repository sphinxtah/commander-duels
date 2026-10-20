"""Validating downloaded bulk files and applying them as one catalog revision.

Validation reads every file before anything is written: each record must parse, identities must
be unique, every printing and tag must name a card in oracle_cards, and no dataset may shrink by
more than a tenth since the last import. Only then does apply run, in one transaction: it diffs
concepts and printings against the catalog, never deletes them (a card Scryfall drops keeps its
row, with removed_revision, so decks keep it), rebuilds rulings, aliases, relations and tags,
decides statuses from the engine's implementations, and writes the revision. Readers see the old
catalog until the commit and the new one after it; a failure rolls everything back, so the last
good catalog stays in use (T20).

The transaction holds the job's row lock from its first statement, and checks the generation it
claimed: a worker whose lease was taken over cannot commit a revision (fencing).
"""

from collections import defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import delete, insert, select, update
from sqlalchemy.orm import Session

from api.models import (
    CardAlias,
    CardConcept,
    CardFace,
    CardPrinting,
    CardRelation,
    CardRuling,
    CardTag,
    CardTagLink,
    CatalogChange,
    CatalogRevision,
    ScheduledJob,
    SourceSnapshot,
)
from catalog import formats, statuses
from catalog.records import Concept, Printing, concept, printing, printing_rank, ruling, tag
from catalog.scryfall import Limits, Reader, SyncError
from catalog.text import normalize

BATCH = 2000
# A dataset may shrink by at most this share between imports; more is a broken file.
MAX_SHRINK = 0.10


class Fenced(Exception):
    """Another worker took the job over; this one's work is void."""


@dataclass(frozen=True)
class Fence:
    job_id: UUID | None
    generation: int

    def hold(self, session: Session) -> None:
        """Locks the job's row for the rest of the transaction, if this worker still owns it."""
        if self.job_id is None:
            return
        job = session.scalar(
            select(ScheduledJob).where(ScheduledJob.id == self.job_id).with_for_update()
        )
        if job is None or job.generation != self.generation or job.status != "running":
            raise Fenced()


@dataclass(frozen=True)
class Source:
    dataset: str
    path: Path
    encoding: str
    snapshot_id: UUID | None = None


@dataclass
class Validated:
    concepts: list[Concept]
    counts: dict[str, int]
    unknown_layouts: dict[str, int]
    skipped_rulings: int = 0
    skipped_taggings: int = 0


@dataclass
class Applied:
    revision_id: int
    changes: dict[str, int] = field(default_factory=dict)


def read(source: Source, limits: Limits) -> Reader:
    return Reader(source.path, source.encoding, limits, source.dataset)


def validate(sources: dict[str, Source], limits: Limits, previous: dict[str, int]) -> Validated:
    """Reads every file once. previous holds each dataset's record count at the last import."""
    concepts: list[Concept] = []
    oracle_ids: set[UUID] = set()
    layouts: dict[str, int] = defaultdict(int)
    for record in read(sources["oracle_cards"], limits):
        card = concept(record)
        if card.oracle_id in oracle_ids:
            raise SyncError("duplicate_identity", f"oracle_cards lists {card.oracle_id} twice.")
        oracle_ids.add(card.oracle_id)
        if not card.known_layout:
            layouts[card.layout] += 1
        concepts.append(card)
    counts = {"oracle_cards": len(concepts)}

    seen: set[UUID] = set()
    for record in read(sources["default_cards"], limits):
        found = printing(record)
        if found.scryfall_id in seen:
            raise SyncError("duplicate_identity", f"default_cards lists {found.scryfall_id} twice.")
        seen.add(found.scryfall_id)
        if found.oracle_id not in oracle_ids:
            raise SyncError(
                "orphan_printing",
                f"Printing {found.scryfall_id} names Oracle ID {found.oracle_id}, which "
                "oracle_cards does not list.",
            )
    counts["default_cards"] = len(seen)

    skipped_rulings = 0
    counted = 0
    for record in read(sources["rulings"], limits):
        counted += 1
        if ruling(record).oracle_id not in oracle_ids:
            skipped_rulings += 1
    counts["rulings"] = counted

    skipped_taggings = 0
    tags = 0
    for record in read(sources["oracle_tags"], limits):
        found_tag = tag(record)
        if found_tag is None:
            continue
        tags += 1
        skipped_taggings += sum(1 for oracle, _ in found_tag.taggings if oracle not in oracle_ids)
    counts["oracle_tags"] = tags

    for dataset, count in counts.items():
        before = previous.get(dataset)
        if count == 0:
            raise SyncError("dataset_empty", f"{dataset} holds no records.")
        if before and count < before * (1 - MAX_SHRINK):
            raise SyncError(
                "unexpected_record_count",
                f"{dataset} shrank from {before} to {count} records since the last import.",
            )
    return Validated(concepts, counts, dict(layouts), skipped_rulings, skipped_taggings)


def batches(rows: Iterable[dict[str, Any]], size: int = BATCH) -> Iterator[list[dict[str, Any]]]:
    batch: list[dict[str, Any]] = []
    for row in rows:
        batch.append(row)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


def face_rows(concept_id: UUID, card: Concept) -> list[dict[str, Any]]:
    return [
        {
            "id": uuid4(),
            "concept_id": concept_id,
            "position": face.position,
            "name": face.name,
            "normalized_name": normalize(face.name),
            "mana_cost": face.mana_cost,
            "type_line": face.type_line,
            "oracle_text": face.oracle_text,
            "colors": face.colors,
            "color_indicator": face.color_indicator,
            "power": face.power,
            "toughness": face.toughness,
            "loyalty": face.loyalty,
            "defense": face.defense,
        }
        for face in card.faces
    ]


class Apply:
    """One revision's work, inside the caller's transaction."""

    def __init__(
        self,
        session: Session,
        sources: dict[str, Source],
        limits: Limits,
        engine: statuses.EngineCards | None,
        now: datetime,
    ) -> None:
        self.session, self.sources, self.limits = session, sources, limits
        self.engine, self.now = engine, now
        self.changes: dict[str, int] = defaultdict(int)
        self.concept_ids: dict[UUID, UUID] = {}
        self.added: set[UUID] = set()
        self.aliases: set[tuple[str, UUID, str]] = set()
        self.revision_id = 0

    def change(
        self,
        kind: str,
        concept_id: UUID | None,
        details: dict[str, object] | None = None,
        printing_id: UUID | None = None,
    ) -> dict[str, Any]:
        self.changes[kind] += 1
        return {
            "id": uuid4(),
            "revision_id": self.revision_id,
            "concept_id": concept_id,
            "printing_id": printing_id,
            "kind": kind,
            "details": details or {},
        }

    def run(
        self, validated: Validated, run_id: UUID | None, datasets: dict[str, object]
    ) -> Applied:
        first = self.session.scalar(select(CatalogRevision.id).limit(1)) is None
        revision = CatalogRevision(
            created_at=self.now,
            sync_run_id=run_id,
            engine_build=self.engine.build if self.engine else None,
            datasets=datasets,
            counts={},
            changes={},
        )
        self.session.add(revision)
        self.session.flush()
        self.revision_id = revision.id
        self.concepts(validated.concepts)
        self.printings(first)
        self.relations(validated.concepts)
        self.rulings()
        self.tags()
        self.decide(validated.concepts)
        versions = formats.record_versions(self.session, revision.id, self.now)
        playable = statuses.playable_count(self.session)
        revision.counts = {
            **validated.counts,
            "concepts": len(validated.concepts),
            "playable": playable,
            "unknown_layouts": validated.unknown_layouts,
            "skipped_rulings": validated.skipped_rulings,
            "skipped_taggings": validated.skipped_taggings,
        }
        revision.changes = {**self.changes, "format_versions": versions}
        for source in self.sources.values():
            if source.snapshot_id is not None:
                self.session.execute(
                    update(SourceSnapshot)
                    .where(SourceSnapshot.id == source.snapshot_id)
                    .values(status="applied", applied_revision=revision.id)
                )
        return Applied(revision.id, dict(self.changes))

    def concepts(self, cards: list[Concept]) -> None:
        existing = {
            row.oracle_id: row
            for row in self.session.execute(
                select(
                    CardConcept.id,
                    CardConcept.oracle_id,
                    CardConcept.name,
                    CardConcept.oracle_text,
                    CardConcept.type_line,
                    CardConcept.mana_cost,
                    CardConcept.gameplay_hash,
                    CardConcept.legality_hash,
                    CardConcept.legalities,
                    CardConcept.edhrec_rank,
                    CardConcept.removed_revision,
                )
            )
        }
        inserts: list[dict[str, Any]] = []
        updates: list[dict[str, Any]] = []
        refaced: list[UUID] = []
        faces: list[dict[str, Any]] = []
        changes: list[dict[str, Any]] = []
        for card in cards:
            row = card.row()
            old = existing.get(card.oracle_id)
            if old is None:
                concept_id = uuid4()
                inserts.append(
                    {
                        **row,
                        "id": concept_id,
                        "status": "catalog_only",
                        "status_reason": "engine_unchecked",
                        "text_differs": False,
                        "review": "none",
                        "capabilities": {},
                        "first_revision": self.revision_id,
                        "changed_revision": self.revision_id,
                        "created_at": self.now,
                        "updated_at": self.now,
                        "paper": True,
                    }
                )
                faces.extend(face_rows(concept_id, card))
                changes.append(self.change("added", concept_id, {"name": card.name}))
                self.concept_ids[card.oracle_id] = concept_id
                self.added.add(concept_id)
                continue
            concept_id = old.id
            self.concept_ids[card.oracle_id] = concept_id
            values: dict[str, Any] = {}
            if old.removed_revision is not None:
                values["removed_revision"] = None
                changes.append(self.change("restored", concept_id, {"name": card.name}))
            if old.gameplay_hash != card.gameplay_hash:
                values.update(row)
                refaced.append(concept_id)
                faces.extend(face_rows(concept_id, card))
                changes.append(
                    self.change(
                        "oracle_changed",
                        concept_id,
                        {
                            "before": {
                                "name": old.name,
                                "type_line": old.type_line,
                                "mana_cost": old.mana_cost,
                                "oracle_text": old.oracle_text,
                            },
                            "after": {
                                "name": card.name,
                                "type_line": card.type_line,
                                "mana_cost": card.mana_cost,
                                "oracle_text": card.oracle_text,
                            },
                        },
                    )
                )
            if old.legality_hash != card.legality_hash:
                values["legalities"] = card.legalities
                values["legality_hash"] = card.legality_hash
                moved = {
                    fmt: {"from": (old.legalities or {}).get(fmt), "to": status}
                    for fmt, status in card.legalities.items()
                    if (old.legalities or {}).get(fmt) != status
                }
                changes.append(
                    self.change("legality_changed", concept_id, {"name": card.name, **moved})
                )
            if values:
                values["changed_revision"] = self.revision_id
            if old.edhrec_rank != card.edhrec_rank:
                values["edhrec_rank"] = card.edhrec_rank
            if values:
                updates.append({**values, "id": concept_id, "updated_at": self.now})
        present = {card.oracle_id for card in cards}
        for oracle_id, old in existing.items():
            if oracle_id not in present and old.removed_revision is None:
                updates.append(
                    {"id": old.id, "removed_revision": self.revision_id, "updated_at": self.now}
                )
                changes.append(self.change("removed", old.id, {"name": old.name}))
        for batch in batches(inserts):
            self.session.execute(insert(CardConcept), batch)
        for batch in batches(updates):
            self.session.execute(update(CardConcept), batch)
        for start in range(0, len(refaced), BATCH):
            self.session.execute(
                delete(CardFace).where(CardFace.concept_id.in_(refaced[start : start + BATCH]))
            )
        for batch in batches(faces):
            self.session.execute(insert(CardFace), batch)
        self.write_changes(changes)

    def write_changes(self, changes: list[dict[str, Any]]) -> None:
        for batch in batches(changes):
            self.session.execute(insert(CatalogChange), batch)

    def printings(self, first: bool) -> None:
        existing = {
            row.scryfall_id: row
            for row in self.session.execute(
                select(
                    CardPrinting.id,
                    CardPrinting.scryfall_id,
                    CardPrinting.concept_id,
                    CardPrinting.cosmetic_hash,
                    CardPrinting.removed_revision,
                )
            )
        }
        known_concepts = set(existing_row.concept_id for existing_row in existing.values())
        best: dict[UUID, tuple[tuple[int, ...], UUID]] = {}
        released: dict[UUID, date] = {}
        paper: dict[UUID, bool] = defaultdict(bool)
        aliases: set[tuple[str, UUID, str]] = set()
        inserts: list[dict[str, Any]] = []
        updates: list[dict[str, Any]] = []
        changes: list[dict[str, Any]] = []
        seen: set[UUID] = set()

        def flush() -> None:
            for batch in batches(inserts):
                self.session.execute(insert(CardPrinting), batch)
            for batch in batches(updates):
                self.session.execute(update(CardPrinting), batch)
            inserts.clear()
            updates.clear()

        for record in read(self.sources["default_cards"], self.limits):
            found: Printing = printing(record)
            concept_id = self.concept_ids[found.oracle_id]
            seen.add(found.scryfall_id)
            old = existing.get(found.scryfall_id)
            if old is None:
                printing_id = uuid4()
                inserts.append(
                    {
                        **found.values,
                        "id": printing_id,
                        "scryfall_id": found.scryfall_id,
                        "concept_id": concept_id,
                        "cosmetic_hash": found.cosmetic_hash,
                        "first_revision": self.revision_id,
                        "changed_revision": self.revision_id,
                        "created_at": self.now,
                        "updated_at": self.now,
                    }
                )
                if not first and concept_id in known_concepts:
                    changes.append(
                        self.change(
                            "printing_added",
                            concept_id,
                            {
                                "set": found.values["set_code"],
                                "number": found.values["collector_number"],
                            },
                            printing_id,
                        )
                    )
            else:
                printing_id = old.id
                if (
                    old.cosmetic_hash != found.cosmetic_hash
                    or old.concept_id != concept_id
                    or old.removed_revision is not None
                ):
                    updates.append(
                        {
                            **found.values,
                            "id": printing_id,
                            "concept_id": concept_id,
                            "cosmetic_hash": found.cosmetic_hash,
                            "removed_revision": None,
                            "changed_revision": self.revision_id,
                            "updated_at": self.now,
                        }
                    )
                    self.changes["printing_changed"] += 1
            rank = printing_rank(found.values)
            if concept_id not in best or rank > best[concept_id][0]:
                best[concept_id] = (rank, printing_id)
            if found.released_at and (
                concept_id not in released or found.released_at < released[concept_id]
            ):
                released[concept_id] = found.released_at
            paper[concept_id] |= found.paper
            for alias, kind in found.aliases:
                aliases.add((normalize(alias), concept_id, kind))
            if len(inserts) + len(updates) >= BATCH:
                flush()
        flush()
        for scryfall_id, old in existing.items():
            if scryfall_id not in seen and old.removed_revision is None:
                updates.append(
                    {"id": old.id, "removed_revision": self.revision_id, "updated_at": self.now}
                )
                changes.append(self.change("printing_removed", old.concept_id, {}, old.id))
        flush()
        self.write_changes(changes)
        current = {
            row.id: row
            for row in self.session.execute(
                select(
                    CardConcept.id,
                    CardConcept.default_printing_id,
                    CardConcept.first_released_at,
                    CardConcept.paper,
                )
            )
        }
        derived = []
        for concept_id, row in current.items():
            values = {
                "default_printing_id": best[concept_id][1] if concept_id in best else None,
                "first_released_at": released.get(concept_id),
                "paper": paper.get(concept_id, False),
            }
            if (row.default_printing_id, row.first_released_at, row.paper) != tuple(
                values.values()
            ):
                derived.append({**values, "id": concept_id})
        for batch in batches(derived):
            self.session.execute(update(CardConcept), batch)
        self.aliases = aliases

    def relations(self, cards: list[Concept]) -> None:
        self.session.execute(delete(CardRelation))
        self.session.execute(delete(CardAlias))
        relations: list[dict[str, Any]] = []
        aliases = set(self.aliases)
        for card in cards:
            concept_id = self.concept_ids[card.oracle_id]
            for part in card.relations:
                try:
                    related = UUID(str(part["id"]))
                except ValueError:
                    continue
                if part.get("name") == card.name:
                    continue
                relations.append(
                    {
                        "id": uuid4(),
                        "concept_id": concept_id,
                        "component": str(part.get("component") or "related")[:32],
                        "related_scryfall_id": related,
                        "related_name": str(part["name"]),
                        "related_type_line": part.get("type_line"),
                    }
                )
            names = {card.game_name, *(face.name for face in card.faces)}
            for name in names:
                if normalize(name) != card.normalized_name:
                    aliases.add((normalize(name), concept_id, "face"))
        for batch in batches(relations):
            self.session.execute(insert(CardRelation), batch)
        rows = (
            {"id": uuid4(), "alias": alias, "concept_id": concept_id, "kind": kind}
            for alias, concept_id, kind in self.unique_aliases(aliases)
        )
        for batch in batches(rows):
            self.session.execute(insert(CardAlias), batch)

    @staticmethod
    def unique_aliases(
        aliases: set[tuple[str, UUID, str]],
    ) -> Iterator[tuple[str, UUID, str]]:
        """One row per alias and card; a face name wins over a flavor or printed name."""
        order = {"face": 0, "flavor_name": 1, "printed_name": 2}
        chosen: dict[tuple[str, UUID], str] = {}
        for alias, concept_id, kind in aliases:
            key = (alias, concept_id)
            if key not in chosen or order.get(kind, 9) < order.get(chosen[key], 9):
                chosen[key] = kind
        for (alias, concept_id), kind in chosen.items():
            yield alias, concept_id, kind

    def rulings(self) -> None:
        self.session.execute(delete(CardRuling))

        def rows() -> Iterator[dict[str, Any]]:
            for record in read(self.sources["rulings"], self.limits):
                found = ruling(record)
                concept_id = self.concept_ids.get(found.oracle_id)
                if concept_id is not None:
                    yield {
                        "id": uuid4(),
                        "concept_id": concept_id,
                        "source": found.source,
                        "published_at": found.published_at,
                        "comment": found.comment,
                    }

        for batch in batches(rows()):
            self.session.execute(insert(CardRuling), batch)

    def tags(self) -> None:
        self.session.execute(delete(CardTagLink))
        self.session.execute(delete(CardTag))
        links: list[dict[str, Any]] = []
        tags: list[dict[str, Any]] = []
        for record in read(self.sources["oracle_tags"], self.limits):
            found = tag(record)
            if found is None:
                continue
            tags.append(
                {
                    "id": found.id,
                    "slug": found.slug,
                    "label": found.label,
                    "description": found.description,
                    "parent_ids": found.parent_ids,
                    "aliases": found.aliases,
                }
            )
            seen: set[UUID] = set()
            for oracle_id, weight in found.taggings:
                concept_id = self.concept_ids.get(oracle_id)
                if concept_id is not None and concept_id not in seen:
                    seen.add(concept_id)
                    links.append({"concept_id": concept_id, "tag_id": found.id, "weight": weight})
        for batch in batches(tags):
            self.session.execute(insert(CardTag), batch)
        for batch in batches(links):
            self.session.execute(insert(CardTagLink), batch)

    def decide(self, cards: list[Concept]) -> None:
        by_id = {self.concept_ids[card.oracle_id]: card for card in cards}
        rows = self.session.execute(
            select(
                CardConcept.id,
                CardConcept.status,
                CardConcept.status_reason,
                CardConcept.status_detail,
                CardConcept.engine_name,
                CardConcept.engine_build,
                CardConcept.certified_hash,
                CardConcept.gameplay_hash,
                CardConcept.text_differs,
                CardConcept.review,
                CardConcept.capabilities,
            ).where(CardConcept.id.in_(list(by_id)))
        )
        updates: list[dict[str, Any]] = []
        changes: list[dict[str, Any]] = []
        for row in rows:
            card = by_id[row.id]
            decision = statuses.decide(card, row, self.engine)
            values = decision.values()
            current = {key: getattr(row, key) for key in values}
            if current != values:
                updates.append({**values, "id": row.id})
                if row.status != decision.status and row.id not in self.added:
                    changes.append(
                        self.change(
                            "status_changed",
                            row.id,
                            {
                                "name": card.name,
                                "from": row.status,
                                "to": decision.status,
                                "reason": decision.reason,
                            },
                        )
                    )
        for batch in batches(updates):
            self.session.execute(update(CardConcept), batch)
        self.write_changes(changes)
