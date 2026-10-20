"""Practice games through the API: seat ownership, the controller lease and game events.

The browser never holds an engine seat token. The API starts each game in the engine with the
service token, keeps the human seat's token in this process's memory, records the game, its
seats and its result in the database, and forwards commands from the seat's owner. Views come
back unchanged from the engine, so the engine's leak rules still decide what a seat sees.

Events go over one WebSocket per game, authenticated by the session cookie and the session's CSRF
token in the first message. One connection per seat holds the controller lease and may command;
taking control from another tab moves the lease, and the old tab observes (AUTH07). Commands
carry an action ID, the expected revision and the prompt ID; the engine runs a resent action once
(T14). SysOp may observe any game and inspect every hand and library (games.view_concealed, its
exception to SEC05 and NET14); every opening is audited.

One API process holds the games: a restart marks the running ones interrupted and closes them in
the engine, because their seat tokens are gone.
"""

import asyncio
import json
import logging
import secrets
from collections import defaultdict
from collections.abc import Callable, Coroutine
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime
from functools import partial
from typing import Annotated, Any, Literal, cast
from uuid import UUID

import anyio
import httpx
from fastapi import APIRouter, Depends, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import Engine, func, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api.auth import INPUT_ERRORS
from api.config import Settings
from api.decklists import parse_deck_list
from api.identity import (
    SESSION_COOKIE,
    ApiError,
    Db,
    Principal,
    audit,
    hash_token,
    keep_alive,
    live_session,
    not_found,
    permissions_for,
    require_permission,
    roles_of,
    settings_of,
    utcnow,
)
from api.models import Game, GameSeat, User, UserSession
from api.schemas import (
    CardNames,
    Error,
    FixtureDeck,
    GameFormatId,
    GameResult,
    GameState,
    GameSummary,
    PracticeFormat,
    PracticeGameRequest,
    PracticeOptions,
    SeatChoice,
)
from api.schemas import GameSeat as SeatSummary

log = logging.getLogger("api.games")
router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
Player = Annotated[Principal, Depends(require_permission("games.play"))]
Inspector = Annotated[Principal, Depends(require_permission("games.view_concealed"))]
AnyCard = Annotated[Principal, Depends(require_permission("cards.any"))]

FIXTURE_DECKS: dict[str, list[FixtureDeck]] = {
    "legacy": ["legacy-mono-red-burn", "legacy-mono-green-creatures"],
    "commander": [
        "commander-mono-white-soldiers",
        "commander-mono-blue-flyers",
        "commander-mono-red-raiders",
        "commander-mono-green-stompers",
    ],
}
BOTS = {"legacy": [1], "commander": [1, 2, 3]}
DEFAULT_BOTS = {"legacy": 1, "commander": 3}
FORMAT_NAMES = {"legacy": "Legacy", "commander": "Commander"}
SERVICE_HEADER = "X-Service-Token"
LONG_POLL_MS = 25_000
INSPECTION_WAIT_MS = 3_000
RETAIN_FINISHED_SECONDS = 600.0
# How long closing a game waits for its result to be recorded, so the reply shows it.
CLOSE_WAIT_SECONDS = 5.0
# Database writes that must land (a game's end, the restart sweep) retry, doubling the wait.
RETRY_SECONDS = 1.0
RETRY_MAX_SECONDS = 30.0
HELLO_SECONDS = 10.0
SESSION_CHECK_SECONDS = 60.0
QUEUE_LIMIT = 512
# Every connection costs a copy of each snapshot. SysOp's are not counted.
CONNECTIONS_PER_ACCOUNT = 4
CONNECTIONS_PER_GAME = 8
RESULT_FIELDS = ("kind", "winner_seat", "draw", "turns", "conceded_seats")

# WebSocket close codes: the HTTP status they stand for, in the private-use range.
CLOSE_UNAUTHENTICATED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_NOT_FOUND = 4404
CLOSE_TOO_SLOW = 4408
CLOSE_GONE = 4410
CLOSE_TOO_MANY = 4429
CLOSE_BAD_MESSAGE = 4400


class EngineUnavailable(Exception):
    pass


class EngineClient:
    """The engine's service routes. Every request carries the service token."""

    def __init__(self, base_url: str, token: str, client: httpx.AsyncClient) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.client = client

    async def request(
        self,
        method: str,
        path: str,
        *,
        seat_token: str | None = None,
        body: object = None,
        params: dict[str, str | int] | None = None,
        timeout: float = 10.0,
    ) -> tuple[int, Any]:
        headers = {SERVICE_HEADER: self.token}
        if seat_token:
            headers["Authorization"] = f"Bearer {seat_token}"
        try:
            response = await self.client.request(
                method,
                f"{self.base_url}/v1/service{path}",
                json=body,
                params=params,
                headers=headers,
                timeout=timeout,
            )
            return response.status_code, response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise EngineUnavailable(str(error)) from error


def unavailable() -> ApiError:
    return ApiError(503, "engine_unavailable", "The game engine is not responding. Try again.")


# Commands, as the engine's command envelope (contracts/engine-command.schema.json) restricted to
# what a seat may send.


class ChoicePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    option_id: str | None = Field(default=None, min_length=1, max_length=16)
    amounts: list[Annotated[int, Field(ge=0, le=10_000)]] | None = Field(
        default=None, min_length=1, max_length=32
    )


class GameCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    v: Literal[1]
    game_id: UUID
    action_id: UUID
    expected_revision: int = Field(ge=0)
    prompt_id: UUID | None = None
    type: Literal["submit_choice", "concede"]
    payload: ChoicePayload

    @model_validator(mode="after")
    def payload_matches_type(self) -> "GameCommand":
        chosen = (self.payload.option_id is not None) + (self.payload.amounts is not None)
        if self.type == "submit_choice" and (self.prompt_id is None or chosen != 1):
            raise ValueError("submit_choice needs prompt_id and one of option_id and amounts")
        if self.type == "concede" and chosen:
            raise ValueError("concede takes an empty payload")
        return self

    def engine_body(self) -> dict[str, object]:
        body: dict[str, object] = {
            "v": 1,
            "game_id": str(self.game_id),
            "action_id": str(self.action_id),
            "expected_revision": self.expected_revision,
            "type": self.type,
            "payload": self.payload.model_dump(exclude_none=True),
        }
        if self.prompt_id is not None:
            body["prompt_id"] = str(self.prompt_id)
        return body


class Hello(BaseModel):
    """The first message on a game's WebSocket."""

    model_config = ConfigDict(extra="forbid")
    type: Literal["hello"]
    csrf_token: str = Field(max_length=128)
    since: int = Field(default=-1, ge=-1)
    control: bool = False
    inspect: bool = False


@dataclass(eq=False)
class Connection:
    """One WebSocket. Everything sent to it goes through its queue, which one task drains."""

    id: str
    user_id: UUID
    session_id: UUID
    owner: bool
    inspect: bool
    # Whether it counts toward the connection limits: SysOp's do not.
    counted: bool = True
    queue: asyncio.Queue[dict[str, Any] | None] = field(
        default_factory=lambda: asyncio.Queue(QUEUE_LIMIT)
    )
    revision: int = -1
    close_code: int | None = None
    ended: anyio.Event = field(default_factory=anyio.Event)

    def send(self, message: dict[str, Any]) -> None:
        if self.close_code is not None:
            return
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            # The client is not reading; it resynchronizes by revision when it reconnects.
            self.close(CLOSE_TOO_SLOW)

    def close(self, code: int, error: str | None = None) -> None:
        """Ends the connection. An error code goes out before the close, as at the handshake, so
        the client can tell a session to refresh from a sign-out."""
        if self.close_code is None:
            self.close_code = code
            while not self.queue.empty():
                self.queue.get_nowait()
            if error is not None:
                self.queue.put_nowait({"type": "error", "code": error})
            self.queue.put_nowait(None)
            self.ended.set()


@dataclass(eq=False)
class LiveGame:
    """A running game this process started: its owner's seat and token, and who is watching."""

    id: UUID
    owner_id: UUID
    seat: int
    seat_token: str
    connections: dict[str, Connection] = field(default_factory=dict)
    controller: str | None = None
    finished: bool = False
    # Set once the database holds how the game ended.
    recorded: asyncio.Event = field(default_factory=asyncio.Event)
    # The follow task's latest snapshot, which carries only the log lines new since the one before.
    snapshot: dict[str, Any] | None = None
    # The latest snapshot with a whole page of the log, for new connections and resyncs.
    page: dict[str, Any] | None = None
    paging: asyncio.Lock = field(default_factory=asyncio.Lock)
    inspecting: bool = False
    inspect_again: bool = False

    @property
    def path(self) -> str:
        return f"/games/{self.id}"


def log_end(snapshot: dict[str, Any]) -> int:
    return int(snapshot["log_from"]) + len(snapshot["log"])


def covers(page: dict[str, Any] | None, latest: dict[str, Any] | None) -> bool:
    """Whether a page is as new as the follow task's latest snapshot, log and result included."""
    if page is None:
        return False
    return latest is None or (
        page["revision"] >= latest["revision"]
        and log_end(page) >= log_end(latest)
        and (page.get("result") is not None or latest.get("result") is None)
    )


