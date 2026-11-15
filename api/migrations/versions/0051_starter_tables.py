"""v1.0.0: a starter deck bought at the table (api/starter_tables.py, docs/tables.md).

- game_tables.starter: whether the table is a starter-deck table, where each player sits down
  with a starter deck bought for it.
- starter_purchases: each such purchase, the deck it made and that deck's revision as it came.

Expand only: a column with a default and a new table. Every table there is stays what it was.
"""

import sqlalchemy as sa
from alembic import op

revision = "0051_starter_tables"
down_revision = "0050_economy_removed"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "game_tables",
        sa.Column("starter", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_table(
        "starter_purchases",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("request_key", sa.String(64), nullable=False),
        sa.Column("format", sa.String(16), nullable=False),
        sa.Column("offer", sa.String(64), nullable=False),
        sa.Column("title", sa.String(160), nullable=False),
        sa.Column("deck_id", sa.Uuid(), sa.ForeignKey("decks.id"), nullable=False),
        sa.Column("revision_id", sa.Uuid(), sa.ForeignKey("deck_revisions.id"), nullable=False),
        sa.Column("opening_id", sa.Uuid(), sa.ForeignKey("pack_openings.id")),
        sa.Column("tokens", sa.BigInteger(), nullable=False),
        sa.Column("sale", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("table_id", sa.Uuid(), sa.ForeignKey("game_tables.id")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "request_key", name="uq_starter_purchases_key"),
        sa.CheckConstraint("format IN ('legacy', 'commander')", name="ck_starter_purchases_format"),
        sa.CheckConstraint("tokens >= 0", name="ck_starter_purchases_tokens"),
    )
    op.create_index("ix_starter_purchases_user_id", "starter_purchases", ["user_id"])
    op.create_index("ix_starter_purchases_deck_id", "starter_purchases", ["deck_id"])
    op.create_index("ix_starter_purchases_table_id", "starter_purchases", ["table_id"])


def downgrade() -> None:
    op.drop_index("ix_starter_purchases_table_id", table_name="starter_purchases")
    op.drop_index("ix_starter_purchases_deck_id", table_name="starter_purchases")
    op.drop_index("ix_starter_purchases_user_id", table_name="starter_purchases")
    op.drop_table("starter_purchases")
    op.drop_column("game_tables", "starter")
