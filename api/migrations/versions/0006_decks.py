"""Decks: players' decks with their drafts, immutable revisions and entries; the deck revision each
game seat played, and the catalog revision and format version each game started under."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0006_decks"
down_revision = "0005_catalog"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
TIMESTAMP = sa.DateTime(timezone=True)
LOCATIONS = "'main', 'sideboard', 'commander', 'companion', 'maybeboard'"


def upgrade() -> None:
    op.create_table(
        "decks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("owner_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("title", sa.String(80), nullable=False),
        sa.Column("format", sa.String(16), nullable=False),
        sa.Column("visibility", sa.String(16), nullable=False),
        sa.Column("share_code", sa.String(32), unique=True),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("draft", JSON, nullable=False),
        sa.Column("draft_version", sa.Integer(), nullable=False),
        sa.Column("draft_hash", sa.String(64), nullable=False),
        sa.Column("card_count", sa.Integer(), nullable=False),
        sa.Column("legal", sa.Boolean(), nullable=False),
        sa.Column("playable", sa.Boolean(), nullable=False),
        sa.Column("identity", sa.String(8), nullable=False),
        sa.Column("latest_revision", sa.Integer()),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("archived_at", TIMESTAMP),
        sa.Column("deleted_at", TIMESTAMP),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
        sa.CheckConstraint("format IN ('legacy', 'commander')", name="ck_decks_format"),
        sa.CheckConstraint("visibility IN ('private', 'link')", name="ck_decks_visibility"),
        sa.CheckConstraint("draft_version >= 1", name="ck_decks_draft_version"),
    )
    op.create_index("ix_decks_owner", "decks", ["owner_id", "updated_at"])

    op.create_table(
        "deck_revisions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("deck_id", sa.Uuid(), sa.ForeignKey("decks.id"), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("format", sa.String(16), nullable=False),
        sa.Column("title", sa.String(80), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("catalog_revision_id", sa.Integer(), sa.ForeignKey("catalog_revisions.id")),
        sa.Column("format_version", sa.Integer()),
        sa.Column("legal", sa.Boolean(), nullable=False),
        sa.Column("playable", sa.Boolean(), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.UniqueConstraint("deck_id", "number"),
        sa.CheckConstraint("format IN ('legacy', 'commander')", name="ck_deck_revisions_format"),
    )
    op.create_index("ix_deck_revisions_deck_id", "deck_revisions", ["deck_id"])

    op.create_table(
        "deck_entries",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("revision_id", sa.Uuid(), sa.ForeignKey("deck_revisions.id"), nullable=False),
        sa.Column("concept_id", sa.Uuid(), sa.ForeignKey("card_concepts.id"), nullable=False),
        sa.Column("printing_id", sa.Uuid(), sa.ForeignKey("card_printings.id")),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("location", sa.String(16), nullable=False),
        sa.CheckConstraint("quantity > 0", name="ck_deck_entries_quantity"),
        sa.CheckConstraint(f"location IN ({LOCATIONS})", name="ck_deck_entries_location"),
    )
    op.create_index("ix_deck_entries_revision_id", "deck_entries", ["revision_id"])
    op.create_index("ix_deck_entries_concept_id", "deck_entries", ["concept_id"])

    if op.get_bind().dialect.name == "postgresql":
        op.execute(
            """
            CREATE FUNCTION deck_revisions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
            END $$;
            CREATE TRIGGER deck_revisions_immutable BEFORE UPDATE ON deck_revisions
                FOR EACH ROW EXECUTE FUNCTION deck_revisions_immutable();
            CREATE TRIGGER deck_entries_immutable BEFORE UPDATE ON deck_entries
                FOR EACH ROW EXECUTE FUNCTION deck_revisions_immutable();
            """
        )

    # Expand only: the previous version ignores these nullable columns.
    with op.batch_alter_table("games") as games:
        games.add_column(
            sa.Column(
                "catalog_revision_id",
                sa.Integer(),
                sa.ForeignKey("catalog_revisions.id", name="fk_games_catalog_revision_id"),
            )
        )
        games.add_column(sa.Column("format_version", sa.Integer()))
    with op.batch_alter_table("game_seats") as seats:
        seats.add_column(
            sa.Column(
                "deck_revision_id",
                sa.Uuid(),
                sa.ForeignKey("deck_revisions.id", name="fk_game_seats_deck_revision_id"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("game_seats") as seats:
        seats.drop_column("deck_revision_id")
    with op.batch_alter_table("games") as games:
        games.drop_column("format_version")
        games.drop_column("catalog_revision_id")
    if op.get_bind().dialect.name == "postgresql":
        op.execute("DROP TRIGGER deck_entries_immutable ON deck_entries")
        op.execute("DROP TRIGGER deck_revisions_immutable ON deck_revisions")
        op.execute("DROP FUNCTION deck_revisions_immutable()")
    op.drop_table("deck_entries")
    op.drop_table("deck_revisions")
    op.drop_table("decks")
