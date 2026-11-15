"""Save and resume (v1.0.0, the specification's section 17; docs/games.md, docs/engine/recovery.md).

A game against the bots can be closed into its recording and played on later. It stands on
recording and recovery (v0.9.9): the engine stops the game where it is, as a dead process stops
one by accident, and what a recovery finds is what a resume finds. Nothing here knows more of a
game than its id.

- **Saving** (``POST /games/{id}/save``). The game's own player, alone at it against the bots.
  The engine brings the game's newest state to disk, stops it and keeps its recording until the
  save runs out. The game becomes ``saved``: it runs nowhere, holds no slot, has no end, and is
  nobody's running game, so its player may start another.
- **Resuming** (``POST /saves/{id}/resume``). The engine takes the game up from its recording,
  with new seat tokens, and the API follows it as it follows a game it got back after a restart.
  It counts as its player's running game again, so a game they are playing comes first.
- **Discarding** (``DELETE /saves/{id}``). The recording is removed and the game ends
  interrupted: no result, and nobody loses.

The rules, as the owner set them (2026-11-14):

- A save lasts ``SAVE_DAYS`` (30) days. Then the game ends interrupted, and the engine removes
  its recording.
- An account holds ``SAVE_LIMIT`` (five) saves. A sixth waits for one to be resumed or discarded.
- **A save ends at the next engine upgrade.** A recording is played on only by the engine build
  that made it, and no second engine is kept beside the new one. Each save names its build
  (``game_saves.engine_build``): when the API starts against another, and when a resume is
  refused for it, the save is ended as ``upgrade`` and its player is told so in the list.

**A private table's game is suspended by its players together**, never by one player's word
(the owner's rules, 2026-11-14):

- **The vote** (``POST``/``DELETE /tables/{code}/suspension``). Any player still in the game
  proposes; every player still in it who is present must agree, and one who declines ends the
  proposal. A player away for two minutes or longer does not vote, so a table can pause when
  someone drops. The table is told each change over the game's socket (``suspension``).
- **The save is the host's**: one of the host's five, kept the same 30 days, discarded by the
  host alone (``DELETE /saves/{id}``).
- **Playing on** (``POST``/``DELETE /tables/{code}/suspension/ready``). The table shows as
  ``suspended``; the game is taken up once every player still in it is back at the table and
  ready, each under their limit of running games. Nobody is voted out for missing the restart.
- Only a private table's single game: not a public table's, not a queue's, not a match's.

What is not saved at all: a game of a best-of-three match (the owner's decision: the match would
stand between its games for as long as the save lasts).

Behind the gate ``save_resume`` (api/rollout.py): off until SysOp stages it. Recovery itself is
on for everyone and needs none.
"""

import asyncio
import logging
from contextlib import AsyncExitStack
from datetime import datetime, timedelta
from functools import partial
from typing import Any, Literal
from uuid import UUID

from fastapi import Request, Response
from pydantic import Field
from sqlalchemy import Engine, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api import metrics, rollout
from api.auth import INPUT_ERRORS
from api.games import (
    CREATE_TIMEOUT_SECONDS,
    ENGINE_FULL,
    RETRY_MAX_SECONDS,
    RETRY_SECONDS,
    EngineUnavailable,
    GameHub,
    LiveGame,
    Player,
    active_games_of,
    campaign_or_none,
    full_access,
    hub_of,
    retried,
    revived,
    seat_tokens,
    summary_of,
    unavailable,
    visible_game,
)
from api.identity import ApiError, Db, Principal, not_found, utcnow
from api.models import CampaignGame, Game, GameSave, GameSeat, GameTable, TableSeat, User
from api.schemas import Contract, Error, GameSummary, SuspendedPlayer, SuspendedTable

# api.tables reads this module's views lazily (view_of), so nothing goes round.
from api.tables import Code, TableView, find, under_limits, view_of

log = logging.getLogger(__name__)

SAVE_DAYS = 30
SAVE_LIMIT = 5
# How long a save that ended by itself (it ran out, an upgrade took it, it could not be given
# back) stays in its player's list, so that they learn what became of the game.
ENDED_SHOWN_DAYS = 14
# The engine waits up to five seconds for the game's state to reach the disk, and as long again
# for its thread to end.
SAVE_TIMEOUT_SECONDS = 30.0
# After a restart the engine's build is asked for this long, while saves wait to be checked.
BUILD_CHECK_SECONDS = 600.0

EndedReason = Literal["resumed", "discarded", "expired", "upgrade", "unrecoverable", "account"]
# The ways a save ends without its player's doing: these are shown in the list for a while.
TOLD = ("expired", "upgrade", "unrecoverable")
ENDED_WORDS = {
    "expired": f"This save ran out after {SAVE_DAYS} days.",
    "upgrade": "The game was upgraded since this was saved, and a saved game is played on only "
    "by the version that saved it.",
    "unrecoverable": "The saved game could not be read back.",
}

router = rollout.router("save_resume", prefix="/api/v1", responses=INPUT_ERRORS)


