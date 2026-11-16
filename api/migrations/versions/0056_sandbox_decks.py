"""v1.0.0: sandbox decks (api/sandbox.py, docs/decks.md).

- decks.sandbox: whether the deck is a sandbox deck, built from every card in the game and
  played only in the sandbox.

Expand only: a column with a default. Every deck there is stays a normal deck. Going back
drops the column: a sandbox deck would then be a normal deck that its owner cannot play (it
holds cards they do not own), which the deck builder says, and nothing else is lost.
"""

import sqlalchemy as sa
from alembic import op

revision = "0056_sandbox_decks"
down_revision = "0055_deck_loans"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "decks",
        sa.Column("sandbox", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    with op.batch_alter_table("decks") as decks:
        decks.drop_column("sandbox")
