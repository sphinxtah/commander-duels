"""Friends, presence and notifications (v0.4.3).

Each account gains its presence (the app's latest check-in, and the latest from a tab in use) and
its privacy settings: who sees its presence (friends, the default, or everyone), appearing
offline, and being found by its email address (on by default). New tables hold friendships and
friend requests, blocked players, and the bell's notifications. Expand only: the previous version
ignores the new columns and tables.

Downgrade drops the tables and the columns, and with them every friendship and notification.
"""

import sqlalchemy as sa
from alembic import op

revision = "0015_friends"
down_revision = "0014_roster_playable"
branch_labels = None
depends_on = None

TIMESTAMP = sa.DateTime(timezone=True)


def upgrade() -> None:
    with op.batch_alter_table("users") as users:
        users.add_column(sa.Column("presence_at", TIMESTAMP))
        users.add_column(sa.Column("active_at", TIMESTAMP))
        users.add_column(
            sa.Column(
                "presence_visibility", sa.String(16), nullable=False, server_default="friends"
            )
        )
        users.add_column(
            sa.Column("appear_offline", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        users.add_column(
            sa.Column("email_searchable", sa.Boolean(), nullable=False, server_default=sa.true())
        )
        users.create_check_constraint(
            "ck_users_presence_visibility", "presence_visibility IN ('friends', 'everyone')"
        )
    op.create_table(
        "friendships",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_low", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("user_high", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("requested_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("accepted_at", TIMESTAMP),
        sa.UniqueConstraint("user_low", "user_high"),
        sa.CheckConstraint("status IN ('pending', 'accepted')", name="ck_friendships_status"),
        sa.CheckConstraint("user_low <> user_high", name="ck_friendships_pair"),
    )
    op.create_index("ix_friendships_user_high", "friendships", ["user_high"])
    op.create_table(
        "player_blocks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("blocker_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("blocked_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.UniqueConstraint("blocker_id", "blocked_id"),
    )
    op.create_index("ix_player_blocks_blocked_id", "player_blocks", ["blocked_id"])
    op.create_table(
        "notifications",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("read_at", TIMESTAMP),
        sa.CheckConstraint(
            "kind IN ('friend_request', 'friend_accepted', 'friend_online')",
            name="ck_notifications_kind",
        ),
    )
    op.create_index(
        "ix_notifications_user_id_created_at", "notifications", ["user_id", "created_at"]
    )
    op.create_index("ix_notifications_actor_id", "notifications", ["actor_id"])


def downgrade() -> None:
    op.drop_table("notifications")
    op.drop_table("player_blocks")
    op.drop_table("friendships")
    with op.batch_alter_table("users") as users:
        users.drop_constraint("ck_users_presence_visibility", type_="check")
        for column in (
            "email_searchable",
            "appear_offline",
            "presence_visibility",
            "active_at",
            "presence_at",
        ):
            users.drop_column(column)