class SavedGame(Contract):
    """A game saved to be played on later."""

    id: UUID
    game: GameSummary
    saved_at: datetime
    expires_at: datetime = Field(
        description="When the save runs out: the game then ends interrupted, with no result."
    )
    turn: int | None = Field(description="The game's turn as it was saved, when known.")
    ended_at: datetime | None = Field(description="Null while the game waits to be resumed.")
    ended_reason: EndedReason | None = Field(
        description="How the save ended: resumed or discarded by its player, expired after its "
        "days, upgrade (the engine was upgraded: a saved game is played on only by the build "
        "that saved it), unrecoverable (its recording could not be read back), or account (its "
        "account was deleted)."
    )


class SuspensionVote(Contract):
    """Where a proposal to suspend a table's game stands, after the caller agreed to it."""

    status: Literal["voting", "suspended"]
    proposed_by: int | None = Field(description="The seat that proposed it.")
    agreed: list[int] = Field(description="The seats that agreed, of those that must.")
    needed: list[int] = Field(
        description="The seats that must agree: every player still in the game who is present. "
        "A player away for two minutes or longer does not vote."
    )
    save_id: UUID | None = Field(
        default=None, description="The save, once the game is suspended: one of the host's."
    )


class Saves(Contract):
    """The account's saved games and the rules they stand under."""

    saves: list[SavedGame] = Field(
        description="Your games against the bots waiting to be resumed, newest first."
    )
    tables: list[SuspendedTable] = Field(
        default_factory=list,
        description="The suspended tables you sit at, whoever hosts them, newest first: each is "
        "played on at its table.",
    )
    held: int = Field(
        default=0,
        description="How many saves count against your limit: your own games and the suspended "
        "tables you host.",
    )
    ended: list[SavedGame] = Field(
        description="Saves that ended otherwise than by their player's doing (expired, upgrade, "
        f"unrecoverable) in the last {ENDED_SHOWN_DAYS} days, newest first."
    )
    limit: int = Field(description="How many saves an account holds at once.")
    days: int = Field(description="How many days a save lasts.")
    ends_at_upgrade: bool = Field(
        default=True,
        description="A save ends at the next upgrade of the game's engine: a saved game is "
        "played on only by the build that saved it.",
    )


# The database's part. Each runs in the caller's transaction and does not commit, except the
# ones that say they are whole pieces of work.


def end_save(db: Session, save: GameSave, reason: str, now: datetime) -> None:
    """Ends an open save. For any reason but resuming, its game ends with it: interrupted, with
    no result, as a game the engine could not give back ends (api/games.py interrupt_active). A
    campaign duel is recorded unfinished, which is no loss."""
    if save.ended_at is not None:
        return
    save.ended_at, save.ended_reason = now, reason
    metrics.count("saves.ended", reason=reason)
    if reason == "resumed":
        return
    game = db.get(Game, save.game_id)
    if game is None or game.status != "saved":
        return
    game.status, game.finished_at = "interrupted", now
    link = db.get(CampaignGame, game.id)
    if link is not None:
        link.outcome, link.finished_at = "unfinished", now
    else:
        # Imported here: api.awards reaches api.social, which imports far.
        from api.awards import settle

        settle(db, game)


def expire_due(db: Session, now: datetime, user_id: UUID | None = None) -> int:
    """Ends the open saves whose time is up: everyone's, or one account's."""
    due = select(GameSave).where(GameSave.ended_at.is_(None), GameSave.expires_at <= now)
    if user_id is not None:
        due = due.where(GameSave.user_id == user_id)
    found = list(db.scalars(due))
    for save in found:
        end_save(db, save, "expired", now)
    db.flush()
    return len(found)


def end_other_builds(db: Session, build: str, now: datetime) -> int:
    """Ends the open saves another engine build holds (the owner's decision: a save ends at the
    upgrade). The engine that runs now could not play them on."""
    found = list(
        db.scalars(
            select(GameSave).where(GameSave.ended_at.is_(None), GameSave.engine_build != build)
        )
    )
    for save in found:
        end_save(db, save, "upgrade", now)
    db.flush()
    return len(found)


def end_saves_of(db: Session, user_id: UUID, now: datetime) -> int:
    """An account being deleted (api/accounts.py): its saved games end. Their recordings stay
    in the engine until their time is up, which no route reads."""
    found = list(
        db.scalars(select(GameSave).where(GameSave.ended_at.is_(None), GameSave.user_id == user_id))
    )
    for save in found:
        end_save(db, save, "account", now)
    db.flush()
    return len(found)


def expire_saves(database: Engine, now: datetime) -> int:
    """The worker's daily job (api/accounts.py handle): saves past their time, whoever's."""
    with Session(database) as db:
        ended = expire_due(db, now)
        db.commit()
    return ended


def held_by(database: Engine, user_id: UUID, now: datetime) -> int:
    """How many saves the account holds, once those past their time have ended."""
    with Session(database) as db:
        expire_due(db, now, user_id)
        db.commit()
        return len(
            list(
                db.scalars(
                    select(GameSave.id).where(
                        GameSave.ended_at.is_(None), GameSave.user_id == user_id
                    )
                )
            )
        )


