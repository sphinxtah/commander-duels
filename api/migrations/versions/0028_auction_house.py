"""Tivit's Auction House (v0.6.0, docs/auctions.md) and the library by finish.

- library_grants.finish: every grant names the finish (nonfoil, foil, etched) it gives, and the
  uniqueness of a grant is its account, its key, its edition and that finish
  (uq_library_grants_finish). Existing grants are given theirs: a pack's (key pack:<opening>) the
  finishes the opening pulled of that edition (pack_cards), a row per finish; everything else
  nonfoil. library_grants is append-only on PostgreSQL (0007): its trigger is set aside while the
  rows are written. The source 'auction' is a card bought at the auction house (auction:<id>).
- auctions, auction_bids and auction_watches start empty.
- token_ledger takes the kinds bid (tokens held, never positive), bid_return and sale; the
  notifications take auction_outbid, auction_won, auction_sold, auction_unsold and
  auction_cancelled.

Not expand only: the previous version writes grants without a finish into a uniqueness that no
longer holds. Downgrade ends the live auctions as cancelled ones end (each leading bid back to its
bidder, as a grant of tokens, since the previous version knows no other kind for it), takes each
sold copy out of its seller's grants, keeps the buyers' copies as grandfathered ones, turns the
auction house's ledger entries into grants (what they moved stays in the balances), adds each
grant's finishes back into one row per edition, and drops the tables.
"""

from collections import Counter, defaultdict
from datetime import UTC, datetime
from uuid import UUID, uuid4

import sqlalchemy as sa
from alembic import op

revision = "0028_auction_house"
down_revision = "0027_one_of_a_kind"
branch_labels = None
depends_on = None

TIMESTAMP = sa.DateTime(timezone=True)
FINISHES = ("nonfoil", "foil", "etched")
OLD_UNIQUE = "uq_library_grants_edition"
NEW_UNIQUE = "uq_library_grants_finish"
SOURCES_BEFORE = "source IN ('starter', 'grandfathered', 'pack', 'unique')"
SOURCES = "source IN ('starter', 'grandfathered', 'pack', 'unique', 'auction')"
TOKENS_BEFORE = (
    "kind IN ('bot_win', 'human_win', 'back_pay', 'welcome', 'grant', 'pack', 'quest', "
    "'achievement')"
)
TOKENS = (
    "kind IN ('bot_win', 'human_win', 'back_pay', 'welcome', 'grant', 'pack', 'quest', "
    "'achievement', 'bid', 'bid_return', 'sale')"
)
EARNED_BEFORE = "kind IN ('grant', 'pack') OR amount >= 0"
EARNED = "kind IN ('grant', 'pack', 'bid') OR amount >= 0"
NOTICES_BEFORE = (
    "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message', "
    "'quest_completed', 'achievement_earned', 'rematch', 'team_invite')"
)
NOTICES = (
    "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message', "
    "'quest_completed', 'achievement_earned', 'rematch', 'team_invite', "
    "'auction_outbid', 'auction_won', 'auction_sold', 'auction_unsold', "
    "'auction_cancelled')"
)
AUCTION_NOTICES = (
    "'auction_outbid', 'auction_won', 'auction_sold', 'auction_unsold', 'auction_cancelled'"
)

grants = sa.table(
    "library_grants",
    sa.column("id", sa.Uuid()),
    sa.column("user_id", sa.Uuid()),
    sa.column("concept_id", sa.Uuid()),
    sa.column("printing_id", sa.Uuid()),
    sa.column("finish", sa.String()),
    sa.column("quantity", sa.Integer()),
    sa.column("source", sa.String()),
    sa.column("grant_key", sa.String()),
    sa.column("created_at", TIMESTAMP),
)


def postgres() -> bool:
    return bool(op.get_bind().dialect.name == "postgresql")


def guarded(table: str, enabled: bool) -> None:
    """Sets a table's append-only trigger aside, or back (PostgreSQL only)."""
    if postgres():
        state = "ENABLE" if enabled else "DISABLE"
        op.execute(f"ALTER TABLE {table} {state} TRIGGER {table}_append_only")


