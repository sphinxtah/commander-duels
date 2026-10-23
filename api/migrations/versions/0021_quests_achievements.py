"""Statistics, daily quests and achievements (v0.5.0): the players' results, the day's quests, the
achievements earned, and the new kinds of the economy ledger and of the bell.

- player_results holds one row per human seat of a game that ended, append-only on PostgreSQL as
  the ledgers are. Every game that ended before v0.5.0 is entered from the result the API recorded
  and the deck the seat played, judged by the rule api/stats.py follows (results-v1), so the
  profiles' totals and histories and the achievements count them. A deck's custom cards, which no
  catalog card stands for, add no colour here.
- daily_quests and player_achievements start empty. A player's history earns its achievements at
  its first check (api/achievements.py), which pays through the ledger then: the migration pays
  nothing.
- token_ledger takes the kinds quest and achievement; notifications take quest_completed and
  achievement_earned, with the subject they name.

Downgrade drops the three tables. The tokens quests and achievements paid stay in the balances,
as grants (the previous version knows no other kind for them); their notifications go.
"""

import json
from collections import defaultdict
from datetime import datetime
from uuid import UUID, uuid4

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0021_quests_achievements"
down_revision = "0020_account_reset"
branch_labels = None
depends_on = None

TIMESTAMP = sa.DateTime(timezone=True)
JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
POLICY = "results-v1"
LOST_BY_LEAVING = ("conceded", "removed", "eliminated")
FIXTURE_COLORS = {"white": "W", "blue": "U", "black": "B", "red": "R", "green": "G"}
COLORS = ("W", "U", "B", "R", "G")
TOKENS_BEFORE = "kind IN ('bot_win', 'human_win', 'back_pay', 'welcome', 'grant', 'pack')"
TOKENS = (
    "kind IN ('bot_win', 'human_win', 'back_pay', 'welcome', 'grant', 'pack', 'quest', "
    "'achievement')"
)
NOTICES_BEFORE = "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message')"
NOTICES = (
    "kind IN ('friend_request', 'friend_accepted', 'friend_online', 'message', "
    "'quest_completed', 'achievement_earned')"
)


def loaded(value: object) -> object:
    """A JSON column as read by plain SQL: parsed already on PostgreSQL, text on SQLite."""
    return json.loads(value) if isinstance(value, str) else value


