"""Human tables (v0.4.0): the lobby's tables and their seats, games of kind 'table', and the
seats that leave a game while it goes on (a concession, a removal, a loss)."""

import sqlalchemy as sa
from alembic import op

revision = "0009_tables"
down_revision = "0008_tokens"
branch_labels = None
depends_on = None

TIMESTAMP = sa.DateTime(timezone=True)
LEFT = "left_reason IS NULL OR left_reason IN ('conceded', 'removed', 'eliminated')"


def upgrade() -> None:
    with op.batch_alter_table("games") as games:
        games.drop_constraint("ck_games_kind", type_="check")
        games.create_check_constraint("ck_games_kind", "kind IN ('practice', 'table')")
    with op.batch_alter_table("game_seats") as seats:
        seats.add_column(sa.Column("left_at", TIMESTAMP))
        seats.add_column(sa.Column("left_reason", sa.String(16)))
        seats.create_check_constraint("ck_game_seats_left", LEFT)

    op.create_table(
        "game_tables",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("code", sa.String(32), nullable=False, unique=True),
        sa.Column("host_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("format", sa.String(16), nullable=False),
        sa.Column("visibility", sa.String(16), nullable=False),
        sa.Column("seats", sa.Integer(), nullable=False),
        sa.Column("bots", sa.Integer(), nullable=False),
        sa.Column("bot_skill", sa.Integer(), nullable=False),
        sa.Column("turn_cap", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("game_id", sa.Uuid(), sa.ForeignKey("games.id")),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("started_at", TIMESTAMP),
        sa.Column("closed_at", TIMESTAMP),
        sa.CheckConstraint("format IN ('legacy', 'commander')", name="ck_game_tables_format"),
        sa.CheckConstraint("visibility IN ('public', 'private')", name="ck_game_tables_visibility"),
        sa.CheckConstraint("status IN ('open', 'started', 'closed')", name="ck_game_tables_status"),
        sa.CheckConstraint(
            "seats BETWEEN 2 AND 4 AND bots >= 0 AND seats - bots >= 2",
            name="ck_game_tables_seats",
        ),
    )
    op.create_index("ix_game_tables_host_id", "game_tables", ["host_id"])
    op.create_index("ix_game_tables_status", "game_tables", ["status"])

    op.create_table(
        "table_seats",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("table_id", sa.Uuid(), sa.ForeignKey("game_tables.id"), nullable=False),
        sa.Column("seat", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("deck_id", sa.Uuid(), sa.ForeignKey("decks.id"), nullable=False),
        sa.Column("ready", sa.Boolean(), nullable=False),
        sa.Column("joined_at", TIMESTAMP, nullable=False),
        sa.UniqueConstraint("table_id", "seat"),
        sa.UniqueConstraint("table_id", "user_id"),
    )
    op.create_index("ix_table_seats_table_id", "table_seats", ["table_id"])
    op.create_index("ix_table_seats_user_id", "table_seats", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_table_seats_user_id", table_name="table_seats")
    op.drop_index("ix_table_seats_table_id", table_name="table_seats")
    op.drop_table("table_seats")
    op.drop_index("ix_game_tables_status", table_name="game_tables")
    op.drop_index("ix_game_tables_host_id", table_name="game_tables")
    op.drop_table("game_tables")
    with op.batch_alter_table("game_seats") as seats:
        seats.drop_constraint("ck_game_seats_left", type_="check")
        seats.drop_column("left_reason")
        seats.drop_column("left_at")
    # Games played at tables stay recorded, with their wins and tokens; earlier versions know
    # only practice games.
    op.execute("UPDATE games SET kind = 'practice' WHERE kind = 'table'")
    with op.batch_alter_table("games") as games:
        games.drop_constraint("ck_games_kind", type_="check")
        games.create_check_constraint("ck_games_kind", "kind IN ('practice')")
