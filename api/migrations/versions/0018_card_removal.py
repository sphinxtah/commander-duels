"""Cards the engine cannot play leave the game (v0.4.5).

Two columns: each deck's note of the cards that left its draft, until its owner dismisses it; and,
for a card in an opened pack, the printing first drawn in its place when the game cannot play that
card. The drafts lose such cards when the worker starts (catalog/worker.py), after the catalog has
decided the prepare cards again, not here. Expand only: the previous version ignores the new
columns.

Downgrade drops the columns, and with them the notes and the record of replaced pack cards.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0018_card_removal"
down_revision = "0017_chat"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    with op.batch_alter_table("decks") as decks:
        decks.add_column(
            sa.Column("removed_cards", JSON, nullable=False, server_default=sa.text("'[]'"))
        )
    with op.batch_alter_table("pack_cards") as cards:
        cards.add_column(sa.Column("replaced_printing_id", sa.Uuid()))


def downgrade() -> None:
    with op.batch_alter_table("pack_cards") as cards:
        cards.drop_column("replaced_printing_id")
    with op.batch_alter_table("decks") as decks:
        decks.drop_column("removed_cards")
