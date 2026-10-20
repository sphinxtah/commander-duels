"""One catalog sync: Scryfall's bulk files into a new catalog revision (section 5's workflow).

A run records itself, asks Scryfall which files it advertises, and reuses each local file whose
source timestamp and SHA-256 match the last import, downloading only the rest. It fetches the
engine's implementation list when the engine build is new. With nothing new from either side the
run ends as unchanged. Otherwise every file is validated, and the revision is applied in one
fenced transaction. Transient failures (Scryfall or the file host unreachable, slow or limiting)
are retried with capped exponential backoff; other failures stop until the next scheduled run.
Either way the last good catalog stays in use.
"""

import logging
import random
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import Engine, and_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.config import Settings
from api.models import CatalogRevision, CatalogSyncRun, ScheduledJob, SourceSnapshot
from catalog import engine_export
from catalog.importer import Apply, Fence, Fenced, Source, validate
from catalog.scryfall import (
    DATASETS,
    BulkFile,
    Limits,
    SyncError,
    discover,
    download,
    file_name,
    sha256_of,
)

log = logging.getLogger(__name__)
KIND = "catalog_sync"
MAX_ATTEMPTS = 6
BACKOFF_SECONDS = 60
MAX_BACKOFF_SECONDS = 3600


@dataclass
class Claimed:
    id: UUID
    generation: int
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass
class Outcome:
    status: str
    code: str
    retry_at: datetime | None = None
    run_id: UUID | None = None
    revision_id: int | None = None


def limits_of(settings: Settings) -> Limits:
    return Limits(
        compressed_bytes=settings.catalog_max_download_mb << 20,
        decompressed_bytes=settings.catalog_max_dataset_mb << 20,
    )


def due_time(settings: Settings, day: datetime) -> datetime:
    """The day's sync time, with a jitter that is the same for every worker on that day."""
    hour, minute = (int(part) for part in settings.catalog_sync_time.split(":"))
    start = datetime.combine(day.date(), time(hour, minute), UTC)
    jitter = random.Random(day.date().isoformat()).randint(
        0, settings.catalog_sync_jitter_minutes * 60
    )
    return start + timedelta(seconds=jitter)


def ensure_scheduled(engine: Engine, settings: Settings, now: datetime) -> None:
    """Keeps today's and tomorrow's runs queued; the deduplication key allows one a day. A new
    installation's first run is due at once, since today's time has passed or comes soon."""
    if not settings.catalog_dir:
        return
    for day in (now, now + timedelta(days=1)):
        key = f"{KIND}:{day.date().isoformat()}"
        with Session(engine) as session:
            if session.scalar(select(ScheduledJob.id).where(ScheduledJob.deduplication_key == key)):
                continue
            session.add(
                ScheduledJob(
                    kind=KIND,
                    deduplication_key=key,
                    payload={"trigger": "schedule"},
                    status="pending",
                    due_at=due_time(settings, day),
                )
            )
            try:
                session.commit()
            except IntegrityError:
                session.rollback()


def request_now(session: Session, user_id: UUID, now: datetime) -> ScheduledJob | None:
    """Queues a run for an administrator; None while a run is queued or running already."""
    busy = session.scalar(
        select(ScheduledJob.id).where(
            ScheduledJob.kind == KIND,
            ScheduledJob.due_at <= now,
            ScheduledJob.status.in_(("pending", "running")),
        )
    )
    if busy is not None:
        return None
    job = ScheduledJob(
        kind=KIND,
        deduplication_key=f"{KIND}:manual:{now.isoformat()}:{user_id}",
        payload={"trigger": "manual", "requested_by": str(user_id)},
        status="pending",
        due_at=now,
    )
    session.add(job)
    return job


def renew(engine: Engine, job: Claimed, now: datetime, seconds: int = 120) -> bool:
    """Extends the lease while the run works; False once another worker has taken it."""
    with engine.begin() as connection:
        result = connection.execute(
            update(ScheduledJob)
            .where(
                ScheduledJob.id == job.id,
                ScheduledJob.generation == job.generation,
                ScheduledJob.status == "running",
            )
            .values(lease_until=now + timedelta(seconds=seconds))
        )
        return bool(result.rowcount)


class Heartbeat:
    """Renews the lease every interval while a run works. Once a renewal finds the job taken
    over, check() raises Fenced at the run's next checkpoint."""

    def __init__(self, engine: Engine, job: Claimed, interval: float | None) -> None:
        self.engine, self.job, self.interval = engine, job, interval
        self.lost = threading.Event()
        self.stopped = threading.Event()
        self.thread: threading.Thread | None = None

    def __enter__(self) -> "Heartbeat":
        if self.interval is not None:
            self.thread = threading.Thread(target=self.beat, name="catalog-lease", daemon=True)
            self.thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stopped.set()
        if self.thread is not None:
            self.thread.join(timeout=30)

    def beat(self) -> None:
        assert self.interval is not None
        while not self.stopped.wait(self.interval):
            try:
                if not renew(self.engine, self.job, datetime.now(UTC)):
                    self.lost.set()
                    return
            except Exception:
                log.warning("Renewing the catalog run's lease failed; trying again")

    def check(self) -> None:
        if self.lost.is_set():
            raise Fenced()


