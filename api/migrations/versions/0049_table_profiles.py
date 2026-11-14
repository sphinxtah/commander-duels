"""v0.9.12: Rule Zero table profiles (api/table_profiles.py, docs/tables.md).

- game_tables.profile: the host's profile, whole; intent, pace and duration beside it, which the
  lobby searches by, with an index for the open tables.
- games.table_profile: the profile a table's game started under.
- table_presets: the tables a host saved to open again.

Expand only: nullable columns and a new table. A table with no profile is the table it was.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0049_table_profiles"
down_revision = "0048_deck_workshop"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.add_column("game_tables", sa.Column("profile", JSON))
    op.add_column("game_tables", sa.Column("intent", sa.String(16)))
    op.add_column("game_tables", sa.Column("pace", sa.String(16)))
    op.add_column("game_tables", sa.Column("duration", sa.SmallInteger()))
    op.create_index("ix_game_tables_status_intent", "game_tables", ["status", "intent"])
    op.add_column("games", sa.Column("table_profile", JSON))
    op.create_table(
        "table_presets",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(48), nullable=False),
        sa.Column("preset", JSON, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "name", name="uq_table_presets_name"),
    )
    op.create_index("ix_table_presets_user_id", "table_presets", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_table_presets_user_id", table_name="table_presets")
    op.drop_table("table_presets")
    op.drop_column("games", "table_profile")
    op.drop_index("ix_game_tables_status_intent", table_name="game_tables")
    op.drop_column("game_tables", "duration")
    op.drop_column("game_tables", "pace")
    op.drop_column("game_tables", "intent")
    op.drop_column("game_tables", "profile")
