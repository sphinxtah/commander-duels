"""v0.9.8: a deck pack from Leng's shop kept together as a deck (api/shop.py, the owner's request).

- decks.opening_id: the opened pack a deck was saved from. A Starter Deck or a Tournament Pack
  opens into 60 or 75 cards, which join the library as every pack's do; its player may also keep
  them together as a Legacy deck, once per opening while that deck is among their decks.

Expand only: the previous version reads nothing new.
"""

import sqlalchemy as sa
from alembic import op

revision = "0043_deck_packs"
down_revision = "0042_unbound_court"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("decks") as decks:
        decks.add_column(
            sa.Column(
                "opening_id",
                sa.Uuid(),
                sa.ForeignKey("pack_openings.id", name="fk_decks_opening"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("decks") as decks:
        decks.drop_constraint("fk_decks_opening", type_="foreignkey")
        decks.drop_column("opening_id")