def overlapping(engine: Engine, job: Claimed, now: datetime) -> bool:
    """Another catalog run holds a live lease: this one waits rather than overlapping it."""
    with Session(engine) as session:
        return (
            session.scalar(
                select(ScheduledJob.id).where(
                    ScheduledJob.kind == KIND,
                    ScheduledJob.id != job.id,
                    ScheduledJob.status == "running",
                    ScheduledJob.lease_until > now,
                )
            )
            is not None
        )


def previous_snapshots(session: Session) -> dict[str, SourceSnapshot]:
    """Each dataset's file at the last import."""
    found: dict[str, SourceSnapshot] = {}
    for dataset in DATASETS:
        snapshot = session.scalar(
            select(SourceSnapshot)
            .where(SourceSnapshot.dataset == dataset, SourceSnapshot.status == "applied")
            .order_by(SourceSnapshot.applied_revision.desc())
            .limit(1)
        )
        if snapshot is not None:
            found[dataset] = snapshot
    return found


class Run:
    def __init__(
        self,
        engine: Engine,
        settings: Settings,
        client: httpx.Client,
        job: Claimed,
        now: datetime,
        heartbeat: Heartbeat,
    ) -> None:
        self.engine, self.settings, self.client, self.job = engine, settings, client, job
        self.heartbeat = heartbeat
        self.started = now
        self.folder = Path(settings.catalog_dir)
        self.limits = limits_of(settings)
        self.stats: dict[str, Any] = {"downloaded": [], "reused": []}
        trigger = job.payload.get("trigger", "schedule")
        requested = job.payload.get("requested_by")
        with Session(engine) as session, session.begin():
            run = CatalogSyncRun(
                job_id=job.id,
                generation=job.generation,
                trigger=trigger if trigger in ("schedule", "manual") else "schedule",
                requested_by=UUID(requested) if isinstance(requested, str) else None,
                attempt=int(job.payload.get("attempt", 1)),
                started_at=now,
                status="running",
                stats={},
            )
            session.add(run)
            session.flush()
            self.run_id = run.id

    def finish(self, status: str, code: str | None, message: str | None, **values: Any) -> None:
        with Session(self.engine) as session, session.begin():
            session.execute(
                update(CatalogSyncRun)
                .where(CatalogSyncRun.id == self.run_id)
                .values(
                    status=status,
                    error_code=code,
                    error_message=message,
                    finished_at=datetime.now(UTC),
                    stats={
                        **self.stats,
                        "seconds": round((datetime.now(UTC) - self.started).total_seconds(), 1),
                    },
                    **values,
                )
            )

    def sources(self, files: dict[str, BulkFile]) -> tuple[dict[str, Source], bool]:
        """Local files for every dataset, and whether any is new since the last import."""
        with Session(self.engine) as session:
            before = previous_snapshots(session)
        sources: dict[str, Source] = {}
        changed = False
        for dataset in DATASETS:
            bulk = files[dataset]
            path = self.folder / file_name(bulk)
            old = before.get(dataset)
            if (
                old is not None
                and old.source_updated_at == bulk.updated_at
                and path.exists()
                and sha256_of(path) == old.sha256
            ):
                sources[dataset] = Source(dataset, path, bulk.encoding)
                self.stats["reused"].append(dataset)
                continue
            got = download(self.client, bulk, self.folder, self.limits)
            changed = True
            with Session(self.engine) as session, session.begin():
                snapshot = SourceSnapshot(
                    sync_run_id=self.run_id,
                    dataset=dataset,
                    source_updated_at=bulk.updated_at,
                    download_uri=bulk.uri,
                    compressed_bytes=got.compressed_bytes,
                    sha256=got.sha256,
                    etag=got.etag,
                    last_modified=got.last_modified,
                    status="downloaded",
                    created_at=datetime.now(UTC),
                )
                session.add(snapshot)
                session.flush()
                sources[dataset] = Source(dataset, got.path, bulk.encoding, snapshot.id)
            self.stats["downloaded"].append(dataset)
            self.heartbeat.check()
        return sources, changed

    def execute(self) -> Outcome:
        with Session(self.engine) as session, session.begin():
            cards, missing = engine_export.load(
                session,
                self.client,
                str(self.settings.engine_url),
                self.settings.engine_service_token.get_secret_value(),
            )
            last = session.execute(
                select(CatalogRevision.id, CatalogRevision.engine_build)
                .order_by(CatalogRevision.id.desc())
                .limit(1)
            ).first()
            checked = session.scalar(
                select(CatalogRevision.id).where(CatalogRevision.engine_build.is_not(None)).limit(1)
            )
        self.stats["engine"] = cards.build if cards else missing
        # A catalog never checked against the engine waits for it: a deploy starts the worker with
        # the engine, which takes a minute to load, and an import without it would leave every card
        # unchecked until the next day's run. Later runs go ahead and keep the cards' statuses.
        if cards is None and checked is None and missing != "engine_service_off":
            raise SyncError(
                str(missing),
                "The engine's implementation list is not available yet; the import waits for it.",
                transient=True,
            )
        files = discover(self.client, str(self.settings.scryfall_url))
        sources, changed = self.sources(files)
        engine_new = cards is not None and (last is None or last.engine_build != cards.build)
        if last is not None and not changed and not engine_new:
            self.finish("unchanged", None, None, revision_id=last.id)
            return Outcome("completed", "unchanged", run_id=self.run_id, revision_id=last.id)
        with Session(self.engine) as session:
            previous = {
                dataset: snapshot.records or 0
                for dataset, snapshot in previous_snapshots(session).items()
            }
        validated = validate(sources, self.limits, previous)
        self.stats["counts"] = validated.counts
        self.heartbeat.check()
        datasets: dict[str, object] = {
            dataset: {
                "updated_at": files[dataset].updated_at.isoformat(),
                "sha256": sha256_of(source.path),
                "records": validated.counts[dataset],
            }
            for dataset, source in sources.items()
        }
        with Session(self.engine) as session, session.begin():
            Fence(self.job.id, self.job.generation).hold(session)
            for dataset, source in sources.items():
                if source.snapshot_id is not None:
                    session.execute(
                        update(SourceSnapshot)
                        .where(SourceSnapshot.id == source.snapshot_id)
                        .values(
                            records=validated.counts[dataset],
                            status="validated",
                        )
                    )
            applied = Apply(session, sources, self.limits, cards, datetime.now(UTC)).run(
                validated, self.run_id, datasets
            )
            revision_id = applied.revision_id
        self.stats["changes"] = applied.changes
        self.finish("succeeded", None, None, revision_id=revision_id)
        log.info("Catalog revision %s applied: %s", revision_id, applied.changes)
        return Outcome("completed", "imported", run_id=self.run_id, revision_id=revision_id)


