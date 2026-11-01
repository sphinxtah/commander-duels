"""The campaign (v0.8.0, api/campaign.py): an account's progress through it, the games played for
its encounters and the rewards earned.

- campaign_progress: one row an account and campaign.
- campaign_games: a practice game played for an encounter, and its outcome.
- campaign_rewards: seals, card backs and titles, each earned once; and each warden's spoils,
  their deck and their tokens.
- token_ledger takes the kind 'campaign' (a warden's tokens) and library_grants the source
  'campaign' (the cards of a warden's deck).

New tables and two wider checks: v0.7.3, still serving while this migrates, never reads the
tables and never writes the new kind or source.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0032_campaign"
down_revision = "0031_land_packs"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
TIMESTAMP = sa.DateTime(timezone=True)
SOURCES_BEFORE = "source IN ('starter', 'grandfathered', 'pack', 'unique', 'auction')"
SOURCES = "source IN ('starter', 'grandfathered', 'pack', 'unique', 'auction', 'campaign')"
TOKENS_BEFORE = (
    "kind IN ('bot_win', 'human_win', 'back_pay', 'welcome', 'grant', 'pack', 'quest', "
    "'achievement', 'bid', 'bid_return', 'sale')"
)
TOKENS = (
    "kind IN ('bot_win', 'human_win', 'back_pay', 'welcome', 'grant', 'pack', 'quest', "
    "'achievement', 'bid', 'bid_return', 'sale', 'campaign')"
)


def upgrade() -> None:
    op.create_table(
        "campaign_progress",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("campaign_id", sa.String(48), nullable=False),
        sa.Column("content_version", sa.SmallInteger(), nullable=False),
        sa.Column("highest_unlocked", sa.SmallInteger(), nullable=False),
        sa.Column("completed", JSON, nullable=False),
        sa.Column("ending", sa.String(16)),
        sa.Column("scenes_seen", JSON, nullable=False),
        sa.Column("hints", sa.Boolean(), nullable=False),
        sa.Column("tutorial_skipped", sa.Boolean(), nullable=False),
        sa.Column("lessons", JSON, nullable=False),
        sa.Column("started_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.UniqueConstraint("user_id", "campaign_id"),
        sa.CheckConstraint(
            "highest_unlocked BETWEEN 1 AND 99", name="ck_campaign_progress_unlocked"
        ),
        sa.CheckConstraint(
            "ending IS NULL OR ending IN ('standard', 'early')", name="ck_campaign_progress_ending"
        ),
    )
    op.create_index("ix_campaign_progress_user_id", "campaign_progress", ["user_id"])
    op.create_table(
        "campaign_games",
        sa.Column("game_id", sa.Uuid(), sa.ForeignKey("games.id"), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("campaign_id", sa.String(48), nullable=False),
        sa.Column("encounter", sa.SmallInteger(), nullable=False),
        sa.Column("opponent", sa.String(64), nullable=False),
        sa.Column("opponent_name", sa.String(64), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("deck", sa.String(16), nullable=False),
        sa.Column("hints", sa.Boolean(), nullable=False),
        sa.Column("finale", sa.String(16)),
        sa.Column("outcome", sa.String(16)),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("finished_at", TIMESTAMP),
        sa.CheckConstraint(
            "outcome IS NULL OR outcome IN ('won', 'lost', 'draw', 'unfinished')",
            name="ck_campaign_games_outcome",
        ),
    )
    op.create_index("ix_campaign_games_user_id", "campaign_games", ["user_id"])
    op.create_table(
        "campaign_rewards",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("campaign_id", sa.String(48), nullable=False),
        sa.Column("key", sa.String(160), nullable=False, unique=True),
        sa.Column("reward", sa.String(64), nullable=False),
        sa.Column("game_id", sa.Uuid(), sa.ForeignKey("games.id")),
        sa.Column("created_at", TIMESTAMP, nullable=False),
    )
    op.create_index("ix_campaign_rewards_user_id", "campaign_rewards", ["user_id"])
    with op.batch_alter_table("token_ledger") as ledger:
        ledger.drop_constraint("ck_token_ledger_kind", type_="check")
        ledger.create_check_constraint("ck_token_ledger_kind", TOKENS)
    with op.batch_alter_table("library_grants") as grants:
        grants.drop_constraint("ck_library_grants_source", type_="check")
        grants.create_check_constraint("ck_library_grants_source", SOURCES)


def downgrade() -> None:
    # The ledger and the grants are append-only on PostgreSQL: their triggers are set aside while
    # the campaign's rows go.
    postgres = op.get_bind().dialect.name == "postgresql"
    if postgres:
        op.execute("ALTER TABLE token_ledger DISABLE TRIGGER token_ledger_append_only")
        op.execute("ALTER TABLE library_grants DISABLE TRIGGER library_grants_append_only")
    op.execute("DELETE FROM token_ledger WHERE kind = 'campaign'")
    op.execute("DELETE FROM library_grants WHERE source = 'campaign'")
    if postgres:
        op.execute("ALTER TABLE token_ledger ENABLE TRIGGER token_ledger_append_only")
        op.execute("ALTER TABLE library_grants ENABLE TRIGGER library_grants_append_only")
    with op.batch_alter_table("library_grants") as grants:
        grants.drop_constraint("ck_library_grants_source", type_="check")
        grants.create_check_constraint("ck_library_grants_source", SOURCES_BEFORE)
    with op.batch_alter_table("token_ledger") as ledger:
        ledger.drop_constraint("ck_token_ledger_kind", type_="check")
        ledger.create_check_constraint("ck_token_ledger_kind", TOKENS_BEFORE)
    op.drop_index("ix_campaign_rewards_user_id", table_name="campaign_rewards")
    op.drop_table("campaign_rewards")
    op.drop_index("ix_campaign_games_user_id", table_name="campaign_games")
    op.drop_table("campaign_games")
    op.drop_index("ix_campaign_progress_user_id", table_name="campaign_progress")
    op.drop_table("campaign_progress")
