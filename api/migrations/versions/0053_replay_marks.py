"""v1.0.0: a reader's bookmarks and notes on a replay (api/replays.py, docs/replays.md).

- replay_marks: an account's own marks on a game's replay: a bookmark at one of the game's
  events with a label and a note, or (seq 0) its note on the whole game.
- notifications.kind may be ``replay_shared``: a friend shared a replay with the account.

Expand only: a new table, and a check that allows one more value. Every row there is stays what
it was. Going back removes the notifications of the new kind, which the older API cannot show.
"""

import sqlalchemy as sa
from alembic import op

revision = "0053_replay_marks"
down_revision = "0052_game_saves"
branch_labels = None
depends_on = None

NOTICES_BEFORE = (
    "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message', "
    "'quest_completed', 'achievement_earned', 'rematch', 'team_invite', "
    "'auction_outbid', 'auction_won', 'auction_sold', 'auction_unsold', "
    "'auction_cancelled', 'table_invite', 'warden_deck')"
)
NOTICES = NOTICES_BEFORE[:-1] + ", 'replay_shared')"


def upgrade() -> None:
    op.create_table(
        "replay_marks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("game_id", sa.Uuid(), sa.ForeignKey("games.id"), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("turn", sa.Integer()),
        sa.Column("label", sa.String(80), nullable=False, server_default=""),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("user_id", "game_id", "seq", name="uq_replay_marks_place"),
        sa.CheckConstraint("seq >= 0", name="ck_replay_marks_seq"),
    )
    op.create_index("ix_replay_marks_user_id", "replay_marks", ["user_id"])
    op.create_index("ix_replay_marks_game_id", "replay_marks", ["game_id"])
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", NOTICES)


def downgrade() -> None:
    op.execute("DELETE FROM notifications WHERE kind = 'replay_shared'")
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", NOTICES_BEFORE)
    op.drop_index("ix_replay_marks_game_id", table_name="replay_marks")
    op.drop_index("ix_replay_marks_user_id", table_name="replay_marks")
    op.drop_table("replay_marks")