class GameHub:
    """The games this API process is running, and the tasks that follow them."""

    def __init__(self, settings: Settings, database: Engine, engine: EngineClient | None) -> None:
        self.settings = settings
        self.database = database
        self.engine = engine
        self.games: dict[UUID, LiveGame] = {}
        self.locks: defaultdict[UUID, asyncio.Lock] = defaultdict(asyncio.Lock)
        self.tasks: set[asyncio.Task[None]] = set()
        # Games being created in the engine: they hold a slot under CD_GAMES_MAX already.
        self.starting = 0

    def require_engine(self) -> EngineClient:
        if self.engine is None:
            raise ApiError(
                503,
                "games_unavailable",
                "Games are not set up: the API and the engine need CD_ENGINE_SERVICE_TOKEN.",
            )
        return self.engine

    def spawn(self, work: Coroutine[Any, Any, None]) -> None:
        task = asyncio.get_running_loop().create_task(work)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def running(self) -> int:
        return sum(not game.finished for game in self.games.values())

    async def start(self) -> None:
        """Games left active by an earlier process cannot be played: their tokens are gone. While
        the database cannot be reached (it may still be starting), the check retries in the
        background."""
        started = utcnow()
        try:
            orphans = await run_in_threadpool(interrupt_active, self.database)
        except SQLAlchemyError:
            log.warning("Could not check for interrupted games; is the database migrated?")
            self.spawn(self.sweep(started))
            return
        await self.close_orphans(orphans)

    async def sweep(self, before: datetime) -> None:
        """The restart's check, retried. It spares the games this process started meanwhile."""
        await asyncio.sleep(RETRY_SECONDS)
        orphans = await retried(
            partial(interrupt_active, self.database, before), "check for interrupted games"
        )
        await self.close_orphans(orphans)

    async def close_orphans(self, orphans: list[UUID]) -> None:
        if orphans and self.engine is not None:
            for game_id in orphans:
                try:
                    await self.engine.request("POST", f"/games/{game_id}/close", body={})
                except EngineUnavailable:
                    pass
            log.info("Marked %d games interrupted after a restart", len(orphans))

    async def stop(self) -> None:
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    def register(self, game: LiveGame) -> None:
        self.games[game.id] = game
        self.spawn(self.follow(game))

    async def follow(self, game: LiveGame) -> None:
        """Long-polls the owner's seat view and publishes every new revision to the game's
        connections, until the game finishes; then records the result."""
        engine = self.require_engine()
        since, log_from, failures = -1, 0, 0
        while True:
            try:
                status, snapshot = await engine.request(
                    "GET",
                    f"{game.path}/view",
                    seat_token=game.seat_token,
                    params={"since": since, "wait_ms": LONG_POLL_MS, "log_from": log_from},
                    timeout=LONG_POLL_MS / 1000 + 10,
                )
            except EngineUnavailable:
                status, snapshot = 0, None
            if status == 404:
                await self.end(game, None)
                return
            if status != 200 or not isinstance(snapshot, dict):
                failures += 1
                await asyncio.sleep(min(30.0, 0.5 * 2 ** min(failures, 6)))
                continue
            failures = 0
            finished = snapshot.get("result") is not None
            if snapshot["revision"] != since or finished:
                since = snapshot["revision"]
                log_from = snapshot["log_from"] + len(snapshot["log"])
                game.snapshot = snapshot
                self.broadcast(game, {"type": "snapshot", "snapshot": snapshot})
                self.inspect_soon(game)
            if finished:
                await self.end(game, snapshot["result"])
                return

    async def end(self, game: LiveGame, result: dict[str, Any] | None) -> None:
        """Records how the game ended (a missing game was interrupted), then keeps it readable
        for a while before forgetting its token. Until the end is recorded the game counts
        against its owner's limit, so the write retries until it lands."""
        game.finished = True
        status = "finished" if result is not None else "interrupted"
        if result is None:
            self.broadcast(game, {"type": "interrupted", "game_id": str(game.id)})
        await retried(
            partial(record_end, self.database, game.id, status, result),
            f"record the end of game {game.id}",
        )
        game.recorded.set()
        await asyncio.sleep(RETAIN_FINISHED_SECONDS)
        for connection in list(game.connections.values()):
            connection.close(1000)
        self.games.pop(game.id, None)

    def broadcast(self, game: LiveGame, message: dict[str, Any]) -> None:
        for connection in list(game.connections.values()):
            connection.send(message)

    def lease_changed(self, game: LiveGame, reason: str) -> None:
        for connection in list(game.connections.values()):
            connection.send(
                {
                    "type": "lease",
                    "role": "controller" if game.controller == connection.id else "observer",
                    "controlled": game.controller is not None,
                    "reason": reason,
                }
            )

    def take_control(self, game: LiveGame, connection: Connection) -> None:
        """The lease moves to this connection; any other tab loses it and observes."""
        taken = game.controller is not None and game.controller != connection.id
        game.controller = connection.id
        self.lease_changed(game, "taken_over" if taken else "granted")

    def release(self, game: LiveGame, connection: Connection, reason: str) -> None:
        if game.controller == connection.id:
            game.controller = None
            self.lease_changed(game, reason)

    def inspect_soon(self, game: LiveGame) -> None:
        """Fetches SysOp's inspection view for the game's inspecting connections, one at a time."""
        if not any(connection.inspect for connection in game.connections.values()):
            return
        if game.inspecting:
            game.inspect_again = True
            return
        game.inspecting = True
        self.spawn(self.inspect(game))

    async def inspect(self, game: LiveGame) -> None:
        engine = self.require_engine()
        try:
            while True:
                game.inspect_again = False
                status, inspection = await engine.request(
                    "GET",
                    f"{game.path}/inspection",
                    params={"wait_ms": INSPECTION_WAIT_MS},
                    timeout=INSPECTION_WAIT_MS / 1000 + 10,
                )
                if status == 200:
                    for connection in list(game.connections.values()):
                        if connection.inspect:
                            connection.send({"type": "inspection", "inspection": inspection})
                if not game.inspect_again:
                    return
        except EngineUnavailable:
            pass
        finally:
            game.inspecting = False

    async def snapshot(self, game: LiveGame) -> dict[str, Any] | None:
        """The owner's seat snapshot now, with the latest page of the log."""
        status, snapshot = await self.require_engine().request(
            "GET", f"{game.path}/view", seat_token=game.seat_token
        )
        return snapshot if status == 200 and isinstance(snapshot, dict) else None

    async def page(self, game: LiveGame) -> dict[str, Any] | None:
        """The seat snapshot for a new connection, a resync or a read over HTTP. The engine builds
        one for each revision the follow task sees, and every later ask gets that copy, so opening
        connections or asking to resync costs the engine nothing more."""
        async with game.paging:
            if not covers(game.page, game.snapshot):
                game.page = await self.snapshot(game)
            return game.page

    async def command(self, game: LiveGame, connection: Connection, raw: object) -> None:
        action_id = raw.get("action_id") if isinstance(raw, dict) else None

        def reply(status: int, body: object) -> None:
            connection.send(
                {"type": "command_result", "action_id": action_id, "status": status, "body": body}
            )

        if game.controller != connection.id:
            reply(
                409,
                {
                    "code": "not_controller",
                    "message": "Another tab controls this seat. Take control to play here.",
                },
            )
            return
        try:
            command = GameCommand.model_validate(raw)
        except ValidationError:
            reply(400, {"code": "invalid_command", "message": "The command is not valid."})
            return
        if command.game_id != game.id:
            reply(400, {"code": "invalid_command", "message": "The command names another game."})
            return
        if game.finished:
            reply(409, {"code": "game_over", "message": "The game has finished."})
            return
        try:
            status, body = await self.require_engine().request(
                "POST",
                f"{game.path}/commands",
                seat_token=game.seat_token,
                body=command.engine_body(),
            )
        except EngineUnavailable:
            reply(
                503, {"code": "engine_unavailable", "message": "The game engine is not responding."}
            )
            return
        reply(status, body)


