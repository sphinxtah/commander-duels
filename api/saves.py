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

What is not saved: a table's game (its players suspend it together, by vote; not built here) and
a game of a best-of-three match (the match would stand between its games for a month).

Behind the gate ``save_resume`` (api/rollout.py): off until SysOp stages it. Recovery itself is
on for everyone and needs none.
"""

import asyncio
import logging
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
from api.models import CampaignGame, Game, GameSave
from api.schemas import Contract, Error, GameSummary

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


class Saves(Contract):
    """The account's saved games and the rules they stand under."""

    saves: list[SavedGame] = Field(description="Waiting to be resumed, newest first.")
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
) -> UUID:
    """The engine stopped the game: it is saved, in one transaction with its save."""
    with Session(database) as db:
        game = db.get(Game, game_id)
        if game is None or game.status != "active":
            raise RuntimeError(f"Game {game_id} is not running: it cannot be recorded as saved")
        game.status = "saved"
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


def open_game_of(database: Engine, save_id: UUID, user_id: UUID, now: datetime) -> UUID:
    with Session(database) as db:
        return own_open(db, save_id, user_id, now).game_id


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


def turn_of(game: LiveGame, user_id: UUID) -> int | None:
    seat = game.seat_of(user_id)
    view = seat.snapshot.get("view") if seat is not None and seat.snapshot else None
    turn = view.get("turn") if isinstance(view, dict) else None
    return turn if isinstance(turn, int) and not isinstance(turn, bool) else None


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
    waiting = db.scalars(
        select(GameSave)
        .where(GameSave.user_id == user_id, GameSave.ended_at.is_(None))
        .order_by(GameSave.saved_at.desc())
    )
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
    be read back); the game then ends interrupted, with no result."""
    hub = hub_of(request)
    engine = hub.require_engine()
    user_id = principal.user.id
    async with hub.locks[user_id]:
        now = utcnow()
        game_id = await run_in_threadpool(open_game_of, hub.database, save_id, user_id, now)
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
                # The engine cannot give the game back: another build holds it (an upgrade), or
                # its recording is gone or damaged. A recording with a result is not a saved
                # game's, and is not played on either.
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
            hub.register(live)
            metrics.count("saves.resumed")
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
