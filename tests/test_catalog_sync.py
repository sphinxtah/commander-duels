"""Whole catalog runs against a stand-in Scryfall and engine: download, import, skip, retry."""

import gzip
import io
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import httpx
from catalog_fixtures import database, engine_list, records
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.config import Settings
from api.models import (
    CardConcept,
    CatalogRevision,
    CatalogSyncRun,
    ScheduledJob,
    SourceSnapshot,
)
from catalog import sync
from catalog.scryfall import DATASETS

UPDATED = "2026-10-20T09:01:59.775+00:00"


def gz(rows: list[dict[str, object]]) -> bytes:
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", mtime=0) as f:
        for row in rows:
            f.write((json.dumps(row) + "\n").encode())
    return out.getvalue()


class Scryfall:
    """Serves the bulk-data list, the four files and the engine's health and list."""

    def __init__(self) -> None:
        self.files = {dataset: gz(records(dataset)) for dataset in DATASETS}
        self.updated = {dataset: UPDATED for dataset in DATASETS}
        self.export = engine_list()
        self.list_status = 200
        self.engine_up = True
        self.cut_short: str | None = None
        self.requests: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request.url.path)
        if request.url.path == "/bulk-data":
            if self.list_status != 200:
                return httpx.Response(self.list_status, headers={"Retry-After": "10"})
            return httpx.Response(
                200,
                json={
                    "object": "list",
                    "data": [
                        {
                            "object": "bulk_data",
                            "type": dataset,
                            "updated_at": self.updated[dataset],
                            "jsonl_download_uri": f"https://data.scryfall.io/{dataset}.jsonl.gz",
                            "compressed_size": len(self.files[dataset]),
                        }
                        for dataset in DATASETS
                    ]
                    + [{"object": "bulk_data", "type": "all_cards", "download_uri": "x"}],
                },
            )
        if request.url.host == "data.scryfall.io":
            dataset = request.url.path.strip("/").split(".")[0]
            body = self.files[dataset]
            if dataset == self.cut_short:
                body = body[: len(body) // 2]
            # A stream, as a real download is: the client reads it raw, chunk by chunk.
            return httpx.Response(
                200, stream=httpx.ByteStream(body), headers={"ETag": f'"{dataset}"'}
            )
        if request.url.path == "/health":
            if not self.engine_up:
                return httpx.Response(503, json={"status": "loading"})
            return httpx.Response(200, json={"implementations": {"build": self.export["build"]}})
        if request.url.path == "/v1/service/implementations":
            assert request.headers["X-Service-Token"] == "t" * 32
            return httpx.Response(200, json=self.export)
        return httpx.Response(404)


def settings(tmp_path: Path) -> Settings:
    return Settings(
        database_url=f"sqlite:///{tmp_path}/catalog.db",
        catalog_dir=str(tmp_path / "files"),
        engine_service_token="t" * 32,
        engine_url="http://engine:8090",
    )


def job(engine, payload: dict[str, object] | None = None) -> sync.Claimed:
    with Session(engine) as session, session.begin():
        row = ScheduledJob(
            kind=sync.KIND,
            deduplication_key=str(uuid4()),
            payload=payload or {"trigger": "schedule"},
            status="running",
            due_at=datetime.now(UTC),
            lease_until=datetime.now(UTC) + timedelta(seconds=60),
            generation=1,
        )
        session.add(row)
        session.flush()
        return sync.Claimed(row.id, 1, dict(row.payload))


def run(engine, config: Settings, fake: Scryfall, payload=None) -> sync.Outcome:
    claimed = job(engine, payload)
    with httpx.Client(transport=httpx.MockTransport(fake.handler)) as client:
        outcome = sync.handle(engine, config, client, claimed, heartbeat_seconds=None)
    sync.settle(engine, claimed, outcome, datetime.now(UTC))
    return outcome


def test_a_sync_imports_then_skips_unchanged_files(tmp_path):
    engine = database(tmp_path)
    config = settings(tmp_path)
    fake = Scryfall()
    first = run(engine, config, fake)
    assert (first.status, first.code) == ("completed", "imported")
    with Session(engine) as session:
        snapshots = session.scalars(select(SourceSnapshot)).all()
        assert {s.dataset: s.status for s in snapshots} == {d: "applied" for d in DATASETS}
        assert all(len(s.sha256) == 64 and s.etag for s in snapshots)
        record = session.get(CatalogSyncRun, first.run_id)
        assert record.status == "succeeded" and record.revision_id == first.revision_id
        assert set(record.stats["downloaded"]) == set(DATASETS)
    second = run(engine, config, fake)
    assert (second.status, second.code, second.revision_id) == (
        "completed",
        "unchanged",
        first.revision_id,
    )
    # Unchanged files are not downloaded again, and the engine list is not fetched again.
    assert fake.requests.count("/v1/service/implementations") == 1
    assert sum(1 for path in fake.requests if path.endswith(".jsonl.gz")) == len(DATASETS)
    # A new file from Scryfall makes a new revision.
    fake.updated["rulings"] = "2026-10-21T09:00:00+00:00"
    third = run(engine, config, fake)
    assert third.code == "imported" and third.revision_id == first.revision_id + 1
    # So does a new engine build, with the same files.
    fake.export = {**engine_list(), "build": "test-build-2"}
    fourth = run(engine, config, fake)
    assert fourth.code == "imported"
    with Session(engine) as session:
        assert session.get(CatalogRevision, fourth.revision_id).engine_build == "test-build-2"


def test_a_broken_transfer_retries_with_backoff_and_keeps_the_catalog(tmp_path):
    engine = database(tmp_path)
    config = settings(tmp_path)
    fake = Scryfall()
    good = run(engine, config, fake)
    fake.updated["default_cards"] = "2026-10-21T09:00:00+00:00"
    fake.cut_short = "default_cards"
    broken = run(engine, config, fake)
    assert (broken.status, broken.code) == ("pending", "download_incomplete")
    assert broken.retry_at is not None
    with Session(engine) as session:
        assert session.scalar(select(func.max(CatalogRevision.id))) == good.revision_id
        failed = session.get(CatalogSyncRun, broken.run_id)
        assert failed.status == "failed" and failed.next_attempt_at is not None
        assert not (Path(config.catalog_dir) / "default_cards.jsonl.gz.part").exists()


def test_the_first_import_waits_for_the_engine_and_later_ones_do_not(tmp_path):
    engine = database(tmp_path)
    config = settings(tmp_path)
    fake = Scryfall()
    # A deploy starts the worker while the engine still loads: nothing is downloaded or written.
    fake.engine_up = False
    waiting = run(engine, config, fake)
    assert (waiting.status, waiting.code) == ("pending", "engine_unavailable")
    assert waiting.retry_at is not None
    assert not any(path.endswith(".jsonl.gz") for path in fake.requests)
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(CatalogRevision)) == 0
    fake.engine_up = True
    first = run(engine, config, fake)
    assert first.code == "imported"
    with Session(engine) as session:
        playable = session.scalar(
            select(func.count()).select_from(CardConcept).where(CardConcept.status == "certified")
        )
    assert playable > 0
    # Once the catalog has met the engine, a run without it goes ahead and keeps the statuses.
    fake.engine_up = False
    fake.updated["rulings"] = "2026-10-21T09:00:00+00:00"
    later = run(engine, config, fake)
    assert later.code == "imported"
    with Session(engine) as session:
        assert session.get(CatalogRevision, later.revision_id).engine_build is None
        assert (
            session.scalar(
                select(func.count())
                .select_from(CardConcept)
                .where(CardConcept.status == "certified")
            )
            == playable
        )


