"""Problem reports (v0.4.1): what a tester sends from "Report a problem", with what the page
attached on its own (the page, the versions, the browser and screen, the game and turn, the latest
request IDs) and an optional screenshot, re-encoded as WebP. The screenshot is kept in the database
rather than on disk, so the nightly backups hold it with its report.

Nothing is carried over. Downgrade drops every report, screenshots included.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0012_reports"
down_revision = "0011_custom_play"
branch_labels = None
depends_on = None

TIMESTAMP = sa.DateTime(timezone=True)
JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "problem_reports",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("summary", sa.String(120), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("status_changed_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("status_changed_at", TIMESTAMP),
        sa.Column("page", sa.String(200), nullable=False),
        sa.Column("app_version", sa.String(32), nullable=False),
        sa.Column("api_version", sa.String(32), nullable=False),
        sa.Column("user_agent", sa.String(512)),
        sa.Column("viewport_width", sa.Integer(), nullable=False),
        sa.Column("viewport_height", sa.Integer(), nullable=False),
        sa.Column("pixel_ratio", sa.Float(), nullable=False),
        sa.Column("game_id", sa.Uuid()),
        sa.Column("game_turn", sa.Integer()),
        sa.Column("requests", JSON, nullable=False),
        sa.Column("screenshot", sa.LargeBinary()),
        sa.Column("screenshot_width", sa.Integer()),
        sa.Column("screenshot_height", sa.Integer()),
        sa.CheckConstraint(
            "status IN ('new', 'seen', 'fixed', 'closed')", name="ck_problem_reports_status"
        ),
        sa.CheckConstraint(
            "(screenshot IS NULL) = (screenshot_width IS NULL) "
            "AND (screenshot IS NULL) = (screenshot_height IS NULL)",
            name="ck_problem_reports_screenshot",
        ),
    )
    op.create_index(
        "ix_problem_reports_status_created_at", "problem_reports", ["status", "created_at"]
    )
    op.create_index(
        "ix_problem_reports_user_id_created_at", "problem_reports", ["user_id", "created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_problem_reports_user_id_created_at", table_name="problem_reports")
    op.drop_index("ix_problem_reports_status_created_at", table_name="problem_reports")
    op.drop_table("problem_reports")