def record_saved(
    database: Engine,
    game_id: UUID,
    user_id: UUID,
    now: datetime,
    expires: datetime,
    build: str,
    turn: int | None,
    table_id: UUID | None = None,
) -> UUID:
    """The engine stopped the game: it is saved, in one transaction with its save. At a table
    (``table_id``) nobody is ready to play on yet: each player says so when they are back."""
    with Session(database) as db:
        game = db.get(Game, game_id)
        if game is None or game.status != "active":
            raise RuntimeError(f"Game {game_id} is not running: it cannot be recorded as saved")
        game.status = "saved"
        if table_id is not None:
            for row in db.scalars(select(TableSeat).where(TableSeat.table_id == table_id)):
                row.ready = False
        save = GameSave(
            game_id=game_id,
            user_id=user_id,
            saved_at=now,
            expires_at=expires,
            engine_build=build,
            turn=turn,
        )
        db.add(save)
        db.commit()
        return save.id


def own_open(db: Session, save_id: UUID, user_id: UUID, now: datetime) -> GameSave:
    """The account's own open save. Another's, and one that has ended, look like none; one whose
    time is up ends here and says so."""
    save = db.get(GameSave, save_id)
    if save is None or save.user_id != user_id:
        raise not_found()
    if save.ended_at is None and save.expires_at <= now:
        end_save(db, save, "expired", now)
        db.commit()
    if save.ended_at is not None:
        if save.ended_reason in TOLD:
            raise ApiError(410, "save_ended", ENDED_WORDS[save.ended_reason])
        raise not_found()
    return save


def open_game_of(
    database: Engine, save_id: UUID, user_id: UUID, now: datetime, solo: bool = False
) -> UUID:
    """The game of the account's own open save. With ``solo``, a table's suspended game is
    refused: it is played on at its table, by all its players."""
    with Session(database) as db:
        save = own_open(db, save_id, user_id, now)
        game = db.get(Game, save.game_id)
        if solo and game is not None and game.kind == "table":
            raise ApiError(
                409,
                "table_save",
                "This game is a table's: it is played on at the table, once every player is "
                "back and ready.",
            )
        return save.game_id


# A table's suspended game.


def suspended_of(db: Session, table: GameTable) -> tuple[Game, GameSave] | None:
    """The table's game and its open save, when its players suspended it."""
    if table.game_id is None:
        return None
    game = db.get(Game, table.game_id)
    if game is None or game.status != "saved":
        return None
    save = db.scalar(
        select(GameSave).where(GameSave.game_id == game.id, GameSave.ended_at.is_(None))
    )
    return (game, save) if save is not None else None


def players_of(db: Session, game_id: UUID) -> dict[UUID, bool]:
    """The game's players, each with whether they are still in it."""
    return {
        row.user_id: row.left_at is None
        for row in db.scalars(select(GameSeat).where(GameSeat.game_id == game_id))
        if row.user_id is not None
    }


def suspended_view(db: Session, table: GameTable, user_id: UUID) -> SuspendedTable | None:
    """The table as its players see it while its game is suspended; None when it is not."""
    found = suspended_of(db, table)
    if found is None:
        return None
    game, save = found
    playing = players_of(db, game.id)
    rows = list(
        db.scalars(select(TableSeat).where(TableSeat.table_id == table.id).order_by(TableSeat.seat))
    )
    handles = dict(
        db.execute(
            select(User.id, User.handle).where(
                User.id.in_({row.user_id for row in rows} | {table.host_id})
            )
        ).all()
    )
    return SuspendedTable(
        code=table.code,
        format=game.format,  # type: ignore[arg-type]
        host=handles.get(table.host_id),
        you_host=table.host_id == user_id,
        save_id=save.id,
        game_id=game.id,
        saved_at=save.saved_at,
        expires_at=save.expires_at,
        turn=save.turn,
        players=[
            SuspendedPlayer(
                seat=row.seat,
                handle=handles.get(row.user_id),
                you=row.user_id == user_id,
                needed=playing.get(row.user_id, False),
                ready=row.ready and playing.get(row.user_id, False),
            )
            for row in rows
        ],
    )


def refuse_unsuspendable(table: GameTable, game: Game) -> None:
    """Only a private table's single game is suspended, by its players together."""
    if table.visibility != "private" or table.queued:
        raise ApiError(
            409, "not_private", "Only a private table's game can be suspended by its players."
        )
    if game.match_id is not None:
        raise ApiError(
            409, "match_game", "A game of a match cannot be suspended: only a single game can."
        )


def end_one(database: Engine, save_id: UUID, reason: str, now: datetime) -> None:
    """A whole piece of work: one save ended, and its game with it."""
    with Session(database) as db:
        save = db.get(GameSave, save_id)
        if save is not None:
            end_save(db, save, reason, now)
            db.commit()


