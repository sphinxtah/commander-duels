from datetime import UTC, datetime, timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from api.models import Base, ScheduledJob
from catalog.worker import claim, finish


def test_lease_recovery_fences_old_worker_and_rejects_unknown_jobs(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path}/jobs.db")
    Base.metadata.create_all(engine)
    now = datetime.now(UTC)
    with Session(engine) as session, session.begin():
        session.add(ScheduledJob(kind="scryfall_sync", deduplication_key="test", due_at=now))
    first = claim(engine, now)
    assert first is not None
    assert claim(engine, now) is None
    later = now + timedelta(seconds=31)
    recovered = claim(engine, later)
    assert recovered is not None and recovered[1] == first[1] + 1
    assert not finish(engine, *first, later)
    assert finish(engine, *recovered, later)
    assert not finish(engine, *recovered, later)
    with Session(engine) as session:
        job = session.get(ScheduledJob, first[0])
        assert job.status == "failed"
        assert job.result_code == "unsupported_job_kind"
    engine.dispose()
