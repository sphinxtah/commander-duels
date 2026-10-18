"""Opt-in PostgreSQL locking test; isolated schema never mutates application tables."""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from api.models import Base, ScheduledJob
from catalog.worker import claim, finish


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_parallel_workers_claim_once():
    url = os.environ["CD_TEST_POSTGRES_URL"]
    schema = f"test_{uuid4().hex}"
    admin = create_engine(url, connect_args={"connect_timeout": 3})
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_engine(
        url, connect_args={"options": f"-csearch_path={schema}", "connect_timeout": 3}
    )
    try:
        Base.metadata.create_all(engine)
        now = datetime.now(UTC)
        with Session(engine) as session, session.begin():
            session.add(ScheduledJob(kind="health_probe", deduplication_key="probe", due_at=now))
        with ThreadPoolExecutor(max_workers=4) as workers:
            claims = list(workers.map(lambda _: claim(engine, now), range(4)))
        accepted = [job for job in claims if job is not None]
        assert len(accepted) == 1
        assert finish(engine, *accepted[0], now)
        assert not finish(engine, *accepted[0], now)
        with Session(engine) as session:
            assert session.get(ScheduledJob, accepted[0][0]).status == "completed"
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
