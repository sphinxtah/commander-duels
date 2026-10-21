import logging
import signal
from datetime import UTC, datetime, timedelta
from threading import Event
from uuid import UUID

import httpx
from sqlalchemy import Engine, and_, or_, select, update
from sqlalchemy.orm import Session

from api import accounts
from api.config import Settings
from api.database import build_engine
from api.models import ScheduledJob
from catalog import boosters, sync

logger = logging.getLogger(__name__)


def claim(engine: Engine, now: datetime) -> tuple[UUID, int, str] | None:
    """PostgreSQL row lock excludes concurrent workers; generation fences late results."""
    with Session(engine) as session, session.begin():
        job = session.scalar(
            select(ScheduledJob)
            .where(
                ScheduledJob.due_at <= now,
                or_(
                    ScheduledJob.status == "pending",
                    and_(ScheduledJob.status == "running", ScheduledJob.lease_until <= now),
                ),
            )
            .order_by(ScheduledJob.due_at)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if job is None:
            return None
        job.status = "running"
        job.generation += 1
        job.lease_until = now + timedelta(seconds=30)
        return job.id, job.generation, job.kind


def finish(engine: Engine, job_id: UUID, generation: int, kind: str, now: datetime) -> bool:
    # The health probe completes at once; an unknown kind fails. Catalog syncs settle through
    # catalog.sync, which never records an import that did not happen.
    with engine.begin() as connection:
        result = connection.execute(
            update(ScheduledJob)
            .where(
                ScheduledJob.id == job_id,
                ScheduledJob.generation == generation,
                ScheduledJob.status == "running",
                ScheduledJob.lease_until > now,
            )
            .values(
                status="completed" if kind == "health_probe" else "failed",
                result_code="ok" if kind == "health_probe" else "unsupported_job_kind",
                lease_until=None,
            )
        )
        return result.rowcount == 1


def work(engine: Engine, config: Settings, client: httpx.Client) -> None:
    """One iteration: keep the catalog's, the booster data's and the account cleanup's schedules
    queued, then run one due job."""
    sync.ensure_scheduled(engine, config, datetime.now(UTC))
    boosters.ensure_scheduled(engine, config, datetime.now(UTC))
    accounts.ensure_scheduled(engine, datetime.now(UTC))
    job = claim(engine, datetime.now(UTC))
    if job is None:
        return
    job_id, generation, kind = job
    if kind not in (sync.KIND, boosters.KIND, accounts.KIND):
        finish(engine, *job, datetime.now(UTC))
        return
    with Session(engine) as session:
        payload = session.scalar(select(ScheduledJob.payload).where(ScheduledJob.id == job_id))
    claimed = sync.Claimed(job_id, generation, dict(payload or {}))
    if kind == accounts.KIND:
        outcome = accounts.handle(engine, datetime.now(UTC))
    elif kind == boosters.KIND:
        outcome = boosters.handle(engine, config, client, claimed)
    else:
        outcome = sync.handle(engine, config, client, claimed)
    if not sync.settle(engine, claimed, outcome, datetime.now(UTC)):
        logger.warning("Job %s (%s) was taken over before it settled", job_id, kind)


def main() -> None:
    config = Settings()
    logging.basicConfig(level=config.log_level)
    engine = build_engine(config.database_url)
    if engine.dialect.name != "postgresql":
        raise ValueError("The durable worker requires PostgreSQL row locking")
    stopped = Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stopped.set())
    try:
        with httpx.Client(timeout=30.0, trust_env=False, follow_redirects=False) as client:
            while not stopped.is_set():
                try:
                    work(engine, config, client)
                except Exception:
                    logger.exception(
                        "Worker iteration failed; check database connectivity and migrations"
                    )
                stopped.wait(config.worker_poll_seconds)
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