def record_resumed(
    database: Engine, save_id: UUID, game_id: UUID, tokens: dict[int, str], now: datetime
) -> LiveGame | None:
    """The engine gave the game back: it is running again, in one transaction with its save's
    end, and is followed with the engine's new tokens. None when it is not a saved game any more
    or the engine named no token for its player's seat."""
    with Session(database) as db:
        save = db.get(GameSave, save_id)
        game = db.get(Game, game_id)
        if save is None or game is None or save.ended_at is not None or game.status != "saved":
            return None
        game.status = "active"
        end_save(db, save, "resumed", now)
        db.commit()
    return revived(database, game_id, tokens)


def saved_game(db: Session, save: GameSave, principal: Principal, campaign: Any) -> SavedGame:
    game = db.get(Game, save.game_id)
    assert game is not None
    return SavedGame(
        id=save.id,
        game=summary_of(db, game, principal, campaign),
        saved_at=save.saved_at,
        expires_at=save.expires_at,
        turn=save.turn,
        ended_at=save.ended_at,
        ended_reason=save.ended_reason,  # type: ignore[arg-type]
    )


# After a restart.


async def settle_after_restart(hub: GameHub) -> None:
    """An upgrade restarts the API with the engine. Once the engine answers with its build, the
    saves another build holds are ended (the owner's decision), so their players read it in the
    list and not at the moment they would play on. Asked only while a save waits; an engine that
    does not answer in time leaves them to be found when they are resumed."""

    def waiting() -> bool:
        with Session(hub.database) as db:
            return db.scalar(select(GameSave.id).where(GameSave.ended_at.is_(None))) is not None

    def end(build: str) -> int:
        with Session(hub.database) as db:
            ended = end_other_builds(db, build, utcnow())
            db.commit()
            return ended

    try:
        if hub.engine is None or not await run_in_threadpool(waiting):
            return
        deadline = asyncio.get_running_loop().time() + BUILD_CHECK_SECONDS
        delay = RETRY_SECONDS
        while True:
            try:
                status, body = await hub.engine.request("GET", "/recordings")
            except EngineUnavailable:
                status, body = 0, None
            build = body.get("engine_build") if status == 200 and isinstance(body, dict) else None
            if isinstance(build, str) and build:
                ended = await retried(partial(end, build), "end the saves of another engine build")
                if ended:
                    log.info("Ended %d saved games of another engine build", ended)
                return
            if asyncio.get_running_loop().time() >= deadline:
                log.warning("The engine did not name its build; saves are checked as resumed")
                return
            await asyncio.sleep(delay)
            delay = min(RETRY_MAX_SECONDS, delay * 2)
    except SQLAlchemyError:
        log.warning("Could not check the saved games after the restart", exc_info=True)


# The routes.


def turn_of(game: LiveGame, user_id: UUID | None = None) -> int | None:
    """The game's turn by the last view of the player's seat, or of any seat."""
    seats = [game.seat_of(user_id)] if user_id is not None else list(game.seats.values())
    for seat in seats:
        view = seat.snapshot.get("view") if seat is not None and seat.snapshot else None
        turn = view.get("turn") if isinstance(view, dict) else None
        if isinstance(turn, int) and not isinstance(turn, bool):
            return turn
    return None


def refuse_unsavable(game: Game, live: LiveGame, user_id: UUID) -> None:
    """Only a game its player plays alone against the bots is saved by that player's word."""
    if game.kind != "practice" or len(live.seats) != 1 or live.seat_of(user_id) is None:
        raise ApiError(
            409,
            "not_solo",
            "Only a game you play alone against the bots can be saved.",
        )
    if game.match_id is not None:
        raise ApiError(
            409,
            "match_game",
            "A game of a match cannot be saved: only a single game against the bots can.",
        )


def save_refusal(status: int, body: object) -> ApiError:
    """The engine did not save the game, which plays on: why, in the player's words."""
    code = body.get("code") if isinstance(body, dict) else None
    if status == 409 and code == "not_recorded":
        return ApiError(
            409,
            "save_unavailable",
            "This game cannot be saved: the server keeps no recording of it.",
        )
    if status in (404, 409):
        return ApiError(409, "game_not_running", "The game is over: there is nothing to save.")
    return ApiError(
        503,
        "save_not_ready",
        "The game could not be saved just now. Try again in a moment.",
        {"Retry-After": "2"},
    )