def hub_of(request: Request | WebSocket) -> GameHub:
    return cast(GameHub, request.app.state.games)


# Database work, run in the thread pool from the event loop.


async def retried[T](work: Callable[[], T], what: str) -> T:
    """Database work that must land, run until it does: the database may be restarting."""
    delay = RETRY_SECONDS
    while True:
        try:
            return await run_in_threadpool(work)
        except SQLAlchemyError:
            log.warning("Could not %s; trying again in %.0f s", what, delay, exc_info=True)
        await asyncio.sleep(delay)
        delay = min(RETRY_MAX_SECONDS, delay * 2)


def interrupt_active(database: Engine, before: datetime | None = None) -> list[UUID]:
    with Session(database) as db:
        active = select(Game.id).where(Game.status == "active")
        if before is not None:
            active = active.where(Game.created_at < before)
        ids = list(db.scalars(active))
        if ids:
            db.execute(
                update(Game)
                .where(Game.id.in_(ids))
                .values(status="interrupted", finished_at=utcnow())
            )
            db.commit()
        return ids


def record_end(database: Engine, game_id: UUID, status: str, result: dict[str, Any] | None) -> None:
    with Session(database) as db:
        game = db.get(Game, game_id)
        if game is not None and game.status == "active":
            game.status = status
            game.finished_at = utcnow()
            # Engine error details stay in the engine's log.
            game.result = {key: result.get(key) for key in RESULT_FIELDS} if result else None
            db.commit()


def active_games_of(db: Session, user_id: UUID) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(Game)
            .where(Game.created_by == user_id, Game.status == "active")
        )
        or 0
    )


def full_access(principal: Principal) -> bool:
    return principal.can("games.view_concealed")


def summary_of(db: Session, game: Game, principal: Principal) -> GameSummary:
    seats = db.scalars(select(GameSeat).where(GameSeat.game_id == game.id).order_by(GameSeat.seat))
    rows = list(seats)
    owners = [row.user_id for row in rows if row.user_id is not None]
    found = db.execute(select(User.id, User.handle).where(User.id.in_(owners)))
    handles = {user_id: handle for user_id, handle in found}
    everything = full_access(principal)
    your_seat = next((row.seat for row in rows if row.user_id == principal.user.id), None)
    return GameSummary(
        id=game.id,
        format=cast(GameFormatId, game.format),
        status=game.status,  # type: ignore[arg-type]
        seats=[
            SeatSummary(
                seat=row.seat,
                player=row.player,  # type: ignore[arg-type]
                handle=handles.get(row.user_id) if row.user_id else None,
                deck=row.deck if everything or row.user_id == principal.user.id else None,
            )
            for row in rows
        ],
        your_seat=your_seat,
        bot_skill=game.bot_skill,
        turn_cap=game.turn_cap,
        created_at=game.created_at,
        finished_at=game.finished_at,
        result=GameResult.model_validate(game.result) if game.result else None,
    )


def visible_game(db: Session, game_id: UUID, principal: Principal) -> tuple[Game, bool]:
    """The game and whether the account owns a seat in it. Others' games look like missing ones,
    except to SysOp (T29)."""
    game = db.get(Game, game_id)
    owner = (
        game is not None
        and db.scalar(
            select(GameSeat.id).where(
                GameSeat.game_id == game_id, GameSeat.user_id == principal.user.id
            )
        )
        is not None
    )
    if game is None or not (owner or full_access(principal)):
        raise not_found()
    return game, owner


# HTTP routes.


