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
        # So is the economy ledger (v0.4.0): tokens once paid or spent stay recorded.
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO token_ledger (id, user_id, kind, amount, key, policy, "
                    "created_at) VALUES (:id, :user, 'welcome', 1000, 'welcome:test', "
                    "'tokens-v1', now())"
                ),
                {"id": uuid4(), "user": player},
            )
        for statement in ("UPDATE token_ledger SET amount = 9", "DELETE FROM token_ledger"):
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


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_account_deletion_on_postgresql(monkeypatch):
    """Deleting an account (v0.4.1) against PostgreSQL's foreign keys, its append-only ledgers
    and audit trail, and the revisions' trigger: a deleted account's played revision may lose its
    title and notes, and nothing else may change."""
    from api.accounts import delete_account
    from api.models import (
        AuditEvent,
        Deck,
        DeckEntryRow,
        DeckRevision,
        ExternalIdentity,
        Game,
        GameSeat,
        GameTable,
        ProgressEntry,
        RoleGrant,
        TableSeat,
        TokenEntry,
        User,
        UserSession,
    )

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
        now = datetime.now(UTC)
        with Session(engine, expire_on_commit=False) as db:
            ada = User(handle="ada", normalized_handle="ada", display_name="Ada", created_at=now)
            bob = User(
                handle="bob", normalized_handle="bob", display_name="Bob Smith", created_at=now
            )
            db.add_all([ada, bob])
            db.flush()

            def deck_of(owner: User, title: str) -> Deck:
                deck = Deck(
                    owner_id=owner.id,
                    title=title,
                    format="legacy",
                    visibility="link",
                    share_code=uuid4().hex[:16],
                    notes="Ring me on 555-0100",
                    draft={},
                    draft_hash="",
                    created_at=now,
                    updated_at=now,
                )
                db.add(deck)
                db.flush()
                return deck

            def revision_of(deck: Deck, number: int) -> DeckRevision:
                revision = DeckRevision(
                    deck_id=deck.id,
                    number=number,
                    format="legacy",
                    title=deck.title,
                    notes=deck.notes,
                    content_hash="x",
                    legal=True,
                    playable=True,
                    created_at=now,
                )
                db.add(revision)
                db.flush()
                db.add(
                    DeckEntryRow(
                        revision_id=revision.id,
                        custom_card_id=uuid4(),
                        quantity=60,
                        location="main",
                    )
                )
                return revision

            # Bob played one revision of his burn deck; the other, and his spare deck, no game
            # played. The spare deck sits at Ada's open table; the burn deck's second revision is
            # the one his seat at a started table was last bound to (v0.5.1).
            burn, spare = deck_of(bob, "Bob's Burn"), deck_of(bob, "Spare")
            played = revision_of(burn, 1)
            unplayed = revision_of(burn, 2)
            revision_of(spare, 1)
            theirs = revision_of(deck_of(ada, "Ada's"), 1)
            game = Game(
                id=uuid4(),
                format="legacy",
                status="finished",
                created_by=bob.id,
                created_at=now,
                bot_skill=1,
                turn_cap=10,
            )
            db.add(game)
            db.flush()
            for seat, owner, revision in ((0, bob, played), (1, ada, theirs)):
                db.add(
                    GameSeat(
                        game_id=game.id,
                        seat=seat,
                        player="human",
                        user_id=owner.id,
                        deck=revision.title,
                        deck_revision_id=revision.id,
                    )
                )
            table = GameTable(
                code=uuid4().hex,
                host_id=ada.id,
                format="legacy",
                visibility="public",
                seats=2,
                bots=0,
                bot_skill=1,
                turn_cap=10,
                status="open",
                created_at=now,
            )
            db.add(table)
            db.flush()
            db.add(
                TableSeat(
                    table_id=table.id, seat=1, user_id=bob.id, deck_id=spare.id, joined_at=now
                )
            )
            started = GameTable(
                code=uuid4().hex,
                host_id=bob.id,
                format="legacy",
                visibility="public",
                seats=2,
                bots=0,
                bot_skill=1,
                turn_cap=10,
                status="started",
                game_id=game.id,
                created_at=now,
            )
            db.add(started)
            db.flush()
            db.add(
                TableSeat(
                    table_id=started.id,
                    seat=0,
                    user_id=bob.id,
                    deck_id=burn.id,
                    deck_revision_id=unplayed.id,
                    joined_at=now,
                )
            )
            db.add(
                ExternalIdentity(user_id=bob.id, issuer="https://accounts.google.com", subject="2")
            )
            db.add(
                UserSession(
                    token_hash="0" * 64,
                    user_id=bob.id,
                    kind="google",
                    csrf_token="csrf",
                    privilege_version=0,
                    created_at=now,
                    authenticated_at=now,
                    last_seen_at=now,
                    idle_expires_at=now,
                    absolute_expires_at=now,
                )
            )
            db.add(RoleGrant(user_id=bob.id, role="moderator", granted_by=ada.id, granted_at=now))
            db.add(
                TokenEntry(
                    user_id=bob.id,
                    kind="welcome",
                    amount=1000,
                    key=f"welcome:{bob.id}",
                    policy="tokens-v1",
                    created_at=now,
                )
            )
            db.add(
                ProgressEntry(
                    user_id=bob.id,
                    kind="game_win",
                    wins=1,
                    key=f"win:{game.id}:0",
                    game_id=game.id,
                    policy="wins-v1",
                    created_at=now,
                )
            )
            db.add(AuditEvent(occurred_at=now, actor_id=bob.id, action="test.event", details={}))
            db.commit()

            removed = delete_account(db, bob, now)
            db.commit()
            assert (removed.revisions, removed.kept_revisions) == (2, 1)
            assert (removed.decks, removed.kept_decks, removed.tables_left) == (1, 1, 1)

        with engine.connect() as connection:
            assert connection.execute(
                text("SELECT id, title, notes FROM deck_revisions ORDER BY title")
            ).all() == [
                (theirs.id, "Ada's", "Ring me on 555-0100"),
                (played.id, "Deleted deck", ""),
            ]
            assert connection.execute(text("SELECT count(*) FROM deck_entries")).scalar() == 2
            assert set(connection.execute(text("SELECT title FROM decks")).scalars()) == {
                "Ada's",
                "Deleted deck",
            }
            seats = connection.execute(text("SELECT deck FROM game_seats ORDER BY seat"))
            assert seats.scalars().all() == ["Deleted deck", "Ada's"]
            # The started table keeps Bob's seat, which lets go of the revision now deleted.
            kept = connection.execute(text("SELECT deck_id, deck_revision_id FROM table_seats"))
            assert kept.all() == [(burn.id, None)]
            for name, expected in (
                ("token_ledger", 1),
                ("progress_ledger", 1),
                ("audit_events", 1),
                ("table_seats", 1),
                ("external_identities", 0),
                ("sessions", 0),
                ("role_grants", 0),
            ):
                assert connection.execute(text(f"SELECT count(*) FROM {name}")).scalar() == (
                    expected
                ), name

        # The kept revision may be blanked again, to the same words, and changed in no other way;
        # no other account's revision may be blanked at all.
        with engine.begin() as connection:
            connection.execute(
                text("UPDATE deck_revisions SET title = 'Deleted deck', notes = '' WHERE id = :id"),
                {"id": played.id},
            )
        for statement, revision_id in (
            (
                "UPDATE deck_revisions SET title = 'Deleted deck', notes = '' WHERE id = :id",
                theirs.id,
            ),
            ("UPDATE deck_revisions SET content_hash = 'y' WHERE id = :id", played.id),
            ("UPDATE deck_revisions SET title = 'Rewritten' WHERE id = :id", played.id),
            ("UPDATE deck_revisions SET notes = 'Rewritten' WHERE id = :id", played.id),
            ("UPDATE deck_entries SET quantity = 1 WHERE revision_id = :id", played.id),
        ):
            with pytest.raises(DBAPIError, match="immutable"), engine.begin() as connection:
                connection.execute(text(statement), {"id": revision_id})

        # Going back to v0.4.0 leaves the account disabled, and revisions immutable as before.
        command.downgrade(config, "0011_custom_play")
        with engine.connect() as connection:
            status = connection.execute(
                text("SELECT status FROM users WHERE id = :id"), {"id": bob.id}
            )
            assert status.scalar() == "disabled"
            gone = connection.execute(text("SELECT to_regproc('deck_revisions_redactable')"))
            assert gone.scalar() is None
        command.upgrade(config, "head")
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
