import logging
import signal
from datetime import UTC, datetime, timedelta
from threading import Event
from uuid import UUID

from sqlalchemy import Engine, and_, or_, select, update
from sqlalchemy.orm import Session

from api.config import Settings
from api.database import build_engine
from api.models import ScheduledJob

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
    # Only a bounded infrastructure probe is supported. Never fake a successful catalog import.
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
        while not stopped.is_set():
            try:
                job = claim(engine, datetime.now(UTC))
                if job:
                    finish(engine, *job, datetime.now(UTC))
            except Exception:
                logger.error("Worker iteration failed; check database connectivity and migrations")
            stopped.wait(config.worker_poll_seconds)
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
