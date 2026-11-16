"""v1.0.0: a notice that a friend offers to lend a deck (api/loans.py, docs/decks.md).

- notifications.kind may be ``deck_offered``: a friend offers the account one of their decks.

A loan itself is an access grant (access_grants, v0.9.10): no table of its own.

Expand only: a check that allows one more value. Every row there is stays what it was. Going
back removes the notifications of the new kind, which the older API cannot show; the grants
stay, and the older API seats none of them.
"""

from alembic import op

revision = "0055_deck_loans"
down_revision = "0054_table_fit"
branch_labels = None
depends_on = None

NOTICES_BEFORE = (
    "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message', "
    "'quest_completed', 'achievement_earned', 'rematch', 'team_invite', "
    "'auction_outbid', 'auction_won', 'auction_sold', 'auction_unsold', "
    "'auction_cancelled', 'table_invite', 'warden_deck', 'replay_shared')"
)
NOTICES = NOTICES_BEFORE[:-1] + ", 'deck_offered')"


def upgrade() -> None:
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", NOTICES)


def downgrade() -> None:
    op.execute("DELETE FROM notifications WHERE kind = 'deck_offered'")
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", NOTICES_BEFORE)
