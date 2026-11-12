"""v0.9.10: access, consent and temporary entitlement (api/access.py, docs/access.md).

- access_grants: access one account gives another, for a while, to a deck, a game's spectator
  seat or replay, a seat's hand, a group, a pool or the sandbox; with its consent, expiry and
  revocation. Never ownership.

Expand only: the previous version reads nothing new.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0046_access_grants"
down_revision = "0045_game_modes"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "access_grants",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("grantor_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("subject_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("resource_kind", sa.String(16), nullable=False),
        sa.Column("resource_id", sa.Uuid()),
        sa.Column("scope", JSON, nullable=False),
        sa.Column("consent", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("answered_at", sa.DateTime(timezone=True)),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.CheckConstraint(
            "resource_kind IN ('deck', 'spectator', 'replay', 'hand', 'group', 'pool', 'sandbox')",
            name="ck_access_grants_resource_kind",
        ),
        sa.CheckConstraint(
            "consent IN ('given', 'offered', 'accepted', 'declined')",
            name="ck_access_grants_consent",
        ),
    )
    op.create_index(
        "ix_access_grants_subject", "access_grants", ["subject_id", "resource_kind", "resource_id"]
    )
    op.create_index("ix_access_grants_grantor", "access_grants", ["grantor_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_access_grants_grantor", table_name="access_grants")
    op.drop_index("ix_access_grants_subject", table_name="access_grants")
    op.drop_table("access_grants")
