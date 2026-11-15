"""v1.0.0: Rule Zero at the table (api/tables.py, api/table_fit.py; docs/tables.md).

- game_tables.profile_changes and table_seats.profile_seen: how often a table's host changed its
  profile, and how many of those changes each seat's player has seen, so that a player says they
  have read a changed profile before getting ready again.
- table_fit: a player's answer after a table's game to how the table fit what its profile
  described. Counted in the site's numbers only.

Expand only: two columns with a default and a new table. Every row there is stays what it was.
"""

import sqlalchemy as sa
from alembic import op

revision = "0054_table_fit"
down_revision = "0053_replay_marks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "game_tables",
        sa.Column("profile_changes", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "table_seats",
        sa.Column("profile_seen", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_table(
        "table_fit",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("game_id", sa.Uuid(), sa.ForeignKey("games.id"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("fit", sa.String(16), nullable=False),
        sa.Column("intent", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("game_id", "user_id", name="uq_table_fit_answer"),
        sa.CheckConstraint(
            "fit IN ('as_described', 'stronger', 'weaker')", name="ck_table_fit_fit"
        ),
    )
    op.create_index("ix_table_fit_game_id", "table_fit", ["game_id"])
    op.create_index("ix_table_fit_user_id", "table_fit", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_table_fit_user_id", table_name="table_fit")
    op.drop_index("ix_table_fit_game_id", table_name="table_fit")
    op.drop_table("table_fit")
    op.drop_column("table_seats", "profile_seen")
    op.drop_column("game_tables", "profile_changes")