def test_a_version_that_learns_a_layout_imports_again_at_once(tmp_path):
    """v0.4.5 learned the prepare layout: when the worker starts, the revision that quarantined
    such cards queues a run due at once, which waits for the engine and imports though no file
    changed, so they are decided straight away rather than at the next day's run."""
    engine = database(tmp_path)
    config = settings(tmp_path)
    fake = Scryfall()
    first = run(engine, config, fake)
    now = datetime.now(UTC)
    # The test slice's only quarantined layout is one no version knows yet.
    assert not sync.ensure_relearned(engine, config, now)
    # As a version before v0.4.5 recorded its revision.
    with Session(engine) as session, session.begin():
        revision = session.get(CatalogRevision, first.revision_id)
        revision.counts = {**revision.counts, "unknown_layouts": {"front_card": 1, "prepare": 72}}
    assert sync.ensure_relearned(engine, config, now)
    assert sync.ensure_relearned(engine, config, now)
    with Session(engine) as session:
        queued = session.scalars(
            select(ScheduledJob).where(
                ScheduledJob.deduplication_key == f"catalog_sync:relearn:{first.revision_id}"
            )
        ).all()
        assert [(job.status, job.due_at.replace(tzinfo=UTC)) for job in queued] == [
            ("pending", now)
        ]
    fake.engine_up = False
    waiting = run(engine, config, fake)
    assert (waiting.status, waiting.code) == ("pending", "engine_unavailable")
    fake.engine_up = True
    again = run(engine, config, fake)
    assert (again.code, again.revision_id) == ("imported", first.revision_id + 1)
    with Session(engine) as session:
        abigale = select(CardConcept.status).where(
            CardConcept.name == "Abigale, Poet Laureate // Heroic Stanza"
        )
        assert session.scalar(abigale) == "certified"
    assert not sync.ensure_relearned(engine, config, now)
    # With the catalog sync off, nothing is queued.
    assert not sync.ensure_relearned(engine, Settings(database_url=config.database_url), now)


