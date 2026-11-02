"""Games through the API: seat ownership, the controller lease and game events.

The browser never holds an engine seat token. The API starts each game in the engine with the
service token, keeps each human seat's token in this process's memory, records the game, its
seats and its result in the database, and forwards commands from each seat's owner. Views come
back unchanged from the engine, so the engine's leak rules still decide what a seat sees.

A practice game seats one player against bots. A table game (v0.4.0, api/tables.py) seats every
player of a human table: each seat has its own token, its own follow task and views, its own
controller lease and connections, and its own concession. At a table, a seat with no connected tab
for 2 minutes is away; the other players still in the game may then vote to remove it, and a
majority of them removes it: the API concedes the seat in the engine and the game goes on.

Events go over one WebSocket per game, authenticated by the session cookie and the session's CSRF
token in the first message. One connection per seat holds the controller lease and may command;
taking control from another tab moves the lease, and the old tab observes (AUTH07). Commands
carry an action ID, the expected revision and the prompt ID; the engine runs a resent action once
(T14). SysOp may observe any game and inspect every hand and library (games.view_concealed, its
exception to SEC05 and NET14); every opening is audited.

Turn control (v0.5.1, rule 723) needs nothing here: the engine puts a controlled player's prompts,
marked with their seat, in the controlling seat's own views, so the controller's tab answers them
with its own seat's token and lease, and the controlled player's tab is told who controls its turn.

One API process holds the games: a restart marks the running ones interrupted and closes them in
the engine, because their seat tokens are gone. On PostgreSQL the process holds an advisory lock
for its lifetime, so a second API process on the same database fails to start (GameHub.hold).
"""

import asyncio
import hashlib
import json
import logging
import random
import secrets
import time
from collections import defaultdict
from collections.abc import AsyncIterator, Callable, Coroutine, Hashable
from contextlib import AbstractAsyncContextManager, asynccontextmanager, suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import partial
from typing import Annotated, Any, Literal, cast
from uuid import UUID, uuid4

import anyio
import httpx
from fastapi import APIRouter, Depends, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import Connection as DatabaseConnection
from sqlalchemy import Engine, func, select, text, update
from sqlalchemy.exc import InterfaceError, OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api.auth import INPUT_ERRORS
from api.config import Settings
from api.custom_play import custom_in_seats
from api.decklists import in_game, parse_deck_list, refuse_unplayable
from api.decks import publish, revision_entries, starters_of
from api.economy import pay_game, tokens_from
from api.engine_cards import engine_cards_of
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
from api.library import Library, Starter, library_of, starter_entries
from api.models import (
    CampaignGame,
    CardConcept,
    CatalogRevision,
    CustomCard,
    Deck,
    FormatVersion,
    Game,
    GameSeat,
    Match,
    MatchPlayer,
    User,
    UserSession,
)
from api.progression import count_win
from api.roster import roster_of
from api.schemas import (
    BotsSetting,
    CampaignRef,
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
    TableRules,
)
from api.schemas import GameSeat as SeatSummary
from api.stand_ins import stand_ins
from api.teams import TEAMS, assign_and_check
from api.validation import DeckContent, DeckEntry, Problem, not_allowed, validate_deck
from catalog.statuses import playable
from catalog.text import normalize

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
    # Two-Headed Giant (v0.5.0, early, api/teams.py): the four Legacy fixtures.
    "two_headed_giant": [
        "legacy-mono-red-burn",
        "legacy-mono-green-creatures",
        "legacy-mono-white-weenie",
        "legacy-mono-blue-skies",
    ],
}
BOTS = {"legacy": [1], "commander": [1, 2, 3], "two_headed_giant": [3]}
DEFAULT_BOTS = {"legacy": 1, "commander": 3, "two_headed_giant": 3}
# Best of one game, or (v0.5.0) a best-of-three match with sideboards: Legacy only.
BEST_OF = {"legacy": [1, 3], "commander": [1], "two_headed_giant": [1]}
FORMAT_NAMES = {
    "legacy": "Legacy",
    "commander": "Commander",
    "two_headed_giant": "Two-Headed Giant",
}
# The format a game's decks are built for, when it is not the game's own: Two-Headed Giant plays
# Legacy decks, under Legacy's legality and format versions.
DECK_FORMATS = {"two_headed_giant": "legacy"}
SERVICE_HEADER = "X-Service-Token"
LONG_POLL_MS = 25_000
INSPECTION_WAIT_MS = 3_000
RETAIN_FINISHED_SECONDS = 600.0
# How long closing a game waits for its result to be recorded, so the reply shows it.
CLOSE_WAIT_SECONDS = 5.0
# Creating a game waits this long for the engine (v0.8.3; other requests wait 10 s): its decks load
# before it answers. Read when a game is created.
CREATE_TIMEOUT_SECONDS = 30.0
# Database writes that must land (a game's end, the restart sweep) retry, doubling the wait.
RETRY_SECONDS = 1.0
RETRY_MAX_SECONDS = 30.0
HELLO_SECONDS = 10.0
SESSION_CHECK_SECONDS = 60.0
QUEUE_LIMIT = 512
# Every connection costs a copy of each snapshot. SysOp's are not counted.
CONNECTIONS_PER_ACCOUNT = 4
# For each player's seat: a four-player table may hold four times as many.
CONNECTIONS_PER_GAME = 8
RESULT_FIELDS = ("kind", "winner_seat", "winner_seats", "draw", "turns", "conceded_seats")
# At a table, a seat with no connected tab for this long is away, and may be voted out.
AWAY_SECONDS = 120.0
# The engine closes a game in which nothing has happened for this long (idle_timeout). A table
# has no turn timers, so its backstop is the engine's longest: a player thinking for minutes keeps
# the game, and an away player is voted out long before. Practice games keep the engine's 15.
TABLE_IDLE_SECONDS = 3600
LEFT_REASONS = ("conceded", "removed", "eliminated")

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
    # A typed name, for choose_name prompts (naming a card); the engine checks it against its list.
    text: str | None = Field(default=None, min_length=1, max_length=200)


PriorityStep = Literal[
    "upkeep", "draw", "main1", "before_combat", "end_of_combat", "main2", "end_of_turn"
]


class PriorityPayload(BaseModel):
    """A change to the seat's priority controls (UI07); left out, a setting stays as it is."""

    model_config = ConfigDict(extra="forbid")
    your_turn: list[PriorityStep] | None = Field(default=None, max_length=7)
    opponent_turn: list[PriorityStep] | None = Field(default=None, max_length=7)
    stop_on_new_stack_objects: bool | None = None
    stop_on_attackers: bool | None = None
    stop_on_blockers: bool | None = None
    pass_after_casting: bool | None = None
    full_control: bool | None = None
    cancel_passes: bool | None = None


class GameCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    v: Literal[1]
    game_id: UUID
    action_id: UUID
    expected_revision: int = Field(ge=0)
    prompt_id: UUID | None = None
    type: Literal["submit_choice", "concede", "set_priority"]
    payload: ChoicePayload | PriorityPayload

    @model_validator(mode="after")
    def payload_matches_type(self) -> "GameCommand":
        if self.type == "set_priority":
            settings = self.payload
            if not isinstance(settings, PriorityPayload) or not settings.model_dump(
                exclude_none=True
            ):
                raise ValueError("set_priority needs at least one setting")
            if self.prompt_id is not None:
                raise ValueError("set_priority takes no prompt_id")
            return self
        if not isinstance(self.payload, ChoicePayload):
            raise ValueError("submit_choice and concede take a choice payload")
        chosen = (
            (self.payload.option_id is not None)
            + (self.payload.amounts is not None)
            + (self.payload.text is not None)
        )
        if self.type == "submit_choice" and (self.prompt_id is None or chosen != 1):
            raise ValueError("submit_choice needs prompt_id and one of option_id, amounts and text")
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
    # The seat its account plays; None for an observer (SysOp), who sees the first player's.
    seat: int | None
    inspect: bool
    # Whether it counts toward the connection limits: SysOp's do not.
    counted: bool = True
    queue: asyncio.Queue[dict[str, Any] | None] = field(
        default_factory=lambda: asyncio.Queue(QUEUE_LIMIT)
    )
    revision: int = -1
    close_code: int | None = None
    ended: anyio.Event = field(default_factory=anyio.Event)
    # Until its first page of the log is queued (opened), the snapshots published to a new
    # connection wait here: each carries only the log lines new since the one before, so one
    # reaching the client first would make it drop the page as a revision it already holds.
    held: list[dict[str, Any]] | None = field(default_factory=list)

    def send(self, message: dict[str, Any]) -> None:
        if self.close_code is not None:
            return
        if self.held is not None and message["type"] == "snapshot":
            if len(self.held) >= QUEUE_LIMIT:
                self.close(CLOSE_TOO_SLOW)
            else:
                self.held.append(message)
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

    def opened(self, page: dict[str, Any] | None) -> None:
        """Queues the connection's first page (None when the client holds its revision already),
        then the snapshots published meanwhile, which the writer skips when the page covers them.
        Later snapshots go straight to the queue."""
        held, self.held = self.held, None
        for message in ([page] if page is not None else []) + (held or []):
            self.send(message)


