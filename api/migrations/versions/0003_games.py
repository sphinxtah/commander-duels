"""Games: practice games the API started in the engine, their seats, owners and results."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003_games"
down_revision = "0002_identity"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
TIMESTAMP = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "games",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("format", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("finished_at", TIMESTAMP),
        sa.Column("bot_skill", sa.Integer(), nullable=False),
        sa.Column("turn_cap", sa.Integer(), nullable=False),
        sa.Column("result", JSON),
        sa.CheckConstraint("kind IN ('practice')", name="ck_games_kind"),
        sa.CheckConstraint("format IN ('legacy', 'commander')", name="ck_games_format"),
        sa.CheckConstraint(
            "status IN ('active', 'finished', 'interrupted')", name="ck_games_status"
        ),
    )
    op.create_index("ix_games_status", "games", ["status"])
    op.create_index("ix_games_created_by", "games", ["created_by"])

    op.create_table(
        "game_seats",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("game_id", sa.Uuid(), sa.ForeignKey("games.id"), nullable=False),
        sa.Column("seat", sa.Integer(), nullable=False),
        sa.Column("player", sa.String(8), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("deck", sa.String(64), nullable=False),
        sa.Column("deck_list", JSON),
        sa.UniqueConstraint("game_id", "seat"),
        sa.CheckConstraint("player IN ('human', 'bot')", name="ck_game_seats_player"),
        sa.CheckConstraint(
            "(player = 'human') = (user_id IS NOT NULL)", name="ck_game_seats_owner"
        ),
    )
    op.create_index("ix_game_seats_game_id", "game_seats", ["game_id"])
    op.create_index("ix_game_seats_user_id", "game_seats", ["user_id"])


def downgrade() -> None:
    op.drop_table("game_seats")
    op.drop_table("games")
