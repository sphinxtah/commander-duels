"""v0.9.2: friends invited to tables (api/tables.py).

- table_invites: a friend invited to an open table, by one of its players. An invited player
  sees the table in the lobby, private or not, and under the "Friends' tables" filter.
- notifications.kind gains 'table_invite': the bell's notice of an invitation, its subject the
  table's code.

Expand only: the previous version reads neither. Its downgrade drops the table invitations' notices
before restoring the old kinds.
"""

import sqlalchemy as sa
from alembic import op

TIMESTAMP = sa.DateTime(timezone=True)

revision = "0039_table_invites"
down_revision = "0038_card_sleeves"
branch_labels = None
depends_on = None

NOTICES_BEFORE = (
    "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message', "
    "'quest_completed', 'achievement_earned', 'rematch', 'team_invite', "
    "'auction_outbid', 'auction_won', 'auction_sold', 'auction_unsold', "
    "'auction_cancelled')"
)
NOTICES = (
    "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message', "
    "'quest_completed', 'achievement_earned', 'rematch', 'team_invite', "
    "'auction_outbid', 'auction_won', 'auction_sold', 'auction_unsold', "
    "'auction_cancelled', 'table_invite')"
)


def upgrade() -> None:
    op.create_table(
        "table_invites",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("table_id", sa.Uuid(), sa.ForeignKey("game_tables.id"), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("invited_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.UniqueConstraint("table_id", "user_id"),
    )
    op.create_index("ix_table_invites_table_id", "table_invites", ["table_id"])
    op.create_index("ix_table_invites_user_id", "table_invites", ["user_id"])
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", NOTICES)


def downgrade() -> None:
    op.execute("DELETE FROM notifications WHERE kind = 'table_invite'")
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", NOTICES_BEFORE)
    op.drop_index("ix_table_invites_user_id", table_name="table_invites")
    op.drop_index("ix_table_invites_table_id", table_name="table_invites")
    op.drop_table("table_invites")
