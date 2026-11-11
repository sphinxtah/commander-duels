"""v0.9.6: the campaign's fifteenth ward, The Unbound Court (api/campaign.py, docs/campaign.md).

- campaign_progress.fled_at: when The Sphinx fled ward 14 in the account's current run, opening ward
  15. Wards 14 and 15 are one run: losing ward 15 clears it (back to ward 14), and winning ward 15
  pays both. challenge_fled_at is the same for Apex Unbound, which became the same dual level.
- campaign_games.seat: the player's seat in the game (0 in a duel, 1 at the court, King A).
- campaign_games.opponents: the court's named bot seats ({seat: [name, roster ID]}), for the
  game's summary; null in a duel, whose one bot is the encounter's opponent.
- game_tables.campaign: a table the campaign opened for ward 15, with friends as the player's
  Generals ({campaign_id, encounter, user_id, challenge}); null for every other table.

Expand only: the previous version reads nothing new.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

TIMESTAMP = sa.DateTime(timezone=True)
JSON = sa.JSON().with_variant(JSONB(), "postgresql")

revision = "0042_unbound_court"
down_revision = "0041_quest_boards"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("campaign_progress") as progress:
        progress.add_column(sa.Column("fled_at", TIMESTAMP))
        progress.add_column(sa.Column("challenge_fled_at", TIMESTAMP))
    with op.batch_alter_table("campaign_games") as games:
        games.add_column(
            sa.Column("seat", sa.SmallInteger(), nullable=False, server_default=sa.text("0"))
        )
        games.add_column(sa.Column("opponents", JSON))
    with op.batch_alter_table("game_tables") as tables:
        tables.add_column(sa.Column("campaign", JSON))


def downgrade() -> None:
    with op.batch_alter_table("game_tables") as tables:
        tables.drop_column("campaign")
    with op.batch_alter_table("campaign_games") as games:
        games.drop_column("opponents")
        games.drop_column("seat")
    with op.batch_alter_table("campaign_progress") as progress:
        progress.drop_column("challenge_fled_at")
        progress.drop_column("fled_at")
