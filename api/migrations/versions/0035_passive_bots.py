"""Passive bots for SysOp (v0.8.6, api/games.py): games.bots_passive and games.passive_bots_used.

SysOp may switch a game's bots to passive (they draw, pass and discard to hand size) to test cards
and the campaign. bots_passive is the switch as it stands; passive_bots_used stays true once the
switch has been on, so the game's end pays nothing out (no win, tokens, quests or campaign spoils).
Expand only: v0.8.5, still serving while this migrates, never reads or writes them.
"""

import sqlalchemy as sa
from alembic import op

revision = "0035_passive_bots"
down_revision = "0034_tour_decks_play"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("games") as games:
        games.add_column(
            sa.Column("bots_passive", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        games.add_column(
            sa.Column("passive_bots_used", sa.Boolean(), nullable=False, server_default=sa.false())
        )


def downgrade() -> None:
    with op.batch_alter_table("games") as games:
        games.drop_column("passive_bots_used")
        games.drop_column("bots_passive")