@router.get("/practice-games/options", response_model=PracticeOptions)
def practice_options(principal: Player) -> PracticeOptions:
    return PracticeOptions(
        formats=[
            PracticeFormat(
                id=cast(GameFormatId, fmt),
                name=FORMAT_NAMES[fmt],
                bots=BOTS[fmt],
                default_bots=DEFAULT_BOTS[fmt],
                decks=decks,
            )
            for fmt, decks in FIXTURE_DECKS.items()
        ],
        deck_lists=principal.can("cards.any"),
    )


def engine_seat(
    player: str, deck: str | None, deck_list: str | None, fmt: str, principal: Principal
) -> dict[str, object]:
    seat: dict[str, object] = {"player": player}
    if deck is not None and deck_list is not None:
        raise ApiError(422, "invalid_seat", "A seat takes a deck or a deck list, not both.")
    if deck is not None:
        if deck not in FIXTURE_DECKS[fmt]:
            raise ApiError(422, "invalid_deck", f"{deck} is not a {FORMAT_NAMES[fmt]} deck.")
        seat["deck"] = deck
    if deck_list is not None:
        if not principal.can("cards.any"):
            raise ApiError(403, "forbidden", "Your account cannot play deck lists yet.")
        seat["deck_list"] = parse_deck_list(deck_list, fmt)
    return seat


def record_game(
    db: Session,
    request: Request,
    principal: Principal,
    created: dict[str, Any],
    body: PracticeGameRequest,
    seats: list[dict[str, object]],
) -> Game:
    now = utcnow()
    game = Game(
        id=UUID(created["game_id"]),
        kind="practice",
        format=body.format,
        status="active",
        created_by=principal.user.id,
        created_at=now,
        bot_skill=body.bot_skill,
        turn_cap=body.turn_cap,
    )
    db.add(game)
    db.flush()
    decks = {entry["seat"]: entry["deck"] for entry in created["settings"]["seats"]}
    for index, seat in enumerate(seats):
        db.add(
            GameSeat(
                game_id=game.id,
                seat=index,
                player=seat["player"],
                user_id=principal.user.id if seat["player"] == "human" else None,
                deck=decks[index],
                deck_list=seat.get("deck_list"),
            )
        )
    lists = [index for index, seat in enumerate(seats) if "deck_list" in seat]
    if lists:
        audit(
            db,
            request,
            "game.deck_lists_used",
            actor_id=principal.user.id,
            details={"game": str(game.id), "seats": [str(index) for index in lists]},
        )
    db.commit()
    return game


@router.post(
    "/practice-games",
    response_model=GameSummary,
    status_code=201,
    responses={429: {"model": Error}},
)
async def create_practice_game(
    body: PracticeGameRequest, request: Request, principal: Player, db: Db
) -> GameSummary:
    """Starts a game against bots. The response names the game; play it over its WebSocket."""
    hub = hub_of(request)
    engine = hub.require_engine()
    fmt = body.format
    bots: list[SeatChoice | None] = (
        list(body.bots) if body.bots is not None else [None] * DEFAULT_BOTS[fmt]
    )
    if len(bots) not in BOTS[fmt]:
        raise ApiError(
            422, "invalid_table", f"{FORMAT_NAMES[fmt]} takes {BOTS[fmt]} bots, not {len(bots)}."
        )
    seats = [engine_seat("human", body.deck, body.deck_list, fmt, principal)] + [
        engine_seat(
            "bot", bot.deck if bot else None, bot.deck_list if bot else None, fmt, principal
        )
        for bot in bots
    ]
    user_id = principal.user.id
    async with hub.locks[user_id]:
        if not full_access(principal):
            running = await run_in_threadpool(active_games_of, db, user_id)
            if running >= hub.settings.games_per_account:
                raise ApiError(
                    409,
                    "game_limit",
                    "Finish or close your running game before starting another.",
                )
        # Other accounts' requests do not wait for this lock, so the slot is taken before the
        # first await: requests at once cannot all pass the check. Once registered, the game
        # holds the slot itself.
        if hub.running() + hub.starting >= hub.settings.games_max:
            raise ApiError(
                429,
                "games_busy",
                "Every game slot is in use. Try again shortly.",
                {"Retry-After": "30"},
            )
        hub.starting += 1
        try:
            try:
                status, created = await engine.request(
                    "POST",
                    "/games",
                    body={
                        "format": fmt,
                        "seats": seats,
                        "skill": body.bot_skill,
                        "turn_cap": body.turn_cap,
                    },
                )
            except EngineUnavailable as error:
                raise unavailable() from error
            if status == 400 and created.get("code") == "unknown_cards":
                names = [str(name) for name in created.get("names", [])]
                raise ApiError(
                    422,
                    "unknown_cards",
                    "The engine has no card named " + ", ".join(names) + ".",
                    names=names,
                )
            if status == 400:
                raise ApiError(422, "invalid_table", str(created.get("message", "Invalid table.")))
            if status == 429:
                raise ApiError(
                    429,
                    "games_busy",
                    "The engine is running every game it can.",
                    {"Retry-After": "30"},
                )
            if status != 201:
                raise unavailable()
            try:
                game = await run_in_threadpool(
                    record_game, db, request, principal, created, body, seats
                )
            except SQLAlchemyError:
                await engine.request("POST", f"/games/{created['game_id']}/close", body={})
                raise
            hub.register(
                LiveGame(
                    id=game.id,
                    owner_id=user_id,
                    seat=0,
                    seat_token=created["seats"][0]["seat_token"],
                )
            )
        finally:
            hub.starting -= 1
        return await run_in_threadpool(summary_of, db, game, principal)