def upgrade() -> None:
    with op.batch_alter_table("library_grants") as table:
        table.add_column(
            sa.Column("finish", sa.String(8), nullable=False, server_default=sa.text("'nonfoil'"))
        )
        table.drop_constraint(OLD_UNIQUE, "unique")
        table.drop_constraint("ck_library_grants_source", type_="check")
        table.create_check_constraint("ck_library_grants_source", SOURCES)
        table.create_check_constraint(
            "ck_library_grants_finish", "finish IN ('nonfoil', 'foil', 'etched')"
        )
    guarded("library_grants", False)
    give_finishes()
    guarded("library_grants", True)
    with op.batch_alter_table("library_grants") as table:
        table.create_unique_constraint(
            NEW_UNIQUE, ["user_id", "grant_key", "printing_id", "finish"]
        )
    with op.batch_alter_table("token_ledger") as ledger:
        ledger.drop_constraint("ck_token_ledger_kind", type_="check")
        ledger.create_check_constraint("ck_token_ledger_kind", TOKENS)
        ledger.drop_constraint("ck_token_ledger_earned", type_="check")
        ledger.create_check_constraint("ck_token_ledger_earned", EARNED)
        ledger.create_check_constraint("ck_token_ledger_bid", "kind != 'bid' OR amount <= 0")
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", NOTICES)

    op.create_table(
        "auctions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("seller_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("concept_id", sa.Uuid(), sa.ForeignKey("card_concepts.id"), nullable=False),
        sa.Column("printing_id", sa.Uuid(), sa.ForeignKey("card_printings.id"), nullable=False),
        sa.Column("finish", sa.String(8), nullable=False),
        sa.Column("starting_bid", sa.BigInteger(), nullable=False),
        sa.Column("buy_now", sa.BigInteger()),
        sa.Column("duration", sa.String(4), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("current_bid", sa.BigInteger()),
        sa.Column("high_bidder_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("bid_count", sa.Integer(), nullable=False),
        sa.Column("buyer_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("sold_price", sa.BigInteger()),
        sa.Column("request_key", sa.String(64), nullable=False),
        sa.Column("batch_index", sa.SmallInteger(), nullable=False),
        sa.Column("relisted_from", sa.Uuid(), sa.ForeignKey("auctions.id"), unique=True),
        sa.Column("cancel_reason", sa.Text()),
        sa.Column("cancelled_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("seller_cleared_at", TIMESTAMP),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("ends_at", TIMESTAMP, nullable=False),
        sa.Column("ended_at", TIMESTAMP),
        sa.CheckConstraint(
            "status IN ('active', 'sold', 'expired', 'withdrawn', 'cancelled')",
            name="ck_auctions_status",
        ),
        sa.CheckConstraint("finish IN ('nonfoil', 'foil', 'etched')", name="ck_auctions_finish"),
        sa.CheckConstraint(
            "duration IN ('1h', '3h', '12h', '24h', '3d')", name="ck_auctions_duration"
        ),
        sa.CheckConstraint("starting_bid >= 1", name="ck_auctions_starting_bid"),
        sa.CheckConstraint("buy_now IS NULL OR buy_now > starting_bid", name="ck_auctions_buy_now"),
        sa.CheckConstraint("(status = 'sold') = (buyer_id IS NOT NULL)", name="ck_auctions_buyer"),
        sa.UniqueConstraint("seller_id", "request_key", "batch_index"),
    )
    op.create_index("ix_auctions_seller_id", "auctions", ["seller_id"])
    op.create_index("ix_auctions_high_bidder_id", "auctions", ["high_bidder_id"])
    op.create_index("ix_auctions_status_ends_at", "auctions", ["status", "ends_at"])
    op.create_index("ix_auctions_printing_id_finish", "auctions", ["printing_id", "finish"])
    op.create_table(
        "auction_bids",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("auction_id", sa.Uuid(), sa.ForeignKey("auctions.id"), nullable=False),
        sa.Column("bidder_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("buy_now", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("request_key", sa.String(64), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.CheckConstraint("status IN ('held', 'returned', 'won')", name="ck_auction_bids_status"),
        sa.CheckConstraint("amount >= 1", name="ck_auction_bids_amount"),
        sa.UniqueConstraint("bidder_id", "request_key"),
    )
    op.create_index("ix_auction_bids_auction_id", "auction_bids", ["auction_id"])
    op.create_index("ix_auction_bids_bidder_id", "auction_bids", ["bidder_id"])
    op.create_table(
        "auction_watches",
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("auction_id", sa.Uuid(), sa.ForeignKey("auctions.id"), primary_key=True),
        sa.Column("watching", sa.Boolean(), nullable=False),
        sa.Column("cleared_at", TIMESTAMP),
        sa.Column("created_at", TIMESTAMP, nullable=False),
    )
    op.create_index("ix_auction_watches_auction_id", "auction_watches", ["auction_id"])


def give_finishes() -> None:
    """A pack's grants split by the finishes its opening pulled of each edition; the rest stay
    nonfoil, as the column's default made them."""
    bind = op.get_bind()
    cards = sa.table(
        "pack_cards",
        sa.column("opening_id", sa.Uuid()),
        sa.column("printing_id", sa.Uuid()),
        sa.column("finish", sa.String()),
    )
    pulled: dict[tuple[str, UUID], Counter[str]] = defaultdict(Counter)
    for row in bind.execute(
        sa.select(cards.c.opening_id, cards.c.printing_id, cards.c.finish).where(
            cards.c.finish != "nonfoil"
        )
    ):
        pulled[(f"pack:{row.opening_id}", row.printing_id)][row.finish] += 1
    if not pulled:
        return
    updates: list[dict[str, object]] = []
    inserts: list[dict[str, object]] = []
    for row in bind.execute(
        sa.select(
            grants.c.id,
            grants.c.user_id,
            grants.c.concept_id,
            grants.c.printing_id,
            grants.c.quantity,
            grants.c.source,
            grants.c.grant_key,
            grants.c.created_at,
        ).where(grants.c.source == "pack")
    ):
        foils = pulled.get((row.grant_key, row.printing_id))
        if not foils:
            continue
        # Each finish takes the copies the opening pulled in it, the rest are nonfoil; the copies
        # add up to what was granted.
        left = row.quantity
        given: dict[str, int] = {}
        for finish in ("etched", "foil"):
            taken = min(foils.get(finish, 0), left)
            if taken > 0:
                given[finish] = taken
                left -= taken
        if left > 0:
            given["nonfoil"] = left
        first, *rest = sorted(given.items(), key=lambda item: FINISHES.index(item[0]))
        updates.append({"grant": row.id, "finish": first[0], "copies": first[1]})
        for finish, copies in rest:
            inserts.append(
                {
                    "id": uuid4(),
                    "user_id": row.user_id,
                    "concept_id": row.concept_id,
                    "printing_id": row.printing_id,
                    "finish": finish,
                    "quantity": copies,
                    "source": row.source,
                    "grant_key": row.grant_key,
                    "created_at": row.created_at,
                }
            )
    statement = (
        grants.update()
        .where(grants.c.id == sa.bindparam("grant"))
        .values(finish=sa.bindparam("finish"), quantity=sa.bindparam("copies"))
    )
    for start in range(0, len(updates), 1000):
        bind.execute(statement, updates[start : start + 1000])
    for start in range(0, len(inserts), 1000):
        bind.execute(grants.insert(), inserts[start : start + 1000])


def downgrade() -> None:
    bind = op.get_bind()
    now = datetime.now(UTC)
    auctions = sa.table(
        "auctions",
        sa.column("id", sa.Uuid()),
        sa.column("seller_id", sa.Uuid()),
        sa.column("printing_id", sa.Uuid()),
        sa.column("finish", sa.String()),
        sa.column("status", sa.String()),
        sa.column("current_bid", sa.BigInteger()),
        sa.column("high_bidder_id", sa.Uuid()),
        sa.column("created_at", TIMESTAMP),
    )
    ledger = sa.table(
        "token_ledger",
        sa.column("id", sa.Uuid()),
        sa.column("user_id", sa.Uuid()),
        sa.column("kind", sa.String()),
        sa.column("amount", sa.BigInteger()),
        sa.column("key", sa.String()),
        sa.column("policy", sa.String()),
        sa.column("reason", sa.Text()),
        sa.column("created_at", TIMESTAMP),
    )
    # The live auctions end as cancelled ones do: the leading bid goes back to its bidder.
    for row in bind.execute(
        sa.select(auctions.c.id, auctions.c.current_bid, auctions.c.high_bidder_id).where(
            auctions.c.status == "active", auctions.c.high_bidder_id.is_not(None)
        )
    ):
        bind.execute(
            ledger.insert().values(
                id=uuid4(),
                user_id=row.high_bidder_id,
                kind="grant",
                amount=row.current_bid,
                key=f"grant:{uuid4()}",
                policy="tokens-v1",
                reason="Bid returned: the auction house closed",
                created_at=now,
            )
        )
    guarded("library_grants", False)
    # A sold copy leaves its seller's grants of that edition and finish, the newest first; the
    # buyer keeps theirs, as a grandfathered copy.
    sold = list(
        bind.execute(
            sa.select(auctions.c.seller_id, auctions.c.printing_id, auctions.c.finish).where(
                auctions.c.status == "sold"
            )
        )
    )
    for sale in sold:
        held = bind.execute(
            sa.select(grants.c.id, grants.c.quantity)
            .where(
                grants.c.user_id == sale.seller_id,
                grants.c.printing_id == sale.printing_id,
                grants.c.finish == sale.finish,
            )
            .order_by(grants.c.created_at.desc())
            .limit(1)
        ).first()
        if held is None:
            continue
        if held.quantity > 1:
            bind.execute(
                grants.update().where(grants.c.id == held.id).values(quantity=held.quantity - 1)
            )
        else:
            bind.execute(grants.delete().where(grants.c.id == held.id))
    bind.execute(grants.update().where(grants.c.source == "auction").values(source="grandfathered"))
    # One row per edition again: the first finish's row takes every copy, the others go.
    kept: dict[tuple[UUID, str, UUID], UUID] = {}
    copies: dict[UUID, int] = defaultdict(int)
    merged: set[UUID] = set()
    gone: list[UUID] = []
    for row in bind.execute(
        sa.select(
            grants.c.id,
            grants.c.user_id,
            grants.c.grant_key,
            grants.c.printing_id,
            grants.c.quantity,
        ).order_by(grants.c.created_at, grants.c.id)
    ):
        first = kept.setdefault((row.user_id, row.grant_key, row.printing_id), row.id)
        copies[first] += row.quantity
        if first != row.id:
            merged.add(first)
            gone.append(row.id)
    statement = (
        grants.update()
        .where(grants.c.id == sa.bindparam("grant"))
        .values(quantity=sa.bindparam("copies"))
    )
    rows = [{"grant": grant, "copies": copies[grant]} for grant in merged]
    for start in range(0, len(rows), 1000):
        bind.execute(statement, rows[start : start + 1000])
    for start in range(0, len(gone), 1000):
        bind.execute(grants.delete().where(grants.c.id.in_(gone[start : start + 1000])))
    guarded("library_grants", True)
    guarded("token_ledger", False)
    bind.execute(
        ledger.update().where(ledger.c.kind.in_(("bid", "bid_return", "sale"))).values(kind="grant")
    )
    guarded("token_ledger", True)
    op.execute(f"DELETE FROM notifications WHERE kind IN ({AUCTION_NOTICES})")

    op.drop_index("ix_auction_watches_auction_id", table_name="auction_watches")
    op.drop_table("auction_watches")
    op.drop_index("ix_auction_bids_bidder_id", table_name="auction_bids")
    op.drop_index("ix_auction_bids_auction_id", table_name="auction_bids")
    op.drop_table("auction_bids")
    op.drop_index("ix_auctions_printing_id_finish", table_name="auctions")
    op.drop_index("ix_auctions_status_ends_at", table_name="auctions")
    op.drop_index("ix_auctions_high_bidder_id", table_name="auctions")
    op.drop_index("ix_auctions_seller_id", table_name="auctions")
    op.drop_table("auctions")

    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", NOTICES_BEFORE)
    with op.batch_alter_table("token_ledger") as ledger_table:
        ledger_table.drop_constraint("ck_token_ledger_bid", type_="check")
        ledger_table.drop_constraint("ck_token_ledger_earned", type_="check")
        ledger_table.create_check_constraint("ck_token_ledger_earned", EARNED_BEFORE)
        ledger_table.drop_constraint("ck_token_ledger_kind", type_="check")
        ledger_table.create_check_constraint("ck_token_ledger_kind", TOKENS_BEFORE)
    with op.batch_alter_table("library_grants") as table:
        table.drop_constraint(NEW_UNIQUE, "unique")
        table.drop_constraint("ck_library_grants_finish", type_="check")
        table.drop_constraint("ck_library_grants_source", type_="check")
        table.create_check_constraint("ck_library_grants_source", SOURCES_BEFORE)
        table.drop_column("finish")
        table.create_unique_constraint(OLD_UNIQUE, ["user_id", "grant_key", "printing_id"])
