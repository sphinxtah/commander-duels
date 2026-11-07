"""v0.8.9: card sleeves (api/sleeves.py).

- card_sleeves: the sleeves players upload, their WebP images in the database so the nightly
  backups hold them.
- decks.sleeve: the sleeve a deck's cards show, "sleeve:<id>" or "back:<slug>"; null for the
  account's campaign back or the official one.
- problem_reports.sleeve_id: a report of a sleeve.

Expand only: the previous version reads none of them.
"""

import sqlalchemy as sa
from alembic import op

TIMESTAMP = sa.DateTime(timezone=True)

revision = "0038_card_sleeves"
down_revision = "0037_grants_and_roles"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "card_sleeves",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(40), nullable=False),
        sa.Column("image", sa.LargeBinary(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("deleted_at", TIMESTAMP, nullable=True),
        sa.Column("removed_at", TIMESTAMP, nullable=True),
        sa.Column("removed_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("removed_reason", sa.Text(), nullable=True),
    )
    op.create_index("ix_card_sleeves_user_id", "card_sleeves", ["user_id", "created_at"])
    with op.batch_alter_table("decks") as decks:
        decks.add_column(sa.Column("sleeve", sa.String(64), nullable=True))
    with op.batch_alter_table("problem_reports") as reports:
        reports.add_column(sa.Column("sleeve_id", sa.Uuid(), nullable=True))
        reports.create_foreign_key(
            "fk_problem_reports_sleeve_id_card_sleeves", "card_sleeves", ["sleeve_id"], ["id"]
        )


def downgrade() -> None:
    with op.batch_alter_table("problem_reports") as reports:
        reports.drop_constraint("fk_problem_reports_sleeve_id_card_sleeves", type_="foreignkey")
        reports.drop_column("sleeve_id")
    with op.batch_alter_table("decks") as decks:
        decks.drop_column("sleeve")
    op.drop_index("ix_card_sleeves_user_id", table_name="card_sleeves")
    op.drop_table("card_sleeves")