def backoff(attempt: int) -> timedelta:
    return timedelta(seconds=min(BACKOFF_SECONDS * 2 ** (attempt - 1), MAX_BACKOFF_SECONDS))


def handle(
    engine: Engine,
    settings: Settings,
    client: httpx.Client,
    job: Claimed,
    heartbeat_seconds: float | None = 20.0,
) -> Outcome:
    now = datetime.now(UTC)
    if not settings.catalog_dir:
        return Outcome("failed", "catalog_off")
    if overlapping(engine, job, now):
        return Outcome("pending", "waiting_for_other_run", retry_at=now + timedelta(minutes=5))
    with Heartbeat(engine, job, heartbeat_seconds) as heartbeat:
        return attempt_run(engine, settings, client, job, now, heartbeat)


def attempt_run(
    engine: Engine,
    settings: Settings,
    client: httpx.Client,
    job: Claimed,
    now: datetime,
    heartbeat: Heartbeat,
) -> Outcome:
    run = Run(engine, settings, client, job, now, heartbeat)
    attempt = int(job.payload.get("attempt", 1))
    try:
        return run.execute()
    except Fenced:
        run.finish("fenced", "fenced", "Another worker took this run over.")
        return Outcome("fenced", "fenced", run_id=run.run_id)
    except SyncError as error:
        retry = error.transient and attempt < MAX_ATTEMPTS
        retry_at = now + backoff(attempt) if retry else None
        run.finish("failed", error.code, error.message, next_attempt_at=retry_at)
        log.warning("Catalog sync failed (%s): %s", error.code, error.message)
        if retry:
            return Outcome("pending", error.code, retry_at=retry_at, run_id=run.run_id)
        return Outcome("failed", error.code, run_id=run.run_id)
    except Exception as error:
        run.finish("failed", "internal_error", f"{error.__class__.__name__}: {error}")
        log.exception("Catalog sync failed unexpectedly")
        return Outcome("failed", "internal_error", run_id=run.run_id)


def settle(engine: Engine, job: Claimed, outcome: Outcome, now: datetime) -> bool:
    """Records the outcome on the job, if this worker still owns it."""
    values: dict[str, Any] = {"lease_until": None, "result_code": outcome.code[:64]}
    if outcome.status == "pending":
        attempt = int(job.payload.get("attempt", 1))
        if outcome.code != "waiting_for_other_run":
            attempt += 1
        values.update(
            status="pending",
            due_at=outcome.retry_at or now,
            payload={**job.payload, "attempt": attempt},
        )
    elif outcome.status == "fenced":
        return False
    else:
        values["status"] = "completed" if outcome.status == "completed" else "failed"
    with engine.begin() as connection:
        result = connection.execute(
            update(ScheduledJob)
            .where(
                and_(
                    ScheduledJob.id == job.id,
                    ScheduledJob.generation == job.generation,
                    ScheduledJob.status == "running",
                )
            )
            .values(**values)
        )
        return bool(result.rowcount)
