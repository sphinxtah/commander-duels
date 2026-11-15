"""How a table fit what it described (v1.0.0, the specification's section 18; docs/tables.md).

A table's Rule Zero profile (api/table_profiles.py) describes the game it is for, and nothing
checks a description. After a table's game each of its players may say, in one answer, whether
the game was **as described**, **stronger** or **weaker** than that. It is optional, asked once
on the game's result, and may be changed while the game is remembered.

**Who sees it** (the owner's decision 25, 2026-11-15): nobody but the site's numbers. The
answers are tallied by the kind of game the profile named, for SysOp and administrators
(api/operations.py); no route shows an answer to another player or to the table's host, and
nothing rates a player, a host or a deck. A player reads back their own.

Asked only where it means something: a finished game of a table that kept a profile, of a
player who sat in it. It has no gate: table profiles are in the game for everyone.
"""

from typing import Literal, get_args
from uuid import UUID

from fastapi import APIRouter
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api import table_profiles
from api.auth import INPUT_ERRORS
from api.identity import Active, ApiError, Db, Principal, not_found, utcnow
from api.models import Game, GameSeat, TableFit
from api.schemas import Contract, Error

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

Fit = Literal["as_described", "stronger", "weaker"]
FITS: tuple[str, ...] = get_args(Fit)


class TableFitView(Contract):
    """What the result's screen needs to ask, and the caller's own answer."""

    asked: bool = Field(
        description="Whether the question applies: a finished game of a table that kept a Rule "
        "Zero profile, and the caller played in it."
    )
    intent_name: str | None = Field(
        description="The kind of game the table said it was for, in words; null when not asked."
    )
    fit: Fit | None = Field(description="The caller's own answer, if they gave one.")


class TableFitAnswer(Contract):
    fit: Fit


class FitCount(Contract):
    """The answers for one kind of game, in the site's numbers."""

    intent: str
    as_described: int = 0
    stronger: int = 0
    weaker: int = 0


def intent_of(game: Game) -> str | None:
    """The kind of game the table's profile named, when the game is one the question is for."""
    if game.kind != "table" or game.status != "finished":
        return None
    profile = table_profiles.read(game.table_profile)
    return profile.intent if profile is not None else None


def played(db: Session, principal: Principal, game_id: UUID) -> Game:
    """The game, for one who sat in it; anyone else is told of no such game."""
    game = db.get(Game, game_id)
    seated = game is not None and db.scalar(
        select(GameSeat.id).where(
            GameSeat.game_id == game_id, GameSeat.user_id == principal.user.id
        )
    )
    if game is None or not seated:
        raise not_found()
    return game


def view_of(db: Session, principal: Principal, game: Game) -> TableFitView:
    intent = intent_of(game)
    if intent is None:
        return TableFitView(asked=False, intent_name=None, fit=None)
    answer = db.scalar(
        select(TableFit.fit).where(
            TableFit.game_id == game.id, TableFit.user_id == principal.user.id
        )
    )
    return TableFitView(
        asked=True,
        intent_name=table_profiles.INTENT_NAMES.get(intent),
        fit=answer,  # type: ignore[arg-type]
    )


@router.get("/games/{game_id}/table-fit", response_model=TableFitView)
def read_fit(game_id: UUID, principal: Active, db: Db) -> TableFitView:
    """Whether the game's result asks how the table fit, and the caller's own answer."""
    return view_of(db, principal, played(db, principal, game_id))


@router.put(
    "/games/{game_id}/table-fit", response_model=TableFitView, responses={409: {"model": Error}}
)
def answer_fit(game_id: UUID, body: TableFitAnswer, principal: Active, db: Db) -> TableFitView:
    """The caller's answer to how the table fit what it described; answering again changes it.
    Counted in the site's numbers and shown to nobody else."""
    game = played(db, principal, game_id)
    intent = intent_of(game)
    if intent is None:
        raise ApiError(
            409,
            "no_table_fit",
            "Only a finished game of a table that described itself asks how it fit.",
        )
    row = db.scalar(
        select(TableFit).where(TableFit.game_id == game.id, TableFit.user_id == principal.user.id)
    )
    if row is None:
        row = TableFit(
            game_id=game.id, user_id=principal.user.id, intent=intent, created_at=utcnow()
        )
        db.add(row)
    row.fit = body.fit
    db.commit()
    return view_of(db, principal, game)


def tally(db: Session) -> list[FitCount]:
    """The answers by the kind of game, for the site's numbers: counts, and no account."""
    found: dict[str, FitCount] = {}
    for intent, fit, count in db.execute(
        select(TableFit.intent, TableFit.fit, func.count()).group_by(TableFit.intent, TableFit.fit)
    ):
        entry = found.setdefault(intent, FitCount(intent=intent))
        if fit in FITS:
            setattr(entry, fit, int(count))
    return [found[intent] for intent in table_profiles.INTENTS if intent in found]
