"""v0.9.3: deleting a deck from the trash for good (api/decks.py), and the campaign's Apex Unbound
challenge (api/campaign.py).

- decks.purged_at: when its owner deleted it from the trash for good. A deck whose revisions no
  game, match or table ever used is deleted outright, revisions and entries too; one with such a
  revision keeps its row (the revisions refer to it, and games keep their copy), purged: it leaves
  every list and no longer counts toward the account's deck limit.
- campaign_games.challenge: the duel is the Apex Unbound challenge, the finale played again after
  the campaign for its badge, never for its seal, spoils or chapter rewards.

Expand only: the previous version reads nothing new; a purged deck would show in its trash again,
and a challenge duel's win would count as a finale won again (which gives nothing new).
"""

import sqlalchemy as sa
from alembic import op

TIMESTAMP = sa.DateTime(timezone=True)

revision = "0040_decks_purged"
down_revision = "0039_table_invites"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("decks") as decks:
        decks.add_column(sa.Column("purged_at", TIMESTAMP))
    with op.batch_alter_table("campaign_games") as games:
        games.add_column(
            sa.Column("challenge", sa.Boolean(), nullable=False, server_default=sa.false())
        )


def downgrade() -> None:
    with op.batch_alter_table("campaign_games") as games:
        games.drop_column("challenge")
    with op.batch_alter_table("decks") as decks:
        decks.drop_column("purged_at")