@router.get("/saves", response_model=Saves)
def list_saves(request: Request, principal: Player, db: Db) -> Saves:
    """Your saved games, and the rules they stand under."""
    now = utcnow()
    user_id = principal.user.id
    if expire_due(db, now, user_id):
        db.commit()
    campaign = campaign_or_none(request)
    held = list(
        db.scalars(
            select(GameSave)
            .where(GameSave.user_id == user_id, GameSave.ended_at.is_(None))
            .order_by(GameSave.saved_at.desc())
        )
    )
    # A table's suspended game is shown with its table, to every player seated there.
    kinds = {save.id: db.scalar(select(Game.kind).where(Game.id == save.game_id)) for save in held}
    waiting = [save for save in held if kinds[save.id] != "table"]
    seated = db.scalars(
        select(GameTable)
        .join(TableSeat, TableSeat.table_id == GameTable.id)
        .join(Game, Game.id == GameTable.game_id)
        .where(TableSeat.user_id == user_id, Game.status == "saved")
    )
    tables = [view for table in seated if (view := suspended_view(db, table, user_id))]
    tables.sort(key=lambda found: found.saved_at, reverse=True)
    ended = db.scalars(
        select(GameSave)
        .where(
            GameSave.user_id == user_id,
            GameSave.ended_reason.in_(TOLD),
            GameSave.ended_at >= now - timedelta(days=ENDED_SHOWN_DAYS),
        )
        .order_by(GameSave.ended_at.desc())
    )
    return Saves(
        saves=[saved_game(db, save, principal, campaign) for save in waiting],
        ended=[saved_game(db, save, principal, campaign) for save in ended],
        tables=tables,
        held=len(held),
        limit=SAVE_LIMIT,
        days=SAVE_DAYS,
    )


@router.post(
    "/games/{game_id}/save",
    response_model=SavedGame,
    status_code=201,
    responses={409: {"model": Error}, 503: {"model": Error}},
)
async def save_game(game_id: UUID, request: Request, principal: Player, db: Db) -> SavedGame:
    """Saves your game against the bots to be played on later: it stops where it is and waits in
    Your games. It lasts 30 days, an account holds five, and a save ends at the next upgrade of
    the game. A refused game plays on untouched."""
    game, owner = await run_in_threadpool(visible_game, db, game_id, principal)
    if not owner:
        raise ApiError(403, "not_a_player", "Only the game's own player saves it.")
    hub = hub_of(request)
    user_id = principal.user.id
    # No pooled connection is held while the engine works.
    await run_in_threadpool(db.commit)
    async with hub.locks[user_id]:
        live = hub.games.get(game_id)
        if live is None or live.finished or live.ending:
            raise ApiError(
                409, "game_not_running", "The game is not being played: there is nothing to save."
            )
        if live.saving:
            raise ApiError(409, "game_saving", "The game is being saved.")
        refuse_unsavable(game, live, user_id)
        engine = hub.require_engine()
        now = utcnow()
        if await run_in_threadpool(held_by, hub.database, user_id, now) >= SAVE_LIMIT:
            raise ApiError(
                409,
                "save_limit",
                f"You hold {SAVE_LIMIT} saved games. Resume or discard one before saving another.",
            )
        expires = now + timedelta(days=SAVE_DAYS)
        turn = turn_of(live, user_id)
        if live.finished or live.ending or live.saving:
            raise ApiError(409, "game_not_running", "The game is over: there is nothing to save.")
        hub.pause(live)
        try:
            status, body = await engine.request(
                "POST",
                f"{live.path}/save",
                body={"until_millis": int(expires.timestamp() * 1000)},
                timeout=SAVE_TIMEOUT_SECONDS,
            )
        except EngineUnavailable as error:
            hub.go_on(live)
            raise unavailable() from error
        build = body.get("engine_build") if isinstance(body, dict) else None
        if status != 200 or not isinstance(build, str) or not build:
            hub.go_on(live)
            metrics.count("saves.refused", status=str(status))
            raise save_refusal(status, body)
        try:
            save_id = await retried(
                partial(record_saved, hub.database, game_id, user_id, now, expires, build, turn),
                f"record the save of game {game_id}",
            )
        except Exception:
            # Stopped in the engine and not saved here: the recording is given up, and the
            # followers, started again, find the game gone and end it interrupted.
            log.exception("Game %s was stopped to be saved and could not be recorded so", game_id)
            with_engine = hub.engine
            if with_engine is not None:
                try:
                    await with_engine.request("POST", f"{live.path}/discard", body={})
                except EngineUnavailable:
                    pass
            hub.go_on(live)
            raise
        metrics.count("saves.saved")
        await hub.saved(live, save_id)

    def read() -> SavedGame:
        # The request's session read the game before it was saved.
        db.expire_all()
        save = db.get(GameSave, save_id)
        assert save is not None
        return saved_game(db, save, principal, campaign_or_none(request))

    return await run_in_threadpool(read)


