"""Card images: what Scryfall answered for each card name whose image the API cached."""

import sqlalchemy as sa
from alembic import op

revision = "0004_card_images"
down_revision = "0003_games"
branch_labels = None
depends_on = None

TIMESTAMP = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "card_images",
        sa.Column("name", sa.Text(), primary_key=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("scryfall_id", sa.Uuid()),
        sa.Column("face", sa.SmallInteger()),
        sa.Column("set_code", sa.Text()),
        sa.Column("collector_number", sa.Text()),
        sa.Column("artist", sa.Text()),
        sa.Column("checked_at", TIMESTAMP, nullable=False),
        sa.CheckConstraint("status IN ('found', 'missing')", name="ck_card_images_status"),
        sa.CheckConstraint(
            "(status = 'found') = (scryfall_id IS NOT NULL)", name="ck_card_images_found"
        ),
    )


def downgrade() -> None:
    op.drop_table("card_images")
