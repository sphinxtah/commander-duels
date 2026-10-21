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
        "problem_reports",
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
