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
        "external_identities",
        "rules_bundles",
        "scheduled_jobs",
    }
    command.downgrade(config, "base")
    assert inspect(engine).get_table_names() == ["alembic_version"]
    command.upgrade(config, "head")
    engine.dispose()
