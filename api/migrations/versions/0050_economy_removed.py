"""v0.9.13: the economy's foundations removed (docs/economy.md).

The owner adopted none of v0.9.12's economy proposals (2026-11-14: "I want to keep the game pure,
as if it were real life") and approved taking out what migration 0047 made, with what the code
wrote beside it. This is the Preparation Framework's one destructive migration, and it is the
owner's decision, not the framework's rule, which stays expand-only:

- entitlements: dropped. No policy that wrote to it was ever on by default.
- daily_quests.alternative: dropped.
- games.eligibility: the farming `signals` v0.9.12 recorded with every game are taken out. What
  v0.9.10 records there (the mode, what the game earned and why not) stays.
- site_settings: the six policies' rows (policy.*) are deleted.

Guarded: it changes nothing and says why when the table holds a row, a daily quest holds an
alternative, or a game holds a reward the farming policy withheld (`seats`). Each exists only if a
policy was switched on by hand; then what becomes of those rows is the owner's to say first.

Going back makes the table and the column again, empty. The signals and the settings are gone.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0050_economy_removed"
down_revision = "0049_table_profiles"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")

POLICIES = (
    "functional_basics",
    "starter_staples",
    "quest_streaks",
    "quest_catch_up",
    "quest_alternatives",
    "farming",
)


def upgrade() -> None:
    bind = op.get_bind()
    postgres = bind.dialect.name == "postgresql"
    # A board drawn by v0.9.12 with the policy off wrote JSON's null, not SQL's: that is no
    # alternative.
    withheld = (
        "eligibility -> 'seats' IS NOT NULL"
        if postgres
        else "json_valid(eligibility) AND json_extract(eligibility, '$.seats') IS NOT NULL"
    )
    found = {
        "rows in entitlements": "SELECT COUNT(*) FROM entitlements",
        "daily quests with an alternative": "SELECT COUNT(*) FROM daily_quests "
        "WHERE alternative IS NOT NULL AND CAST(alternative AS TEXT) <> 'null'",
        "games with a reward the farming policy withheld": "SELECT COUNT(*) FROM games "
        f"WHERE eligibility IS NOT NULL AND {withheld}",
    }
    used = {what: bind.execute(sa.text(query)).scalar() or 0 for what, query in found.items()}
    if any(used.values()):
        raise RuntimeError(
            "Migration 0050 removes the economy foundations of v0.9.12, and they were used here: "
            + ", ".join(f"{count} {what}" for what, count in used.items() if count)
            + ". Nothing was changed. An economy policy was switched on by hand at some point; "
            "decide what becomes of those rows before this version is deployed "
            "(docs/economy.md#the-data)."
        )
    if postgres:
        op.execute(
            "UPDATE games SET eligibility = eligibility - 'signals' "
            "WHERE eligibility -> 'signals' IS NOT NULL"
        )
    else:
        op.execute(
            "UPDATE games SET eligibility = json_remove(eligibility, '$.signals') "
            "WHERE json_valid(eligibility) "
            "AND json_extract(eligibility, '$.signals') IS NOT NULL"
        )
    op.execute(
        sa.text("DELETE FROM site_settings WHERE key IN :keys").bindparams(
            sa.bindparam("keys", [f"policy.{name}" for name in POLICIES], expanding=True)
        )
    )
    op.drop_column("daily_quests", "alternative")
    op.drop_index("ix_entitlements_user_id_kind", table_name="entitlements")
    op.drop_table("entitlements")


def downgrade() -> None:
    op.create_table(
        "entitlements",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("card_id", sa.Uuid(), sa.ForeignKey("card_concepts.id"), nullable=False),
        sa.Column("copies", sa.SmallInteger(), nullable=False),
        sa.Column("key", sa.String(160), nullable=False, unique=True),
        sa.Column("policy", sa.String(32), nullable=False),
        sa.Column("reason", sa.Text()),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.CheckConstraint("kind IN ('staple', 'staff')", name="ck_entitlements_kind"),
        sa.CheckConstraint("copies > 0", name="ck_entitlements_copies"),
    )
    op.create_index("ix_entitlements_user_id_kind", "entitlements", ["user_id", "kind"])
    op.add_column("daily_quests", sa.Column("alternative", JSON))
