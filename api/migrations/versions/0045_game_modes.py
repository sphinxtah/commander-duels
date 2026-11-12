"""v0.9.10: game modes and reward eligibility (api/modes.py, docs/modes.md).

- games.mode: what kind of play the game is (practice, table, campaign, ...), set when it is made.
  Old games are given theirs from what they are: a campaign duel's link, else their kind.
- games.eligibility: what the game earned its players and what it did not, and why, recorded as it
  ended. Null for games that ended before v0.9.10.
- player_results.mode: the mode of the result's game; "testing" for a result SysOp granted.

Expand only: the previous version reads nothing new, and ignores the columns.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0045_game_modes"
down_revision = "0044_game_events"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    with op.batch_alter_table("games") as games:
        games.add_column(sa.Column("mode", sa.String(16)))
        games.add_column(sa.Column("eligibility", JSON))
    with op.batch_alter_table("player_results") as results:
        results.add_column(sa.Column("mode", sa.String(16)))
    op.execute(
        "UPDATE games SET mode = CASE "
        "WHEN id IN (SELECT game_id FROM campaign_games) THEN 'campaign' "
        "WHEN kind = 'table' THEN 'table' ELSE 'practice' END"
    )
    # Results are append-only in PostgreSQL (migration 0007): their mode is filled once, here,
    # with the guard lifted for this statement alone. Nothing else of a result changes.
    postgres = op.get_bind().dialect.name == "postgresql"
    if postgres:
        op.execute("ALTER TABLE player_results DISABLE TRIGGER player_results_append_only")
    op.execute(
        "UPDATE player_results SET mode = COALESCE("
        "(SELECT games.mode FROM games WHERE games.id = player_results.game_id), 'testing')"
    )
    if postgres:
        op.execute("ALTER TABLE player_results ENABLE TRIGGER player_results_append_only")


def downgrade() -> None:
    with op.batch_alter_table("player_results") as results:
        results.drop_column("mode")
    with op.batch_alter_table("games") as games:
        games.drop_column("eligibility")
        games.drop_column("mode")