def upgrade() -> None:
    op.create_table(
        "player_results",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("game_id", sa.Uuid(), sa.ForeignKey("games.id"), nullable=False),
        sa.Column("seat", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("outcome", sa.String(16), nullable=False),
        sa.Column("format", sa.String(32), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("seats", sa.SmallInteger(), nullable=False),
        sa.Column("players", sa.SmallInteger(), nullable=False),
        sa.Column("bots", sa.SmallInteger(), nullable=False),
        sa.Column("bot_skill", sa.SmallInteger()),
        sa.Column("colors", sa.String(8), nullable=False),
        sa.Column("turns", sa.Integer()),
        sa.Column("started_at", TIMESTAMP, nullable=False),
        sa.Column("finished_at", TIMESTAMP, nullable=False),
        sa.Column("policy", sa.String(32), nullable=False),
        sa.UniqueConstraint("game_id", "seat"),
        sa.CheckConstraint(
            "outcome IN ('win', 'loss', 'draw', 'no_result')", name="ck_player_results_outcome"
        ),
    )
    op.create_index(
        "ix_player_results_user_id_finished_at", "player_results", ["user_id", "finished_at"]
    )
    op.create_table(
        "daily_quests",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("slot", sa.SmallInteger(), nullable=False),
        sa.Column("key", sa.String(128), nullable=False, unique=True),
        sa.Column("quest", sa.String(48), nullable=False),
        sa.Column("tokens", sa.Integer(), nullable=False),
        sa.Column("target", sa.SmallInteger(), nullable=False),
        sa.Column("counts_from", TIMESTAMP, nullable=False),
        sa.Column("swapped_at", TIMESTAMP),
        sa.Column("completed_at", TIMESTAMP),
        sa.Column("policy", sa.String(32), nullable=False),
        sa.Column("created_at", TIMESTAMP, nullable=False),
        sa.CheckConstraint("slot BETWEEN 0 AND 2", name="ck_daily_quests_slot"),
    )
    op.create_index("ix_daily_quests_user_id_day", "daily_quests", ["user_id", "day"])
    op.create_table(
        "player_achievements",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("achievement", sa.String(48), nullable=False),
        sa.Column("version", sa.SmallInteger(), nullable=False),
        sa.Column("key", sa.String(128), nullable=False, unique=True),
        sa.Column("tokens", sa.Integer(), nullable=False),
        sa.Column("pin", sa.SmallInteger()),
        sa.Column("earned_at", TIMESTAMP, nullable=False),
        sa.CheckConstraint("pin IS NULL OR pin BETWEEN 1 AND 3", name="ck_player_achievements_pin"),
    )
    op.create_index("ix_player_achievements_user_id", "player_achievements", ["user_id"])

    with op.batch_alter_table("token_ledger") as ledger:
        ledger.drop_constraint("ck_token_ledger_kind", type_="check")
        ledger.create_check_constraint("ck_token_ledger_kind", TOKENS)
    with op.batch_alter_table("notifications") as notifications:
        notifications.add_column(sa.Column("subject", sa.String(48)))
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", NOTICES)

    if op.get_bind().dialect.name == "postgresql":
        # A result once recorded stays as it was; progression_append_only is 0007's.
        op.execute(
            "CREATE TRIGGER player_results_append_only BEFORE UPDATE OR DELETE ON player_results "
            "FOR EACH ROW EXECUTE FUNCTION progression_append_only()"
        )

    carry_over()


def outcome_of(result: object, seat: int, left: str | None) -> str:
    """api/stats.py's outcome_of under results-v1, for a game recorded before v0.5.0."""
    found = result if isinstance(result, dict) else {}
    winner = found.get("winner_seat")
    kind = found.get("kind")
    if kind == "completed" and isinstance(winner, int):
        return "win" if winner == seat else "loss"
    conceded = found.get("conceded_seats")
    if (
        kind == "humans_eliminated"
        or left in LOST_BY_LEAVING
        or (isinstance(conceded, list) and seat in conceded)
    ):
        return "loss"
    if found.get("draw") is True:
        return "draw"
    return "no_result"


def carry_over() -> None:
    bind = op.get_bind()
    games = sa.table(
        "games",
        sa.column("id", sa.Uuid()),
        sa.column("kind", sa.String()),
        sa.column("format", sa.String()),
        sa.column("status", sa.String()),
        sa.column("created_at", TIMESTAMP),
        sa.column("finished_at", TIMESTAMP),
        sa.column("bot_skill", sa.Integer()),
        sa.column("result", JSON),
    )
    seats = sa.table(
        "game_seats",
        sa.column("game_id", sa.Uuid()),
        sa.column("seat", sa.Integer()),
        sa.column("player", sa.String()),
        sa.column("user_id", sa.Uuid()),
        sa.column("deck", sa.String()),
        sa.column("deck_revision_id", sa.Uuid()),
        sa.column("left_reason", sa.String()),
    )
    entries = sa.table(
        "deck_entries",
        sa.column("revision_id", sa.Uuid()),
        sa.column("concept_id", sa.Uuid()),
        sa.column("location", sa.String()),
    )
    concepts = sa.table(
        "card_concepts",
        sa.column("id", sa.Uuid()),
        sa.column("identity_mask", sa.Integer()),
        sa.column("colors_mask", sa.Integer()),
    )
    results = sa.table(
        "player_results",
        sa.column("id", sa.Uuid()),
        sa.column("game_id", sa.Uuid()),
        sa.column("seat", sa.Integer()),
        sa.column("user_id", sa.Uuid()),
        sa.column("outcome", sa.String()),
        sa.column("format", sa.String()),
        sa.column("kind", sa.String()),
        sa.column("seats", sa.SmallInteger()),
        sa.column("players", sa.SmallInteger()),
        sa.column("bots", sa.SmallInteger()),
        sa.column("bot_skill", sa.SmallInteger()),
        sa.column("colors", sa.String()),
        sa.column("turns", sa.Integer()),
        sa.column("started_at", TIMESTAMP),
        sa.column("finished_at", TIMESTAMP),
        sa.column("policy", sa.String()),
    )
    # Each played revision's colours, as the deck builder counts them: a Commander deck's
    # commanders' color identity, a Legacy deck's cards' colors.
    masks: dict[tuple[UUID, str], int] = defaultdict(int)
    for row in bind.execute(
        sa.select(
            entries.c.revision_id,
            entries.c.location,
            concepts.c.identity_mask,
            concepts.c.colors_mask,
        )
        .join(concepts, concepts.c.id == entries.c.concept_id)
        .where(entries.c.revision_id.in_(sa.select(seats.c.deck_revision_id)))
    ):
        if row.location == "commander":
            masks[(row.revision_id, "commander")] |= row.identity_mask or 0
        elif row.location == "main":
            masks[(row.revision_id, "main")] |= row.colors_mask or 0
    table: dict[UUID, list[tuple[int, str, UUID | None, str, UUID | None, str | None]]] = (
        defaultdict(list)
    )
    for row in bind.execute(
        sa.select(
            seats.c.game_id,
            seats.c.seat,
            seats.c.player,
            seats.c.user_id,
            seats.c.deck,
            seats.c.deck_revision_id,
            seats.c.left_reason,
        )
    ):
        table[row.game_id].append(
            (row.seat, row.player, row.user_id, row.deck, row.deck_revision_id, row.left_reason)
        )

    def colors(fmt: str, deck: str, revision_id: UUID | None) -> str:
        if revision_id is not None:
            bits = masks[(revision_id, "commander" if fmt == "commander" else "main")]
            return "".join(color for index, color in enumerate(COLORS) if bits & (1 << index))
        return next(
            (letter for word, letter in FIXTURE_COLORS.items() if f"-mono-{word}-" in deck), ""
        )

    rows: list[dict[str, object]] = []
    for game in bind.execute(
        sa.select(
            games.c.id,
            games.c.kind,
            games.c.format,
            games.c.created_at,
            games.c.finished_at,
            games.c.bot_skill,
            games.c.result,
        ).where(games.c.status.in_(("finished", "interrupted")))
    ):
        found = loaded(game.result)
        turns = found.get("turns") if isinstance(found, dict) else None
        everyone = table[game.id]
        bots = sum(1 for _, player, *_ in everyone if player == "bot")
        finished: datetime = game.finished_at or game.created_at
        for seat, _, user_id, deck, revision_id, left in everyone:
            if user_id is None:
                continue
            rows.append(
                {
                    "id": uuid4(),
                    "game_id": game.id,
                    "seat": seat,
                    "user_id": user_id,
                    "outcome": outcome_of(found, seat, left),
                    "format": game.format,
                    "kind": game.kind,
                    "seats": len(everyone),
                    "players": sum(1 for other in everyone if other[2] is not None) - 1,
                    "bots": bots,
                    "bot_skill": game.bot_skill if bots else None,
                    "colors": colors(game.format, deck, revision_id),
                    "turns": turns if isinstance(turns, int) else None,
                    "started_at": game.created_at,
                    "finished_at": finished,
                    "policy": POLICY,
                }
            )
    for start in range(0, len(rows), 1000):
        bind.execute(results.insert(), rows[start : start + 1000])


def downgrade() -> None:
    postgres = op.get_bind().dialect.name == "postgresql"
    if postgres:
        op.execute("DROP TRIGGER player_results_append_only ON player_results")
        op.execute("ALTER TABLE token_ledger DISABLE TRIGGER token_ledger_append_only")
    # What quests and achievements paid stays in the balances.
    op.execute("UPDATE token_ledger SET kind = 'grant' WHERE kind IN ('quest', 'achievement')")
    if postgres:
        op.execute("ALTER TABLE token_ledger ENABLE TRIGGER token_ledger_append_only")
    op.execute("DELETE FROM notifications WHERE kind IN ('quest_completed', 'achievement_earned')")
    with op.batch_alter_table("notifications") as notifications:
        notifications.drop_constraint("ck_notifications_kind", type_="check")
        notifications.create_check_constraint("ck_notifications_kind", NOTICES_BEFORE)
        notifications.drop_column("subject")
    with op.batch_alter_table("token_ledger") as ledger:
        ledger.drop_constraint("ck_token_ledger_kind", type_="check")
        ledger.create_check_constraint("ck_token_ledger_kind", TOKENS_BEFORE)
    op.drop_index("ix_player_achievements_user_id", table_name="player_achievements")
    op.drop_table("player_achievements")
    op.drop_index("ix_daily_quests_user_id_day", table_name="daily_quests")
    op.drop_table("daily_quests")
    op.drop_index("ix_player_results_user_id_finished_at", table_name="player_results")
    op.drop_table("player_results")
