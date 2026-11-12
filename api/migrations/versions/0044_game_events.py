"""v0.9.10: a game's structured events (api/events.py, docs/engine/events.md).

- game_events: each event the engine made of the game, by game and sequence number, with the
  epoch it was made in, its turn and kind for retrieval, and the event whole.

Expand only: the previous version reads nothing new.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")

revision = "0044_game_events"
down_revision = "0043_deck_packs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "game_events",
        sa.Column("game_id", sa.Uuid(), sa.ForeignKey("games.id"), primary_key=True),
        sa.Column("seq", sa.Integer(), primary_key=True, autoincrement=False),
        sa.Column("epoch", sa.SmallInteger(), nullable=False),
        sa.Column("turn", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("event", JSON, nullable=False),
    )
    op.create_index("ix_game_events_game_id_turn", "game_events", ["game_id", "turn"])
    op.create_index("ix_game_events_game_id_type", "game_events", ["game_id", "type"])


def downgrade() -> None:
    op.drop_index("ix_game_events_game_id_type", table_name="game_events")
    op.drop_index("ix_game_events_game_id_turn", table_name="game_events")
    op.drop_table("game_events")