@router.get("/games", response_model=list[GameSummary])
def list_games(
    principal: Player, db: Db, scope: Annotated[Literal["mine", "all"], Query()] = "mine"
) -> list[GameSummary]:
    """Your recent games, newest first; SysOp may list everyone's (scope=all)."""
    statement = select(Game).order_by(Game.created_at.desc()).limit(50)
    if scope == "all":
        if not full_access(principal):
            raise ApiError(403, "forbidden", "Your account does not have permission for this.")
    else:
        statement = statement.where(
            Game.id.in_(select(GameSeat.game_id).where(GameSeat.user_id == principal.user.id))
        )
    return [summary_of(db, game, principal) for game in db.scalars(statement)]


@router.get("/games/{game_id}", response_model=GameState)
async def get_game(game_id: UUID, request: Request, principal: Player, db: Db) -> GameState:
    """The game, with its owner's current seat snapshot while the engine holds it."""
    game, owner = await run_in_threadpool(visible_game, db, game_id, principal)
    if not owner:
        await run_in_threadpool(observed, db, request, principal, game_id, "game.observed")
    hub = hub_of(request)
    live = hub.games.get(game_id)
    snapshot = None
    if live is not None:
        # No pooled connection is held while the engine answers.
        await run_in_threadpool(db.commit)
        try:
            snapshot = await hub.page(live)
        except EngineUnavailable as error:
            raise unavailable() from error
    summary = await run_in_threadpool(summary_of, db, game, principal)
    return GameState(game=summary, snapshot=snapshot)


def observed(
    db: Session, request: Request | WebSocket, principal: Principal, game_id: UUID, action: str
) -> None:
    audit(db, request, action, actor_id=principal.user.id, details={"game": str(game_id)})
    db.commit()


@router.post("/games/{game_id}/close", response_model=GameSummary)
async def close_game(game_id: UUID, request: Request, principal: Player, db: Db) -> GameSummary:
    """Ends the game for every seat: its owner's choice, or SysOp's. The reply shows the game
    as it ended."""
    game, owner = await run_in_threadpool(visible_game, db, game_id, principal)
    hub = hub_of(request)
    live = hub.games.get(game_id)
    # No pooled connection is held while the engine closes the game.
    await run_in_threadpool(db.commit)
    if live is not None and not live.finished:
        try:
            await hub.require_engine().request("POST", f"{live.path}/close", body={})
        except EngineUnavailable as error:
            raise unavailable() from error
        if not owner:
            await run_in_threadpool(observed, db, request, principal, game_id, "game.closed")
    if live is not None:
        # The follow task records the result once the engine's last snapshot reaches it.
        with suppress(TimeoutError):
            await asyncio.wait_for(live.recorded.wait(), CLOSE_WAIT_SECONDS)
    elif game.status == "active":
        # Nothing follows the game: an earlier process ran it, and no seat can play it now.
        # The creator's lock keeps out a game being created, which is recorded before it is
        # registered.
        async with hub.locks[game.created_by]:
            orphan = game_id not in hub.games
            if orphan:
                await run_in_threadpool(record_end, hub.database, game_id, "interrupted", None)
                if not owner:
                    await run_in_threadpool(
                        observed, db, request, principal, game_id, "game.closed"
                    )
        if orphan:
            # The engine may still run it, holding a slot, when the restart's check has not
            # reached the database yet; once it does, that check no longer sees the game.
            await hub.close_orphans([game_id])
    await run_in_threadpool(db.refresh, game)
    return await run_in_threadpool(summary_of, db, game, principal)


@router.get(
    "/games/{game_id}/inspection",
    response_model=dict[str, Any],
    responses={409: {"model": Error}},
)
async def inspect_game(
    game_id: UUID, request: Request, principal: Inspector, db: Db
) -> dict[str, Any]:
    """SysOp's inspection view: every hand and library in order (engine view type
    contracts/engine-inspection.schema.json). Audited."""
    await run_in_threadpool(visible_game, db, game_id, principal)
    hub = hub_of(request)
    if game_id not in hub.games:
        raise ApiError(409, "game_not_live", "The engine no longer holds this game.")
    await run_in_threadpool(observed, db, request, principal, game_id, "game.inspection_opened")
    try:
        status, inspection = await hub.require_engine().request(
            "GET",
            f"/games/{game_id}/inspection",
            params={"wait_ms": INSPECTION_WAIT_MS},
            timeout=INSPECTION_WAIT_MS / 1000 + 10,
        )
    except EngineUnavailable as error:
        raise unavailable() from error
    if status == 409:
        raise ApiError(409, "unsettled", "The game is not waiting for a player. Ask again.")
    if status != 200:
        raise unavailable()
    return cast(dict[str, Any], inspection)


