"""The roster keeps only Planeswalkers a game can play (v0.4.2).

The owner removed the ten Planeswalkers none of whose cards the engine can play from the roster
(content/planeswalkers.json, scripts/planeswalkers.py). An account allied with one of them leaves
the alliance: its library loses no card a game could play, and its picture is its avatar again.
Data only, so the previous version runs on it, showing such an account with no alliance.

Downgrade changes nothing: the alliances that ended stay ended.
"""

import sqlalchemy as sa
from alembic import op

revision = "0014_roster_playable"
down_revision = "0013_account_deletion"
branch_labels = None
depends_on = None

REMOVED = (
    "abian",
    "b-o-b",
    "deb-thomas",
    "dungeon-master",
    "ersta",
    "luxior",
    "mr-monopoly",
    "sifa",
    "svega",
    "thomil",
)


def upgrade() -> None:
    users = sa.table("users", sa.column("alliance", sa.String), sa.column("alliance_since"))
    op.execute(
        users.update()
        .where(users.c.alliance.in_(REMOVED))
        .values(alliance=None, alliance_since=None)
    )


def downgrade() -> None:
    pass
