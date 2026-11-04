"""King's Table (v0.8.7, api/kings_table.py): six seats in two teams of three, at human tables and
the practice table.

- games: a game's format may be kings_table, and kings_table keeps the settings it started with
  ({deck_format, life, king_attacks_anyone}), which its summary shows. Null for every game already
  there.
- game_tables: a table's format may be kings_table, seating six with at least one player (other
  tables keep two to four with at least two players), and kings_table keeps the host's settings.
  Its bots sit in the seats bot_seats names, as at a Two-Headed Giant table.

The public queues do not play it, so queue_entries keeps its formats. Expand only: the previous
version reads no game or table of a format it does not know, and ignores the new columns.

Downgrade deletes every King's Table table and the seats taken at it, ends the rematches of their
games (a lapsed rematch for each finished one without any, so none is offered by a version that
cannot start it), turns every King's Table game into a game of its decks' format with no practice
request to replay, and drops the columns.
"""

import json
import uuid

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0036_kings_table"
down_revision = "0035_passive_bots"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
FORMATS_BEFORE = "format IN ('legacy', 'commander', 'two_headed_giant')"
FORMATS = "format IN ('legacy', 'commander', 'two_headed_giant', 'kings_table')"
SEATS_BEFORE = "seats BETWEEN 2 AND 4 AND bots >= 0 AND seats - bots >= 2"
SEATS = (
    "bots >= 0 AND ((format = 'kings_table' AND seats = 6 AND seats - bots >= 1) OR "
    "(format <> 'kings_table' AND seats BETWEEN 2 AND 4 AND seats - bots >= 2))"
)


def upgrade() -> None:
    with op.batch_alter_table("games") as games:
        games.add_column(sa.Column("kings_table", JSON))
        games.drop_constraint("ck_games_format", type_="check")
        games.create_check_constraint("ck_games_format", FORMATS)
    with op.batch_alter_table("game_tables") as tables:
        tables.add_column(sa.Column("kings_table", JSON))
        tables.drop_constraint("ck_game_tables_format", type_="check")
        tables.create_check_constraint("ck_game_tables_format", FORMATS)
        tables.drop_constraint("ck_game_tables_seats", type_="check")
        tables.create_check_constraint("ck_game_tables_seats", SEATS)


def deck_format(raw: object) -> str:
    """A King's Table game's decks' format, from its settings as stored (text on SQLite)."""
    found = json.loads(raw) if isinstance(raw, str) else raw
    chosen = found.get("deck_format") if isinstance(found, dict) else None
    return chosen if chosen in ("legacy", "commander") else "commander"


def downgrade() -> None:
    connection = op.get_bind()
    found_tables = "SELECT id FROM game_tables WHERE format = 'kings_table'"
    op.execute(f"DELETE FROM table_seats WHERE table_id IN ({found_tables})")
    op.execute("DELETE FROM game_tables WHERE format = 'kings_table'")
    found = connection.execute(
        sa.text(
            "SELECT id, kind, status, created_by, kings_table FROM games "
            "WHERE format = 'kings_table'"
        )
    ).all()
    for game_id, kind, status, created_by, settings in found:
        connection.execute(
            sa.text(
                "UPDATE rematches SET status = 'lapsed', ended_at = CURRENT_TIMESTAMP "
                "WHERE game_id = :game AND status IN ('open', 'starting')"
            ),
            {"game": game_id},
        )
        offered = connection.execute(
            sa.text("SELECT id FROM rematches WHERE game_id = :game"), {"game": game_id}
        ).first()
        if offered is None and kind == "table" and status != "active":
            connection.execute(
                sa.text(
                    "INSERT INTO rematches (id, game_id, proposed_by, status, created_at, "
                    "expires_at, ended_at) VALUES (:id, :game, :user, 'lapsed', "
                    "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                ).bindparams(sa.bindparam("id", type_=sa.Uuid())),
                {"id": uuid.uuid4(), "game": game_id, "user": created_by},
            )
        connection.execute(
            sa.text("UPDATE games SET format = :format, settings = NULL WHERE id = :game"),
            {"format": deck_format(settings), "game": game_id},
        )
    with op.batch_alter_table("game_tables") as tables:
        tables.drop_constraint("ck_game_tables_seats", type_="check")
        tables.create_check_constraint("ck_game_tables_seats", SEATS_BEFORE)
        tables.drop_constraint("ck_game_tables_format", type_="check")
        tables.create_check_constraint("ck_game_tables_format", FORMATS_BEFORE)
        tables.drop_column("kings_table")
    with op.batch_alter_table("games") as games:
        games.drop_constraint("ck_games_format", type_="check")
        games.create_check_constraint("ck_games_format", FORMATS_BEFORE)
        games.drop_column("kings_table")
