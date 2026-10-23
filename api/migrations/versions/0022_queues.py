"""Public queues and rematches (v0.5.0).

A new table holds each account's place in a public queue (one row an account: its queue, deck
and wait, or what became of its last wait), and two more hold rematches: one at most for a
finished game, with the players a table's rematch asks and their answers. Tables the queue makes
are marked queued; a practice game records its request, so its rematch can replay it; and the
bell gains a notification for a rematch offered, with the game it would replay. Expand only: the
previous version ignores the new tables and columns.

Downgrade drops the tables and the columns, with every place in a queue and every rematch, and
the rematch notifications. Queue games stay recorded as the table games they are.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0022_queues"
down_revision = "0020_account_reset"
branch_labels = None
depends_on = None

TIMESTAMP = sa.DateTime(timezone=True)
JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
KINDS_BEFORE = "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message')"
KINDS = "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message', 'rematch')"


def upgrade() -> None:
    op.create_table(
        "queue_entries",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("format", sa.String(16), nullable=False),
        sa.Column("seats", sa.Integer(), nullable=False),
        sa.Column("deck_id", sa.Uuid(), sa.ForeignKey("decks.id"), nullable=False),
        sa.Column("humans_only", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("joined_at", TIMESTAMP, nullable=False),
        sa.Column("seen_at", TIMESTAMP, nullable=False),
        sa.Column("ended_at", TIMESTAMP),
        sa.Column("game_id", sa.Uuid(), sa.ForeignKey("games.id")),
        sa.Column("reason", sa.String(32)),
        sa.Column("message", sa.Text()),
        sa.CheckConstraint("format IN ('legacy', 'commander')", name="ck_queue_entries_format"),
        sa.CheckConstraint("seats BETWEEN 2 AND 4", name="ck_queue_entries_seats"),
        sa.CheckConstraint(
            "status IN ('waiting', 'starting', 'matched', 'left', 'refused')",
            name="ck_queue_entries_status",
        ),
    )
    op.create_index(
        "ix_queue_entries_queue", "queue_entries", ["format", "seats", "status", "joined_at"]
    )
    op.create_table(
        "rematches",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("game_id", sa.Uuid(), sa.ForeignKey("games.id"), nullable=False, unique=True),
        sa.Column("proposed_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("expires_at", TIMESTAMP, nullable=False),
        sa.Column("ended_at", TIMESTAMP),
        sa.Column("next_game_id", sa.Uuid(), sa.ForeignKey("games.id")),
        sa.Column("declined_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("message", sa.Text()),
        sa.CheckConstraint(
            "status IN ('open', 'starting', 'started', 'declined', 'lapsed', 'failed')",
            name="ck_rematches_status",
        ),
    )
    op.create_table(
        "rematch_players",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("rematch_id", sa.Uuid(), sa.ForeignKey("rematches.id"), nullable=False),
        sa.Column("seat", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("answer", sa.String(8)),
        sa.Column("answered_at", TIMESTAMP),
        sa.UniqueConstraint("rematch_id", "seat"),
        sa.UniqueConstraint("rematch_id", "user_id"),
        sa.CheckConstraint("answer IS NULL OR answer IN ('yes', 'no')", name="ck_rematch_players"),
    )
    op.create_index("ix_rematch_players_rematch_id", "rematch_players", ["rematch_id"])
    op.create_index("ix_rematch_players_user_id", "rematch_players", ["user_id"])
    with op.batch_alter_table("games") as games:
        games.add_column(sa.Column("settings", JSON))
    with op.batch_alter_table("game_tables") as tables:
        tables.add_column(
            sa.Column("queued", sa.Boolean(), nullable=False, server_default=sa.false())
        )
    with op.batch_alter_table("notifications") as notifications:
        notifications.add_column(
            sa.Column(
                "game_id",
                sa.Uuid(),
                sa.ForeignKey("games.id", name="fk_notifications_game_id"),
            )
        )
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", KINDS)


def downgrade() -> None:
    op.execute("DELETE FROM notifications WHERE kind = 'rematch'")
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", KINDS_BEFORE)
        notifications.drop_column("game_id")
    with op.batch_alter_table("game_tables") as tables:
        tables.drop_column("queued")
    with op.batch_alter_table("games") as games:
        games.drop_column("settings")
    op.drop_index("ix_rematch_players_user_id", table_name="rematch_players")
    op.drop_index("ix_rematch_players_rematch_id", table_name="rematch_players")
    op.drop_table("rematch_players")
    op.drop_table("rematches")
    op.drop_index("ix_queue_entries_queue", table_name="queue_entries")
    op.drop_table("queue_entries")
