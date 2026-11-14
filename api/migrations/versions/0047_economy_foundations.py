"""v0.9.12: the economy's foundations (docs/economy.md).

- entitlements: functional access to a card, bound to an account and never owned: the
  starter-staple pool's claims (api/entitlements.py).
- daily_quests.alternative: a second quest that completes a daily slot as well (the
  quest_alternatives policy, api/quests.py).

The policies themselves are site settings and need no table; every one is off until SysOp sets
it. Expand only: the previous version reads nothing new.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0047_economy_foundations"
down_revision = "0046_access_grants"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "entitlements",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("card_id", sa.Uuid(), sa.ForeignKey("card_concepts.id"), nullable=False),
        sa.Column("copies", sa.SmallInteger(), nullable=False),
        sa.Column("key", sa.String(160), nullable=False, unique=True),
        sa.Column("policy", sa.String(32), nullable=False),
        sa.Column("reason", sa.Text()),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.CheckConstraint("kind IN ('staple', 'staff')", name="ck_entitlements_kind"),
        sa.CheckConstraint("copies > 0", name="ck_entitlements_copies"),
    )
    op.create_index("ix_entitlements_user_id_kind", "entitlements", ["user_id", "kind"])
    op.add_column("daily_quests", sa.Column("alternative", JSON))


def downgrade() -> None:
    op.drop_column("daily_quests", "alternative")
    op.drop_index("ix_entitlements_user_id_kind", table_name="entitlements")
    op.drop_table("entitlements")
