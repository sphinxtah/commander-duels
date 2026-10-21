"""The Planeswalker Alliance (v0.3.1): the progression ledger, players' card libraries, the
alliance and the starter decks chosen on each account, and the custom cards SysOp uploads.

Existing data is carried over:
- every game already won counts, from the result each finished game recorded;
- SysOp starts at 100,000 wins, entered as a setting, apart from counted wins;
- each player's saved decks put their cards in the player's library (the most copies any one deck
  holds), so no deck built before libraries existed stops working;
- every player who finished onboarding is asked to choose two starter decks.
"""

import json
from collections import defaultdict
from datetime import UTC, datetime
from uuid import UUID, uuid4

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0007_alliance"
down_revision = "0006_decks"
branch_labels = None
depends_on = None

TIMESTAMP = sa.DateTime(timezone=True)
JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
SYSOP_START = 100_000
APPEND_ONLY = ("progress_ledger", "library_grants")


def loaded(value: object) -> object:
    """A JSON column as read by plain SQL: parsed already on PostgreSQL, text on SQLite."""
    return json.loads(value) if isinstance(value, str) else value


def upgrade() -> None:
    with op.batch_alter_table("users") as users:
        users.add_column(sa.Column("alliance", sa.String(48)))
        users.add_column(sa.Column("alliance_since", TIMESTAMP))
        users.add_column(sa.Column("starter_decks", JSON))
        users.drop_constraint("ck_users_onboarding", type_="check")
        users.create_check_constraint(
            "ck_users_onboarding", "onboarding IN ('handle', 'starters', 'complete')"
        )

    op.create_table(
        "progress_ledger",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("wins", sa.BigInteger(), nullable=False),
        sa.Column("key", sa.String(96), nullable=False, unique=True),
        sa.Column("game_id", sa.Uuid(), sa.ForeignKey("games.id")),
        sa.Column("policy", sa.String(32), nullable=False),
        sa.Column("reason", sa.Text()),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.CheckConstraint("kind IN ('game_win', 'wins_set')", name="ck_progress_ledger_kind"),
        sa.CheckConstraint(
            "(kind = 'game_win') = (game_id IS NOT NULL)", name="ck_progress_ledger_game"
        ),
    )
    op.create_index("ix_progress_ledger_user_id", "progress_ledger", ["user_id"])

    op.create_table(
        "library_grants",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("concept_id", sa.Uuid(), sa.ForeignKey("card_concepts.id"), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("grant_key", sa.String(96), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.UniqueConstraint("user_id", "grant_key", "concept_id"),
        sa.CheckConstraint("quantity > 0", name="ck_library_grants_quantity"),
        sa.CheckConstraint(
            "source IN ('starter', 'grandfathered')", name="ck_library_grants_source"
        ),
    )
    op.create_index("ix_library_grants_user_id", "library_grants", ["user_id"])

    op.create_table(
        "custom_cards",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(160), nullable=False, unique=True),
        sa.Column("planeswalker", sa.String(48), nullable=False),
        sa.Column("mana_cost", sa.String(64)),
        sa.Column("type_line", sa.String(160), nullable=False),
        sa.Column("oracle_text", sa.Text(), nullable=False),
        sa.Column("flavor_text", sa.Text()),
        sa.Column("power", sa.String(8)),
        sa.Column("toughness", sa.String(8)),
        sa.Column("loyalty", sa.String(8)),
        sa.Column("rarity", sa.String(16), nullable=False),
        sa.Column("set_code", sa.String(16)),
        sa.Column("collector_number", sa.String(16)),
        sa.Column("artist", sa.String(128)),
        sa.Column("image", sa.LargeBinary(), nullable=False),
        sa.Column("image_type", sa.String(32), nullable=False),
        sa.Column("image_sha256", sa.String(64), nullable=False),
        sa.Column("uploaded_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
    )

    if op.get_bind().dialect.name == "postgresql":
        # The ledger and the grants are append-only: what was counted or given stays recorded.
        op.execute(
            """
            CREATE FUNCTION progression_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
            END $$;
            """
        )
        for table in APPEND_ONLY:
            op.execute(
                f"CREATE TRIGGER {table}_append_only BEFORE UPDATE OR DELETE ON {table} "
                "FOR EACH ROW EXECUTE FUNCTION progression_append_only()"
            )

    carry_over()


def carry_over() -> None:
    bind = op.get_bind()
    now = datetime.now(UTC)
    ledger = sa.table(
        "progress_ledger",
        sa.column("id", sa.Uuid()),
        sa.column("user_id", sa.Uuid()),
        sa.column("kind", sa.String()),
        sa.column("wins", sa.BigInteger()),
        sa.column("key", sa.String()),
        sa.column("game_id", sa.Uuid()),
        sa.column("policy", sa.String()),
        sa.column("reason", sa.Text()),
        sa.column("created_at", TIMESTAMP),
    )
    grants = sa.table(
        "library_grants",
        sa.column("id", sa.Uuid()),
        sa.column("user_id", sa.Uuid()),
        sa.column("concept_id", sa.Uuid()),
        sa.column("quantity", sa.Integer()),
        sa.column("source", sa.String()),
        sa.column("grant_key", sa.String()),
        sa.column("created_at", TIMESTAMP),
    )
    games = sa.table(
        "games",
        sa.column("id", sa.Uuid()),
        sa.column("status", sa.String()),
        sa.column("result", JSON),
    )
    seats = sa.table(
        "game_seats",
        sa.column("game_id", sa.Uuid()),
        sa.column("seat", sa.Integer()),
        sa.column("user_id", sa.Uuid()),
    )
    users = sa.table(
        "users",
        sa.column("id", sa.Uuid()),
        sa.column("kind", sa.String()),
        sa.column("onboarding", sa.String()),
    )
    decks = sa.table(
        "decks",
        sa.column("owner_id", sa.Uuid()),
        sa.column("draft", JSON),
    )
    concepts = sa.table("card_concepts", sa.column("id", sa.Uuid()))

    # Games won before v0.3.1: a completed result whose winning seat was a player's.
    owners = {
        (game_id, seat): user_id
        for game_id, seat, user_id in bind.execute(
            sa.select(seats.c.game_id, seats.c.seat, seats.c.user_id).where(
                seats.c.user_id.is_not(None)
            )
        )
    }
    wins = []
    for game_id, result in bind.execute(
        sa.select(games.c.id, games.c.result).where(games.c.status == "finished")
    ):
        found = loaded(result)
        if not isinstance(found, dict) or found.get("kind") != "completed":
            continue
        seat = found.get("winner_seat")
        user_id = owners.get((game_id, seat)) if isinstance(seat, int) else None
        if user_id is not None:
            wins.append(
                {
                    "id": uuid4(),
                    "user_id": user_id,
                    "kind": "game_win",
                    "wins": 1,
                    "key": f"win:{game_id}:{seat}",
                    "game_id": game_id,
                    "policy": "wins-v1",
                    "reason": "Won before v0.3.1",
                    "created_at": now,
                }
            )
    sysop = bind.scalar(sa.select(users.c.id).where(users.c.kind == "sysop"))
    if sysop is not None:
        wins.append(
            {
                "id": uuid4(),
                "user_id": sysop,
                "kind": "wins_set",
                "wins": SYSOP_START,
                "key": "set:sysop-start",
                "game_id": None,
                "policy": "wins-v1",
                "reason": "SysOp starts at 100,000 wins",
                "created_at": now,
            }
        )
    if wins:
        bind.execute(ledger.insert(), wins)

    # Players' saved decks put their cards in their libraries: per card, the most copies any one
    # deck holds outside its maybeboard.
    players: set[UUID] = set(bind.scalars(sa.select(users.c.id).where(users.c.kind == "player")))
    known: set[UUID] = set(bind.scalars(sa.select(concepts.c.id)))
    most: dict[UUID, dict[UUID, int]] = defaultdict(dict)
    for row in bind.execute(sa.select(decks.c.owner_id, decks.c.draft)):
        owner_id: UUID = row.owner_id
        draft = row.draft
        if owner_id not in players:
            continue
        counted: dict[UUID, int] = defaultdict(int)
        content = loaded(draft)
        entries = content.get("entries", []) if isinstance(content, dict) else []
        for entry in entries:
            if not isinstance(entry, dict) or entry.get("location") == "maybeboard":
                continue
            try:
                concept = UUID(str(entry["card_id"]))
                quantity = int(entry["quantity"])
            except (KeyError, ValueError, TypeError):
                continue
            if concept in known and quantity > 0:
                counted[concept] += quantity
        for card_id, copies in counted.items():
            most[owner_id][card_id] = max(most[owner_id].get(card_id, 0), copies)
    rows = [
        {
            "id": uuid4(),
            "user_id": owner_id,
            "concept_id": concept,
            "quantity": quantity,
            "source": "grandfathered",
            "grant_key": "grandfathered:0.3.1",
            "created_at": now,
        }
        for owner_id, cards in most.items()
        for concept, quantity in cards.items()
    ]
    for start in range(0, len(rows), 1000):
        bind.execute(grants.insert(), rows[start : start + 1000])

    # Players who finished onboarding choose their two starter decks next.
    bind.execute(
        users.update()
        .where(users.c.kind == "player", users.c.onboarding == "complete")
        .values(onboarding="starters")
    )


def downgrade() -> None:
    users = sa.table("users", sa.column("onboarding", sa.String()))
    op.get_bind().execute(
        users.update().where(users.c.onboarding == "starters").values(onboarding="complete")
    )
    if op.get_bind().dialect.name == "postgresql":
        for table in APPEND_ONLY:
            op.execute(f"DROP TRIGGER {table}_append_only ON {table}")
        op.execute("DROP FUNCTION progression_append_only()")
    op.drop_table("custom_cards")
    op.drop_index("ix_library_grants_user_id", "library_grants")
    op.drop_table("library_grants")
    op.drop_index("ix_progress_ledger_user_id", "progress_ledger")
    op.drop_table("progress_ledger")
    with op.batch_alter_table("users") as users_table:
        users_table.drop_constraint("ck_users_onboarding", type_="check")
        users_table.create_check_constraint(
            "ck_users_onboarding", "onboarding IN ('handle', 'complete')"
        )
        for column in ("starter_decks", "alliance_since", "alliance"):
            users_table.drop_column(column)
