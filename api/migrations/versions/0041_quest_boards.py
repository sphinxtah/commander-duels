"""v0.9.5: the quest boards, achievement rewards ×4, and opening a warden's deck.

- daily_quests.board: 'daily' (the daily board's five a day, slots 0-4) or 'weekly' (the weekly
  board's twenty a week, slots 0-19, its day the Sunday its week starts on). Rows before it are
  the old three a day (quests-v1), kept as they are.
- quest_boards: a board an account finished, its streak and its bonus, keyed once per period.
- packs.sale: bought at the weekly sale's price, filled in for packs bought before from their
  ledger entry's reason (packs is append-only on PostgreSQL: its trigger is set aside meanwhile).
- warden_openings: a warden's deck won in the campaign, to open as a pack (api/campaign.py): the
  cards the win granted, in the order they reveal, and when the player opened it.
- notifications.kind gains 'warden_deck': the bell's notice of a warden's deck waiting.
- The achievements' rewards are four times what they were (the owner, 2026-11-10). Every
  achievement an account earned since its last reset is paid the difference here, once: an
  'achievement' entry in the token ledger keyed achievement-raise:<the achievement's key>, so
  running this again pays nothing. The earned row records the new reward.

Expand only, but its downgrade removes the new quests (the old version allows three a day) and
the warden decks' notices; the tokens paid stay in the ledger, which never forgets.
"""

from datetime import UTC, datetime
from uuid import UUID, uuid4

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

TIMESTAMP = sa.DateTime(timezone=True)

revision = "0041_quest_boards"
down_revision = "0040_decks_purged"
branch_labels = None
depends_on = None

NOTICES_BEFORE = (
    "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message', "
    "'quest_completed', 'achievement_earned', 'rematch', 'team_invite', "
    "'auction_outbid', 'auction_won', 'auction_sold', 'auction_unsold', "
    "'auction_cancelled', 'table_invite')"
)
NOTICES = (
    "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message', "
    "'quest_completed', 'achievement_earned', 'rematch', 'team_invite', "
    "'auction_outbid', 'auction_won', 'auction_sold', 'auction_unsold', "
    "'auction_cancelled', 'table_invite', 'warden_deck')"
)
SLOTS_BEFORE = "slot BETWEEN 0 AND 2"
SLOTS = "(board = 'daily' AND slot BETWEEN 0 AND 4) OR (board = 'weekly' AND slot BETWEEN 0 AND 19)"

# The rewards as v0.5.0 set them (achievements-v1), by achievement and name: the back pay is the
# new reward, four times this, less what was paid. Fixed here, as the code's definitions may change.
REWARDS_BEFORE: dict[str, tuple[str, int]] = {
    "first-win": ("First Victory", 100),
    "wins-10": ("Seasoned Planeswalker", 200),
    "wins-100": ("Veteran Planeswalker", 400),
    "wins-1000": ("Legendary Planeswalker", 1_000),
    "commander-win": ("Commander Victor", 100),
    "commander-wins-25": ("Commander Captain", 300),
    "commander-four": ("Last One Standing", 150),
    "commander-four-10": ("King of the Table", 300),
    "legacy-win": ("Legacy Victor", 100),
    "legacy-wins-25": ("Legacy Master", 300),
    "win-white": ("Paragon of White", 100),
    "win-blue": ("Paragon of Blue", 100),
    "win-black": ("Paragon of Black", 100),
    "win-red": ("Paragon of Red", 100),
    "win-green": ("Paragon of Green", 100),
    "every-colour": ("Master of the Five", 250),
    "five-colour-win": ("Five-Colour Triumph", 200),
    "beat-skill-4": ("Rising Challenger", 100),
    "beat-skill-6": ("Machine Breaker", 200),
    "beat-skill-6-10": ("Master of Machines", 300),
    "win-players": ("Worthy Opponent", 150),
    "win-players-10": ("Table Champion", 400),
    "quest-1": ("First Quest", 100),
    "quests-10": ("Quest Seeker", 200),
    "quests-50": ("Questing Knight", 400),
    "pack-1": ("Fresh Pack", 100),
    "packs-25": ("Collector", 300),
    "friend-1": ("Ally", 100),
    "friends-10": ("Fellowship", 200),
}
RAISE = 4
POLICY = "achievements-v2"


