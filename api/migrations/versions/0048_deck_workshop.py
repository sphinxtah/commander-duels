"""v0.9.12: the deck workshop's foundations (api/workshop.py, docs/decks.md).

- decks.folder and decks.tags: where an owner keeps a deck among their decks.
- deck_entries.choice: a choice made as the deck is built, kept with the revision (Cryptic
  Spires's two circled colours).
- wishlist_entries: the cards an account wants.

Expand only: nullable columns and a new table. A deck with no folder, no tags and no choice is
the deck it was, so every existing deck and revision is read as before.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0048_deck_workshop"
down_revision = "0047_economy_foundations"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.add_column("decks", sa.Column("folder", sa.String(64)))
    op.add_column("decks", sa.Column("tags", JSON))
    op.add_column("deck_entries", sa.Column("choice", sa.String(8)))
    op.create_table(
        "wishlist_entries",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("card_id", sa.Uuid(), sa.ForeignKey("card_concepts.id"), nullable=False),
        sa.Column("quantity", sa.SmallInteger(), nullable=False),
        sa.Column("deck_id", sa.Uuid(), sa.ForeignKey("decks.id")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "card_id", name="uq_wishlist_entries_card"),
        sa.CheckConstraint("quantity BETWEEN 1 AND 250", name="ck_wishlist_entries_quantity"),
    )
    op.create_index("ix_wishlist_entries_user_id", "wishlist_entries", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_wishlist_entries_user_id", table_name="wishlist_entries")
    op.drop_table("wishlist_entries")
    op.drop_column("deck_entries", "choice")
    op.drop_column("decks", "tags")
    op.drop_column("decks", "folder")
