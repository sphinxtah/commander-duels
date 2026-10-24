"""Stand-ins (v0.6.2, docs/shop.md "Buying and opening", docs/tables.md "The table's rules").

The owner's decision of v0.6.2: a pack gives the card it drew, whether the engine can play it or
not, and casual games play such a card as a stand-in.

- game_tables.allow_stand_in: whether a table's decks may hold stand-ins. A table open at the
  upgrade allows them when it allows banned cards and cards not legal in the format (casual), and
  not under tournament rules.
- From v0.4.5 to v0.6.1 a card the game could not play gave way in a pack to another from its
  sheet, and the pack's card recorded the one drawn first (pack_cards.replaced_printing_id). Each
  account is now granted that card, in that pack card's finish, keeping the one it was given:
  source pack, key pack-drawn:<opening>, at the opening's time, so an opening from before the
  account's reset grants nothing it counts (library.since_reset). Only cards a deck holds: a token
  or art card drawn first is not granted, as packs never give them. The grants are written once;
  a grant already there (the same account, key, edition and finish) is left as it is.

Expand only: the previous version ignores the column and reads the grants as pack copies.

Downgrade takes the grants back and drops the column.
"""

from collections import defaultdict
from typing import Any
from uuid import uuid4

import sqlalchemy as sa
from alembic import op

revision = "0029_stand_ins"
down_revision = "0028_auction_house"
branch_labels = None
depends_on = None

KEY = "pack-drawn:"

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
    sa.column("created_at", sa.DateTime(timezone=True)),
)
openings = sa.table(
    "pack_openings",
    sa.column("id", sa.Uuid()),
    sa.column("user_id", sa.Uuid()),
    sa.column("created_at", sa.DateTime(timezone=True)),
)
pack_cards = sa.table(
    "pack_cards",
    sa.column("opening_id", sa.Uuid()),
    sa.column("finish", sa.String()),
    sa.column("replaced_printing_id", sa.Uuid()),
)
printings = sa.table(
    "card_printings",
    sa.column("id", sa.Uuid()),
    sa.column("concept_id", sa.Uuid()),
)
concepts = sa.table(
    "card_concepts",
    sa.column("id", sa.Uuid()),
    sa.column("deck_card", sa.Boolean()),
    sa.column("status_reason", sa.String()),
)


def upgrade() -> None:
    with op.batch_alter_table("game_tables") as tables:
        tables.add_column(
            sa.Column("allow_stand_in", sa.Boolean(), nullable=False, server_default=sa.true())
        )
    op.execute("UPDATE game_tables SET allow_stand_in = (allow_banned AND allow_not_legal)")
    grant_drawn(op.get_bind())


def grant_drawn(bind: sa.Connection) -> int:
    """Grants each card a pack drew before v0.6.2 in place of the one it gave, once; returns how
    many grants it wrote. tests/test_shop.py runs it on a database at head."""
    rows = bind.execute(
        sa.select(
            openings.c.id,
            openings.c.user_id,
            openings.c.created_at,
            printings.c.concept_id,
            pack_cards.c.replaced_printing_id,
            pack_cards.c.finish,
        )
        .select_from(pack_cards)
        .join(openings, openings.c.id == pack_cards.c.opening_id)
        .join(printings, printings.c.id == pack_cards.c.replaced_printing_id)
        .join(concepts, concepts.c.id == printings.c.concept_id)
        .where(
            pack_cards.c.replaced_printing_id.is_not(None),
            concepts.c.deck_card.is_(True),
            sa.func.coalesce(concepts.c.status_reason, "") != "not_a_deck_card",
        )
    ).all()
    copies: dict[tuple[Any, Any, Any], int] = defaultdict(int)
    found: dict[tuple[Any, Any, Any], tuple[Any, Any, Any]] = {}
    for opening, user, created, concept, printing, finish in rows:
        copies[(opening, printing, finish)] += 1
        found[(opening, printing, finish)] = (user, concept, created)
    written = 0
    for (opening, printing, finish), quantity in copies.items():
        user, concept, created = found[(opening, printing, finish)]
        key = f"{KEY}{opening}"
        if bind.scalar(
            sa.select(grants.c.id).where(
                grants.c.user_id == user,
                grants.c.grant_key == key,
                grants.c.printing_id == printing,
                grants.c.finish == finish,
            )
        ):
            continue
        bind.execute(
            grants.insert().values(
                id=uuid4(),
                user_id=user,
                concept_id=concept,
                printing_id=printing,
                finish=finish,
                quantity=quantity,
                source="pack",
                grant_key=key,
                created_at=created,
            )
        )
        written += 1
    return written


def downgrade() -> None:
    # The grants are append-only on PostgreSQL: the trigger is set aside while they go.
    postgres = op.get_bind().dialect.name == "postgresql"
    if postgres:
        op.execute("ALTER TABLE library_grants DISABLE TRIGGER library_grants_append_only")
    op.execute(f"DELETE FROM library_grants WHERE grant_key LIKE '{KEY}%'")
    if postgres:
        op.execute("ALTER TABLE library_grants ENABLE TRIGGER library_grants_append_only")
    with op.batch_alter_table("game_tables") as tables:
        tables.drop_column("allow_stand_in")