@dataclass(eq=False)
class LiveSeat:
    """A player's seat in a running game: its engine token, its controller lease, the views its
    follow task fetched and, at a table, whether its player is away."""

    seat: int
    user_id: UUID
    token: str
    controller: str | None = None
    # The follow task's latest snapshot, which carries only the log lines new since the one before.
    snapshot: dict[str, Any] | None = None
    # The latest snapshot with a whole page of the log, for new connections and resyncs.
    page: dict[str, Any] | None = None
    paging: asyncio.Lock = field(default_factory=asyncio.Lock)
    # Since when no tab of the seat's player is connected (time.monotonic), or None while one is.
    away_since: float | None = None
    # Why the seat is out of a game that goes on: conceded, removed or eliminated.
    left: str | None = None
    # Votes on removing the seat while it is away, by the voting seat: True for yes.
    votes: dict[int, bool] = field(default_factory=dict)
    # A concession or a removal on its way to the engine: the view that shows the seat out is
    # theirs, not a loss.
    conceding: bool = False
    removing: bool = False


@dataclass(eq=False)
class LiveGame:
    """A running game this process started: its players' seats and tokens, and who is watching."""

    id: UUID
    seats: dict[int, LiveSeat]
    kind: str = "practice"
    connections: dict[str, Connection] = field(default_factory=dict)
    finished: bool = False
    # Set once a follow task has begun to record the game's end, which happens once.
    ending: bool = False
    # Set once the database holds how the game ended.
    recorded: asyncio.Event = field(default_factory=asyncio.Event)
    inspecting: bool = False
    inspect_again: bool = False
    # At a table (v0.4.4, api/table_chat.py): the alliances, each a pair of seats, and the offers
    # waiting for an answer, each (from, to).
    alliances: set[frozenset[int]] = field(default_factory=set)
    offers: set[tuple[int, int]] = field(default_factory=set)
    # A Two-Headed Giant table's game (v0.5.1): the teams are fixed, and the allies-only channel
    # is each team's, its two players allied from the start when both are players.
    teams: bool = False

    def __post_init__(self) -> None:
        if self.teams:
            self.alliances = {frozenset(pair) for pair in TEAMS if set(pair) <= self.seats.keys()}

    @property
    def path(self) -> str:
        return f"/games/{self.id}"

    @property
    def watched(self) -> LiveSeat:
        """The seat observers see: the first player's."""
        return self.seats[min(self.seats)]

    def seat_of(self, user_id: UUID) -> LiveSeat | None:
        return next((seat for seat in self.seats.values() if seat.user_id == user_id), None)

    def viewed(self, connection: Connection) -> LiveSeat:
        """The seat whose views a connection receives: its own, or the watched one."""
        if connection.seat is not None and connection.seat in self.seats:
            return self.seats[connection.seat]
        return self.watched


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


@dataclass(eq=False)
class Held:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # The tasks holding the lock or waiting for it.
    users: int = 0


class KeyedLocks:
    """asyncio locks by key: an account's, a table's, a game's or a match's id. A key's lock is
    kept only while a task holds it or waits for it, so the map does not grow with every id ever
    locked. ``async with locks[key]`` holds it."""

    def __init__(self) -> None:
        self.held: dict[Hashable, Held] = {}

    def __getitem__(self, key: Hashable) -> AbstractAsyncContextManager[None]:
        return self.hold(key)

    def __len__(self) -> int:
        return len(self.held)

    def locked(self, key: Hashable) -> bool:
        """Whether a task holds the key's lock. Asking keeps nothing."""
        found = self.held.get(key)
        return found is not None and found.lock.locked()

    @asynccontextmanager
    async def hold(self, key: Hashable) -> AsyncIterator[None]:
        held = self.held.setdefault(key, Held())
        held.users += 1
        try:
            async with held.lock:
                yield
        finally:
            held.users -= 1
            if not held.users:
                del self.held[key]


