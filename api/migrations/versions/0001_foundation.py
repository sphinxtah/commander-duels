"""Initial identity, bundle and durable job foundation."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001_foundation"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("normalized_handle", sa.String(32), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "external_identities",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("issuer", sa.String(255), nullable=False),
        sa.Column("subject", sa.String(255), nullable=False),
        sa.UniqueConstraint("issuer", "subject"),
    )
    op.create_table(
        "rules_bundles",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("engine_commit", sa.String(64), nullable=False),
        sa.Column("catalog_revision", sa.String(64), nullable=False),
        sa.Column("format_revision", sa.String(64), nullable=False),
        sa.Column("scenario_revision", sa.String(64), nullable=False),
        sa.Column("protocol_version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "scheduled_jobs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("kind", sa.String(64), nullable=False),
        sa.Column("deduplication_key", sa.String(128), nullable=False, unique=True),
        sa.Column(
            "payload", sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=False
        ),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_until", sa.DateTime(timezone=True)),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("result_code", sa.String(64)),
        sa.CheckConstraint("generation >= 0"),
        sa.CheckConstraint("status IN ('pending', 'running', 'completed', 'failed')"),
    )
    op.create_index("ix_scheduled_jobs_due_at", "scheduled_jobs", ["due_at"])


def downgrade() -> None:
    for table in ["scheduled_jobs", "rules_bundles", "external_identities", "users"]:
        op.drop_table(table)