async def take_up(hub: GameHub, save_id: UUID, game_id: UUID, now: datetime) -> LiveGame:
    """Asks the engine to resume a saved game and records it running again: the game as this
    process follows it, not yet registered. The caller holds a slot (``hub.reserve``) and the
    locks of the players it concerns. A save the engine cannot give back is ended, and says so
    (410); an engine that is full or not ready leaves the save waiting (429, 503)."""
    engine = hub.require_engine()
    try:
        status, body = await engine.request(
            "POST",
            f"/games/{game_id}/attach",
            body={"resume": True},
            timeout=CREATE_TIMEOUT_SECONDS,
        )
    except EngineUnavailable as error:
        raise unavailable() from error
    if status == 429:
        words = body.get("message") if isinstance(body, dict) else None
        raise ApiError(
            429,
            "games_busy",
            words if isinstance(words, str) else ENGINE_FULL,
            {"Retry-After": "30"},
        )
    answered = body.get("status") if status == 200 and isinstance(body, dict) else None
    if status in (404, 405, 409) or answered == "finished":
        # The engine cannot give the game back: another build holds it (an upgrade), or its
        # recording is gone or damaged. A recording with a result is not a saved game's, and
        # is not played on either.
        code = body.get("code") if isinstance(body, dict) else None
        reason = "upgrade" if code == "recording_incompatible" else "unrecoverable"
        log.warning("Saved game %s cannot be resumed (%s, %s)", game_id, status, code)
        await retried(
            partial(end_one, hub.database, save_id, reason, now),
            f"end the save of game {game_id}",
        )
        raise ApiError(410, "save_ended", ENDED_WORDS[reason])
    if answered not in ("attached", "recovered") or not isinstance(body.get("seats"), list):
        # Still loading its cards, or something else that passes: the save waits.
        raise unavailable()
    live = await retried(
        partial(record_resumed, hub.database, save_id, game_id, seat_tokens(body), now),
        f"record game {game_id} as resumed",
    )
    if live is None:
        # Running in the engine and not followed: closed there, and ended here.
        await hub.give_up([game_id])
        await retried(
            partial(end_one, hub.database, save_id, "unrecoverable", now),
            f"end the save of game {game_id}",
        )
        raise ApiError(410, "save_ended", ENDED_WORDS["unrecoverable"])
    metrics.count("saves.resumed")
    return live


@router.post(
    "/saves/{save_id}/resume",
    response_model=GameSummary,
    responses={
        409: {"model": Error},
        410: {"model": Error},
        429: {"model": Error},
        503: {"model": Error},
    },
)
async def resume_save(save_id: UUID, request: Request, principal: Player, db: Db) -> GameSummary:
    """Plays a saved game on: the engine takes it up where it stopped, and it is your running
    game again. 410 when the save has ended (it ran out, the game was upgraded, or it could not
    be read back); the game then ends interrupted, with no result. A table's suspended game is
    played on at its table instead (409 ``table_save``)."""
    hub = hub_of(request)
    hub.require_engine()
    user_id = principal.user.id
    async with hub.locks[user_id]:
        now = utcnow()
        game_id = await run_in_threadpool(open_game_of, hub.database, save_id, user_id, now, True)
        if not full_access(principal):
            running = await run_in_threadpool(active_games_of, db, user_id)
            await run_in_threadpool(db.commit)
            if running >= hub.settings.games_per_account:
                raise ApiError(
                    409,
                    "game_limit",
                    "Finish, save or close your running game before resuming this one.",
                )
        hub.reserve()
        try:
            hub.register(await take_up(hub, save_id, game_id, now))
        finally:
            hub.starting -= 1

    def read() -> GameSummary:
        db.expire_all()
        game = db.get(Game, game_id)
        assert game is not None
        return summary_of(db, game, principal, campaign_or_none(request))

    return await run_in_threadpool(read)


@router.delete("/saves/{save_id}", status_code=204, responses={410: {"model": Error}})
async def discard_save(save_id: UUID, request: Request, principal: Player) -> Response:
    """Gives a saved game up: it ends interrupted, with no result, and its recording is removed.
    Nobody loses."""
    hub = hub_of(request)
    user_id = principal.user.id
    async with hub.locks[user_id]:
        now = utcnow()
        game_id = await run_in_threadpool(open_game_of, hub.database, save_id, user_id, now)
        if hub.engine is not None:
            try:
                await hub.engine.request("POST", f"/games/{game_id}/discard", body={})
            except EngineUnavailable:
                # The engine removes the recording itself when the save's time is up.
                pass
        await retried(
            partial(end_one, hub.database, save_id, "discarded", now),
            f"discard the save of game {game_id}",
        )
    return Response(status_code=204)


# A private table's game, suspended by its players together.


def table_game(db: Session, code: str) -> tuple[GameTable, Game | None]:
    """The table by its code, and its game. A table that does not exist is not found."""
    table = find(db, code)
    return table, db.get(Game, table.game_id) if table.game_id is not None else None


def table_of(database: Engine, game_id: UUID) -> tuple[UUID, UUID, str] | None:
    """The id, host and code of the table a game was started at."""
    with Session(database) as db:
        table = db.scalar(select(GameTable).where(GameTable.game_id == game_id))
        return (table.id, table.host_id, table.code) if table is not None else None


