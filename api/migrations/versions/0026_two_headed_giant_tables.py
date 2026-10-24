"""Two-Headed Giant at human tables and in a public queue (v0.5.1).

- game_tables: a table's format may be two_headed_giant, and bot_seats names the seats its bots
  fill when they are not the last ones (a bot may sit in either team). Null for every table
  already there: their bots fill the last seats, as before. kept_teams names the players who stay
  on a team at the table, because cards their deck shares with a teammate's were named there.
- table_seats: deck_revision_id, the revision of its deck a seat is bound to, checked against the
  player's library; a team's decks are compared by it. Null for every seat already there.
- queue_entries: a place's format may be two_headed_giant; two friends wait as a team, the one
  who invites is inviting until the other accepts (status inviting), and partner_id names the
  friend (each of the two rows names the other once they wait together).
- notifications: the bell's invitation to the queue as a friend's teammate (team_invite).

Expand only: the previous version reads tables, places and notifications of the kinds it knows,
and ignores the new column of each.

Downgrade deletes the Two-Headed Giant tables that never started and the seats taken at them,
marks those that started as Legacy tables (their games stay recorded, as two_headed_giant games),
deletes every place in the Two-Headed Giant queue and every invitation, and drops the columns.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0026_two_headed_giant_tables"
down_revision = "0025_library_editions"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
FORMATS_BEFORE = "format IN ('legacy', 'commander')"
FORMATS = "format IN ('legacy', 'commander', 'two_headed_giant')"
STATUSES_BEFORE = "status IN ('waiting', 'starting', 'matched', 'left', 'refused')"
STATUSES = "status IN ('inviting', 'waiting', 'starting', 'matched', 'left', 'refused')"
# The kinds as 0022_queues left them, and with an invitation to the queue as a teammate.
KINDS_BEFORE = (
    "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message', "
    "'quest_completed', 'achievement_earned', 'rematch')"
)
KINDS = (
    "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message', "
    "'quest_completed', 'achievement_earned', 'rematch', 'team_invite')"
)


def upgrade() -> None:
    with op.batch_alter_table("game_tables") as tables:
        tables.add_column(sa.Column("bot_seats", JSON))
        tables.add_column(sa.Column("kept_teams", JSON))
        tables.drop_constraint("ck_game_tables_format", type_="check")
        tables.create_check_constraint("ck_game_tables_format", FORMATS)
    with op.batch_alter_table("table_seats") as seats:
        seats.add_column(
            sa.Column(
                "deck_revision_id",
                sa.Uuid(),
                sa.ForeignKey("deck_revisions.id", name="fk_table_seats_deck_revision_id"),
            )
        )
        seats.create_index("ix_table_seats_deck_revision_id", ["deck_revision_id"])
    with op.batch_alter_table("queue_entries") as entries:
        entries.add_column(
            sa.Column(
                "partner_id",
                sa.Uuid(),
                sa.ForeignKey("users.id", name="fk_queue_entries_partner_id"),
            )
        )
        entries.create_index("ix_queue_entries_partner_id", ["partner_id"])
        entries.drop_constraint("ck_queue_entries_format", type_="check")
        entries.create_check_constraint("ck_queue_entries_format", FORMATS)
        entries.drop_constraint("ck_queue_entries_status", type_="check")
        entries.create_check_constraint("ck_queue_entries_status", STATUSES)
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", KINDS)


def downgrade() -> None:
    op.execute("DELETE FROM notifications WHERE kind = 'team_invite'")
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", KINDS_BEFORE)
    op.execute(
        "DELETE FROM queue_entries WHERE format = 'two_headed_giant' OR status = 'inviting'"
        " OR partner_id IS NOT NULL"
    )
    with op.batch_alter_table("queue_entries") as entries:
        entries.drop_constraint("ck_queue_entries_status", type_="check")
        entries.create_check_constraint("ck_queue_entries_status", STATUSES_BEFORE)
        entries.drop_constraint("ck_queue_entries_format", type_="check")
        entries.create_check_constraint("ck_queue_entries_format", FORMATS_BEFORE)
        entries.drop_index("ix_queue_entries_partner_id")
        entries.drop_column("partner_id")
    unstarted = "SELECT id FROM game_tables WHERE format = 'two_headed_giant' AND game_id IS NULL"
    op.execute(f"DELETE FROM table_seats WHERE table_id IN ({unstarted})")
    op.execute("DELETE FROM game_tables WHERE format = 'two_headed_giant' AND game_id IS NULL")
    op.execute("UPDATE game_tables SET format = 'legacy' WHERE format = 'two_headed_giant'")
    with op.batch_alter_table("table_seats") as seats:
        seats.drop_index("ix_table_seats_deck_revision_id")
        seats.drop_column("deck_revision_id")
    with op.batch_alter_table("game_tables") as tables:
        tables.drop_constraint("ck_game_tables_format", type_="check")
        tables.create_check_constraint("ck_game_tables_format", FORMATS_BEFORE)
        tables.drop_column("kept_teams")
        tables.drop_column("bot_seats")
