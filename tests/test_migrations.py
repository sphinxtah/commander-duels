from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text

from api.database import migration_head


def test_migration_upgrade_and_downgrade(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path}/migration.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    config = Config("alembic.ini")
    command.upgrade(config, "head")
    engine = create_engine(url)
    with engine.connect() as connection:
        # Readiness compares against this head; it must match what `upgrade head` applies.
        revision = connection.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert revision == migration_head()
    assert set(inspect(engine).get_table_names()) == {
        "alembic_version",
        "users",
        "progress_ledger",
        "token_ledger",
        "site_settings",
        "shop_products",
        "booster_collations",
        "booster_sync_runs",
        "booster_sources",
        "packs",
        "pack_openings",
        "pack_cards",
        "library_grants",
        "custom_cards",
        "external_identities",
        "rules_bundles",
        "scheduled_jobs",
        "sessions",
        "role_grants",
        "audit_events",
        "login_challenges",
        "games",
        "game_seats",
        "game_tables",
        "table_seats",
        "card_images",
        "catalog_sync_runs",
        "catalog_revisions",
        "catalog_source_snapshots",
        "catalog_changes",
        "card_concepts",
        "card_faces",
        "card_printings",
        "card_rulings",
        "card_relations",
        "card_aliases",
        "card_tags",
        "card_tag_links",
        "engine_cards",
        "format_versions",
        "decks",
        "deck_revisions",
        "deck_entries",
    }
    command.downgrade(config, "base")
    assert inspect(engine).get_table_names() == ["alembic_version"]
    command.upgrade(config, "head")
    engine.dispose()


def test_a_deleted_account_goes_back_as_disabled(tmp_path, monkeypatch):
    """v0.4.0 knows no deleted status (migration 0013): going back leaves the account disabled,
    which that version refuses at sign-in."""
    url = f"sqlite:///{tmp_path}/deleted.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    config = Config("alembic.ini")
    command.upgrade(config, "head")
    engine = create_engine(url)
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO users (id, display_name, kind, status, onboarding, avatar, locale, "
                "preferences, privilege_version, created_at, deleted_at) VALUES ('0123456789ab"
                "cdef0123456789abcdef', 'Deleted player', 'player', 'deleted', 'complete', "
                "'sigil', 'en', '{}', 1, '2026-10-21', '2026-10-21')"
            )
        )
    command.downgrade(config, "0011_custom_play")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT status FROM users")).scalar() == "disabled"
    assert "deleted_at" not in {column["name"] for column in inspect(engine).get_columns("users")}
    command.upgrade(config, "head")
    engine.dispose()