def back_pay() -> None:
    """The difference for every achievement earned since its account's last reset, once."""
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT a.id, a.user_id, a.achievement, a.key, a.tokens FROM player_achievements a "
            "JOIN users u ON u.id = a.user_id "
            "WHERE u.reset_at IS NULL OR a.earned_at > u.reset_at"
        )
    ).all()
    taken = {
        key
        for (key,) in bind.execute(
            sa.text("SELECT key FROM token_ledger WHERE key LIKE 'achievement-raise:%'")
        ).all()
    }
    now = datetime.now(UTC)
    ledger = sa.table(
        "token_ledger",
        sa.column("id", sa.Uuid()),
        sa.column("user_id", sa.Uuid()),
        sa.column("kind", sa.String()),
        sa.column("amount", sa.BigInteger()),
        sa.column("key", sa.String()),
        sa.column("policy", sa.String()),
        sa.column("reason", sa.String()),
        sa.column("created_at", TIMESTAMP),
    )
    entries = []
    for row_id, user_id, achievement, key, paid in rows:
        tokens = int(str(paid))
        before = REWARDS_BEFORE.get(str(achievement))
        if before is None:
            continue
        name, old = before
        new = old * RAISE
        raise_key = f"achievement-raise:{key}"[:128]
        if tokens >= new or raise_key in taken:
            continue
        entries.append(
            {
                "id": uuid4(),
                "user_id": UUID(str(user_id)),
                "kind": "achievement",
                "amount": new - tokens,
                "key": raise_key,
                "policy": POLICY,
                "reason": f"{name}: reward raised to {new:,} tokens",
                "created_at": now,
            }
        )
        bind.execute(
            sa.text("UPDATE player_achievements SET tokens = :tokens WHERE id = :id"),
            {"tokens": new, "id": row_id},
        )
    if entries:
        op.bulk_insert(ledger, entries)


def upgrade() -> None:
    with op.batch_alter_table("daily_quests") as quests:
        quests.add_column(sa.Column("board", sa.String(8), nullable=False, server_default="daily"))
        quests.drop_constraint("ck_daily_quests_slot", type_="check")
        quests.create_check_constraint("ck_daily_quests_slot", SLOTS)
        quests.create_check_constraint("ck_daily_quests_board", "board IN ('daily', 'weekly')")
    op.create_table(
        "quest_boards",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("board", sa.String(8), nullable=False),
        sa.Column("period", sa.Date(), nullable=False),
        sa.Column("key", sa.String(128), nullable=False, unique=True),
        sa.Column("streak", sa.Integer(), nullable=False),
        sa.Column("bonus", sa.Integer(), nullable=False),
        sa.Column("policy", sa.String(32), nullable=False),
        sa.Column("completed_at", TIMESTAMP, nullable=False),
        sa.CheckConstraint("board IN ('daily', 'weekly')", name="ck_quest_boards_board"),
        sa.CheckConstraint("streak >= 1", name="ck_quest_boards_streak"),
    )
    op.create_index(
        "ix_quest_boards_user_id_board_period", "quest_boards", ["user_id", "board", "period"]
    )
    with op.batch_alter_table("packs") as packs:
        packs.add_column(sa.Column("sale", sa.Boolean(), nullable=False, server_default=sa.false()))
    bind = op.get_bind()
    sold = [
        pack_id
        for pack_id, key in bind.execute(
            sa.text(
                "SELECT p.id, l.key FROM packs p JOIN token_ledger l ON l.user_id = p.user_id "
                "WHERE l.kind = 'pack' AND l.reason LIKE '%(weekly sale,%' "
                "AND p.source = 'purchase'"
            )
        ).all()
        if key == f"pack:{UUID(str(pack_id))}"
    ]
    # packs is append-only on PostgreSQL (0010): its trigger is set aside for the backfill.
    postgres = bind.dialect.name == "postgresql"
    if postgres and sold:
        op.execute("ALTER TABLE packs DISABLE TRIGGER packs_append_only")
    for pack_id in sold:
        bind.execute(
            sa.text("UPDATE packs SET sale = :sale WHERE id = :id"), {"sale": True, "id": pack_id}
        )
    if postgres and sold:
        op.execute("ALTER TABLE packs ENABLE TRIGGER packs_append_only")
    op.create_table(
        "warden_openings",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("campaign_id", sa.String(48), nullable=False),
        sa.Column("encounter", sa.SmallInteger(), nullable=False),
        sa.Column("key", sa.String(160), nullable=False, unique=True),
        sa.Column("deck_id", sa.Uuid()),
        sa.Column("game_id", sa.Uuid(), sa.ForeignKey("games.id")),
        sa.Column("opponent", sa.String(64), nullable=False),
        sa.Column("opponent_name", sa.String(64), nullable=False),
        sa.Column("deck_title", sa.String(80), nullable=False),
        sa.Column("cards", sa.JSON().with_variant(JSONB(), "postgresql"), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("opened_at", TIMESTAMP),
    )
    op.create_index("ix_warden_openings_user_id", "warden_openings", ["user_id"])
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", NOTICES)
    back_pay()


def downgrade() -> None:
    op.execute("DELETE FROM notifications WHERE kind = 'warden_deck'")
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", NOTICES_BEFORE)
    op.drop_index("ix_warden_openings_user_id", table_name="warden_openings")
    op.drop_table("warden_openings")
    with op.batch_alter_table("packs") as packs:
        packs.drop_column("sale")
    op.drop_index("ix_quest_boards_user_id_board_period", table_name="quest_boards")
    op.drop_table("quest_boards")
    op.execute("DELETE FROM daily_quests WHERE board = 'weekly' OR slot > 2")
    with op.batch_alter_table("daily_quests") as quests:
        quests.drop_constraint("ck_daily_quests_board", type_="check")
        quests.drop_constraint("ck_daily_quests_slot", type_="check")
        quests.create_check_constraint("ck_daily_quests_slot", SLOTS_BEFORE)
        quests.drop_column("board")