def lock_key(schema: str) -> int:
    """The advisory lock a process running the games holds: one for each database schema."""
    digest = hashlib.blake2b(f"commander-duels.games:{schema}".encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big", signed=True)


class GameHub:
    """The games this API process is running, and the tasks that follow them."""

    def __init__(self, settings: Settings, database: Engine, engine: EngineClient | None) -> None:
        self.settings = settings
        self.database = database
        self.engine = engine
        self.games: dict[UUID, LiveGame] = {}
        self.locks = KeyedLocks()
        self.tasks: set[asyncio.Task[None]] = set()
        # The connection holding the advisory lock on running the games (PostgreSQL only).
        self.holder: DatabaseConnection | None = None
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
        task.add_done_callback(self.task_done)

    def task_done(self, task: asyncio.Task[None]) -> None:
        """A task's failure is logged when it happens (v0.8.3), not when the task is collected."""
        self.tasks.discard(task)
        if not task.cancelled() and (error := task.exception()) is not None:
            log.error("A game task failed", exc_info=error)

    def running(self) -> int:
        return sum(not game.finished for game in self.games.values())

    async def start(self) -> None:
        """Games left active by an earlier process cannot be played: their tokens are gone. While
        the database cannot be reached (it may still be starting), the check retries in the
        background. On PostgreSQL the process first takes the lock on running the games (hold),
        waiting while the database cannot be reached."""
        await retried(self.hold, "take the lock on running the games")
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

    def hold(self) -> None:
        """Takes PostgreSQL's session-level advisory lock on running the games, on a connection of
        its own, held until the process stops. The running games, their seat tokens, the queues'
        claims and the limits live in this process's memory, so the API runs as one process: a
        second one would mark this one's games interrupted as it starts and reset its queues'
        claims. A second process therefore fails to start. Other databases (SQLite, in tests)
        take no lock."""
        if self.database.dialect.name != "postgresql" or self.holder is not None:
            return
        connection = self.database.connect()
        try:
            schema: str = connection.execute(text("SELECT current_schema()")).scalar_one()
            taken: bool = connection.execute(
                text("SELECT pg_try_advisory_lock(:key)"), {"key": lock_key(schema)}
            ).scalar_one()
            connection.commit()
        except BaseException:
            connection.close()
            raise
        if not taken:
            connection.close()
            log.critical(
                "Another API process is running the games of this database (schema %s): the API "
                "runs as one process. Stop the other process, or run one worker (no --workers, "
                "WEB_CONCURRENCY unset or 1).",
                schema,
            )
            raise RuntimeError("A second API process is running on this database")
        # Out of the pool: the pool may replace it, and closing it ends the session and the lock.
        connection.detach()
        self.holder = connection

    async def stop(self) -> None:
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        if self.holder is not None:
            holder, self.holder = self.holder, None
            await run_in_threadpool(holder.close)

    def reserve(self) -> None:
        """Takes a game slot under CD_GAMES_MAX for a game about to be created; the caller gives it
        back (starting -= 1) once the game is registered or refused. Taken before the first await,
        so requests at once cannot all pass the check."""
        if self.running() + self.starting >= self.settings.games_max:
            raise ApiError(
                429,
                "games_busy",
                "Every game slot is in use. Try again shortly.",
                {"Retry-After": "30"},
            )
        self.starting += 1

    def register(self, game: LiveGame) -> None:
        self.games[game.id] = game
        now = time.monotonic()
        for seat in game.seats.values():
            # Nobody has connected yet: a player who never comes is away from the start.
            seat.away_since = now
            self.spawn(self.follow(game, seat))
            if game.kind == "table":
                self.spawn(self.away_check(game, seat, now))

    async def follow(self, game: LiveGame, seat: LiveSeat) -> None:
        """Long-polls one seat's view and publishes every new revision to the connections that see
        that seat, until the game finishes; then records the result, once for the game. If
        following fails in a way it cannot recover from, the game ends as interrupted (v0.8.3)
        rather than staying active with nothing to follow it."""
        try:
            await self.following(game, seat)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception(
                "Following game %s, seat %d, failed; it ends interrupted", game.id, seat.seat
            )
            await self.end(game, None)

    async def following(self, game: LiveGame, seat: LiveSeat) -> None:
        engine = self.require_engine()
        since, log_from, failures = -1, 0, 0
        while True:
            try:
                status, snapshot = await engine.request(
                    "GET",
                    f"{game.path}/view",
                    seat_token=seat.token,
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
            if (
                not isinstance(snapshot.get("revision"), int)
                or not isinstance(snapshot.get("log"), list)
                or not isinstance(snapshot.get("log_from"), int)
            ):
                # A view the API cannot read (v0.8.3): tried again, as an unreachable engine is.
                log.warning("Game %s sent a view without its revision or log", game.id)
                failures += 1
                await asyncio.sleep(min(30.0, 0.5 * 2 ** min(failures, 6)))
                continue
            failures = 0
            finished = snapshot.get("result") is not None
            if snapshot["revision"] != since or finished:
                since = snapshot["revision"]
                log_from = snapshot["log_from"] + len(snapshot["log"])
                seat.snapshot = snapshot
                self.publish(game, seat, {"type": "snapshot", "snapshot": snapshot})
                if seat is game.watched:
                    self.inspect_soon(game)
                out = snapshot.get("status") == "eliminated"
                if out and not finished and not (seat.conceding or seat.removing):
                    self.seat_left(game, seat, "eliminated")
            if finished:
                await self.end(game, snapshot["result"])
                return

    async def end(self, game: LiveGame, result: dict[str, Any] | None) -> None:
        """Records how the game ended (a missing game was interrupted), then keeps it readable
        for a while before forgetting its tokens. Until the end is recorded the game counts
        against its players' limits, so the write retries until it lands. Every seat's follow task
        comes here; the first records, and the others' last views still reach their seats."""
        if game.ending:
            return
        game.ending = True
        game.finished = True
        status = "finished" if result is not None else "interrupted"
        if result is None:
            self.broadcast(game, {"type": "interrupted", "game_id": str(game.id)})
        await self.record(game, status, result)
        game.recorded.set()
        self.presence_changed(game)
        # A match's game (v0.5.0): sideboarding for the next one starts its clock. Imported here:
        # api.matches imports this module.
        from api import matches

        try:
            await matches.after_game(self, game.id)
        except SQLAlchemyError:
            pass
        except Exception:
            # Logged, and the game is still forgotten after its time (v0.8.3).
            log.exception("The match of game %s could not go on", game.id)
        await asyncio.sleep(RETAIN_FINISHED_SECONDS)
        for connection in list(game.connections.values()):
            connection.close(1000)
        self.games.pop(game.id, None)

    async def record(self, game: LiveGame, status: str, result: dict[str, Any] | None) -> None:
        """Writes the game's end, retried while the database is unreachable. A write that fails for
        any other reason (v0.8.3) is logged, and the game is recorded interrupted instead, with no
        result; if even that fails, the game alone is marked interrupted. Either way the game
        stops counting as its players' running game."""
        what = f"record the end of game {game.id}"
        content_dir = self.settings.content_dir
        try:
            await retried(
                partial(record_end, self.database, game.id, status, result, content_dir), what
            )
            return
        except Exception:
            log.exception("Could not %s; recording it interrupted", what)
        if status != "interrupted" or result is not None:
            try:
                await retried(
                    partial(record_end, self.database, game.id, "interrupted", None, content_dir),
                    what,
                )
                return
            except Exception:
                log.exception("Could not record game %s interrupted", game.id)
        try:
            await retried(partial(force_interrupted, self.database, game.id), what)
        except Exception:
            log.exception("Could not mark game %s interrupted", game.id)

    def broadcast(self, game: LiveGame, message: dict[str, Any]) -> None:
        for connection in list(game.connections.values()):
            connection.send(message)

    def publish(self, game: LiveGame, seat: LiveSeat, message: dict[str, Any]) -> None:
        """Sends a seat's view to the connections that see it: never to another player's."""
        for connection in list(game.connections.values()):
            if game.viewed(connection) is seat:
                connection.send(message)

    def lease_changed(self, game: LiveGame, seat: LiveSeat, reason: str) -> None:
        for connection in list(game.connections.values()):
            if game.viewed(connection) is seat:
                connection.send(
                    {
                        "type": "lease",
                        "role": "controller" if seat.controller == connection.id else "observer",
                        "controlled": seat.controller is not None,
                        "reason": reason,
                    }
                )

    def take_control(self, game: LiveGame, connection: Connection) -> None:
        """The seat's lease moves to this connection; any other tab loses it and observes."""
        seat = game.viewed(connection)
        taken = seat.controller is not None and seat.controller != connection.id
        seat.controller = connection.id
        self.lease_changed(game, seat, "taken_over" if taken else "granted")

    def release(self, game: LiveGame, connection: Connection, reason: str) -> None:
        seat = game.seats.get(connection.seat) if connection.seat is not None else None
        if seat is not None and seat.controller == connection.id:
            seat.controller = None
            self.lease_changed(game, seat, reason)

    # Players away from a table, and the votes to remove them.

    def arrived(self, game: LiveGame, connection: Connection) -> None:
        """A tab of the seat's player connected: the seat is back, and votes on it end. The new
        connection learns who is away."""
        seat = game.seats.get(connection.seat) if connection.seat is not None else None
        if seat is not None and seat.away_since is not None:
            seat.away_since = None
            seat.votes.clear()
            self.presence_changed(game)
        elif game.kind == "table":
            connection.send(self.presence(game))

    def departed(self, game: LiveGame, connection: Connection) -> None:
        """A connection closed. When it was its seat's last, the seat is away from now."""
        seat = game.seats.get(connection.seat) if connection.seat is not None else None
        if seat is None or seat.away_since is not None or game.finished:
            return
        if any(other.seat == seat.seat for other in game.connections.values()):
            return
        seat.away_since = time.monotonic()
        self.presence_changed(game)
        if game.kind == "table":
            self.spawn(self.away_check(game, seat, seat.away_since))

    async def away_check(self, game: LiveGame, seat: LiveSeat, since: float) -> None:
        """Tells the table once a seat has been away long enough to be voted out."""
        await asyncio.sleep(AWAY_SECONDS)
        if seat.away_since == since and not game.finished and self.games.get(game.id) is game:
            self.presence_changed(game)

    def removable(self, game: LiveGame, seat: LiveSeat) -> bool:
        return (
            game.kind == "table"
            and not game.finished
            and seat.left is None
            and not seat.removing
            and seat.away_since is not None
            and time.monotonic() - seat.away_since >= AWAY_SECONDS
        )

    @staticmethod
    def voters(game: LiveGame, seat: LiveSeat) -> list[LiveSeat]:
        """Who votes on removing a seat: every other player still in the game."""
        return [other for other in game.seats.values() if other is not seat and other.left is None]

    def presence(self, game: LiveGame) -> dict[str, Any]:
        """Who is away, for how long, and the votes on removing them."""
        now = time.monotonic()
        seats = []
        for seat in sorted(game.seats.values(), key=lambda found: found.seat):
            voters = {other.seat for other in self.voters(game, seat)}
            seats.append(
                {
                    "seat": seat.seat,
                    "connected": seat.away_since is None,
                    "away_seconds": (
                        None if seat.away_since is None else int(now - seat.away_since)
                    ),
                    "left": seat.left,
                    "removable": self.removable(game, seat),
                    "yes": sorted(s for s, yes in seat.votes.items() if yes and s in voters),
                    "no": sorted(s for s, yes in seat.votes.items() if not yes and s in voters),
                    "needed": len(voters) // 2 + 1,
                }
            )
        return {"type": "presence", "away_after": int(AWAY_SECONDS), "seats": seats}

    def presence_changed(self, game: LiveGame) -> None:
        if game.kind == "table":
            self.broadcast(game, self.presence(game))

    def seat_left(self, game: LiveGame, seat: LiveSeat, reason: str) -> None:
        """A seat out of a table's game that goes on (it conceded or lost): recorded, so it no
        longer counts against its player's running games, and shown to the table."""
        if game.kind != "table" or seat.left is not None or game.finished:
            return
        seat.left = reason
        seat.votes.clear()
        # Imported here: api.table_chat imports api.chat, which imports api.admin, which imports
        # this module.
        from api import table_chat

        table_chat.seat_out(self, game, seat)
        self.spawn(
            self.recorded_left(
                partial(record_left, self.database, game.id, seat.seat, reason),
                f"record seat {seat.seat} leaving game {game.id}",
            )
        )
        self.presence_changed(game)

    @staticmethod
    async def recorded_left(work: Callable[[], None], what: str) -> None:
        await retried(work, what)

    async def vote(
        self,
        game: LiveGame,
        connection: Connection,
        websocket: WebSocket,
        target: int,
        remove: bool,
    ) -> tuple[str, str] | None:
        """A player's vote on removing an away seat; None when counted, else the refusal. It passes
        when a majority of the other players still in the game vote yes (in a two-player game,
        the one opponent), and the seat is removed then."""
        voter = game.seats.get(connection.seat) if connection.seat is not None else None
        seat = game.seats.get(target)
        if voter is None or game.kind != "table":
            return "not_a_player", "Only the table's players vote."
        if seat is None or seat is voter:
            return "invalid_vote", "There is no such player to vote on."
        if voter.left is not None:
            return "not_in_game", "You are out of this game, so you no longer vote."
        if not self.removable(game, seat):
            return (
                "not_removable",
                "That player is not away, or has not been away for "
                f"{int(AWAY_SECONDS // 60)} minutes yet.",
            )
        seat.votes[voter.seat] = remove
        voters = self.voters(game, seat)
        yes = [other for other in voters if seat.votes.get(other.seat)]
        if len(yes) >= len(voters) // 2 + 1:
            return await self.remove(game, seat, yes, websocket, voter)
        self.presence_changed(game)
        return None

    async def remove(
        self,
        game: LiveGame,
        seat: LiveSeat,
        voters: list[LiveSeat],
        websocket: WebSocket,
        deciding: LiveSeat,
    ) -> tuple[str, str] | None:
        """Concedes an away seat the vote removed, in the engine with the seat's own token, and
        audits it (table.player_removed). The game goes on for the others."""
        seat.removing = True
        self.presence_changed(game)
        body = {
            "v": 1,
            "game_id": str(game.id),
            "action_id": str(uuid4()),
            "expected_revision": seat.snapshot["revision"] if seat.snapshot else 0,
            "type": "concede",
            "payload": {},
        }
        try:
            status, _ = await self.require_engine().request(
                "POST", f"{game.path}/commands", seat_token=seat.token, body=body
            )
        except EngineUnavailable:
            status = 503
        if status != 200:
            seat.removing = False
            self.presence_changed(game)
            return "removal_failed", "The rules engine did not remove the player. Vote again."
        seat.left = "removed"
        seat.removing = False
        seat.votes.clear()
        await retried(
            partial(
                record_removal,
                self.database,
                websocket,
                game.id,
                seat,
                [other.user_id for other in voters],
                deciding.user_id,
            ),
            f"record the removal of seat {seat.seat} from game {game.id}",
        )
        self.presence_changed(game)
        return None

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

    async def snapshot(self, game: LiveGame, seat: LiveSeat) -> dict[str, Any] | None:
        """A seat's snapshot now, with the latest page of the log."""
        status, snapshot = await self.require_engine().request(
            "GET", f"{game.path}/view", seat_token=seat.token
        )
        return snapshot if status == 200 and isinstance(snapshot, dict) else None

    async def page(self, game: LiveGame, seat: LiveSeat) -> dict[str, Any] | None:
        """The seat snapshot for a new connection, a resync or a read over HTTP. The engine builds
        one for each revision the follow task sees, and every later ask gets that copy, so opening
        connections or asking to resync costs the engine nothing more."""
        async with seat.paging:
            if not covers(seat.page, seat.snapshot):
                seat.page = await self.snapshot(game, seat)
            return seat.page

    async def command(self, game: LiveGame, connection: Connection, raw: object) -> None:
        action_id = raw.get("action_id") if isinstance(raw, dict) else None

        def reply(status: int, body: object) -> None:
            connection.send(
                {"type": "command_result", "action_id": action_id, "status": status, "body": body}
            )

        seat = game.seats.get(connection.seat) if connection.seat is not None else None
        if seat is None or seat.controller != connection.id:
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
        conceding = command.type == "concede"
        seat.conceding = seat.conceding or conceding
        try:
            status, body = await self.require_engine().request(
                "POST",
                f"{game.path}/commands",
                seat_token=seat.token,
                body=command.engine_body(),
            )
        except EngineUnavailable:
            reply(
                503, {"code": "engine_unavailable", "message": "The game engine is not responding."}
            )
            return
        finally:
            if conceding:
                seat.conceding = False
        reply(status, body)
        if status == 200 and conceding:
            self.seat_left(game, seat, "conceded")


def hub_of(request: Request | WebSocket) -> GameHub:
    return cast(GameHub, request.app.state.games)


# Database work, run in the thread pool from the event loop.


async def retried[T](work: Callable[[], T], what: str) -> T:
    """Database work that must land, run until it does: the database may be restarting. Since
    v0.8.3 only an unreachable or restarting database is waited for; any other error (a constraint,
    bad data, a bug) would fail every time, so it is raised to the caller."""
    delay = RETRY_SECONDS
    while True:
        try:
            return await run_in_threadpool(work)
        except (OperationalError, InterfaceError):
            log.warning("Could not %s; trying again in %.0f s", what, delay, exc_info=True)
        await asyncio.sleep(delay)
        delay = min(RETRY_MAX_SECONDS, delay * 2)


def interrupt_active(database: Engine, before: datetime | None = None) -> list[UUID]:
    # Imported here: api.awards reaches api.social, which imports api.admin, which imports this.
    from api.awards import settle

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
            # Each player's history shows the game, with no result (v0.5.0); a campaign duel
            # (v0.8.0) is the campaign's, which records it unfinished.
            for game in db.scalars(select(Game).where(Game.id.in_(ids))):
                link = db.get(CampaignGame, game.id)
                if link is not None:
                    link.outcome, link.finished_at = "unfinished", utcnow()
                else:
                    settle(db, game)
            # Their matches (v0.5.0) count them as games without a result.
            from api import matches  # Imported here: api.matches imports this module.

            matches.games_interrupted(db, ids)
            db.commit()
        return ids


def record_end(
    database: Engine,
    game_id: UUID,
    status: str,
    result: dict[str, Any] | None,
    content_dir: str | None = None,
) -> None:
    """Records how the game ended and, in the same transaction, the win of a player's seat that
    won it (api/progression.py), the tokens it pays (api/economy.py), and since v0.5.0 the
    players' results with the winner's quests and achievements (api/awards.py), so a result is
    never recorded without its win, its pay and its rewards, or twice. Since v0.5.0 a match's
    game also counts in its match (api/matches.py), which ends or goes on to its next game.
    Since v0.8.0 a campaign duel's end is the campaign's instead (api/campaign.py): no win and no
    quests, and for a win the encounter and its rewards (a first win's spoils: the warden's deck
    and tokens), in this same transaction."""
    # Imported here, as above; api.matches and api.campaign import this module.
    from api import campaign, matches
    from api.awards import settle

    with Session(database) as db:
        game = db.get(Game, game_id)
        if game is not None and game.status == "active":
            game.status = status
            game.finished_at = utcnow()
            # Engine error details stay in the engine's log.
            game.result = recorded(result) if result else None
            db.flush()
            link = db.get(CampaignGame, game.id)
            # A game SysOp played with passive bots (v0.8.6) pays nothing out: no win, tokens,
            # quests or achievements, and in the campaign no spoils or chapter rewards, though a
            # won duel still moves SysOp's own campaign on, for testing the wards that follow.
            payouts = not game.passive_bots_used
            if link is not None:
                content = campaign.campaign_in(content_dir) if content_dir else None
                campaign.game_ended(db, game, link, content, content_dir, payouts=payouts)
            elif payouts:
                count_win(db, game)
                pay_game(db, game)
                settle(db, game)
                matches.game_ended(db, game)
            else:
                matches.game_ended(db, game)
            db.commit()


def force_interrupted(database: Engine, game_id: UUID) -> None:
    """The last resort when a game's end cannot be recorded (v0.8.3): the game alone marked
    interrupted, so it no longer counts as its players' running game. Nothing else is written."""
    with Session(database) as db:
        db.execute(
            update(Game)
            .where(Game.id == game_id, Game.status == "active")
            .values(status="interrupted", finished_at=utcnow())
        )
        db.commit()


def recorded(result: dict[str, Any]) -> dict[str, Any]:
    """The engine's result as the game keeps it. An engine before v0.5.0 names no winning team:
    its winning seats are the winner alone."""
    kept = {key: result.get(key) for key in RESULT_FIELDS}
    if kept["winner_seats"] is None:
        kept["winner_seats"] = [] if kept["winner_seat"] is None else [kept["winner_seat"]]
    return kept


def record_left(database: Engine, game_id: UUID, seat: int, reason: str) -> None:
    """A seat out of a game that goes on, once."""
    with Session(database) as db:
        db.execute(
            update(GameSeat)
            .where(GameSeat.game_id == game_id, GameSeat.seat == seat, GameSeat.left_at.is_(None))
            .values(left_at=utcnow(), left_reason=reason)
        )
        db.commit()


def record_removal(
    database: Engine,
    websocket: WebSocket,
    game_id: UUID,
    seat: LiveSeat,
    voters: list[UUID],
    deciding: UUID,
) -> None:
    """A seat the other players removed while it was away, and its audit entry, together."""
    with Session(database) as db:
        found = db.scalar(
            select(GameSeat).where(GameSeat.game_id == game_id, GameSeat.seat == seat.seat)
        )
        if found is not None and found.left_reason == "removed":
            return
        if found is not None:
            found.left_at = found.left_at or utcnow()
            found.left_reason = "removed"
        # Removed from a match's game, the player is out of the match (v0.5.0).
        from api import matches  # Imported here: api.matches imports this module.

        matches.player_removed(db, game_id, seat.user_id)
        audit(
            db,
            websocket,
            "table.player_removed",
            actor_id=deciding,
            target_user_id=seat.user_id,
            details={
                "game": str(game_id),
                "seat": seat.seat,
                "voters": [str(voter) for voter in voters],
            },
        )
        db.commit()


def active_games_of(db: Session, user_id: UUID) -> int:
    """The account's running games: those where its seat is still in play. A seat that conceded,
    was removed or lost while a table's game goes on no longer counts. Since v0.5.0 a match counts
    as one running game, between its games too, until it ends or the player leaves it."""
    games = (
        db.scalar(
            select(func.count(func.distinct(Game.id)))
            .select_from(Game)
            .join(GameSeat, GameSeat.game_id == Game.id)
            .where(
                GameSeat.user_id == user_id,
                GameSeat.left_at.is_(None),
                Game.status == "active",
                Game.match_id.is_(None),
            )
        )
        or 0
    )
    return games + running_matches_of(db, user_id)


def running_matches_of(db: Session, user_id: UUID) -> int:
    """The account's matches still being played (v0.5.0, api/matches.py), which it has not left."""
    return (
        db.scalar(
            select(func.count())
            .select_from(MatchPlayer)
            .join(Match, Match.id == MatchPlayer.match_id)
            .where(
                MatchPlayer.user_id == user_id,
                MatchPlayer.left_at.is_(None),
                Match.status.in_(("playing", "sideboarding")),
            )
        )
        or 0
    )


def full_access(principal: Principal) -> bool:
    return principal.can("games.view_concealed")


def passive_switchable(game: Game, rows: list[GameSeat], principal: Principal) -> bool:
    """Whether SysOp may switch this game's bots (v0.8.6): SysOp's own running practice game
    (a campaign duel is one), with SysOp its only human seat and at least one bot."""
    humans = [row for row in rows if row.player == "human"]
    return (
        principal.user.kind == "sysop"
        and game.status == "active"
        and game.kind == "practice"
        and len(humans) == 1
        and humans[0].user_id == principal.user.id
        and any(row.player == "bot" for row in rows)
    )


def summary_of(db: Session, game: Game, principal: Principal) -> GameSummary:
    # A match's game (v0.5.0) shows its match. Imported here: api.matches imports this module.
    from api.matches import match_ref

    seats = db.scalars(select(GameSeat).where(GameSeat.game_id == game.id).order_by(GameSeat.seat))
    rows = list(seats)
    owners = [row.user_id for row in rows if row.user_id is not None]
    found = db.execute(select(User.id, User.handle, User.alliance).where(User.id.in_(owners)))
    handles, alliances = {}, {}
    for user_id, handle, alliance in found:
        handles[user_id], alliances[user_id] = handle, alliance
    everything = full_access(principal)
    your_seat = next((row.seat for row in rows if row.user_id == principal.user.id), None)
    # A campaign duel (v0.8.0): the bot is the encounter's opponent, by name and portrait.
    link = db.get(CampaignGame, game.id)
    opponent = (link.opponent_name, link.opponent) if link is not None else None
    return GameSummary(
        id=game.id,
        kind=game.kind,  # type: ignore[arg-type]
        format=cast(GameFormatId, game.format),
        status=game.status,  # type: ignore[arg-type]
        seats=[
            SeatSummary(
                seat=row.seat,
                player=row.player,  # type: ignore[arg-type]
                handle=(
                    handles.get(row.user_id)
                    if row.user_id
                    else opponent[0]
                    if opponent and row.player == "bot"
                    else None
                ),
                portrait=(
                    alliances.get(row.user_id)
                    if row.user_id
                    else opponent[1]
                    if opponent and row.player == "bot"
                    else None
                ),
                deck=row.deck if everything or row.user_id == principal.user.id else None,
                left=row.left_reason,  # type: ignore[arg-type]
            )
            for row in rows
        ],
        your_seat=your_seat,
        bot_skill=game.bot_skill,
        turn_cap=game.turn_cap,
        created_at=game.created_at,
        finished_at=game.finished_at,
        result=GameResult.model_validate(game.result) if game.result else None,
        tokens=(
            tokens_from(db, game.id, principal.user.id)
            if your_seat is not None and game.status == "finished"
            else None
        ),
        match=match_ref(db, game),
        passive_bots=(game.bots_passive if passive_switchable(game, rows, principal) else None),
        campaign=(
            CampaignRef(
                encounter=link.encounter,
                opponent=link.opponent,
                name=link.opponent_name,
                title=link.title,
                hints=link.hints,
                deck=link.deck,  # type: ignore[arg-type]
                finale=link.finale,  # type: ignore[arg-type]
                outcome=link.outcome,  # type: ignore[arg-type]
            )
            if link is not None
            else None
        ),
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
    """The table's formats and bots. The engine's fixture decks are offered to SysOp only, as its
    test decks for the browser journeys; players play their own decks, the two starter decks they
    chose among them. The routes still accept a fixture deck by name, for scripts."""
    fixtures = principal.can("cards.any")
    return PracticeOptions(
        formats=[
            PracticeFormat(
                id=cast(GameFormatId, fmt),
                name=FORMAT_NAMES[fmt],
                bots=BOTS[fmt],
                default_bots=DEFAULT_BOTS[fmt],
                decks=decks if fixtures else [],
                best_of=BEST_OF[fmt],
            )
            for fmt, decks in FIXTURE_DECKS.items()
        ],
        deck_lists=principal.can("cards.any"),
        own_decks=principal.can("decks.edit"),
    )


def listed(names: list[str]) -> str:
    """Names as a sentence lists them: "A", "A and B", "A, B and C", at most five and a count."""
    shown = names[:5] + ([f"{len(names) - 5} more"] if len(names) > 5 else [])
    return shown[0] if len(shown) == 1 else ", ".join(shown[:-1]) + " and " + shown[-1]


def refusal(db: Session, refused: list[Problem], fmt: str) -> str:
    """Why the table's rules refuse a deck (v0.4.5): the cards it holds that they do not allow."""
    name = FORMAT_NAMES[fmt]
    ids = {card_id for problem in refused for card_id in problem.card_ids}
    names = dict(
        db.execute(select(CardConcept.id, CardConcept.name).where(CardConcept.id.in_(ids))).all()
    )
    kinds: list[str] = []
    clauses: list[str] = []
    for option, kind, one, many in (
        ("banned", "banned cards", f"is banned in {name}", f"are banned in {name}"),
        (
            "not_legal",
            f"cards not legal in {name}",
            f"is not legal in {name}",
            f"are not legal in {name}",
        ),
        ("stand_in", "stand-ins", "plays as a stand-in", "play as stand-ins"),
    ):
        held = list(
            dict.fromkeys(
                names[card_id]
                for problem in refused
                if problem.kind == option
                for card_id in problem.card_ids
                if card_id in names
            )
        )
        if held:
            kinds.append(kind)
            clauses.append(f"{listed(held)} {one if len(held) == 1 else many}")
    return (
        f"This table does not allow {' or '.join(kinds)}: {'; '.join(clauses)}. Choose another "
        f"deck, or take {'it' if len(ids) == 1 else 'them'} out of this one."
    )


def own_deck(
    db: Session,
    owner: User,
    permissions: frozenset[str],
    deck_id: UUID,
    fmt: str,
    library: Library,
    rules: TableRules,
) -> tuple[dict[str, object], UUID, str]:
    """One of the account's decks as the engine's deck list, bound to an immutable revision of
    it (DECK01). The revision must be playable: legal, every card in the game, and every copy in
    the player's library now (v0.3.1). Since v0.4.5 the table's rules must also allow its cards'
    legality: banned cards, and cards not legal in the format; since v0.6.2 its stand-ins, which
    the deck list describes to the engine (api/stand_ins.py). SysOp's decks need only cards in
    the game (since v0.4.5 no longer any card the engine implements), as its deck lists do. A
    table's host starts the game with every player's deck (api/tables.py)."""
    deck = db.get(Deck, deck_id)
    if deck is None or deck.owner_id != owner.id or deck.deleted_at is not None:
        raise ApiError(422, "invalid_deck", "That is not one of your decks.")
    if deck.format != fmt:
        raise ApiError(
            422,
            "invalid_deck",
            f"{deck.title} is a {FORMAT_NAMES[deck.format]} deck, not a {FORMAT_NAMES[fmt]} one.",
        )
    revision = publish(db, deck, library)
    entries = [
        entry
        for entry in revision_entries(db, revision)
        if entry.location in ("main", "commander", "sideboard")
    ]
    validation = validate_deck(
        db,
        DeckContent(format=fmt, entries=revision_entries(db, revision)),  # type: ignore[arg-type]
        datetime.now(UTC).date(),
        library.collection(),
    )
    names = engine_names(db, entries, library.godlike, library.won_custom)
    if not validation.playable:
        sysop_ok = "cards.any" in permissions and all(names.get(e.card_id) for e in entries)
        locked = any(problem.kind == "collection_locked" for problem in validation.errors)
        if locked and not sysop_ok:
            raise ApiError(
                422,
                "deck_not_playable",
                f"{deck.title} holds more copies of some cards, or of their editions, than your "
                "library does: open it in the deck builder to see which.",
            )
        if not sysop_ok:
            raise ApiError(
                422,
                "deck_not_playable",
                f"{deck.title} cannot start a game until its problems are fixed: open it in the "
                "deck builder to see them.",
            )
    refused = not_allowed(validation, rules)
    if refused and "cards.any" not in permissions:
        raise ApiError(422, "deck_not_allowed", refusal(db, refused, fmt))
    deck_list = engine_deck_list(db, entries, names, fmt)
    if deck_list is None:
        raise ApiError(422, "deck_not_playable", f"{deck.title} holds a card the engine lacks.")
    return {"deck_list": deck_list}, revision.id, deck.title[:64]


def engine_names(
    db: Session, entries: list[DeckEntry], godlike: bool, won: frozenset[UUID] = frozenset()
) -> dict[UUID, str | None]:
    """The engine's name of each card in the game the entries hold: a certified catalog card's,
    since v0.6.2 a stand-in's name in the game (api/stand_ins.py), and the Godlike tier's custom
    cards by their own names (v0.4.0), for a Godlike owner or, since v0.8.0, those the owner
    holds for good (won)."""
    held = {entry.card_id for entry in entries}
    names: dict[UUID, str | None] = dict(
        db.execute(
            select(CardConcept.id, CardConcept.engine_name).where(
                CardConcept.id.in_(held), playable()
            )
        ).all()
    )
    names |= {card: str(data["name"]) for card, data in stand_ins(db, held - names.keys()).items()}
    if godlike or won:
        wanted = {entry.card_id for entry in entries} - names.keys()
        names |= dict(
            db.execute(
                select(CustomCard.id, CustomCard.name).where(
                    CustomCard.id.in_(wanted if godlike else wanted & won)
                )
            ).all()
        )
    return names


def engine_deck_list(
    db: Session, entries: list[DeckEntry], names: dict[UUID, str | None], fmt: str
) -> dict[str, object] | None:
    """A deck's main deck and commanders as the engine's deck list, or None when a card has no
    engine name. Since v0.5.0 a Legacy deck's sideboard goes with it: XMage keeps it outside the
    game, where wishes find it (FMT07). Companions stay out of it, as the companion location does,
    since XMage would offer a sideboard's companion as one. Since v0.6.2 the list describes the
    stand-ins it holds (stand_ins), which the engine makes from their description."""
    counts: dict[str, int] = defaultdict(int)
    sideboard: dict[str, int] = defaultdict(int)
    commanders: list[str] = []
    companions = set(
        db.scalars(
            select(CardConcept.id).where(
                CardConcept.id.in_({entry.card_id for entry in entries}), CardConcept.companion
            )
        )
    )
    for entry in entries:
        name = names.get(entry.card_id)
        if not name:
            return None
        if entry.location == "commander":
            commanders.append(name)
        elif entry.location == "main":
            counts[name] += entry.quantity
        elif entry.location == "sideboard" and fmt == "legacy" and entry.card_id not in companions:
            sideboard[name] += entry.quantity
    deck_list: dict[str, object] = {
        "cards": [{"name": name, "count": count} for name, count in counts.items()]
    }
    if fmt == "commander":
        deck_list["commanders"] = commanders
    if sideboard:
        deck_list["sideboard"] = [
            {"name": name, "count": count} for name, count in sideboard.items()
        ]
    standing_in = stand_ins(db, {entry.card_id for entry in entries})
    if standing_in:
        deck_list["stand_ins"] = list(
            {str(data["name"]): data for data in standing_in.values()}.values()
        )
    return deck_list


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


@dataclass
class SeatPlan:
    """A seat as sent to the engine, and the player's deck revision behind it, if any."""

    engine: dict[str, object]
    revision: UUID | None = None
    title: str | None = None
    # A bot's starter deck, sent as a deck list but chosen by the API, not by SysOp.
    starter: bool = False
    # The Godlike tier's custom cards the deck holds (v0.4.0), by name.
    custom: list[str] = field(default_factory=list)


def starter_seat(db: Session, starter: Starter) -> SeatPlan | None:
    """A bot seat playing a starter deck, as the engine's deck list; None when a card of it is not
    in the game (v0.4.5; before, one with no engine implementation in this catalog), and the
    engine's own fixture deck plays instead."""
    entries, missing = starter_entries(db, starter)
    if missing:
        return None
    names = dict(
        db.execute(
            select(CardConcept.id, CardConcept.engine_name).where(
                CardConcept.id.in_({entry.card_id for entry in entries}), playable()
            )
        ).all()
    )
    counts: dict[str, int] = defaultdict(int)
    commanders: list[str] = []
    for entry in entries:
        name = names.get(entry.card_id)
        if not name:
            return None
        if entry.location == "commander":
            commanders.append(name)
        else:
            counts[name] += entry.quantity
    deck_list = {
        "cards": [{"name": name, "count": count} for name, count in counts.items()],
        "commanders": commanders,
    }
    return SeatPlan({"player": "bot", "deck_list": deck_list}, title=starter.title, starter=True)


def plan_seats(
    db: Session,
    request: Request,
    principal: Principal,
    body: PracticeGameRequest,
    bots: list[SeatChoice | None],
) -> list[SeatPlan]:
    fmt = body.format
    deck_format = DECK_FORMATS.get(fmt, fmt)
    settings = settings_of(request)
    library = library_of(db, principal.user, principal.permissions, roster_of(request))
    # Commander bots with no deck chosen play the starter decks, each a different one, unless the
    # site keeps them on the engine's fixture decks (the browser journeys' leak checks).
    starters = list(starters_of(request).values()) if settings.bot_decks == "starters" else []
    random.shuffle(starters)
    human: tuple[str, str | None, UUID | None, str | None] = (
        "human",
        body.deck,
        body.deck_id,
        body.deck_list,
    )
    choices = [human] + [
        (
            "bot",
            bot.deck if bot else None,
            bot.deck_id if bot else None,
            bot.deck_list if bot else None,
        )
        for bot in bots
    ]
    plans: list[SeatPlan] = []
    for player, deck, deck_id, deck_list in choices:
        if deck_id is not None:
            if deck is not None or deck_list is not None:
                raise ApiError(422, "invalid_seat", "A seat takes one deck.")
            if not principal.can("decks.edit"):
                raise ApiError(403, "forbidden", "Your account cannot play its own decks.")
            seat, revision, title = own_deck(
                db, principal.user, principal.permissions, deck_id, deck_format, library, body.rules
            )
            if fmt == "two_headed_giant":
                # MTR 9.5: Two-Headed Giant Constructed has no sideboards; a deck's stays home.
                cast(dict[str, object], seat["deck_list"]).pop("sideboard", None)
            plans.append(SeatPlan({"player": player, **seat}, revision, title))
            continue
        unchosen = deck is None and deck_list is None
        if player == "bot" and fmt == "commander" and unchosen and starters:
            planned = starter_seat(db, starters.pop())
            if planned is not None:
                plans.append(planned)
                continue
        seat = engine_seat(player, deck, deck_list, fmt, principal)
        if isinstance(seat.get("deck_list"), dict):
            # SysOp's lists hold only cards in the game, as every deck does (v0.4.5).
            refuse_unplayable(db, cast(dict[str, object], seat["deck_list"]))
        plans.append(SeatPlan(seat))
    if fmt == "two_headed_giant":
        # Teams (v0.5.0): seats 0 and 1 against 2 and 3. The API gives each bot without a deck
        # its fixture deck and checks each team's decks together (api/teams.py).
        assign_and_check([plan.engine for plan in plans], body.rules.banned)
    # Bots never play the Godlike tier's custom cards (v0.4.0). The other seats holding them are
    # checked against the running engine before the game starts (require_loaded).
    for index, held in custom_in_seats(db, [plan.engine for plan in plans]).items():
        if plans[index].engine["player"] == "bot":
            raise ApiError(
                422,
                "custom_cards_for_bots",
                "Bots never play Godlike cards: choose another deck for the bot.",
            )
        plans[index].custom = held
    # Revisions made for the game are kept even if the engine refuses it, and the connection
    # goes back before the engine is asked.
    db.commit()
    return plans


async def require_loaded(request: Request, plans: list[SeatPlan]) -> None:
    """Refuses a game whose decks hold custom cards the running engine has not loaded, asking
    the engine afresh (v0.4.0). The names are the players' own cards: only a Godlike deck holds
    them."""
    wanted = sorted({name for plan in plans for name in plan.custom})
    if not wanted:
        return
    cards = engine_cards_of(request)
    loaded = await cards.loaded(wanted, fresh=True) if cards is not None else None
    if loaded is None:
        raise unavailable()
    missing = [name for name in wanted if not loaded.get(name.casefold())]
    if missing:
        raise ApiError(
            422,
            "custom_not_loaded",
            ", ".join(missing)
            + (" is" if len(missing) == 1 else " are")
            + " not loaded by this engine, so this game cannot start. Take "
            + ("it" if len(missing) == 1 else "them")
            + " out of the deck, or play where the engine has loaded "
            + ("it." if len(missing) == 1 else "them."),
            names=missing,
        )


def record_game(
    db: Session,
    request: Request,
    principal: Principal,
    created: dict[str, Any],
    body: PracticeGameRequest,
    plans: list[SeatPlan],
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
        catalog_revision_id=db.scalar(select(func.max(CatalogRevision.id))),
        # The decks' format: Two-Headed Giant plays Legacy decks (v0.5.0).
        format_version=db.scalar(
            select(func.max(FormatVersion.version)).where(
                FormatVersion.format == DECK_FORMATS.get(body.format, body.format)
            )
        ),
        # The request, for a rematch with the same settings (v0.5.0, api/rematches.py).
        settings=body.model_dump(mode="json"),
    )
    db.add(game)
    db.flush()
    decks = {entry["seat"]: entry["deck"] for entry in created["settings"]["seats"]}
    for index, plan in enumerate(plans):
        seat = plan.engine
        db.add(
            GameSeat(
                game_id=game.id,
                seat=index,
                player=seat["player"],
                user_id=principal.user.id if seat["player"] == "human" else None,
                deck=plan.title or decks[index],
                deck_list=seat.get("deck_list"),
                deck_revision_id=plan.revision,
            )
        )
    # Best of three (v0.5.0): the first game of a match. Imported here: api.matches imports this
    # module.
    from api import matches

    matches.begin(db, game, body.best_of)
    lists = [
        index
        for index, plan in enumerate(plans)
        if "deck_list" in plan.engine and not plan.revision and not plan.starter
    ]
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


def malformed(created: object, body: dict[str, object]) -> str | None:
    """What is missing from the engine's answer to a create, or None. The API records and follows
    a game by its id, each human seat's token and each seat's deck, so it checks them all before
    it records anything."""
    if not isinstance(created, dict):
        return "the answer is not an object"
    try:
        UUID(str(created.get("game_id")))
    except ValueError:
        return "no game id"
    asked = body.get("seats")
    asked = asked if isinstance(asked, list) else []
    humans = [
        index
        for index, seat in enumerate(asked)
        if isinstance(seat, dict) and seat.get("player") == "human"
    ]
    seats = created.get("seats")
    if not isinstance(seats, list) or not all(isinstance(entry, dict) for entry in seats):
        return "no seats"
    tokens = {entry.get("seat"): entry.get("seat_token") for entry in seats}
    if any(not isinstance(tokens.get(index), str) or not tokens[index] for index in humans):
        return "a human seat without its token"
    settings = created.get("settings")
    decks = settings.get("seats") if isinstance(settings, dict) else None
    if not isinstance(decks, list) or not all(isinstance(entry, dict) for entry in decks):
        return "no seat settings"
    named = {entry.get("seat"): entry.get("deck") for entry in decks}
    if any(not isinstance(named.get(index), str) for index in range(len(asked))):
        return "a seat without its deck"
    return None


def seat_tokens(created: dict[str, Any]) -> dict[int, str]:
    """Each human seat's token from the engine's answer to a create (checked by malformed)."""
    return {
        entry["seat"]: entry["seat_token"]
        for entry in created["seats"]
        if isinstance(entry.get("seat"), int) and isinstance(entry.get("seat_token"), str)
    }


async def close_in_engine(engine: EngineClient, game_id: str) -> None:
    """Closes a game the API will not follow. A close that fails is logged, never raised: it must
    not hide the failure that made the API give the game up."""
    try:
        await engine.request("POST", f"/games/{game_id}/close", body={})
    except Exception:
        log.warning("Could not close game %s in the engine", game_id, exc_info=True)


async def create_in_engine(engine: EngineClient, body: dict[str, object]) -> tuple[int, Any]:
    """POST /games under an id the API chooses (v0.8.3). When no answer comes, the game is closed
    by that id, which also stops a create that reaches the engine later (it answers 409): no game
    is left running that nothing follows, and a retry starts a new one. An answer the API cannot
    follow the game from (no id, a human seat without its token) is treated the same way."""
    game_id = str(uuid4())
    try:
        status, created = await engine.request(
            "POST",
            "/games",
            body={**body, "game_id": game_id},
            timeout=CREATE_TIMEOUT_SECONDS,
        )
        if status == 201 and (problem := malformed(created, body)) is not None:
            log.warning(
                "The engine created game %s with an answer the API cannot use: %s", game_id, problem
            )
            answered = created.get("game_id") if isinstance(created, dict) else None
            if isinstance(answered, str) and answered != game_id:
                await close_in_engine(engine, answered)
            raise EngineUnavailable(f"unusable answer to a create: {problem}")
        return status, created
    except EngineUnavailable:
        await close_in_engine(engine, game_id)
        raise


@asynccontextmanager
async def followed_or_closed(
    hub: "GameHub", created: dict[str, Any], db: Session | None = None
) -> AsyncIterator[None]:
    """Around recording and registering a game the engine has just created. When that fails, for
    any reason, the request's transaction (db) is rolled back, the game is closed in the engine
    and, if it was recorded, recorded interrupted, so no game is left running or active with
    nothing following it. The failure is raised; the cleanup cannot hide it. A cancellation only
    arrives once the database work in its thread has finished, so it is cleaned up the same way."""
    try:
        yield
    except BaseException:
        game_id = UUID(str(created["game_id"]))
        if game_id not in hub.games:
            with anyio.CancelScope(shield=True):
                if db is not None:
                    with suppress(Exception):
                        await run_in_threadpool(db.rollback)
                await close_in_engine(hub.require_engine(), str(game_id))
                try:
                    await run_in_threadpool(
                        record_end,
                        hub.database,
                        game_id,
                        "interrupted",
                        None,
                        hub.settings.content_dir,
                    )
                except Exception:
                    log.exception("Could not record game %s interrupted", game_id)
        raise


async def engine_game(
    engine: EngineClient, body: dict[str, object], request: Request
) -> dict[str, Any]:
    """Asks the engine for a service game; its refusals become the API's. The answer holds each
    human seat's token, once."""
    try:
        status, created = await create_in_engine(engine, body)
    except EngineUnavailable as error:
        raise unavailable() from error
    if status != 201 and not isinstance(created, dict):
        created = {}
    if status == 400 and created.get("code") == "unknown_cards":
        # Custom cards it was thought to have loaded are asked about again.
        if (cards := engine_cards_of(request)) is not None:
            cards.forget()
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
    return cast(dict[str, Any], created)


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
    if body.best_of not in BEST_OF[fmt]:
        raise ApiError(422, "invalid_table", "Only Legacy plays best of three.")
    plans = await run_in_threadpool(plan_seats, db, request, principal, body, bots)
    await require_loaded(request, plans)
    seats = [plan.engine for plan in plans]
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
        hub.reserve()
        try:
            created = await engine_game(
                engine,
                {"format": fmt, "seats": seats, "skill": body.bot_skill, "turn_cap": body.turn_cap},
                request,
            )
            async with followed_or_closed(hub, created, db):
                game = await run_in_threadpool(
                    record_game, db, request, principal, created, body, plans
                )
                token = seat_tokens(created)[0]
                hub.register(LiveGame(id=game.id, seats={0: LiveSeat(0, user_id, token)}))
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
    """The game, with your seat's current snapshot while the engine holds it (an observer's is the
    first player's)."""
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
            snapshot = await hub.page(live, live.seat_of(principal.user.id) or live.watched)
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
    as it ended. A table's game goes on for the other players, so its players concede their own
    seat instead; only SysOp closes it while it runs."""
    game, owner = await run_in_threadpool(visible_game, db, game_id, principal)
    hub = hub_of(request)
    live = hub.games.get(game_id)
    table_game = game.kind == "table" and live is not None and not live.finished
    if table_game and not full_access(principal):
        raise ApiError(
            409,
            "table_game",
            "This game goes on for the other players: concede your seat in the game instead.",
        )
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


@router.put(
    "/games/{game_id}/bots",
    response_model=GameSummary,
    responses={403: {"model": Error}, 409: {"model": Error}},
)
async def set_bots(
    game_id: UUID, setting: BotsSetting, request: Request, principal: Player, db: Db
) -> GameSummary:
    """SysOp's switch between normal and passive bots (v0.8.6), for testing cards and the
    campaign: passive bots only draw, pass and discard to hand size, from their next decision.
    Only in SysOp's own running practice game (a campaign duel included) with no other human
    seat. Once they have been passive, the game's end pays nothing out. Audited."""
    if principal.user.kind != "sysop":
        raise ApiError(403, "forbidden", "Only SysOp can switch the bots.")
    game, _ = await run_in_threadpool(visible_game, db, game_id, principal)
    rows = await run_in_threadpool(
        lambda: list(
            db.scalars(select(GameSeat).where(GameSeat.game_id == game_id).order_by(GameSeat.seat))
        )
    )
    hub = hub_of(request)
    if not passive_switchable(game, rows, principal) or game_id not in hub.games:
        raise ApiError(
            409,
            "passive_bots_unavailable",
            "Passive bots are for SysOp's own running practice game against bots alone.",
        )
    try:
        status, answer = await hub.require_engine().request(
            "POST", f"/games/{game_id}/bots", body={"passive": setting.passive}
        )
    except EngineUnavailable as error:
        raise unavailable() from error
    if status == 409 or status == 404:
        raise ApiError(409, "game_not_live", "The engine no longer holds this game.")
    if status != 200 or not isinstance(answer, dict):
        raise unavailable()
    passive = bool(answer.get("passive"))

    def record() -> None:
        current = db.get_one(Game, game_id)
        current.bots_passive = passive
        current.passive_bots_used = current.passive_bots_used or passive
        audit(
            db,
            request,
            "game.bots_passive" if passive else "game.bots_normal",
            actor_id=principal.user.id,
            details={"game": str(game_id)},
        )
        db.commit()

    await run_in_threadpool(record)
    await run_in_threadpool(db.refresh, game)
    return await run_in_threadpool(summary_of, db, game, principal)


@router.get("/engine/cards", response_model=CardNames)
async def card_names(
    request: Request,
    principal: AnyCard,
    db: Db,
    q: Annotated[str, Query(min_length=1, max_length=200)],
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> CardNames:
    """Names of cards the engine implements, for SysOp's deck lists (cards.any): since v0.4.5
    only those of cards in the game."""
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
    names = CardNames.model_validate(found).names
    playing = await run_in_threadpool(in_game, db, names)
    return CardNames(names=[name for name in names if normalize(name) in playing])


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
    return sum(
        connection.user_id == user_id for connection in counted
    ) >= CONNECTIONS_PER_ACCOUNT or len(counted) >= CONNECTIONS_PER_GAME * len(game.seats)


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
    # Compared as bytes (v0.8.6): a token with characters outside ASCII is a wrong token, not an
    # error (compare_digest refuses such str).
    if not secrets.compare_digest(hello.csrf_token.encode(), principal.session.csrf_token.encode()):
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

    seat = game.seat_of(principal.user.id) if owner else None
    connection = Connection(
        id=secrets.token_hex(8),
        user_id=principal.user.id,
        session_id=principal.session.id,
        seat=seat.seat if seat is not None else None,
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
                await converse(hub, game, connection, websocket, principal, hello)
            finally:
                connection.close(1000)
    finally:
        game.connections.pop(connection.id, None)
        hub.release(game, connection, "disconnected")
        hub.departed(game, connection)


async def converse(
    hub: GameHub,
    game: LiveGame,
    connection: Connection,
    websocket: WebSocket,
    principal: Principal,
    hello: Hello,
) -> None:
    """Welcomes the connection, then serves its messages until it closes."""
    for action in (["game.observed"] if connection.seat is None else []) + (
        ["game.inspection_opened"] if hello.inspect else []
    ):
        await run_in_threadpool(audited, hub.database, websocket, principal, game.id, action)
    connection.send(
        {
            "type": "welcome",
            "game_id": str(game.id),
            "connection_id": connection.id,
            "seat": connection.seat,
            "role": "observer",
            "controlled": game.viewed(connection).controller is not None,
        }
    )
    if hello.control:
        claim(hub, game, connection)
    await resync(hub, game, connection, hello.since)
    hub.arrived(game, connection)
    if game.kind == "table":
        from api import table_chat  # Imported here: see GameHub.seat_left.

        await table_chat.welcome(hub, game, connection)
    if hello.inspect:
        hub.inspect_soon(game)
    await receive_loop(hub, game, connection, websocket)


def audited(
    database: Engine, websocket: WebSocket, principal: Principal, game_id: UUID, action: str
) -> None:
    with Session(database) as db:
        observed(db, websocket, principal, game_id, action)


def claim(hub: GameHub, game: LiveGame, connection: Connection) -> None:
    if connection.seat is not None:
        hub.take_control(game, connection)
    else:
        connection.send(
            {"type": "error", "code": "not_owner", "message": "Only the seat's owner controls it."}
        )


async def resync(hub: GameHub, game: LiveGame, connection: Connection, since: int) -> None:
    """Sends the seat's current snapshot unless the client already has that revision. A new
    connection's first page goes ahead of the snapshots published while it was fetched."""
    seat = game.viewed(connection)
    try:
        snapshot = await hub.page(game, seat)
    except EngineUnavailable:
        snapshot = seat.snapshot
    sent = snapshot is not None and (since < 0 or snapshot["revision"] != since)
    connection.opened({"type": "snapshot", "snapshot": snapshot} if sent else None)


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
        if kind in ("command", "vote", "chat", "emote", "alliance"):
            # Every command, vote and chat message checks that the session still stands, and
            # counts as activity. One stopped here goes nowhere; after a session refresh the
            # client resends a command.
            ended = await run_in_threadpool(
                partial(session_ended, active=True),
                hub.database,
                websocket,
                connection.session_id,
            )
            if ended is not None:
                connection.close(CLOSE_UNAUTHENTICATED, ended)
                return
            if kind == "command":
                await hub.command(game, connection, message.get("command"))
                continue
            if kind != "vote":
                from api import table_chat  # Imported here: see GameHub.seat_left.

                await table_chat.receive(hub, game, connection, websocket, message)
                continue
            seat, remove = message.get("seat"), message.get("remove", True)
            if not isinstance(seat, int) or isinstance(seat, bool) or not isinstance(remove, bool):
                connection.send({"type": "error", "code": "invalid_message"})
                continue
            from api import table_chat  # Imported here: see GameHub.seat_left.

            # Every vote is said to the whole table, so votes are limited (v0.8.3).
            if wait := table_chat.acting_too_fast(websocket, connection):
                connection.send(
                    {
                        "type": "error",
                        "code": "chat_limited",
                        "message": "You are voting very fast. Wait a moment.",
                        "seat": seat,
                        "retry_after": wait,
                    }
                )
                continue
            refused = await hub.vote(game, connection, websocket, seat, remove)
            if refused is not None:
                code, text = refused
                connection.send({"type": "error", "code": code, "message": text, "seat": seat})
        elif kind in ("take_control", "release_control", "resync"):
            # These check that the session still stands too, without counting as activity (the
            # page sends them on its own): a tab whose session ended cannot take the seat's lease
            # until the minute's check.
            ended = await run_in_threadpool(
                session_ended, hub.database, websocket, connection.session_id
            )
            if ended is not None:
                connection.close(CLOSE_UNAUTHENTICATED, ended)
                return
            if kind == "take_control":
                claim(hub, game, connection)
            elif kind == "release_control":
                hub.release(game, connection, "released")
            else:
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
