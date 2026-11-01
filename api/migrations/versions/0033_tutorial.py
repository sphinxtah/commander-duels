"""The first-time tutorial (v0.8.4, api/tutorial.py): three columns on users.

- tutorial: the stage reached (choose, demo, overview, setup, tour_shop, tour_auctions, done).
- tutorial_path: beginner, novice or advanced; null until chosen.
- tutorial_skipped: whether the player skipped the rest of it.

Accounts that finished setting up before v0.8.4 start at done, and those still setting up at
choose. v0.8.3, still serving while this migrates, never reads the columns; the defaults let it
create accounts.
"""

import sqlalchemy as sa
from alembic import op

revision = "0033_tutorial"
down_revision = "0032_campaign"
branch_labels = None
depends_on = None

STAGES = (
    "tutorial IN ('choose', 'demo', 'overview', 'setup', 'tour_shop', 'tour_auctions', 'done')"
)
PATHS = "tutorial_path IS NULL OR tutorial_path IN ('beginner', 'novice', 'advanced')"


def upgrade() -> None:
    with op.batch_alter_table("users") as users:
        users.add_column(
            sa.Column("tutorial", sa.String(16), nullable=False, server_default="choose")
        )
        users.add_column(sa.Column("tutorial_path", sa.String(16), nullable=True))
        users.add_column(
            sa.Column(
                "tutorial_skipped", sa.Boolean(), nullable=False, server_default=sa.false()
            )
        )
        users.create_check_constraint("ck_users_tutorial", STAGES)
        users.create_check_constraint("ck_users_tutorial_path", PATHS)
    op.execute("UPDATE users SET tutorial = 'done' WHERE onboarding = 'complete'")


def downgrade() -> None:
    with op.batch_alter_table("users") as users:
        users.drop_constraint("ck_users_tutorial_path", type_="check")
        users.drop_constraint("ck_users_tutorial", type_="check")
        users.drop_column("tutorial_skipped")
        users.drop_column("tutorial_path")
        users.drop_column("tutorial")
