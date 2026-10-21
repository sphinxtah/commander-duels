"""Leng's card shop (v0.4.0): booster products, their collations from MTGJSON's booster data and
the runs of the job that reads it, and the packs players buy, are given and open.

Nothing is carried over: the products come from content/pack-prices.json when the API or the
worker first reads it, and their collations from the booster data job's first run. Collations,
packs and openings are append-only on PostgreSQL, as the ledgers are.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0010_shop"
down_revision = "0009_tables"
branch_labels = None
depends_on = None

TIMESTAMP = sa.DateTime(timezone=True)
JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
BIG = sa.Integer().with_variant(sa.BigInteger(), "postgresql")
APPEND_ONLY = ("booster_collations", "packs", "pack_openings", "pack_cards")


def upgrade() -> None:
    op.create_table(
        "booster_sync_runs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("job_id", sa.Uuid(), sa.ForeignKey("scheduled_jobs.id")),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("trigger", sa.String(16), nullable=False),
        sa.Column("requested_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("started_at", TIMESTAMP, nullable=False),
        sa.Column("finished_at", TIMESTAMP),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("error_code", sa.String(64)),
        sa.Column("error_message", sa.Text()),
        sa.Column("stats", JSON, nullable=False),
        sa.Column("next_attempt_at", TIMESTAMP),
        sa.CheckConstraint(
            "status IN ('running', 'succeeded', 'unchanged', 'failed', 'fenced')",
            name="ck_booster_sync_runs_status",
        ),
        sa.CheckConstraint(
            "trigger IN ('schedule', 'manual')", name="ck_booster_sync_runs_trigger"
        ),
    )
    op.create_index("ix_booster_sync_runs_job_id", "booster_sync_runs", ["job_id"])
    op.create_index("ix_booster_sync_runs_started_at", "booster_sync_runs", ["started_at"])

    op.create_table(
        "booster_sources",
        sa.Column("name", sa.String(32), primary_key=True),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("etag", sa.Text()),
        sa.Column("last_modified", sa.Text()),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("size", BIG, nullable=False),
        sa.Column("mtgjson_version", sa.String(64)),
        sa.Column("fetched_at", TIMESTAMP, nullable=False),
        sa.Column("checked_at", TIMESTAMP, nullable=False),
    )

    op.create_table(
        "shop_products",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("set_code", sa.String(16), nullable=False),
        sa.Column("booster", sa.String(48), nullable=False),
        sa.Column("set_name", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("released", sa.Date()),
        sa.Column("origin", sa.String(16), nullable=False),
        sa.Column("usd", sa.Float()),
        sa.Column("usd_method", sa.String(16)),
        sa.Column("usd_source", sa.Text()),
        sa.Column("price_override", sa.BigInteger()),
        sa.Column("price_reason", sa.Text()),
        sa.Column("on_sale", sa.Boolean(), nullable=False),
        sa.Column("sale_reason", sa.Text()),
        sa.Column("changed_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("changed_at", TIMESTAMP),
        sa.Column("data_status", sa.String(16), nullable=False),
        sa.Column("collation_id", sa.Uuid()),
        sa.Column("pack_size", sa.Integer()),
        sa.Column("unresolved_count", sa.Integer(), nullable=False),
        sa.Column("unresolved", JSON, nullable=False),
        sa.Column("checked_at", TIMESTAMP),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.UniqueConstraint("set_code", "booster"),
        sa.CheckConstraint("origin IN ('price_list', 'mtgjson')", name="ck_shop_products_origin"),
        sa.CheckConstraint(
            "data_status IN ('waiting', 'ready', 'unresolved', 'missing')",
            name="ck_shop_products_data_status",
        ),
        sa.CheckConstraint(
            "price_override IS NULL OR price_override > 0", name="ck_shop_products_price"
        ),
    )

    op.create_table(
        "booster_collations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("product_id", sa.Uuid(), sa.ForeignKey("shop_products.id"), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("mtgjson_version", sa.String(64), nullable=False),
        sa.Column("source_sha256", sa.String(64), nullable=False),
        sa.Column("digest", sa.String(64), nullable=False),
        sa.Column("layouts", JSON, nullable=False),
        sa.Column("sheets", JSON, nullable=False),
        sa.Column("cards", sa.Integer(), nullable=False),
        sa.Column("sync_run_id", sa.Uuid(), sa.ForeignKey("booster_sync_runs.id")),
        sa.Column("catalog_revision_id", sa.Integer(), sa.ForeignKey("catalog_revisions.id")),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.UniqueConstraint("product_id", "revision"),
    )
    op.create_index("ix_booster_collations_product_id", "booster_collations", ["product_id"])

    op.create_table(
        "packs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("product_id", sa.Uuid(), sa.ForeignKey("shop_products.id"), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("tokens", sa.BigInteger(), nullable=False),
        sa.Column("request_key", sa.String(64)),
        sa.Column("grant_id", sa.Uuid()),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("reason", sa.Text()),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.UniqueConstraint("user_id", "request_key"),
        sa.CheckConstraint("source IN ('purchase', 'grant')", name="ck_packs_source"),
        sa.CheckConstraint("tokens >= 0", name="ck_packs_tokens"),
        sa.CheckConstraint("(source = 'grant') = (actor_id IS NOT NULL)", name="ck_packs_actor"),
    )
    op.create_index("ix_packs_user_id", "packs", ["user_id"])

    op.create_table(
        "pack_openings",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("pack_id", sa.Uuid(), sa.ForeignKey("packs.id"), nullable=False, unique=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("product_id", sa.Uuid(), sa.ForeignKey("shop_products.id"), nullable=False),
        sa.Column(
            "collation_id", sa.Uuid(), sa.ForeignKey("booster_collations.id"), nullable=False
        ),
        sa.Column("layout", sa.Integer(), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
    )
    op.create_index("ix_pack_openings_user_id", "pack_openings", ["user_id"])

    op.create_table(
        "pack_cards",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("opening_id", sa.Uuid(), sa.ForeignKey("pack_openings.id"), nullable=False),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("printing_id", sa.Uuid(), sa.ForeignKey("card_printings.id"), nullable=False),
        sa.Column("concept_id", sa.Uuid(), sa.ForeignKey("card_concepts.id"), nullable=False),
        sa.Column("finish", sa.String(8), nullable=False),
        sa.Column("sheet", sa.String(64), nullable=False),
        sa.Column("new", sa.Boolean(), nullable=False),
        sa.UniqueConstraint("opening_id", "position"),
        sa.CheckConstraint("finish IN ('nonfoil', 'foil', 'etched')", name="ck_pack_cards_finish"),
    )
    op.create_index("ix_pack_cards_opening_id", "pack_cards", ["opening_id"])

    if op.get_bind().dialect.name == "postgresql":
        # What a pack held, and how it was collated, stays recorded (PROG02);
        # progression_append_only is 0007's.
        for table in APPEND_ONLY:
            op.execute(
                f"CREATE TRIGGER {table}_append_only BEFORE UPDATE OR DELETE ON {table} "
                "FOR EACH ROW EXECUTE FUNCTION progression_append_only()"
            )


def downgrade() -> None:
    # Cards pulled stay in the libraries (library_grants, source 'pack') and tokens spent stay
    # spent; 0008's downgrade removes the pulled cards with the source that names them.
    if op.get_bind().dialect.name == "postgresql":
        for table in APPEND_ONLY:
            op.execute(f"DROP TRIGGER {table}_append_only ON {table}")
    op.drop_index("ix_pack_cards_opening_id", table_name="pack_cards")
    op.drop_table("pack_cards")
    op.drop_index("ix_pack_openings_user_id", table_name="pack_openings")
    op.drop_table("pack_openings")
    op.drop_index("ix_packs_user_id", table_name="packs")
    op.drop_table("packs")
    op.drop_index("ix_booster_collations_product_id", table_name="booster_collations")
    op.drop_table("booster_collations")
    op.drop_table("shop_products")
    op.drop_table("booster_sources")
    op.drop_index("ix_booster_sync_runs_started_at", table_name="booster_sync_runs")
    op.drop_index("ix_booster_sync_runs_job_id", table_name="booster_sync_runs")
    op.drop_table("booster_sync_runs")
