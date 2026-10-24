"""One-of-a-kind cards (v0.5.1, docs/progression.md "One of a kind").

The owner asked on 2026-10-23 for the only copy of The One Ring ever printed (The Lord of the
Rings: Tales of Middle-earth #0, serialized 001/001) to be in Sphinx's library, and in no one
else's. library_grants gains the source 'unique', and the copy is granted to the active player
whose handle is Sphinx, once (grant key unique:<Scryfall ID>). A database without the printing or
without that player (a fresh one, or a test's) gets no grant; the rest of the rule
(api/library.py ONE_OF_A_KIND) holds anyway: packs never deal the printing, and no other deck may
hold it.

Expand only: the previous version reads the grant as a library copy of an unknown source.

Downgrade deletes the one-of-a-kind grants and restores the sources before it.
"""

from datetime import UTC, datetime
from uuid import UUID, uuid4

import sqlalchemy as sa
from alembic import op

revision = "0027_one_of_a_kind"
down_revision = "0026_two_headed_giant_tables"
branch_labels = None
depends_on = None

SOURCES_BEFORE = "source IN ('starter', 'grandfathered', 'pack')"
SOURCES = "source IN ('starter', 'grandfathered', 'pack', 'unique')"
# Scryfall ID: normalized handle of the owner (api/library.py ONE_OF_A_KIND says the same).
ONE_OF_A_KIND = {UUID("93de9042-cc62-4ade-8d8d-68fdbc84bfae"): "sphinx"}

grants = sa.table(
    "library_grants",
    sa.column("id", sa.Uuid()),
    sa.column("user_id", sa.Uuid()),
    sa.column("concept_id", sa.Uuid()),
    sa.column("printing_id", sa.Uuid()),
    sa.column("quantity", sa.Integer()),
    sa.column("source", sa.String()),
    sa.column("grant_key", sa.String()),
    sa.column("created_at", sa.DateTime(timezone=True)),
)
printings = sa.table(
    "card_printings",
    sa.column("id", sa.Uuid()),
    sa.column("concept_id", sa.Uuid()),
    sa.column("scryfall_id", sa.Uuid()),
)
users = sa.table(
    "users",
    sa.column("id", sa.Uuid()),
    sa.column("normalized_handle", sa.String()),
    sa.column("kind", sa.String()),
    sa.column("status", sa.String()),
)


def upgrade() -> None:
    with op.batch_alter_table("library_grants") as table:
        table.drop_constraint("ck_library_grants_source", type_="check")
        table.create_check_constraint("ck_library_grants_source", SOURCES)
    bind = op.get_bind()
    for scryfall_id, handle in ONE_OF_A_KIND.items():
        printing = bind.execute(
            sa.select(printings.c.id, printings.c.concept_id).where(
                printings.c.scryfall_id == scryfall_id
            )
        ).first()
        owner = bind.scalar(
            sa.select(users.c.id).where(
                users.c.normalized_handle == handle,
                users.c.kind == "player",
                users.c.status == "active",
            )
        )
        key = f"unique:{scryfall_id}"
        if (
            printing is None
            or owner is None
            or bind.scalar(sa.select(grants.c.id).where(grants.c.grant_key == key))
        ):
            continue
        bind.execute(
            grants.insert().values(
                id=uuid4(),
                user_id=owner,
                concept_id=printing.concept_id,
                printing_id=printing.id,
                quantity=1,
                source="unique",
                grant_key=key,
                created_at=datetime.now(UTC),
            )
        )


def downgrade() -> None:
    # The grants are append-only on PostgreSQL: the trigger is set aside while they go.
    postgres = op.get_bind().dialect.name == "postgresql"
    if postgres:
        op.execute("ALTER TABLE library_grants DISABLE TRIGGER library_grants_append_only")
    op.execute("DELETE FROM library_grants WHERE source = 'unique'")
    if postgres:
        op.execute("ALTER TABLE library_grants ENABLE TRIGGER library_grants_append_only")
    with op.batch_alter_table("library_grants") as table:
        table.drop_constraint("ck_library_grants_source", type_="check")
        table.create_check_constraint("ck_library_grants_source", SOURCES_BEFORE)