async def carry_out(hub: GameHub, game: LiveGame) -> UUID | None:
    """Suspends a table's game every player who must has agreed to: the engine stops it, and it
    is one of the host's saves. None when there is nothing to do any more (the game ended, or
    the vote is no longer whole). A refusal ends the proposal, tells the table why, and is
    raised; the game plays on."""
    async with hub.locks[("suspend", game.id)]:
        if game.finished or game.ending or game.saving or not hub.suspension_agreed(game):
            return None
        engine = hub.require_engine()
        now = utcnow()
        found = await run_in_threadpool(table_of, hub.database, game.id)
        if found is None:
            hub.suspension_ended(game)
            return None
        table_id, host_id, code = found

        def refused(error: ApiError) -> ApiError:
            hub.suspension_ended(game, refused=error.message)
            return error

        if await run_in_threadpool(held_by, hub.database, host_id, now) >= SAVE_LIMIT:
            raise refused(
                ApiError(
                    409,
                    "save_limit",
                    f"The table's host holds {SAVE_LIMIT} saved games: one must be resumed or "
                    "discarded before this game can be suspended.",
                )
            )
        if game.finished or game.ending or game.saving:
            return None
        expires = now + timedelta(days=SAVE_DAYS)
        turn = turn_of(game)
        hub.pause(game)
        try:
            status, body = await engine.request(
                "POST",
                f"{game.path}/save",
                body={"until_millis": int(expires.timestamp() * 1000)},
                timeout=SAVE_TIMEOUT_SECONDS,
            )
        except EngineUnavailable as error:
            hub.go_on(game)
            raise refused(unavailable()) from error
        build = body.get("engine_build") if isinstance(body, dict) else None
        if status != 200 or not isinstance(build, str) or not build:
            hub.go_on(game)
            metrics.count("saves.refused", status=str(status))
            raise refused(save_refusal(status, body))
        try:
            save_id = await retried(
                partial(
                    record_saved,
                    hub.database,
                    game.id,
                    host_id,
                    now,
                    expires,
                    build,
                    turn,
                    table_id,
                ),
                f"record the suspension of game {game.id}",
            )
        except Exception:
            log.exception("Game %s was stopped to be suspended and could not be recorded", game.id)
            try:
                await engine.request("POST", f"{game.path}/discard", body={})
            except EngineUnavailable:
                pass
            hub.go_on(game)
            hub.suspension_ended(game, refused="The game could not be suspended.")
            raise
        game.suspension.clear()
        game.suspension_by = None
        metrics.count("saves.saved")
        await hub.saved(game, save_id, table=code)
        return save_id


async def suspend_agreed(hub: GameHub, game: LiveGame) -> None:
    """The hub's own asking (a player who had not agreed went away for long, or left the game,
    and everyone left has agreed): carried out, with a refusal told to the table and no one
    else to raise it to."""
    try:
        await carry_out(hub, game)
    except ApiError:
        pass


def live_seat(hub: GameHub, game: Game | None, user_id: UUID) -> tuple[LiveGame, int]:
    """The table's running game and the caller's seat in it, still in play."""
    live = hub.games.get(game.id) if game is not None and game.status == "active" else None
    if live is None or live.finished or live.ending:
        raise ApiError(
            409, "game_not_running", "The table's game is not being played: nothing to suspend."
        )
    seat = live.seat_of(user_id)
    if seat is None or seat.left is not None:
        raise ApiError(
            409, "not_in_game", "Only a player still in the game votes on suspending it."
        )
    return live, seat.seat


@router.post(
    "/tables/{code}/suspension",
    response_model=SuspensionVote,
    responses={409: {"model": Error}, 503: {"model": Error}},
)
async def agree_to_suspend(
    code: Code, request: Request, principal: Player, db: Db
) -> SuspensionVote:
    """Proposes to suspend a private table's game, or agrees to the proposal: the game is saved
    to be played on later once every player still in it who is present has agreed. A player
    away for two minutes or longer does not vote. The save is one of the host's five."""
    hub = hub_of(request)
    table, game = await run_in_threadpool(table_game, db, code)
    host_id = table.host_id
    await run_in_threadpool(db.commit)
    live, seat = live_seat(hub, game, principal.user.id)
    assert game is not None
    refuse_unsuspendable(table, game)
    if live.saving:
        raise ApiError(409, "game_saving", "The game is being saved.")
    if not live.suspension:
        # Asked before anyone is asked to agree: a proposal that could not be carried out.
        if await run_in_threadpool(held_by, hub.database, host_id, utcnow()) >= SAVE_LIMIT:
            raise ApiError(
                409,
                "save_limit",
                f"The table's host holds {SAVE_LIMIT} saved games: one must be resumed or "
                "discarded before this game can be suspended.",
            )
        if live.finished or live.ending or live.saving:
            raise ApiError(409, "game_not_running", "The table's game is over.")
        if not live.suspension:
            live.suspension_by = seat
    live.suspension.add(seat)
    if hub.suspension_agreed(live):
        proposed_by = live.suspension_by
        state = hub.suspension_state(live)
        save_id = await carry_out(hub, live)
        if save_id is not None:
            return SuspensionVote(
                status="suspended",
                proposed_by=proposed_by,
                agreed=state["agreed"],
                needed=state["needed"],
                save_id=save_id,
            )
    state = hub.suspension_state(live)
    if not live.finished:
        hub.broadcast(live, state)
    return SuspensionVote(
        status="voting",
        proposed_by=state["proposed_by"],
        agreed=state["agreed"],
        needed=state["needed"],
    )


