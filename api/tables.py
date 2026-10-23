"""Human tables (v0.4.0): the lobby, invite links, seats, and the start of a table's game.

- **The lobby.** A player opens a table: Legacy for two, or Commander for two to four, public or
  private, with bots of one skill (1-6) in the seats the players leave. Public tables are listed
  while they wait for players; a private one is reached only by its invite link, whose code is
  unguessable. SysOp sees every table. A table nobody started closes after 3 hours.
- **Rules** (v0.4.5). The host chooses which cards its decks may hold by their legality in the
  format: banned cards, and cards not legal in it (Un-cards, playtest and digital-only cards).
  A new table is casual, allowing both; tournament rules allow neither. The format's deck rules
  always apply. The lobby shows each table's rules.
- **Seats.** A player takes a seat with one of their own decks, checked as at the practice table:
  every copy in their library, no deck that cannot be played, and no card the table's rules do
  not allow (the player is told which). Administrators' whole-catalog decks play too. Players may
  change deck, mark themselves ready and leave. A player sits at one open table at a time, and
  the host leaving closes the table.
- **Starting.** The host starts once every player's seat is taken and ready, within every player's
  limit of running games (CD_GAMES_PER_ACCOUNT; SysOp has none), and every deck is checked again.
  That makes one engine game, with the players' seats first, then the bots'. The game runs as any
  other (api/games.py): each player's seat has its own token, lease, views and concession, and
  away players may be voted out.
- **Privacy.** Others see a seat's handle and portrait (its alliance), never its deck.
"""

import random
import secrets
from contextlib import AsyncExitStack
from datetime import datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Path, Request
from pydantic import Field
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api import matches
from api.auth import INPUT_ERRORS
from api.custom_play import custom_in_seats
from api.decks import starters_of
from api.games import (
    FORMAT_NAMES,
    TABLE_IDLE_SECONDS,
    LiveGame,
    LiveSeat,
    Player,
    SeatPlan,
    active_games_of,
    engine_game,
    full_access,
    hub_of,
    own_deck,
    require_loaded,
    starter_seat,
)
from api.identity import (
    ApiError,
    Db,
    Principal,
    not_found,
    permissions_for,
    roles_of,
    settings_of,
    utcnow,
)
from api.library import library_of
from api.models import (
    CatalogRevision,
    Deck,
    FormatVersion,
    Game,
    GameSeat,
    GameTable,
    TableSeat,
    User,
)
from api.roster import roster_of
from api.schemas import BEST_OF_TEXT, BestOf, Contract, Error, TableFormatId, TableRules, casual

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