@router.get("/cards", response_model=CardNames)
async def card_names(
    request: Request,
    principal: AnyCard,
    q: Annotated[str, Query(min_length=1, max_length=200)],
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> CardNames:
    """Names of cards the engine implements, for SysOp's deck lists (cards.any)."""
    try:
        status, found = (
            await hub_of(request)
            .require_engine()
            .request("GET", "/cards", params={"q": q, "limit": limit})
        )
    except EngineUnavailable as error:
        raise unavailable() from error
    if status != 200:
        raise unavailable()
    return CardNames.model_validate(found)


# The game's WebSocket.


def connection_principal(
    database: Engine, websocket: WebSocket, *, active: bool = False
) -> Principal | str:
    """The signed-in account behind a WebSocket, or why there is none. A WebSocket cannot set a
    cookie, so a session due for rotation must be refreshed over HTTP first. Commands (active)
    count as activity for the session's idle limit; an open connection alone does not."""
    with Session(database, expire_on_commit=False) as db:
        found = live_session(websocket, db)
        if found is None:
            return "authentication_required"
        session, user = found
        if session.privilege_version != user.privilege_version:
            return "session_refresh"
        if active:
            keep_alive(websocket, db, session, user)
        roles = roles_of(db, user)
        return Principal(user, session, roles, permissions_for(user, roles))


def session_ended(
    database: Engine, websocket: WebSocket, session_id: UUID, *, active: bool = False
) -> str | None:
    """Why an open connection's session no longer stands, as the error code to close with, or
    None while it stands. A session rotated by an HTTP request since the handshake is no sign-out:
    the browser already holds its successor, so the page refreshes and reconnects."""
    principal = connection_principal(database, websocket, active=active)
    if not isinstance(principal, str):
        # The socket's cookie never changes, so another session behind it is its successor
        # (a rotated token stands for it for a moment; see live_session).
        return None if principal.session.id == session_id else "session_refresh"
    # Asked of the cookie's own session, not the connection's: a handshake during the rotation
    # grace holds the successor's id, while its cookie is the rotated one.
    if principal == "authentication_required" and rotated(
        database, websocket.cookies.get(SESSION_COOKIE)
    ):
        return "session_refresh"
    return principal


def rotated(database: Engine, token: str | None) -> bool:
    """Whether the session behind a cookie was rotated and a successor still stands. Rotation
    keeps the CSRF token, so the successor is the account's live session with the same one."""
    if not token:
        return False
    now = utcnow()
    with Session(database) as db:
        old = db.scalar(select(UserSession).where(UserSession.token_hash == hash_token(token)))
        if old is None or old.revoked_reason != "rotated":
            return False
        successors = db.scalars(
            select(UserSession).where(
                UserSession.user_id == old.user_id,
                UserSession.csrf_token == old.csrf_token,
                UserSession.revoked_at.is_(None),
            )
        )
        return any(
            row.idle_expires_at > now and row.absolute_expires_at > now for row in successors
        )


def websocket_game(database: Engine, game_id: UUID, principal: Principal) -> bool | None:
    """Whether the account owns a seat in the game; None if it may not see the game at all."""
    with Session(database) as db:
        try:
            return visible_game(db, game_id, principal)[1]
        except ApiError:
            return None


def origin_refused(websocket: WebSocket) -> bool:
    """Browsers send Origin with every WebSocket handshake; another site's is refused."""
    origin = websocket.headers.get("origin")
    return bool(origin and origin not in settings_of(websocket).allowed_origins) or (
        websocket.headers.get("sec-fetch-site") == "cross-site"
    )


async def refuse(websocket: WebSocket, code: int, reason: str) -> None:
    await websocket.send_json({"type": "error", "code": reason})
    await websocket.close(code, reason)


def crowded(game: LiveGame, user_id: UUID) -> bool:
    """Whether the account, or the game, has all the connections it may have."""
    counted = [connection for connection in game.connections.values() if connection.counted]
    return (
        sum(connection.user_id == user_id for connection in counted) >= CONNECTIONS_PER_ACCOUNT
        or len(counted) >= CONNECTIONS_PER_GAME
    )


@router.websocket("/games/{game_id}/events")
async def game_events(websocket: WebSocket, game_id: UUID) -> None:
    """A game's events and commands. The first message is a hello with the session's CSRF token;
    the protocol is in docs/games.md."""
    hub = hub_of(websocket)
    websocket.state.request_id = secrets.token_hex(16)
    await websocket.accept()
    if origin_refused(websocket):
        await refuse(websocket, CLOSE_FORBIDDEN, "origin_refused")
        return
    database = hub.database
    principal = await run_in_threadpool(connection_principal, database, websocket)
    if isinstance(principal, str):
        await refuse(websocket, CLOSE_UNAUTHENTICATED, principal)
        return
    if principal.user.status != "active" or not principal.can("games.play"):
        await refuse(websocket, CLOSE_FORBIDDEN, "forbidden")
        return
    owner = await run_in_threadpool(websocket_game, database, game_id, principal)
    if owner is None:
        await refuse(websocket, CLOSE_NOT_FOUND, "not_found")
        return
    game = hub.games.get(game_id)
    if game is None:
        await refuse(websocket, CLOSE_GONE, "game_not_live")
        return
    try:
        hello = Hello.model_validate_json(
            await asyncio.wait_for(websocket.receive_text(), HELLO_SECONDS)
        )
    except (TimeoutError, ValidationError, WebSocketDisconnect, KeyError):
        await refuse(websocket, CLOSE_BAD_MESSAGE, "hello_required")
        return
    if not secrets.compare_digest(hello.csrf_token, principal.session.csrf_token):
        await refuse(websocket, CLOSE_FORBIDDEN, "csrf_failed")
        return
    if hello.inspect and not full_access(principal):
        await refuse(websocket, CLOSE_FORBIDDEN, "forbidden")
        return
    # Counted and added with no await between, so handshakes at once cannot all pass.
    counted = not full_access(principal)
    if counted and crowded(game, principal.user.id):
        await refuse(websocket, CLOSE_TOO_MANY, "too_many_connections")
        return

    connection = Connection(
        id=secrets.token_hex(8),
        user_id=principal.user.id,
        session_id=principal.session.id,
        owner=owner,
        inspect=hello.inspect,
        counted=counted,
    )
    game.connections[connection.id] = connection
    try:
        # Structured: the writer and the session watcher end with the connection, and a
        # cancellation from the server unwinds all three together.
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(send_loop, websocket, connection)
            tasks.start_soon(watch_session, database, websocket, connection)
            try:
                await converse(hub, game, connection, websocket, principal, owner, hello)
            finally:
                connection.close(1000)
    finally:
        game.connections.pop(connection.id, None)
        hub.release(game, connection, "disconnected")


async def converse(
    hub: GameHub,
    game: LiveGame,
    connection: Connection,
    websocket: WebSocket,
    principal: Principal,
    owner: bool,
    hello: Hello,
) -> None:
    """Welcomes the connection, then serves its messages until it closes."""
    for action in (["game.observed"] if not owner else []) + (
        ["game.inspection_opened"] if hello.inspect else []
    ):
        await run_in_threadpool(audited, hub.database, websocket, principal, game.id, action)
    connection.send(
        {
            "type": "welcome",
            "game_id": str(game.id),
            "connection_id": connection.id,
            "seat": game.seat if owner else None,
            "role": "observer",
            "controlled": game.controller is not None,
        }
    )
    if hello.control:
        claim(hub, game, connection)
    await resync(hub, game, connection, hello.since)
    if hello.inspect:
        hub.inspect_soon(game)
    await receive_loop(hub, game, connection, websocket)


def audited(
    database: Engine, websocket: WebSocket, principal: Principal, game_id: UUID, action: str
) -> None:
    with Session(database) as db:
        observed(db, websocket, principal, game_id, action)


def claim(hub: GameHub, game: LiveGame, connection: Connection) -> None:
    if connection.owner:
        hub.take_control(game, connection)
    else:
        connection.send(
            {"type": "error", "code": "not_owner", "message": "Only the seat's owner controls it."}
        )


async def resync(hub: GameHub, game: LiveGame, connection: Connection, since: int) -> None:
    """Sends the seat's current snapshot unless the client already has that revision."""
    try:
        snapshot = await hub.page(game)
    except EngineUnavailable:
        snapshot = game.snapshot
    if snapshot is not None and (since < 0 or snapshot["revision"] != since):
        connection.send({"type": "snapshot", "snapshot": snapshot})


async def receive_loop(
    hub: GameHub, game: LiveGame, connection: Connection, websocket: WebSocket
) -> None:
    while connection.close_code is None:
        try:
            text = await websocket.receive_text()
        except (WebSocketDisconnect, RuntimeError, KeyError):
            return
        try:
            message = json.loads(text)
            kind = message["type"]
        except (ValueError, TypeError, KeyError):
            connection.send({"type": "error", "code": "invalid_message"})
            continue
        if kind == "command":
            # Every command checks that the session still stands, and counts as activity. A
            # command stopped here goes nowhere; after a session refresh the client resends it.
            ended = await run_in_threadpool(
                partial(session_ended, active=True),
                hub.database,
                websocket,
                connection.session_id,
            )
            if ended is not None:
                connection.close(CLOSE_UNAUTHENTICATED, ended)
                return
            await hub.command(game, connection, message.get("command"))
        elif kind == "take_control":
            claim(hub, game, connection)
        elif kind == "release_control":
            hub.release(game, connection, "released")
        elif kind == "resync":
            since = message.get("since", -1)
            await resync(hub, game, connection, since if isinstance(since, int) else -1)
        elif kind == "ping":
            connection.send({"type": "pong"})
        else:
            connection.send({"type": "error", "code": "invalid_message"})


async def send_loop(websocket: WebSocket, connection: Connection) -> None:
    """The connection's only writer. Older snapshots than one already sent are skipped."""
    try:
        while True:
            message = await connection.queue.get()
            if message is None:
                break
            if message["type"] == "snapshot":
                revision = message["snapshot"]["revision"]
                finished = message["snapshot"].get("result") is not None
                if revision <= connection.revision and not finished:
                    continue
                connection.revision = revision
            await websocket.send_json(message)
        await websocket.close(connection.close_code or 1000)
    except (WebSocketDisconnect, RuntimeError):
        pass


async def watch_session(database: Engine, websocket: WebSocket, connection: Connection) -> None:
    """Signing out, a revoked session or an expired one ends the connection, as does a role
    change (the client refreshes the session and reconnects). Returns when the connection ends."""
    while connection.close_code is None:
        with anyio.move_on_after(SESSION_CHECK_SECONDS):
            await connection.ended.wait()
        if connection.close_code is not None:
            return
        ended = await run_in_threadpool(session_ended, database, websocket, connection.session_id)
        if ended is not None:
            connection.close(CLOSE_UNAUTHENTICATED, ended)
