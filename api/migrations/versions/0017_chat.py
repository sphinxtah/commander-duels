"""Chat between friends and at the table (v0.4.4).

New tables hold friends' conversations (one a pair, with each side's read mark) and their
messages, and the messages of each table's chat, allies-only ones and the alliances' events
included. The bell gains a notification for new messages, and a problem report may carry the
message it reports with the messages before it. Expand only: the previous version ignores the new
tables and columns.

Downgrade drops the tables, the report columns and the message notifications, and with them every
message.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0017_chat"
down_revision = "0016_weekly_sale"
branch_labels = None
depends_on = None

TIMESTAMP = sa.DateTime(timezone=True)
JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
KINDS_BEFORE = "kind IN ('friend_request', 'friend_accepted', 'friend_online')"
KINDS = "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message')"


def upgrade() -> None:
    op.create_table(
        "conversations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_low", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("user_high", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("last_message_at", TIMESTAMP, nullable=False),
        sa.Column("low_read_at", TIMESTAMP),
        sa.Column("high_read_at", TIMESTAMP),
        sa.UniqueConstraint("user_low", "user_high"),
        sa.CheckConstraint("user_low <> user_high", name="ck_conversations_pair"),
    )
    op.create_index("ix_conversations_user_high", "conversations", ["user_high"])
    op.create_table(
        "direct_messages",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("conversation_id", sa.Uuid(), sa.ForeignKey("conversations.id"), nullable=False),
        sa.Column("sender_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.UniqueConstraint("sender_id", "client_id"),
    )
    op.create_index(
        "ix_direct_messages_conversation_id_created_at",
        "direct_messages",
        ["conversation_id", "created_at"],
    )
    op.create_index("ix_direct_messages_created_at", "direct_messages", ["created_at"])
    op.create_table(
        "table_messages",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("game_id", sa.Uuid(), sa.ForeignKey("games.id"), nullable=False),
        sa.Column("sender_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("seat", sa.Integer()),
        sa.Column("channel", sa.String(16), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("seats", JSON),
        sa.Column("client_id", sa.Uuid()),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.CheckConstraint("channel IN ('table', 'allies')", name="ck_table_messages_channel"),
        sa.CheckConstraint("kind IN ('text', 'emote', 'event')", name="ck_table_messages_kind"),
    )
    op.create_index(
        "ix_table_messages_game_id_created_at", "table_messages", ["game_id", "created_at"]
    )
    op.create_index("ix_table_messages_sender_id", "table_messages", ["sender_id"])
    op.create_index("ix_table_messages_created_at", "table_messages", ["created_at"])
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", KINDS)
    with op.batch_alter_table("problem_reports") as reports:
        reports.add_column(sa.Column("reported_user_id", sa.Uuid()))
        reports.add_column(sa.Column("chat", JSON))


def downgrade() -> None:
    with op.batch_alter_table("problem_reports") as reports:
        reports.drop_column("chat")
        reports.drop_column("reported_user_id")
    op.execute("DELETE FROM notifications WHERE kind = 'message'")
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", KINDS_BEFORE)
    op.drop_table("table_messages")
    op.drop_table("direct_messages")
    op.drop_table("conversations")