@router.delete("/tables/{code}/suspension", status_code=204, responses={409: {"model": Error}})
async def decline_to_suspend(code: Code, request: Request, principal: Player, db: Db) -> Response:
    """Declines the proposal to suspend the table's game, or withdraws it: the proposal is over
    for everyone, and the table is told who ended it."""
    hub = hub_of(request)
    _, game = await run_in_threadpool(table_game, db, code)
    await run_in_threadpool(db.commit)
    live, seat = live_seat(hub, game, principal.user.id)
    if live.suspension and not live.saving:
        hub.suspension_ended(live, declined_by=seat)
    return Response(status_code=204)


def set_ready(
    database: Engine, code: str, user_id: UUID, ready: bool, now: datetime
) -> tuple[UUID, UUID, UUID, list[UUID]] | None:
    """The caller is back at the suspended table and ready to play on, or no longer is. Returns
    the table, the save, the game and its players still in it once every one of them is ready;
    None while someone is not."""
    with Session(database) as db:
        table, _ = table_game(db, code)
        found = suspended_of(db, table)
        if found is None:
            raise ApiError(409, "not_suspended", "This table's game is not suspended.")
        game, save = found
        if save.expires_at <= now:
            end_save(db, save, "expired", now)
            db.commit()
            raise ApiError(410, "save_ended", ENDED_WORDS["expired"])
        playing = players_of(db, game.id)
        if not playing.get(user_id, False):
            raise ApiError(
                409, "not_in_game", "Only a player still in the game gets ready to play it on."
            )
        rows = list(db.scalars(select(TableSeat).where(TableSeat.table_id == table.id)))
        for row in rows:
            if row.user_id == user_id:
                row.ready = ready
        db.commit()
        needed = [user for user, still in playing.items() if still]
        back = {row.user_id for row in rows if row.ready}
        if ready and set(needed) <= back:
            return table.id, save.id, game.id, needed
        return None


def unready(database: Engine, table_id: UUID, user_ids: list[UUID]) -> None:
    with Session(database) as db:
        for row in db.scalars(select(TableSeat).where(TableSeat.table_id == table_id)):
            if row.user_id in user_ids:
                row.ready = False
        db.commit()


def table_view(db: Session, code: str, principal: Principal) -> TableView:
    db.expire_all()
    return view_of(db, find(db, code), principal)


def over_limit(db: Session, request: Request, players: list[UUID]) -> UUID | None:
    """The first of the players who has no room for one more running game, if any has."""
    for user_id in players:
        try:
            under_limits(db, request, [user_id])
        except ApiError:
            return user_id
    return None


@router.post(
    "/tables/{code}/suspension/ready",
    response_model=TableView,
    responses={
        409: {"model": Error},
        410: {"model": Error},
        429: {"model": Error},
        503: {"model": Error},
    },
)
async def ready_to_play_on(code: Code, request: Request, principal: Player, db: Db) -> TableView:
    """You are back at the suspended table and ready to play on. Once every player still in the
    game is, the engine takes the game up where it stopped and the table is started again: the
    reply's ``game_id`` is then the running game. A player with another game running cannot get
    ready (409 ``game_limit``)."""
    hub = hub_of(request)
    hub.require_engine()
    user_id = principal.user.id
    if not full_access(principal):
        running = await run_in_threadpool(active_games_of, db, user_id)
        await run_in_threadpool(db.commit)
        if running >= hub.settings.games_per_account:
            raise ApiError(
                409,
                "game_limit",
                "Finish, save or close your running game before playing this one on.",
            )
    table, _ = await run_in_threadpool(table_game, db, code)
    table_id = table.id
    await run_in_threadpool(db.commit)
    async with hub.locks[table_id]:
        now = utcnow()
        whole = await run_in_threadpool(set_ready, hub.database, code, user_id, True, now)
        if whole is not None:
            _, save_id, game_id, players = whole
            async with AsyncExitStack() as stack:
                # Every player's lock, in one order, as a table's start takes them.
                for player in sorted(players, key=str):
                    await stack.enter_async_context(hub.locks[player])
                short = await run_in_threadpool(over_limit, db, request, players)
                if short is not None:
                    # Started another game since getting ready: they get ready again, later.
                    await run_in_threadpool(unready, hub.database, table_id, [short])
                else:
                    hub.reserve()
                    try:
                        hub.register(await take_up(hub, save_id, game_id, now))
                    finally:
                        hub.starting -= 1
    return await run_in_threadpool(table_view, db, code, principal)


@router.delete(
    "/tables/{code}/suspension/ready",
    response_model=TableView,
    responses={409: {"model": Error}, 410: {"model": Error}},
)
async def not_ready_to_play_on(
    code: Code, request: Request, principal: Player, db: Db
) -> TableView:
    """You are not ready to play the suspended game on after all."""
    hub = hub_of(request)
    table, _ = await run_in_threadpool(table_game, db, code)
    table_id = table.id
    await run_in_threadpool(db.commit)
    async with hub.locks[table_id]:
        await run_in_threadpool(set_ready, hub.database, code, principal.user.id, False, utcnow())
    return await run_in_threadpool(table_view, db, code, principal)
