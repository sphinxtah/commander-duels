"""Opt-in PostgreSQL locking test; isolated schema never mutates application tables."""

import os
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, make_url, select, text
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
        # The progression ledger (v0.3.1) is append-only too: a win, once counted, stays.
        player = uuid4()
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO users (id, normalized_handle, created_at, kind) "
                    "VALUES (:id, 'ada', now(), 'player')"
                ),
                {"id": player},
            )
            connection.execute(
                text(
                    "INSERT INTO progress_ledger (id, user_id, kind, wins, key, policy, "
                    "created_at) VALUES (:id, :user, 'wins_set', 5, 'set:test', 'wins-v1', now())"
                ),
                {"id": uuid4(), "user": player},
            )
        for statement in ("UPDATE progress_ledger SET wins = 9", "DELETE FROM progress_ledger"):
            with pytest.raises(DBAPIError, match="append-only"), engine.begin() as connection:
                connection.execute(text(statement))
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


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_catalog_search_and_decks_on_postgresql(monkeypatch, tmp_path):
    """The catalog's SQL on PostgreSQL: JSON legalities, keyword casts, color bits, mana value
    parity, tag hierarchy; deck validation; and revisions the database refuses to change."""
    from catalog_fixtures import bulk, engine_list, import_bulk

    from api.search import condition
    from api.validation import DeckContent, DeckEntry, validate_deck

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
    engine = create_engine(scoped, connect_args={"connect_timeout": 3})
    try:
        command.upgrade(Config("alembic.ini"), "head")
        import_bulk(engine, tmp_path / "files", bulk(), engine_list())
        # A second import of the same files changes nothing, on PostgreSQL too.
        again = import_bulk(engine, tmp_path / "again", bulk(), engine_list())
        assert {kind: count for kind, count in again.changes.items() if count} == {}
        from api.models import CardConcept

        with Session(engine) as session:
            for query, expected in (
                ("f:commander is:commander id:r", "Karlach, Fury of Avernus"),
                ("banned:legacy", "Black Lotus"),
                ("k:flying c:w", "Gisela, the Broken Blade"),
                ("mv:even c:u -t:land", "Counterspell"),
                ("otag:removal", "Swords to Plowshares"),
                ("r>=rare s:ced", "Black Lotus"),
                ("year<2000 t:instant", "Lightning Bolt"),
                ('o:"draw" or o:"discard" c=u', "Brainstorm"),
                ('!"lim-dul\'s vault"', "Lim-Dûl's Vault"),
            ):
                names = session.scalars(
                    select(CardConcept.name).where(condition(session, query))
                ).all()
                assert expected in names, query
            ids = {
                name: session.scalar(select(CardConcept.id).where(CardConcept.name == name))
                for name in ("Lightning Bolt", "Mountain")
            }
            result = validate_deck(
                session,
                DeckContent(
                    format="legacy",
                    entries=[
                        DeckEntry(card_id=ids["Lightning Bolt"], quantity=4),
                        DeckEntry(card_id=ids["Mountain"], quantity=56),
                    ],
                ),
                datetime.now(UTC).date(),
            )
            assert result.playable
        with engine.begin() as connection:
            user = uuid4()
            connection.execute(
                text(
                    "INSERT INTO users (id, display_name, kind, status, onboarding, avatar, "
                    "locale, preferences, privilege_version, created_at) VALUES (:id, 'Ada', "
                    "'player', 'active', 'complete', 'sigil', 'en', '{}', 0, now())"
                ),
                {"id": user},
            )
            deck, revision = uuid4(), uuid4()
            connection.execute(
                text(
                    "INSERT INTO decks (id, owner_id, title, format, visibility, notes, draft, "
                    "draft_version, draft_hash, card_count, legal, playable, identity, source, "
                    "created_at, updated_at) VALUES (:id, :owner, 'Burn', 'legacy', 'private', "
                    "'', '{}', 1, '', 0, false, false, '', 'empty', now(), now())"
                ),
                {"id": deck, "owner": user},
            )
            connection.execute(
                text(
                    "INSERT INTO deck_revisions (id, deck_id, number, format, title, notes, "
                    "content_hash, legal, playable, created_at) VALUES (:id, :deck, 1, "
                    "'legacy', 'Burn', '', 'x', true, true, now())"
                ),
                {"id": revision, "deck": deck},
            )
            connection.execute(
                text(
                    "INSERT INTO deck_entries (id, revision_id, concept_id, quantity, location) "
                    "VALUES (:id, :revision, :card, 4, 'main')"
                ),
                {"id": uuid4(), "revision": revision, "card": ids["Lightning Bolt"]},
            )
        for statement in (
            "UPDATE deck_revisions SET title = 'rewritten'",
            "UPDATE deck_entries SET quantity = 40",
        ):
            with pytest.raises(DBAPIError, match="immutable"), engine.begin() as connection:
                connection.execute(text(statement))
        with pytest.raises(IntegrityError), engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO deck_entries (id, revision_id, concept_id, quantity, location) "
                    "VALUES (:id, :revision, :card, 0, 'main')"
                ),
                {"id": uuid4(), "revision": revision, "card": ids["Mountain"]},
            )
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
