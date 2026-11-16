"""Who may watch a table's game (v1.0.0, docs/tables.md): the rule itself, apart from its routes
(api/spectators.py), so that the tables, the games and the routes all ask the same one without
importing each other.

The owner's decisions (2026-11-16): a table's host lets nobody watch, the friends its players
invited, or anyone (a public table alone); invited spectators watch live, and where anyone may
watch the game is shown a minute behind.
"""

from typing import Literal
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from api import rollout
from api.models import Game, GameTable, PlayerBlock, TableSeat, TableSpectator, User

WORKFLOW = "spectators"
Setting = Literal["nobody", "invited", "anyone"]
# How far behind the game spectators watch where anyone may: the engine's own delay (0 to 300
# seconds), told to it as the game starts and fixed from then on.
OPEN_DELAY_SECONDS = 60


def delay(table: GameTable) -> int:
    """How far behind its game the table's spectators watch, in seconds."""
    return OPEN_DELAY_SECONDS if table.spectators == "anyone" else 0


def seated(db: Session, table: GameTable, user_id: UUID) -> bool:
    return (
        db.scalar(
            select(TableSeat.id).where(TableSeat.table_id == table.id, TableSeat.user_id == user_id)
        )
        is not None
    )


def invited(db: Session, table: GameTable, user_id: UUID) -> bool:
    return (
        db.scalar(
            select(TableSpectator.id).where(
                TableSpectator.table_id == table.id, TableSpectator.user_id == user_id
            )
        )
        is not None
    )


def blocked_by_a_player(db: Session, table: GameTable, user_id: UUID) -> bool:
    """Whether the account and one of the table's players block each other, either way."""
    players = select(TableSeat.user_id).where(TableSeat.table_id == table.id)
    return (
        db.scalar(
            select(PlayerBlock.id).where(
                or_(
                    (PlayerBlock.blocker_id == user_id) & PlayerBlock.blocked_id.in_(players),
                    (PlayerBlock.blocked_id == user_id) & PlayerBlock.blocker_id.in_(players),
                )
            )
        )
        is not None
    )


def allowed(db: Session, table: GameTable, user: User) -> bool:
    """Whether the account may watch the table's game, as its setting stands now: invited, or
    anyone at a public table; never one of its own players, never across a block, and only while
    the workflow is the account's to reach."""
    if table.spectators == "nobody" or not rollout.available(db, WORKFLOW, user):
        return False
    if user.status != "active" or seated(db, table, user.id):
        return False
    if blocked_by_a_player(db, table, user.id):
        return False
    if table.spectators == "anyone" and table.visibility == "public":
        return True
    return invited(db, table, user.id)


def table_of(db: Session, game_id: UUID) -> GameTable | None:
    """The table whose game it is. A best-of-three match's later games are its first game's
    table's: the table keeps the game it started with."""
    table = db.scalar(select(GameTable).where(GameTable.game_id == game_id))
    if table is not None:
        return table
    game = db.get(Game, game_id)
    if game is None or game.match_id is None or game.match_game == 1:
        return None
    first = db.scalar(select(Game.id).where(Game.match_id == game.match_id, Game.match_game == 1))
    if first is None:
        return None
    return db.scalar(select(GameTable).where(GameTable.game_id == first))


def current_game(db: Session, table: GameTable) -> UUID | None:
    """The table's game to watch now: its game, or of a best-of-three match the latest one."""
    if table.game_id is None:
        return None
    match_id = db.scalar(select(Game.match_id).where(Game.id == table.game_id))
    if match_id is None:
        return table.game_id
    latest = db.scalar(
        select(Game.id).where(Game.match_id == match_id).order_by(Game.match_game.desc()).limit(1)
    )
    return latest or table.game_id


def may_watch(db: Session, game_id: UUID, user: User) -> GameTable | None:
    """The table whose game the account may watch, or None. Asked at every reading, so a
    spectator who was removed reads no more."""
    table = table_of(db, game_id)
    if table is None or not allowed(db, table, user):
        return None
    return table
