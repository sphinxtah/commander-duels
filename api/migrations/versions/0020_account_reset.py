"""SysOp resets an account to a new one's state (v0.4.5): when it last happened.

The library's grants and the packs are append-only, so a reset leaves them recorded; the account's
library and packs count only those made after users.reset_at (api/resets.py). Expand only: the
previous version ignores the column.

Downgrade drops it: a reset account's library and packs from before its reset count again, and a
starter deck chosen or bought again since keys its grant with the reset's time, which the previous
version does not read as the deck it names.
"""

import sqlalchemy as sa
from alembic import op

revision = "0020_account_reset"
down_revision = "0019_table_rules"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as users:
        users.add_column(sa.Column("reset_at", sa.DateTime(timezone=True)))


def downgrade() -> None:
    with op.batch_alter_table("users") as users:
        users.drop_column("reset_at")
