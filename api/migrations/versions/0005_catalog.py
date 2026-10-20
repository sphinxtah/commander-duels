"""The card catalog: Scryfall concepts, faces and printings, rulings, relations, aliases and tags,
with import runs, source snapshots, revisions and their changes, the engine's implementations and
format versions."""

from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005_catalog"
down_revision = "0004_card_images"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
TIMESTAMP = sa.DateTime(timezone=True)
BIG = sa.Integer().with_variant(sa.BigInteger(), "postgresql")
REVISION = "catalog_revisions.id"


def revisions() -> list[sa.Column[Any]]:
    return [
        sa.Column("first_revision", sa.Integer(), sa.ForeignKey(REVISION), nullable=False),
        sa.Column("changed_revision", sa.Integer(), sa.ForeignKey(REVISION), nullable=False),
        sa.Column("removed_revision", sa.Integer(), sa.ForeignKey(REVISION)),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "catalog_sync_runs",
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
        sa.Column("revision_id", sa.Integer()),
        sa.Column("next_attempt_at", TIMESTAMP),
        sa.CheckConstraint(
            "status IN ('running', 'succeeded', 'unchanged', 'failed', 'fenced')",
            name="ck_catalog_sync_runs_status",
        ),
        sa.CheckConstraint(
            "trigger IN ('schedule', 'manual')", name="ck_catalog_sync_runs_trigger"
        ),
    )
    op.create_index("ix_catalog_sync_runs_job_id", "catalog_sync_runs", ["job_id"])
    op.create_index("ix_catalog_sync_runs_started_at", "catalog_sync_runs", ["started_at"])

    op.create_table(
        "catalog_revisions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("sync_run_id", sa.Uuid(), sa.ForeignKey("catalog_sync_runs.id")),
        sa.Column("engine_build", sa.Text()),
        sa.Column("datasets", JSON, nullable=False),
        sa.Column("counts", JSON, nullable=False),
        sa.Column("changes", JSON, nullable=False),
    )

    op.create_table(
        "catalog_source_snapshots",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("sync_run_id", sa.Uuid(), sa.ForeignKey("catalog_sync_runs.id"), nullable=False),
        sa.Column("dataset", sa.String(32), nullable=False),
        sa.Column("source_updated_at", TIMESTAMP, nullable=False),
        sa.Column("download_uri", sa.Text(), nullable=False),
        sa.Column("compressed_bytes", BIG, nullable=False),
        sa.Column("decompressed_bytes", BIG),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("etag", sa.Text()),
        sa.Column("last_modified", sa.Text()),
        sa.Column("records", sa.Integer()),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("applied_revision", sa.Integer(), sa.ForeignKey(REVISION)),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.CheckConstraint(
            "status IN ('downloaded', 'validated', 'applied', 'failed')",
            name="ck_catalog_source_snapshots_status",
        ),
    )
    op.create_index(
        "ix_catalog_source_snapshots_dataset", "catalog_source_snapshots", ["dataset", "status"]
    )
    op.create_index(
        "ix_catalog_source_snapshots_sync_run_id", "catalog_source_snapshots", ["sync_run_id"]
    )

    op.create_table(
        "card_concepts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("oracle_id", sa.Uuid(), nullable=False, unique=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("normalized_name", sa.Text(), nullable=False),
        sa.Column("construction_key", sa.Text(), nullable=False),
        sa.Column("layout", sa.String(32), nullable=False),
        sa.Column("deck_card", sa.Boolean(), nullable=False),
        sa.Column("mana_cost", sa.Text()),
        sa.Column("mana_value", sa.Float(), nullable=False),
        sa.Column("type_line", sa.Text(), nullable=False),
        sa.Column("oracle_text", sa.Text(), nullable=False),
        sa.Column("power", sa.Text()),
        sa.Column("toughness", sa.Text()),
        sa.Column("loyalty", sa.Text()),
        sa.Column("defense", sa.Text()),
        sa.Column("colors", JSON, nullable=False),
        sa.Column("color_identity", JSON, nullable=False),
        sa.Column("color_indicator", JSON),
        sa.Column("colors_mask", sa.SmallInteger(), nullable=False),
        sa.Column("identity_mask", sa.SmallInteger(), nullable=False),
        sa.Column("keywords", JSON, nullable=False),
        sa.Column("produced_mana", JSON, nullable=False),
        sa.Column("legalities", JSON, nullable=False),
        sa.Column("reserved", sa.Boolean(), nullable=False),
        sa.Column("game_changer", sa.Boolean(), nullable=False),
        sa.Column("edhrec_rank", sa.Integer()),
        sa.Column("first_released_at", sa.Date()),
        sa.Column("paper", sa.Boolean(), nullable=False),
        sa.Column("commander", sa.Boolean(), nullable=False),
        sa.Column("partner", sa.String(160)),
        sa.Column("companion", sa.Boolean(), nullable=False),
        sa.Column("copy_limit", sa.SmallInteger()),
        sa.Column("activated", sa.Boolean(), nullable=False),
        sa.Column("name_search", sa.Text(), nullable=False),
        sa.Column("type_search", sa.Text(), nullable=False),
        sa.Column("text_search", sa.Text(), nullable=False),
        sa.Column("gameplay_hash", sa.String(64), nullable=False),
        sa.Column("legality_hash", sa.String(64), nullable=False),
        sa.Column("extra", JSON, nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("status_reason", sa.String(32)),
        sa.Column("status_detail", sa.Text()),
        sa.Column("engine_name", sa.Text()),
        sa.Column("engine_build", sa.Text()),
        sa.Column("certified_hash", sa.String(64)),
        sa.Column("text_differs", sa.Boolean(), nullable=False),
        sa.Column("review", sa.String(16), nullable=False),
        sa.Column("capabilities", JSON, nullable=False),
        sa.Column("default_printing_id", sa.Uuid()),
        *revisions(),
        sa.CheckConstraint(
            "status IN ('catalog_only', 'mapped', 'implemented', 'certified', 'suspended', "
            "'unsupported')",
            name="ck_card_concepts_status",
        ),
        sa.CheckConstraint("review IN ('none', 'pending')", name="ck_card_concepts_review"),
    )
    op.create_index("ix_card_concepts_normalized_name", "card_concepts", ["normalized_name"])
    op.create_index("ix_card_concepts_construction_key", "card_concepts", ["construction_key"])
    op.create_index("ix_card_concepts_status", "card_concepts", ["status"])

    op.create_table(
        "card_faces",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("concept_id", sa.Uuid(), sa.ForeignKey("card_concepts.id"), nullable=False),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("normalized_name", sa.Text(), nullable=False),
        sa.Column("mana_cost", sa.Text()),
        sa.Column("type_line", sa.Text()),
        sa.Column("oracle_text", sa.Text()),
        sa.Column("colors", JSON),
        sa.Column("color_indicator", JSON),
        sa.Column("power", sa.Text()),
        sa.Column("toughness", sa.Text()),
        sa.Column("loyalty", sa.Text()),
        sa.Column("defense", sa.Text()),
        sa.UniqueConstraint("concept_id", "position"),
    )
    op.create_index("ix_card_faces_concept_id", "card_faces", ["concept_id"])
    op.create_index("ix_card_faces_normalized_name", "card_faces", ["normalized_name"])

    op.create_table(
        "card_printings",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("scryfall_id", sa.Uuid(), nullable=False, unique=True),
        sa.Column("concept_id", sa.Uuid(), sa.ForeignKey("card_concepts.id"), nullable=False),
        sa.Column("set_code", sa.String(16), nullable=False),
        sa.Column("set_name", sa.Text(), nullable=False),
        sa.Column("set_type", sa.String(32), nullable=False),
        sa.Column("collector_number", sa.String(32), nullable=False),
        sa.Column("lang", sa.String(8), nullable=False),
        sa.Column("released_at", sa.Date()),
        sa.Column("rarity", sa.String(16), nullable=False),
        sa.Column("layout", sa.String(32), nullable=False),
        sa.Column("finishes", JSON, nullable=False),
        sa.Column("frame", sa.String(16)),
        sa.Column("frame_effects", JSON, nullable=False),
        sa.Column("border_color", sa.String(16)),
        sa.Column("full_art", sa.Boolean(), nullable=False),
        sa.Column("promo", sa.Boolean(), nullable=False),
        sa.Column("promo_types", JSON, nullable=False),
        sa.Column("digital", sa.Boolean(), nullable=False),
        sa.Column("games", JSON, nullable=False),
        sa.Column("artist", sa.Text()),
        sa.Column("illustration_id", sa.Uuid()),
        sa.Column("image_status", sa.String(32)),
        sa.Column("image_uris", JSON),
        sa.Column("faces", JSON, nullable=False),
        sa.Column("flavor_name", sa.Text()),
        sa.Column("printed_name", sa.Text()),
        sa.Column("extra", JSON, nullable=False),
        sa.Column("cosmetic_hash", sa.String(64), nullable=False),
        *revisions(),
    )
    op.create_index("ix_card_printings_concept_id", "card_printings", ["concept_id"])
    op.create_index("ix_card_printings_set", "card_printings", ["set_code", "collector_number"])

    op.create_table(
        "card_rulings",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("concept_id", sa.Uuid(), sa.ForeignKey("card_concepts.id"), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("published_at", sa.Date(), nullable=False),
        sa.Column("comment", sa.Text(), nullable=False),
    )
    op.create_index("ix_card_rulings_concept_id", "card_rulings", ["concept_id"])

    op.create_table(
        "card_relations",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("concept_id", sa.Uuid(), sa.ForeignKey("card_concepts.id"), nullable=False),
        sa.Column("component", sa.String(32), nullable=False),
        sa.Column("related_scryfall_id", sa.Uuid(), nullable=False),
        sa.Column("related_name", sa.Text(), nullable=False),
        sa.Column("related_type_line", sa.Text()),
    )
    op.create_index("ix_card_relations_concept_id", "card_relations", ["concept_id"])

    op.create_table(
        "card_aliases",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("alias", sa.Text(), nullable=False),
        sa.Column("concept_id", sa.Uuid(), sa.ForeignKey("card_concepts.id"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.UniqueConstraint("alias", "concept_id"),
    )
    op.create_index("ix_card_aliases_alias", "card_aliases", ["alias"])
    op.create_index("ix_card_aliases_concept_id", "card_aliases", ["concept_id"])

    op.create_table(
        "card_tags",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("slug", sa.Text(), nullable=False, unique=True),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("parent_ids", JSON, nullable=False),
        sa.Column("aliases", JSON, nullable=False),
    )
    op.create_table(
        "card_tag_links",
        sa.Column("concept_id", sa.Uuid(), sa.ForeignKey("card_concepts.id"), primary_key=True),
        sa.Column("tag_id", sa.Uuid(), sa.ForeignKey("card_tags.id"), primary_key=True),
        sa.Column("weight", sa.String(16), nullable=False),
    )
    op.create_index("ix_card_tag_links_tag_id", "card_tag_links", ["tag_id"])

    op.create_table(
        "catalog_changes",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("revision_id", sa.Integer(), sa.ForeignKey(REVISION), nullable=False),
        sa.Column("concept_id", sa.Uuid(), sa.ForeignKey("card_concepts.id")),
        sa.Column("printing_id", sa.Uuid(), sa.ForeignKey("card_printings.id")),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("details", JSON, nullable=False),
    )
    op.create_index("ix_catalog_changes_revision_id", "catalog_changes", ["revision_id"])
    op.create_index("ix_catalog_changes_concept_id", "catalog_changes", ["concept_id"])

    op.create_table(
        "engine_cards",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("engine_build", sa.String(128), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("normalized_name", sa.Text(), nullable=False),
        sa.Column("class_name", sa.Text(), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("data", JSON, nullable=False),
        sa.Column("gates", JSON, nullable=False),
        sa.Column("passed", sa.Boolean(), nullable=False),
        sa.UniqueConstraint("engine_build", "name"),
    )
    op.create_index("ix_engine_cards_engine_build", "engine_cards", ["engine_build"])
    op.create_index("ix_engine_cards_normalized_name", "engine_cards", ["normalized_name"])

    op.create_table(
        "format_versions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("format", sa.String(16), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("effective_at", TIMESTAMP, nullable=False),
        sa.Column("catalog_revision_id", sa.Integer(), sa.ForeignKey(REVISION)),
        sa.Column("rules", JSON, nullable=False),
        sa.Column("banned", JSON, nullable=False),
        sa.Column("banned_hash", sa.String(64), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.UniqueConstraint("format", "version"),
        sa.CheckConstraint("format IN ('legacy', 'commander')", name="ck_format_versions_format"),
    )


def downgrade() -> None:
    for table in (
        "format_versions",
        "engine_cards",
        "catalog_changes",
        "card_tag_links",
        "card_tags",
        "card_aliases",
        "card_relations",
        "card_rulings",
        "card_printings",
        "card_faces",
        "card_concepts",
        "catalog_source_snapshots",
        "catalog_revisions",
        "catalog_sync_runs",
    ):
        op.drop_table(table)