def test_rate_limits_retry_and_settle_reschedules_the_job(tmp_path):
    engine = database(tmp_path)
    config = settings(tmp_path)
    fake = Scryfall()
    fake.list_status = 429
    claimed = job(engine)
    with httpx.Client(transport=httpx.MockTransport(fake.handler)) as client:
        outcome = sync.handle(engine, config, client, claimed, heartbeat_seconds=None)
    assert (outcome.status, outcome.code) == ("pending", "scryfall_rate_limited")
    assert sync.settle(engine, claimed, outcome, datetime.now(UTC))
    with Session(engine) as session:
        row = session.get(ScheduledJob, claimed.id)
        assert row.status == "pending" and row.payload["attempt"] == 2
    # The last attempt gives up until the next scheduled run.
    last = job(engine, {"trigger": "schedule", "attempt": sync.MAX_ATTEMPTS})
    with httpx.Client(transport=httpx.MockTransport(fake.handler)) as client:
        outcome = sync.handle(engine, config, client, last, heartbeat_seconds=None)
    assert outcome.status == "failed"
    assert sync.settle(engine, last, outcome, datetime.now(UTC))
    # A refusal that retrying cannot fix fails at once.
    fake.list_status = 403
    with httpx.Client(transport=httpx.MockTransport(fake.handler)) as client:
        outcome = sync.handle(engine, config, client, job(engine), heartbeat_seconds=None)
    assert (outcome.status, outcome.code) == ("failed", "scryfall_refused")


def test_a_taken_over_job_does_not_settle(tmp_path):
    engine = database(tmp_path)
    claimed = job(engine)
    with Session(engine) as session, session.begin():
        session.get(ScheduledJob, claimed.id).generation = 2
    assert not sync.renew(engine, claimed, datetime.now(UTC))
    assert not sync.settle(
        engine, claimed, sync.Outcome("completed", "imported"), datetime.now(UTC)
    )


def test_overlapping_runs_wait(tmp_path):
    engine = database(tmp_path)
    config = settings(tmp_path)
    job(engine)
    second = job(engine)
    with httpx.Client(transport=httpx.MockTransport(Scryfall().handler)) as client:
        outcome = sync.handle(engine, config, client, second, heartbeat_seconds=None)
    assert (outcome.status, outcome.code) == ("pending", "waiting_for_other_run")


def test_the_schedule_queues_one_run_a_day_and_manual_runs_wait_their_turn(tmp_path):
    engine = database(tmp_path)
    config = settings(tmp_path)
    now = datetime(2026, 10, 20, 15, 0, tzinfo=UTC)
    sync.ensure_scheduled(engine, config, now)
    sync.ensure_scheduled(engine, config, now)
    with Session(engine) as session:
        jobs = session.scalars(select(ScheduledJob).order_by(ScheduledJob.due_at)).all()
        assert [job.deduplication_key for job in jobs] == [
            "catalog_sync:2026-10-20",
            "catalog_sync:2026-10-21",
        ]
        start = datetime(2026, 10, 20, 10, 0, tzinfo=UTC)
        assert start <= jobs[0].due_at.replace(tzinfo=UTC) <= start + timedelta(minutes=30)
        # Today's run is overdue, so a manual request waits for it.
        assert sync.request_now(session, uuid4(), now) is None
    off = Settings(database_url=config.database_url)
    (tmp_path / "off").mkdir()
    engine2 = database(tmp_path / "off")
    sync.ensure_scheduled(engine2, off, now)
    with Session(engine2) as session:
        assert session.scalar(select(func.count()).select_from(ScheduledJob)) == 0
        manual = sync.request_now(session, uuid4(), now)
        assert manual is not None and manual.payload["trigger"] == "manual"
