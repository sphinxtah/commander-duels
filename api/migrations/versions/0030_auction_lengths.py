"""Auction lengths (v0.6.3, docs/auctions.md "Selling"): 7 days, 30 days and unlimited.

The owner's decision of v0.6.3: an unlimited auction is Buy Now only, as eBay's Good 'Til
Cancelled. It has no end (ends_at null), its starting bid is its Buy Now price, and it takes no
bids; it runs until bought, withdrawn or cancelled.

- auctions.duration widens to 9 characters and takes '7d', '30d' and 'unlimited'.
- auctions.ends_at is null exactly for an unlimited auction.
- ck_auctions_buy_now: an unlimited auction has a Buy Now price equal to its starting bid.

The previous version reads a null end as an error: deploy the API and the worker together.

Downgrade ends the live unlimited auctions now (they have no bids, so they expire unsold at the
worker's next pass and the copies come back), and records every new length as 3 days.
"""

import sqlalchemy as sa
from alembic import op

revision = "0030_auction_lengths"
down_revision = "0029_stand_ins"
branch_labels = None
depends_on = None

OLD_DURATIONS = "duration IN ('1h', '3h', '12h', '24h', '3d')"
DURATIONS = "duration IN ('1h', '3h', '12h', '24h', '3d', '7d', '30d', 'unlimited')"
OLD_BUY_NOW = "buy_now IS NULL OR buy_now > starting_bid"
BUY_NOW = (
    "(duration = 'unlimited' AND buy_now = starting_bid) "
    "OR (duration != 'unlimited' AND (buy_now IS NULL OR buy_now > starting_bid))"
)
ENDS = "(duration = 'unlimited') = (ends_at IS NULL)"


def upgrade() -> None:
    with op.batch_alter_table("auctions") as auctions:
        auctions.drop_constraint("ck_auctions_duration", type_="check")
        auctions.drop_constraint("ck_auctions_buy_now", type_="check")
        auctions.alter_column(
            "duration", existing_type=sa.String(4), type_=sa.String(9), existing_nullable=False
        )
        auctions.alter_column("ends_at", existing_type=sa.DateTime(timezone=True), nullable=True)
        auctions.create_check_constraint("ck_auctions_duration", DURATIONS)
        auctions.create_check_constraint("ck_auctions_buy_now", BUY_NOW)
        auctions.create_check_constraint("ck_auctions_ends", ENDS)


def downgrade() -> None:
    with op.batch_alter_table("auctions") as auctions:
        auctions.drop_constraint("ck_auctions_ends", type_="check")
        auctions.drop_constraint("ck_auctions_buy_now", type_="check")
        auctions.drop_constraint("ck_auctions_duration", type_="check")
    op.execute("UPDATE auctions SET ends_at = COALESCE(ended_at, created_at) WHERE ends_at IS NULL")
    # An unlimited auction's starting bid is its Buy Now: one token less keeps it above.
    op.execute(
        "UPDATE auctions SET starting_bid = starting_bid - 1 "
        "WHERE duration = 'unlimited' AND starting_bid > 1"
    )
    op.execute(
        "UPDATE auctions SET buy_now = NULL "
        "WHERE duration = 'unlimited' AND buy_now <= starting_bid"
    )
    op.execute("UPDATE auctions SET duration = '3d' WHERE duration IN ('7d', '30d', 'unlimited')")
    with op.batch_alter_table("auctions") as auctions:
        auctions.alter_column("ends_at", existing_type=sa.DateTime(timezone=True), nullable=False)
        auctions.alter_column(
            "duration", existing_type=sa.String(9), type_=sa.String(4), existing_nullable=False
        )
        auctions.create_check_constraint("ck_auctions_duration", OLD_DURATIONS)
        auctions.create_check_constraint("ck_auctions_buy_now", OLD_BUY_NOW)