# A table nobody started is closed after this long, so the lobby holds no forgotten tables.
OPEN_HOURS = 3
LISTED = 50
SEATS = {"legacy": [2], "commander": [2, 3, 4]}
Code = Annotated[str, Path(min_length=8, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")]
Visibility = Literal["public", "private"]


class TableRequest(Contract):
    """A new table: the host takes the first seat with one of their decks."""

    format: TableFormatId = "legacy"
    seats: int = Field(
        default=2,
        ge=2,
        le=4,
        description="Every seat, bots included: 2 in Legacy, 2-4 in Commander.",
    )
    bots: int = Field(
        default=0, ge=0, le=2, description="Seats bots fill, after the players'; Commander only."
    )
    bot_skill: int = Field(default=4, ge=1, le=6)
    turn_cap: int = Field(default=60, ge=1, le=200)
    visibility: Visibility = Field(
        default="public",
        description="public tables are listed; a private one is reached by its invite link only.",
    )
    rules: TableRules = Field(
        default_factory=casual,
        description="Which cards its decks may hold by their legality; casual unless told "
        "otherwise.",
    )
    best_of: BestOf = Field(default=1, description=BEST_OF_TEXT)
    deck_id: UUID = Field(description="The host's deck.")


class SeatTaking(Contract):
    deck_id: UUID = Field(description="One of your decks, in the table's format.")


class SeatChange(Contract):
    deck_id: UUID | None = Field(default=None, description="Another of your decks; unreadies.")
    ready: bool | None = None


class TablePlayer(Contract):
    seat: int
    player: Literal["human", "bot"]
    taken: bool = Field(description="Whether a player sits there; bots' seats always are.")
    handle: str | None
    portrait: str | None = Field(description="A player's allied Planeswalker.")
    host: bool
    ready: bool = Field(description="The host is always ready: starting is their ready.")
    you: bool
    deck: str | None = Field(description="Your own seat's deck title; others' decks are private.")
    deck_id: UUID | None = Field(description="Your own seat's deck.")


class TableView(Contract):
    code: str = Field(description="The invite link's code: #tables/<code>.")
    format: TableFormatId
    visibility: Visibility
    status: Literal["open", "started", "closed"]
    seats: int
    bots: int
    bot_skill: int
    turn_cap: int
    rules: TableRules
    best_of: int = Field(default=1, description="Since v0.5.0: 3 for a best-of-three match.")
    host: str | None = Field(description="The host's handle.")
    players: list[TablePlayer] = Field(description="Every seat in turn order, bots last.")
    your_seat: int | None
    can_start: bool = Field(description="You host it, every player's seat is taken and ready.")
    game_id: UUID | None = Field(description="Its game, once started; for its players and SysOp.")
    created_at: datetime


def cutoff() -> datetime:
    return utcnow() - timedelta(hours=OPEN_HOURS)


def status_of(table: GameTable) -> str:
    """A table left open too long counts as closed."""
    if table.status == "open" and table.created_at < cutoff():
        return "closed"
    return table.status


def rules_of(table: GameTable) -> TableRules:
    return TableRules(banned=table.allow_banned, not_legal=table.allow_not_legal)


def find(db: Session, code: str, *, lock: bool = False) -> GameTable:
    statement = select(GameTable).where(GameTable.code == code)
    table = db.scalar(statement.with_for_update() if lock else statement)
    if table is None:
        raise not_found()
    return table


def seats_of(db: Session, table: GameTable) -> list[TableSeat]:
    return list(
        db.scalars(select(TableSeat).where(TableSeat.table_id == table.id).order_by(TableSeat.seat))
    )


def open_table_of(db: Session, user_id: UUID) -> GameTable | None:
    """The open table the account sits at, if any: one at a time."""
    return db.scalar(
        select(GameTable)
        .join(TableSeat, TableSeat.table_id == GameTable.id)
        .where(
            TableSeat.user_id == user_id,
            GameTable.status == "open",
            GameTable.created_at >= cutoff(),
        )
    )


def view_of(db: Session, table: GameTable, principal: Principal) -> TableView:
    rows = seats_of(db, table)
    by_seat = {row.seat: row for row in rows}
    users = {row.user_id for row in rows} | {table.host_id}
    found = {
        user_id: (handle, alliance)
        for user_id, handle, alliance in db.execute(
            select(User.id, User.handle, User.alliance).where(User.id.in_(users))
        )
    }
    you = principal.user.id
    mine = next((row for row in rows if row.user_id == you), None)
    deck = db.get(Deck, mine.deck_id) if mine is not None else None
    humans = table.seats - table.bots
    players: list[TablePlayer] = []
    for index in range(table.seats):
        row = by_seat.get(index)
        if index >= humans:
            players.append(
                TablePlayer(
                    seat=index,
                    player="bot",
                    taken=True,
                    handle=None,
                    portrait=None,
                    host=False,
                    ready=True,
                    you=False,
                    deck=None,
                    deck_id=None,
                )
            )
            continue
        handle, alliance = found.get(row.user_id, (None, None)) if row else (None, None)
        own = row is not None and row.user_id == you
        host = row is not None and row.user_id == table.host_id
        players.append(
            TablePlayer(
                seat=index,
                player="human",
                taken=row is not None,
                handle=handle,
                portrait=alliance,
                host=host,
                ready=row is not None and (row.ready or host),
                you=own,
                deck=deck.title if own and deck is not None else None,
                deck_id=row.deck_id if own and row is not None else None,
            )
        )
    status = status_of(table)
    ready = all(player.taken and player.ready for player in players)
    return TableView(
        code=table.code,
        format=table.format,  # type: ignore[arg-type]
        visibility=table.visibility,  # type: ignore[arg-type]
        status=status,  # type: ignore[arg-type]
        seats=table.seats,
        bots=table.bots,
        bot_skill=table.bot_skill,
        turn_cap=table.turn_cap,
        rules=rules_of(table),
        best_of=table.best_of,
        host=found.get(table.host_id, (None, None))[0],
        players=players,
        your_seat=mine.seat if mine is not None else None,
        can_start=status == "open" and table.host_id == you and ready,
        game_id=table.game_id if mine is not None or full_access(principal) else None,
        created_at=table.created_at,
    )


def check_deck(
    db: Session,
    request: Request,
    user: User,
    permissions: frozenset[str],
    deck_id: UUID,
    fmt: str,
    rules: TableRules,
) -> None:
    """A deck the player may sit down with: theirs, of the table's format, playable with their
    library now (as at the practice table), and holding no card the table's rules do not allow."""
    if "decks.edit" not in permissions:
        raise ApiError(403, "forbidden", "Your account cannot play its own decks.")
    library = library_of(db, user, permissions, roster_of(request))
    own_deck(db, user, permissions, deck_id, fmt, library, rules)


def may_sit(db: Session, request: Request, principal: Principal) -> None:
    """One open table at a time, and room under the account's limit of running games. The
    account's row is locked, so two requests at once sit down once."""
    db.scalar(select(User.id).where(User.id == principal.user.id).with_for_update())
    if open_table_of(db, principal.user.id) is not None:
        raise ApiError(409, "at_a_table", "You are at another open table. Leave it first.")
    # Imported here: api.queues imports this module. A player waits in a queue or sits at a table,
    # not both (v0.5.0).
    from api.queues import waiting_of

    if waiting_of(db, principal.user.id) is not None:
        raise ApiError(409, "in_queue", "You are waiting in a public queue. Leave it first.")
    limit = settings_of(request).games_per_account
    if not full_access(principal) and active_games_of(db, principal.user.id) >= limit:
        raise ApiError(
            409, "game_limit", "Finish your running game before you sit down at a table."
        )


# Routes.


@router.get("/tables", response_model=list[TableView])
def list_tables(principal: Player, db: Db) -> list[TableView]:
    """Open tables, newest first: the public ones and your own; SysOp sees every one."""
    statement = (
        select(GameTable)
        .where(GameTable.status == "open", GameTable.created_at >= cutoff())
        .order_by(GameTable.created_at.desc())
        .limit(LISTED)
    )
    if not full_access(principal):
        mine = select(TableSeat.table_id).where(TableSeat.user_id == principal.user.id)
        statement = statement.where((GameTable.visibility == "public") | GameTable.id.in_(mine))
    return [view_of(db, table, principal) for table in db.scalars(statement)]


@router.post(
    "/tables", response_model=TableView, status_code=201, responses={409: {"model": Error}}
)
def create_table(body: TableRequest, request: Request, principal: Player, db: Db) -> TableView:
    """Opens a table with the host in its first seat."""
    fmt = body.format
    if body.seats not in SEATS[fmt]:
        raise ApiError(
            422,
            "invalid_table",
            f"{FORMAT_NAMES[fmt]} seats {SEATS[fmt]} players, not {body.seats}.",
        )
    if body.bots > body.seats - 2:
        raise ApiError(422, "invalid_table", "A table needs at least two players' seats.")
    if body.best_of != 1 and fmt != "legacy":
        raise ApiError(422, "invalid_table", "Only Legacy plays best of three.")
    check_deck(db, request, principal.user, principal.permissions, body.deck_id, fmt, body.rules)
    may_sit(db, request, principal)
    now = utcnow()
    table = GameTable(
        code=secrets.token_urlsafe(12),
        host_id=principal.user.id,
        format=fmt,
        visibility=body.visibility,
        seats=body.seats,
        bots=body.bots,
        bot_skill=body.bot_skill,
        turn_cap=body.turn_cap,
        allow_banned=body.rules.banned,
        allow_not_legal=body.rules.not_legal,
        best_of=body.best_of,
        status="open",
        created_at=now,
    )
    db.add(table)
    db.flush()
    db.add(
        TableSeat(
            table_id=table.id,
            seat=0,
            user_id=principal.user.id,
            deck_id=body.deck_id,
            ready=True,
            joined_at=now,
        )
    )
    db.commit()
    return view_of(db, table, principal)


@router.get("/tables/{code}", response_model=TableView)
def get_table(code: Code, principal: Player, db: Db) -> TableView:
    """A table by its code: the invite link."""
    return view_of(db, find(db, code), principal)


@router.post("/tables/{code}/join", response_model=TableView, responses={409: {"model": Error}})
def join_table(
    code: Code, body: SeatTaking, request: Request, principal: Player, db: Db
) -> TableView:
    """Takes the first free player's seat with one of your decks."""
    table = find(db, code)
    if status_of(table) != "open":
        raise ApiError(409, "table_closed", "This table is no longer taking players.")
    rows = seats_of(db, table)
    if any(row.user_id == principal.user.id for row in rows):
        raise ApiError(409, "already_seated", "You already sit at this table.")
    free = [seat for seat in range(table.seats - table.bots) if seat not in {r.seat for r in rows}]
    if not free:
        raise ApiError(409, "table_full", "Every player's seat at this table is taken.")
    check_deck(
        db,
        request,
        principal.user,
        principal.permissions,
        body.deck_id,
        table.format,
        rules_of(table),
    )
    may_sit(db, request, principal)
    db.add(
        TableSeat(
            table_id=table.id,
            seat=free[0],
            user_id=principal.user.id,
            deck_id=body.deck_id,
            ready=False,
            joined_at=utcnow(),
        )
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ApiError(409, "table_full", "That seat was just taken. Try again.") from None
    return view_of(db, table, principal)


def seat_at(db: Session, table: GameTable, principal: Principal) -> TableSeat:
    row = db.scalar(
        select(TableSeat).where(
            TableSeat.table_id == table.id, TableSeat.user_id == principal.user.id
        )
    )
    if row is None:
        raise ApiError(409, "not_seated", "You do not sit at this table.")
    if status_of(table) != "open":
        raise ApiError(409, "table_closed", "This table is no longer open.")
    return row


@router.patch("/tables/{code}/seat", response_model=TableView, responses={409: {"model": Error}})
def change_seat(
    code: Code, body: SeatChange, request: Request, principal: Player, db: Db
) -> TableView:
    """Changes your deck (which makes you not ready), or whether you are ready."""
    table = find(db, code)
    row = seat_at(db, table, principal)
    if body.deck_id is not None and body.deck_id != row.deck_id:
        check_deck(
            db,
            request,
            principal.user,
            principal.permissions,
            body.deck_id,
            table.format,
            rules_of(table),
        )
        row.deck_id = body.deck_id
        row.ready = False
    if body.ready is not None:
        row.ready = body.ready
    db.commit()
    return view_of(db, table, principal)


@router.post("/tables/{code}/leave", response_model=TableView, responses={409: {"model": Error}})
def leave_table(code: Code, principal: Player, db: Db) -> TableView:
    """Leaves the table before it starts. The host leaving closes it for everyone."""
    table = find(db, code)
    row = seat_at(db, table, principal)
    if table.host_id == principal.user.id:
        table.status = "closed"
        table.closed_at = utcnow()
        db.execute(delete(TableSeat).where(TableSeat.table_id == table.id))
    else:
        db.delete(row)
    db.commit()
    return view_of(db, table, principal)


def plan_table(
    db: Session, request: Request, table_id: UUID, principal: Principal
) -> tuple[list[SeatPlan], list[UUID | None]]:
    """Every seat as the engine takes it, the players' first: each player's deck bound to a
    revision now (DECK01), then the bots. Returns the plans and each seat's player."""
    table = db.get(GameTable, table_id)
    if table is None:
        raise not_found()
    if table.host_id != principal.user.id:
        raise ApiError(403, "not_host", "Only the table's host starts the game.")
    if status_of(table) != "open":
        raise ApiError(409, "table_closed", "This table is no longer open.")
    rows = seats_of(db, table)
    humans = table.seats - table.bots
    if len(rows) < humans:
        raise ApiError(409, "table_not_full", "Wait until every player's seat is taken.")
    waiting = [row for row in rows if not row.ready and row.user_id != table.host_id]
    if waiting:
        raise ApiError(409, "not_ready", "Wait until every player is ready.")
    roster = roster_of(request)
    plans: list[SeatPlan] = []
    users: list[UUID | None] = []
    for row in rows:
        user = db.get(User, row.user_id)
        assert user is not None
        permissions = permissions_for(user, roles_of(db, user))
        if user.status != "active" or "games.play" not in permissions:
            raise ApiError(409, "player_unavailable", f"{user.handle} cannot play games now.")
        library = library_of(db, user, permissions, roster)
        try:
            seat, revision, title = own_deck(
                db, user, permissions, row.deck_id, table.format, library, rules_of(table)
            )
        except ApiError as refused:
            if user.id == principal.user.id:
                raise
            # Another player's deck stays private: the host learns only whose it is, not whether
            # its cards or the table's rules stop it.
            row.ready = False
            db.commit()
            raise ApiError(
                409,
                "deck_not_playable",
                f"{user.handle}'s deck cannot be played now; they need to choose another.",
            ) from refused
        plans.append(SeatPlan({"player": "human", **seat}, revision, title))
        users.append(user.id)
    # Bots with no deck chosen play the starter decks in Commander, a different one each, unless
    # the site keeps them on the engine's fixture decks.
    starters = (
        list(starters_of(request).values()) if settings_of(request).bot_decks == "starters" else []
    )
    random.shuffle(starters)
    for _ in range(table.bots):
        planned = starter_seat(db, starters.pop()) if starters else None
        plans.append(planned or SeatPlan({"player": "bot"}))
        users.append(None)
    # A Godlike player's custom cards (v0.4.0) are checked against the running engine before the
    # game starts; bots here play starter or fixture decks, never them.
    for index, held in custom_in_seats(db, [plan.engine for plan in plans]).items():
        plans[index].custom = held
    # Revisions made for the game are kept even if the engine refuses it, and the connection
    # goes back before the engine is asked.
    db.commit()
    return plans, users


def record_table_game(
    db: Session,
    table_id: UUID,
    created: dict[str, object],
    plans: list[SeatPlan],
    users: list[UUID | None],
) -> Game:
    """The table's game and its seats, and the table as started, in one transaction. The seats
    must be as they were when the game was planned."""
    table = db.scalar(select(GameTable).where(GameTable.id == table_id).with_for_update())
    assert table is not None
    seated = {row.seat: row.user_id for row in seats_of(db, table)}
    if status_of(table) != "open" or [seated.get(i) for i in range(len(seated))] != [
        user for user in users if user is not None
    ]:
        raise ApiError(409, "table_changed", "A player left as the game started. Try again.")
    game = add_table_game(db, table, created, plans, users)
    db.commit()
    return game


def add_table_game(
    db: Session,
    table: GameTable,
    created: dict[str, object],
    plans: list[SeatPlan],
    users: list[UUID | None],
) -> Game:
    """The table's game and its seats, and the table as started, in the caller's transaction:
    the lobby's start, and since v0.5.0 the queue's and a rematch's (api/queues.py)."""
    now = utcnow()
    game = Game(
        id=UUID(str(created["game_id"])),
        kind="table",
        format=table.format,
        status="active",
        created_by=table.host_id,
        created_at=now,
        bot_skill=table.bot_skill,
        turn_cap=table.turn_cap,
        catalog_revision_id=db.scalar(select(func.max(CatalogRevision.id))),
        format_version=db.scalar(
            select(func.max(FormatVersion.version)).where(FormatVersion.format == table.format)
        ),
    )
    db.add(game)
    db.flush()
    settings = created["settings"]
    assert isinstance(settings, dict)
    decks = {entry["seat"]: entry["deck"] for entry in settings["seats"]}
    for index, plan in enumerate(plans):
        db.add(
            GameSeat(
                game_id=game.id,
                seat=index,
                player=plan.engine["player"],
                user_id=users[index],
                deck=plan.title or decks[index],
                deck_list=plan.engine.get("deck_list"),
                deck_revision_id=plan.revision,
            )
        )
    # Best of three (v0.5.0): the first game of the table's match.
    matches.begin(db, game, table.best_of, idle_timeout_seconds=TABLE_IDLE_SECONDS)
    table.status = "started"
    table.started_at = now
    table.game_id = game.id
    db.flush()
    return game


@router.post(
    "/tables/{code}/start",
    response_model=TableView,
    responses={409: {"model": Error}, 429: {"model": Error}},
)
async def start_table(code: Code, request: Request, principal: Player, db: Db) -> TableView:
    """The host starts the table's game: every player's seat taken and ready, and every player
    under their limit of running games. The reply names the game; each player plays it over its
    WebSocket."""
    hub = hub_of(request)
    engine = hub.require_engine()
    table = await run_in_threadpool(find, db, code)
    async with hub.locks[table.id]:
        plans, users = await run_in_threadpool(plan_table, db, request, table.id, principal)
        players = [user for user in users if user is not None]
        async with AsyncExitStack() as stack:
            # Every player's lock, in one order: no practice game or other table of theirs starts
            # meanwhile, and two starts cannot wait on each other.
            for user_id in sorted(players, key=str):
                await stack.enter_async_context(hub.locks[user_id])
            await run_in_threadpool(under_limits, db, request, players)
            await require_loaded(request, plans)
            hub.reserve()
            try:
                created = await engine_game(
                    engine,
                    {
                        "format": table.format,
                        "seats": [plan.engine for plan in plans],
                        "skill": table.bot_skill,
                        "turn_cap": table.turn_cap,
                        "idle_timeout_seconds": TABLE_IDLE_SECONDS,
                    },
                    request,
                )
                try:
                    game = await run_in_threadpool(
                        record_table_game, db, table.id, created, plans, users
                    )
                except (ApiError, SQLAlchemyError):
                    await run_in_threadpool(db.rollback)
                    await engine.request("POST", f"/games/{created['game_id']}/close", body={})
                    raise
                tokens = {entry["seat"]: entry["seat_token"] for entry in created["seats"]}
                hub.register(
                    LiveGame(
                        id=game.id,
                        kind="table",
                        seats={
                            seat: LiveSeat(seat, user_id, tokens[seat])
                            for seat, user_id in enumerate(users)
                            if user_id is not None
                        },
                    )
                )
            finally:
                hub.starting -= 1
    await run_in_threadpool(db.refresh, table)
    return await run_in_threadpool(view_of, db, table, principal)


def under_limits(db: Session, request: Request, players: list[UUID]) -> None:
    """Every player has room for one more running game; SysOp has no limit."""
    limit = settings_of(request).games_per_account
    for user_id in players:
        user = db.get(User, user_id)
        assert user is not None
        if "games.view_concealed" in permissions_for(user, roles_of(db, user)):
            continue
        if active_games_of(db, user_id) >= limit:
            raise ApiError(
                409,
                "game_limit",
                f"{user.handle} has a game running; it must end before this one starts.",
            )
    db.commit()
