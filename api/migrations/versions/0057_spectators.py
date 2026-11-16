"""v1.0.0: spectators at a table (api/spectators.py, docs/tables.md), and coaching
(api/coaching.py, docs/games.md).

- game_tables.spectators: who may watch the table's game: nobody, the friends its players
  invited, or anyone (a public table's alone).
- table_spectators: each friend invited to watch, and by whom.
- notifications.kind may be ``watch_invite``: a friend invites the account to watch a table;
  and ``coach_invite``: a friend lets the account see their seat as their coach. Coaching keeps
  nothing else: its consent is an access grant, which v0.9.10 made the table for.
- table_messages.channel may be ``spectators``: what a game's spectators say among themselves.

Expand only: a column with a default (every table there is lets nobody watch, as before), a new
table, and two checks that each allow one more value. Going back removes the invitations, the
column, and the notifications and chat lines of the new kinds, which the older API cannot show.
"""

import sqlalchemy as sa
from alembic import op

revision = "0057_spectators"
down_revision = "0056_sandbox_decks"
branch_labels = None
depends_on = None

NOTICES_BEFORE = (
    "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message', "
    "'quest_completed', 'achievement_earned', 'rematch', 'team_invite', "
    "'auction_outbid', 'auction_won', 'auction_sold', 'auction_unsold', "
    "'auction_cancelled', 'table_invite', 'warden_deck', 'replay_shared', 'deck_offered')"
)
NOTICES = NOTICES_BEFORE[:-1] + ", 'watch_invite', 'coach_invite')"
SETTINGS = "spectators IN ('nobody', 'invited', 'anyone')"
CHANNELS_BEFORE = "channel IN ('table', 'allies')"
CHANNELS = "channel IN ('table', 'allies', 'spectators')"


def upgrade() -> None:
    with op.batch_alter_table("game_tables") as tables:
        tables.add_column(
            sa.Column("spectators", sa.String(8), nullable=False, server_default="nobody")
        )
        tables.create_check_constraint("ck_game_tables_spectators", SETTINGS)
    op.create_table(
        "table_spectators",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("table_id", sa.Uuid(), sa.ForeignKey("game_tables.id"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("invited_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("table_id", "user_id"),
    )
    op.create_index("ix_table_spectators_table_id", "table_spectators", ["table_id"])
    op.create_index("ix_table_spectators_user_id", "table_spectators", ["user_id"])
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", NOTICES)
    with op.batch_alter_table("table_messages") as messages:
        messages.drop_constraint("ck_table_messages_channel", type_="check")
        messages.create_check_constraint("ck_table_messages_channel", CHANNELS)


def downgrade() -> None:
    op.execute("DELETE FROM table_messages WHERE channel = 'spectators'")
    with op.batch_alter_table("table_messages") as messages:
        messages.drop_constraint("ck_table_messages_channel", type_="check")
        messages.create_check_constraint("ck_table_messages_channel", CHANNELS_BEFORE)
    op.execute("DELETE FROM notifications WHERE kind IN ('watch_invite', 'coach_invite')")
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", NOTICES_BEFORE)
    op.drop_index("ix_table_spectators_user_id", table_name="table_spectators")
    op.drop_index("ix_table_spectators_table_id", table_name="table_spectators")
    op.drop_table("table_spectators")
    with op.batch_alter_table("game_tables") as tables:
        tables.drop_constraint("ck_game_tables_spectators", type_="check")
        tables.drop_column("spectators")
