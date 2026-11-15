"""v1.0.0: games saved to be played on later (api/saves.py, docs/games.md).

- games.status may be ``saved``: a game its player saved, which runs nowhere and has no end yet.
- game_saves: each time a game was saved, until when it is kept, the engine build that holds it,
  and how the save ended.

Expand only: a check that allows one more value, and a new table. Every game there is keeps the
status it has. Going back is refused while a game is saved: the older API knows no such status,
and would neither show the game nor ever end it.
"""

import sqlalchemy as sa
from alembic import op

revision = "0052_game_saves"
down_revision = "0051_starter_tables"
branch_labels = None
depends_on = None

BEFORE = "status IN ('active', 'finished', 'interrupted')"
AFTER = "status IN ('active', 'finished', 'interrupted', 'saved')"


def upgrade() -> None:
    with op.batch_alter_table("games") as games:
        games.drop_constraint("ck_games_status", type_="check")
        games.create_check_constraint("ck_games_status", AFTER)
    op.create_table(
        "game_saves",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("game_id", sa.Uuid(), sa.ForeignKey("games.id"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("saved_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("engine_build", sa.String(64), nullable=False),
        sa.Column("turn", sa.Integer()),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
        sa.Column("ended_reason", sa.String(16)),
        sa.CheckConstraint(
            "ended_reason IS NULL OR ended_reason IN "
            "('resumed', 'discarded', 'expired', 'upgrade', 'unrecoverable', 'account')",
            name="ck_game_saves_ended_reason",
        ),
        sa.CheckConstraint(
            "(ended_at IS NULL) = (ended_reason IS NULL)", name="ck_game_saves_ended"
        ),
    )
    op.create_index("ix_game_saves_game_id", "game_saves", ["game_id"])
    op.create_index("ix_game_saves_user_id", "game_saves", ["user_id"])
    op.create_index(
        "uq_game_saves_open",
        "game_saves",
        ["game_id"],
        unique=True,
        postgresql_where=sa.text("ended_at IS NULL"),
        sqlite_where=sa.text("ended_at IS NULL"),
    )


def downgrade() -> None:
    saved = op.get_bind().scalar(sa.text("SELECT count(*) FROM games WHERE status = 'saved'"))
    if saved:
        raise RuntimeError(
            f"{saved} games are saved: resume or discard them before going back to a version "
            "that knows no saved games."
        )
    op.drop_index("uq_game_saves_open", table_name="game_saves")
    op.drop_index("ix_game_saves_user_id", table_name="game_saves")
    op.drop_index("ix_game_saves_game_id", table_name="game_saves")
    op.drop_table("game_saves")
    with op.batch_alter_table("games") as games:
        games.drop_constraint("ck_games_status", type_="check")
        games.create_check_constraint("ck_games_status", BEFORE)
