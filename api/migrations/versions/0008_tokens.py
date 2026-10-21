"""Tokens (v0.4.0): the economy ledger, the site's settings, and pulled cards in the library.

Existing data is carried over:
- every account gets the welcome grant of 1,000 tokens;
- every game already won is paid, as v0.4.0 pays wins: each bot the winner defeated pays by the
  game's bot skill. No earlier game had a second human, so none pays for a human.
Back pay uses the same keys as pay at the end of a game, so nothing is ever paid twice.
"""

import json
from collections import defaultdict
from datetime import UTC, datetime
from uuid import UUID, uuid4

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0008_tokens"
down_revision = "0007_alliance"
branch_labels = None
depends_on = None

TIMESTAMP = sa.DateTime(timezone=True)
JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
POLICY = "tokens-v1"
WELCOME = 1_000
BOT_TOKENS = {1: 5, 2: 8, 3: 11, 4: 14, 5: 17, 6: 20}
KINDS = "('bot_win', 'human_win', 'back_pay', 'welcome', 'grant', 'pack')"


def loaded(value: object) -> object:
    """A JSON column as read by plain SQL: parsed already on PostgreSQL, text on SQLite."""
    return json.loads(value) if isinstance(value, str) else value


def upgrade() -> None:
    op.create_table(
        "token_ledger",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("key", sa.String(128), nullable=False, unique=True),
        sa.Column("game_id", sa.Uuid(), sa.ForeignKey("games.id")),
        sa.Column("opponent_seat", sa.SmallInteger()),
        sa.Column("opponent_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("policy", sa.String(32), nullable=False),
        sa.Column("reason", sa.Text()),
        sa.Column("actor_id", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.CheckConstraint(f"kind IN {KINDS}", name="ck_token_ledger_kind"),
        sa.CheckConstraint(
            "(kind IN ('bot_win', 'human_win', 'back_pay')) = (game_id IS NOT NULL)",
            name="ck_token_ledger_game",
        ),
        sa.CheckConstraint(
            "kind IN ('grant', 'pack') OR amount >= 0", name="ck_token_ledger_earned"
        ),
        sa.CheckConstraint("kind != 'pack' OR amount <= 0", name="ck_token_ledger_spent"),
    )
    op.create_index("ix_token_ledger_user_id", "token_ledger", ["user_id"])
    op.create_index("ix_token_ledger_game_id", "token_ledger", ["game_id"])

    op.create_table(
        "site_settings",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("value", JSON),
        sa.Column("updated_by", sa.Uuid(), sa.ForeignKey("users.id")),
        sa.Column("updated_at", TIMESTAMP, nullable=False),
    )

    with op.batch_alter_table("library_grants") as grants:
        grants.drop_constraint("ck_library_grants_source", type_="check")
        grants.create_check_constraint(
            "ck_library_grants_source", "source IN ('starter', 'grandfathered', 'pack')"
        )

    if op.get_bind().dialect.name == "postgresql":
        # Tokens once paid or spent stay recorded (PROG03); progression_append_only is 0007's.
        op.execute(
            "CREATE TRIGGER token_ledger_append_only BEFORE UPDATE OR DELETE ON token_ledger "
            "FOR EACH ROW EXECUTE FUNCTION progression_append_only()"
        )

    carry_over()


def carry_over() -> None:
    bind = op.get_bind()
    now = datetime.now(UTC)
    ledger = sa.table(
        "token_ledger",
        sa.column("id", sa.Uuid()),
        sa.column("user_id", sa.Uuid()),
        sa.column("kind", sa.String()),
        sa.column("amount", sa.BigInteger()),
        sa.column("key", sa.String()),
        sa.column("game_id", sa.Uuid()),
        sa.column("opponent_seat", sa.SmallInteger()),
        sa.column("policy", sa.String()),
        sa.column("reason", sa.Text()),
        sa.column("created_at", TIMESTAMP),
    )
    users = sa.table("users", sa.column("id", sa.Uuid()))
    games = sa.table(
        "games",
        sa.column("id", sa.Uuid()),
        sa.column("status", sa.String()),
        sa.column("bot_skill", sa.Integer()),
        sa.column("result", JSON),
    )
    seats = sa.table(
        "game_seats",
        sa.column("game_id", sa.Uuid()),
        sa.column("seat", sa.Integer()),
        sa.column("player", sa.String()),
        sa.column("user_id", sa.Uuid()),
    )

    def entry(user_id: UUID, kind: str, amount: int, key: str, reason: str) -> dict[str, object]:
        return {
            "id": uuid4(),
            "user_id": user_id,
            "kind": kind,
            "amount": amount,
            "key": key,
            "game_id": None,
            "opponent_seat": None,
            "policy": POLICY,
            "reason": reason,
            "created_at": now,
        }

    accounts: list[UUID] = list(bind.scalars(sa.select(users.c.id)))
    rows = [
        entry(user_id, "welcome", WELCOME, f"welcome:{user_id}", "Welcome to Leng's card shop")
        for user_id in accounts
    ]
    # Games won before v0.4.0: each bot the winning player's seat defeated pays by the skill.
    table: dict[UUID, list[tuple[int, str, UUID | None]]] = defaultdict(list)
    for row in bind.execute(
        sa.select(seats.c.game_id, seats.c.seat, seats.c.player, seats.c.user_id)
    ):
        table[row.game_id].append((row.seat, row.player, row.user_id))
    for row in bind.execute(
        sa.select(games.c.id, games.c.bot_skill, games.c.result).where(games.c.status == "finished")
    ):
        game_id: UUID = row.id
        skill: int = row.bot_skill
        found = loaded(row.result)
        if not isinstance(found, dict) or found.get("kind") != "completed":
            continue
        winner = found.get("winner_seat")
        if not isinstance(winner, int):
            continue
        owner = next((user for seat, _, user in table[game_id] if seat == winner), None)
        if owner is None:
            continue
        for seat, player, _ in table[game_id]:
            if seat != winner and player == "bot":
                paid = entry(
                    owner,
                    "back_pay",
                    BOT_TOKENS.get(skill, BOT_TOKENS[4]),
                    f"tokens:{game_id}:{winner}:{seat}",
                    f"A skill-{skill} bot beaten before v0.4.0",
                )
                rows.append(paid | {"game_id": game_id, "opponent_seat": seat})
    for start in range(0, len(rows), 1000):
        bind.execute(ledger.insert(), rows[start : start + 1000])


def downgrade() -> None:
    postgres = op.get_bind().dialect.name == "postgresql"
    if postgres:
        op.execute("DROP TRIGGER token_ledger_append_only ON token_ledger")
        op.execute("ALTER TABLE library_grants DISABLE TRIGGER library_grants_append_only")
    # Pulled cards cannot stay behind a check that no longer names packs.
    op.execute("DELETE FROM library_grants WHERE source = 'pack'")
    if postgres:
        op.execute("ALTER TABLE library_grants ENABLE TRIGGER library_grants_append_only")
    with op.batch_alter_table("library_grants") as grants:
        grants.drop_constraint("ck_library_grants_source", type_="check")
        grants.create_check_constraint(
            "ck_library_grants_source", "source IN ('starter', 'grandfathered')"
        )
    op.drop_table("site_settings")
    op.drop_index("ix_token_ledger_game_id", table_name="token_ledger")
    op.drop_index("ix_token_ledger_user_id", table_name="token_ledger")
    op.drop_table("token_ledger")
