"""Table rules (v0.4.5): each table's host chooses whether its decks may hold banned cards, and
cards not legal in the format, and each deck records which of them it needs.

Tables open at the upgrade become casual, allowing both: they took only legal decks, so allowing
more takes nothing away. Decks gain the options they need, null until the owner's deck list
validates them again under the new rules. Expand only: the previous version ignores the new
columns.

Downgrade drops the columns: tables go back to taking legal decks only, and a deck's flags are
refreshed at its next save.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0019_table_rules"
down_revision = "0018_card_removal"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    with op.batch_alter_table("game_tables") as tables:
        tables.add_column(
            sa.Column("allow_banned", sa.Boolean(), nullable=False, server_default=sa.true())
        )
        tables.add_column(
            sa.Column("allow_not_legal", sa.Boolean(), nullable=False, server_default=sa.true())
        )
    with op.batch_alter_table("decks") as decks:
        decks.add_column(sa.Column("needs", JSON))


def downgrade() -> None:
    with op.batch_alter_table("decks") as decks:
        decks.drop_column("needs")
    with op.batch_alter_table("game_tables") as tables:
        tables.drop_column("allow_not_legal")
        tables.drop_column("allow_banned")
