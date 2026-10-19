"""Opt-in PostgreSQL locking test; isolated schema never mutates application tables."""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, make_url, text
from sqlalchemy.exc import DBAPIError, IntegrityError
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


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_migrations_and_append_only_audit_trail(monkeypatch):
    url = os.environ["CD_TEST_POSTGRES_URL"]
    schema = f"test_{uuid4().hex}"
    admin = create_engine(url, connect_args={"connect_timeout": 3})
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    scoped = (
        make_url(url)
        .update_query_dict({"options": f"-csearch_path={schema}"})
        .render_as_string(hide_password=False)
    )
    monkeypatch.setenv("CD_DATABASE_URL", scoped)
    config = Config("alembic.ini")
    engine = create_engine(scoped, connect_args={"connect_timeout": 3})
    try:
        command.upgrade(config, "head")
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO audit_events (id, occurred_at, action, details) "
                    "VALUES (:id, now(), 'test.event', '{}')"
                ),
                {"id": uuid4()},
            )
        for statement in (
            "UPDATE audit_events SET action = 'rewritten'",
            "DELETE FROM audit_events",
        ):
            with pytest.raises(DBAPIError, match="append-only"), engine.begin() as connection:
                connection.execute(text(statement))
        with engine.connect() as connection:
            assert connection.execute(text("SELECT action FROM audit_events")).scalar() == (
                "test.event"
            )
        # SysOp is unique; a second root account is refused by the database itself.
        with pytest.raises(IntegrityError), engine.begin() as connection:
            for handle in ("sysop", "sysop2"):
                connection.execute(
                    text(
                        "INSERT INTO users (id, normalized_handle, created_at, kind) "
                        "VALUES (:id, :handle, now(), 'sysop')"
                    ),
                    {"id": uuid4(), "handle": handle},
                )
        command.downgrade(config, "base")
        command.upgrade(config, "head")
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
