"""The Godlike tier's custom cards in decks (v0.4.0): a revision's entry may be a custom card.

A deck's draft keeps its entries as JSON, which already holds any card's ID. A revision's entries
are rows: each now names either a catalog card (concept_id) or a custom card (custom_card_id),
never both. The custom card's ID has no foreign key, so SysOp may still remove a custom card while
revisions that games played keep their rows. Expand only: the previous version reads concept_id
as before.

Downgrade removes the revision rows of custom cards, which the previous version cannot read.
"""

import sqlalchemy as sa
from alembic import op

revision = "0011_custom_play"
down_revision = "0008_tokens"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("deck_entries") as entries:
        entries.add_column(sa.Column("custom_card_id", sa.Uuid()))
        entries.alter_column("concept_id", existing_type=sa.Uuid(), nullable=True)
        entries.create_check_constraint(
            "ck_deck_entries_card", "(concept_id IS NULL) != (custom_card_id IS NULL)"
        )


def downgrade() -> None:
    # Revisions are immutable to updates, not to deletes (0006's trigger).
    op.execute("DELETE FROM deck_entries WHERE custom_card_id IS NOT NULL")
    with op.batch_alter_table("deck_entries") as entries:
        entries.drop_constraint("ck_deck_entries_card", type_="check")
        entries.alter_column("concept_id", existing_type=sa.Uuid(), nullable=False)
        entries.drop_column("custom_card_id")
