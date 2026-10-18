from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, create_engine

MIGRATIONS = Path(__file__).with_name("migrations")


def build_engine(url: str) -> Engine:
    kwargs = {"connect_timeout": 3} if url.startswith("postgresql") else {}
    return create_engine(url, pool_pre_ping=True, connect_args=kwargs)


def migration_head() -> str:
    """Revision a ready database must report. A branched migration history fails loudly."""
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS))
    config.set_main_option("path_separator", "os")
    head = ScriptDirectory.from_config(config).get_current_head()
    if head is None:
        raise RuntimeError(f"No Alembic revisions found in {MIGRATIONS}")
    return head
