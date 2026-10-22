"""Leng's weekly sale (v0.4.3): each week's five products at 20% off, drawn once and kept.

Expand only: the previous version ignores the table. Downgrade drops it; the next request draws
the week again.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0016_weekly_sale"
down_revision = "0015_friends"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "shop_weekly_sales",
        sa.Column("week_start", sa.Date(), primary_key=True),
        sa.Column("product_ids", JSON, nullable=False),
        sa.Column("percent", sa.SmallInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("shop_weekly_sales")
