"""Best-of-three Legacy matches with sideboards (v0.5.0, api/matches.py, docs/matches.md).

- matches: a match's kind (practice or table), format, how many games it is the best of, its
  status (playing, sideboarding, finished or closed), the number of the game in play or the next
  one, who chooses to play or draw the next game and what they chose, the sideboarding's deadline,
  and how it ended: its winner's seat or a draw, and why.
- match_players: each seat's player, the deck revision bound at the match's start (DECK01), the
  deck the engine took for a seat that never sideboards (a bot's, a fixture deck, SysOp's list),
  the player's private arrangement of that revision's main deck and sideboard, whether they are
  ready, their game wins, and when and why they left the match.
- games.match_id and match_game: each game of a match is its own game, numbered from 1.
- game_tables.best_of: a Legacy table's host chooses best of one or best of three; tables open at
  the upgrade play best of one, as before.

Expand only: the previous version ignores the new tables and columns. Downgrade drops them: every
game stays, as a game of its own with its win and its tokens; matches between games are lost.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0023_matches"
down_revision = "0020_account_reset"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
TIMESTAMP = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "matches",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("format", sa.String(16), nullable=False),
        sa.Column("best_of", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("created_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("bot_skill", sa.Integer(), nullable=False),
        sa.Column("turn_cap", sa.Integer(), nullable=False),
        sa.Column("idle_timeout_seconds", sa.Integer()),
        sa.Column("game_number", sa.Integer(), nullable=False),
        sa.Column("chooser_seat", sa.Integer()),
        sa.Column("starting_seat", sa.Integer()),
        sa.Column("sideboard_until", TIMESTAMP),
        sa.Column("winner_seat", sa.Integer()),
        sa.Column("draw", sa.Boolean(), nullable=False),
        sa.Column("end_reason", sa.String(16)),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("finished_at", TIMESTAMP),
        sa.CheckConstraint("kind IN ('practice', 'table')", name="ck_matches_kind"),
        sa.CheckConstraint("format IN ('legacy', 'commander')", name="ck_matches_format"),
        sa.CheckConstraint("best_of = 3", name="ck_matches_best_of"),
        sa.CheckConstraint(
            "status IN ('playing', 'sideboarding', 'finished', 'closed')", name="ck_matches_status"
        ),
        sa.CheckConstraint(
            "end_reason IS NULL OR end_reason IN ('games', 'conceded', 'removed', 'closed', "
            "'failed')",
            name="ck_matches_end_reason",
        ),
    )
    op.create_index("ix_matches_status", "matches", ["status"])
    op.create_index("ix_matches_created_by", "matches", ["created_by"])

    op.create_table(
        "match_players",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("match_id", sa.Uuid(), sa.ForeignKey("matches.id"), nullable=False),
        sa.Column("seat", sa.Integer(), nullable=False),
        sa.Column("player", sa.String(8), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("deck_revision_id", sa.Uuid(), sa.ForeignKey("deck_revisions.id")),
        sa.Column("engine_deck", JSON),
        sa.Column("arrangement", JSON),
        sa.Column("ready", sa.Boolean(), nullable=False),
        sa.Column("game_wins", sa.Integer(), nullable=False),
        sa.Column("left_at", TIMESTAMP),
        sa.Column("left_reason", sa.String(16)),
        sa.UniqueConstraint("match_id", "seat"),
        sa.CheckConstraint("player IN ('human', 'bot')", name="ck_match_players_player"),
        sa.CheckConstraint(
            "(player = 'human') = (user_id IS NOT NULL)", name="ck_match_players_owner"
        ),
        sa.CheckConstraint(
            "left_reason IS NULL OR left_reason IN ('conceded', 'removed')",
            name="ck_match_players_left",
        ),
    )
    op.create_index("ix_match_players_match_id", "match_players", ["match_id"])
    op.create_index("ix_match_players_user_id", "match_players", ["user_id"])

    with op.batch_alter_table("games") as games:
        games.add_column(
            sa.Column("match_id", sa.Uuid(), sa.ForeignKey("matches.id", name="fk_games_match_id"))
        )
        games.add_column(sa.Column("match_game", sa.Integer()))
        games.create_check_constraint("ck_games_match", "(match_id IS NULL) = (match_game IS NULL)")
        games.create_index("ix_games_match_id", ["match_id"])
    with op.batch_alter_table("game_tables") as tables:
        tables.add_column(
            sa.Column("best_of", sa.Integer(), nullable=False, server_default=sa.text("1"))
        )
        tables.create_check_constraint(
            "ck_game_tables_best_of", "best_of IN (1, 3) AND (best_of = 1 OR format = 'legacy')"
        )


def downgrade() -> None:
    with op.batch_alter_table("game_tables") as tables:
        tables.drop_constraint("ck_game_tables_best_of", type_="check")
        tables.drop_column("best_of")
    with op.batch_alter_table("games") as games:
        games.drop_index("ix_games_match_id")
        games.drop_constraint("ck_games_match", type_="check")
        games.drop_column("match_game")
        games.drop_column("match_id")
    op.drop_index("ix_match_players_user_id", table_name="match_players")
    op.drop_index("ix_match_players_match_id", table_name="match_players")
    op.drop_table("match_players")
    op.drop_index("ix_matches_created_by", table_name="matches")
    op.drop_index("ix_matches_status", table_name="matches")
    op.drop_table("matches")
