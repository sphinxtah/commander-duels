"""Two-Headed Giant practice games (v0.5.0, early): a game's format may be two_headed_giant.

A practice game seats the player and a bot teammate against two bots, with Legacy decks
(api/games.py). Only the games table's format check changes; decks, tables and format versions keep
Legacy and Commander. Expand only: the previous version reads no game it did not start.

Downgrade turns every Two-Headed Giant game into a Legacy one, which its decks are, so the check
can return to its earlier form without deleting a game or the wins and tokens it recorded.
"""

from alembic import op

revision = "0024_two_headed_giant"
down_revision = "0023_matches"
branch_labels = None
depends_on = None

FORMATS_BEFORE = "format IN ('legacy', 'commander')"
FORMATS = "format IN ('legacy', 'commander', 'two_headed_giant')"


def upgrade() -> None:
    with op.batch_alter_table("games") as games:
        games.drop_constraint("ck_games_format", type_="check")
        games.create_check_constraint("ck_games_format", FORMATS)


def downgrade() -> None:
    op.execute("UPDATE games SET format = 'legacy' WHERE format = 'two_headed_giant'")
    with op.batch_alter_table("games") as games:
        games.drop_constraint("ck_games_format", type_="check")
        games.create_check_constraint("ck_games_format", FORMATS_BEFORE)
