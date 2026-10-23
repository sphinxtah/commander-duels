"""Rematches (v0.5.0): the same game again, from its result screen. docs/queues.md describes them.

- **A practice game** (a queue's game alone against bots too): Rematch starts a new game at once
  with the same request (games.settings): the same deck, bots, skill, format, turn cap and rules.
  The deck is checked again, as for any new game.
- **A table's game** (from the lobby or a queue): Rematch offers the players still there (every
  player whom the away vote did not remove) a new game with the same seats and decks, and the
  table's rules; bots fill the seats bots filled, and a removed player's. It starts once every
  player asked has accepted, within OFFER_SECONDS. A player who declines, or an offer not answered
  in time, ends it, and the others go back to the queue or the lobby. The others hear of the offer
  on the result screen and through the bell. At the start every deck is checked again with the
  table's rules, and every player's limit of running games, as at a table's start: a deck or a
  limit that stops it ends the offer, naming whose, never what the deck holds.
- **Free to play.** Offering or accepting needs room under the account's limit of running games,
  and no open table or queue of its own: the rematch is its one table.
- One rematch a game: asking again answers with the first.
- **Two-Headed Giant** (v0.5.1): the rematch keeps the teams. Every player keeps their seat, bots
  take the seats bots or removed players held, and each team's decks are checked together again.
"""

import secrets
from contextlib import AsyncExitStack
from datetime import datetime, timedelta
from typing import Literal, cast
from uuid import UUID

from fastapi import APIRouter, Request
from pydantic import Field
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api import teams
from api.auth import INPUT_ERRORS
from api.custom_play import custom_in_seats
from api.games import (
    DECK_FORMATS,
    TABLE_IDLE_SECONDS,
    LiveGame,
    LiveSeat,
    Player,
    SeatPlan,
    active_games_of,
    create_practice_game,
    engine_game,
    full_access,
    hub_of,
    own_deck,
    require_loaded,
    visible_game,
)
from api.identity import ApiError, Db, Principal, permissions_for, roles_of, settings_of, utcnow
from api.library import library_of
from api.models import (
    DeckRevision,
    Game,
    GameSeat,
    GameTable,
    Match,
    Notification,
    Rematch,
    RematchPlayer,
    TableSeat,
    User,
)
from api.queues import bot_plans, waiting_of
from api.roster import roster_of
from api.schemas import Contract, Error, PracticeGameRequest
from api.social import notify
from api.tables import add_table_game, open_table_of, rules_of, under_limits

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

# How long a table's rematch waits for every player's answer.
OFFER_SECONDS = 120
# A start (the last answer's) that has not finished this long after the offer's time died with
# its process: the rematch lapses.
STARTING_GRACE = timedelta(seconds=60)
RematchState = Literal["none", "open", "started", "declined", "lapsed", "failed"]


class RematchPlayerView(Contract):
    seat: int = Field(description="Their seat in the finished game.")
    handle: str | None
    portrait: str | None = Field(description="A player's allied Planeswalker.")
    answer: Literal["yes", "no"] | None = Field(description="Null while they have not answered.")
    you: bool


class RematchView(Contract):
    """A finished game's rematch, as its players see it on the result screen."""

    status: RematchState = Field(
        description="none (nobody asked yet), open (waiting for answers), started (game_id names "
        "the new game), declined, lapsed (not every answer came in time) or failed (message says "
        "whose deck or game stopped it)."
    )
    kind: Literal["practice", "table"] = Field(
        description="practice starts at once; a table's asks every player."
    )
    origin: Literal["practice", "lobby", "queue"] = Field(
        description="Where the game came from, and so where its players go back to."
    )
    can_offer: bool = Field(description="Whether you may ask for a rematch now.")
    players: list[RematchPlayerView] = Field(
        description="At a table: the players it asks, by their seats in the finished game."
    )
    your_answer: Literal["yes", "no"] | None
    expires_at: datetime | None
    expires_in: int | None = Field(description="While open: seconds left.")
    game_id: UUID | None = Field(description="The new game, once started.")
    offered_by: str | None = Field(description="The handle of who asked for it.")
    declined_by: str | None = Field(description="The handle of who declined.")
    message: str | None


def rematch_of(db: Session, game_id: UUID, *, lock: bool = False) -> Rematch | None:
    statement = select(Rematch).where(Rematch.game_id == game_id)
    if lock:
        # Read again under the lock, over what an earlier read of this session holds.
        statement = statement.with_for_update().execution_options(populate_existing=True)
    return db.scalar(statement)


def table_of(db: Session, game: Game) -> GameTable | None:
    """The table whose game it is. A best-of-three match's later games (v0.5.0) are its first
    game's table's."""
    first = game.id
    if game.match_id is not None and game.match_game != 1:
        first = (
            db.scalar(select(Game.id).where(Game.match_id == game.match_id, Game.match_game == 1))
            or game.id
        )
    return db.scalar(select(GameTable).where(GameTable.game_id == first))


def match_goes_on(db: Session, game: Game) -> bool:
    """Whether the game's best-of-three match (v0.5.0) goes on to another game: its rematch is the
    whole match's, once it is over."""
    if game.match_id is None:
        return False
    match = db.get(Match, game.match_id)
    return match is not None and match.status in ("playing", "sideboarding")


def still_there(db: Session, game: Game) -> list[GameSeat]:
    """The players a table's rematch asks: every player's seat but those the away vote removed."""
    return list(
        db.scalars(
            select(GameSeat)
            .where(
                GameSeat.game_id == game.id,
                GameSeat.user_id.is_not(None),
                or_(GameSeat.left_reason.is_(None), GameSeat.left_reason != "removed"),
            )
            .order_by(GameSeat.seat)
        )
    )


def end(db: Session, rematch: Rematch, status: str, now: datetime) -> None:
    """The rematch is over: its notifications no longer wait."""
    rematch.status = status
    rematch.ended_at = now
    db.execute(
        update(Notification)
        .where(
            Notification.kind == "rematch",
            Notification.game_id == rematch.game_id,
            Notification.read_at.is_(None),
        )
        .values(read_at=now)
    )


def lapse_if_due(db: Session, rematch: Rematch | None, now: datetime) -> None:
    """An offer not answered in time lapses; so does a start a stopped process left behind."""
    if rematch is None:
        return
    due = rematch.expires_at + (STARTING_GRACE if rematch.status == "starting" else timedelta())
    if rematch.status in ("open", "starting") and due <= now:
        end(db, rematch, "lapsed", now)
        db.commit()


def view_of(db: Session, game: Game, principal: Principal) -> RematchView:
    now = utcnow()
    rematch = rematch_of(db, game.id)
    lapse_if_due(db, rematch, now)
    me = principal.user.id
    table = table_of(db, game) if game.kind == "table" else None
    origin: Literal["practice", "lobby", "queue"] = (
        "practice" if game.kind == "practice" else "queue" if table and table.queued else "lobby"
    )
    answers: dict[UUID, str | None] = {}
    if rematch is not None:
        rows = list(
            db.scalars(
                select(RematchPlayer)
                .where(RematchPlayer.rematch_id == rematch.id)
                .order_by(RematchPlayer.seat)
            )
        )
        seated = [(row.seat, row.user_id) for row in rows]
        answers = {row.user_id: row.answer for row in rows}
    elif game.kind == "table":
        seated = [(row.seat, row.user_id) for row in still_there(db, game) if row.user_id]
    else:
        seated = []
    people = {
        user.id: user
        for user in db.scalars(select(User).where(User.id.in_([user for _, user in seated])))
    }
    played = (
        db.scalar(select(GameSeat.id).where(GameSeat.game_id == game.id, GameSeat.user_id == me))
        is not None
    )
    asked = any(user == me for _, user in seated)
    can_offer = (
        played
        and game.status != "active"
        and rematch is None
        and not match_goes_on(db, game)
        and (game.settings is not None if game.kind == "practice" else asked and len(seated) > 1)
    )
    declined = db.get(User, rematch.declined_by) if rematch and rematch.declined_by else None
    offered = db.get(User, rematch.proposed_by) if rematch else None
    open_ = rematch is not None and rematch.status in ("open", "starting")
    return RematchView(
        status=(
            "none" if rematch is None else "open" if open_ else rematch.status  # type: ignore[arg-type]
        ),
        kind=game.kind,  # type: ignore[arg-type]
        origin=origin,
        can_offer=can_offer,
        players=[
            RematchPlayerView(
                seat=seat,
                handle=people[user].handle if user in people else None,
                portrait=people[user].alliance if user in people else None,
                answer=answers.get(user),  # type: ignore[arg-type]
                you=user == me,
            )
            for seat, user in seated
        ],
        your_answer=answers.get(me),  # type: ignore[arg-type]
        expires_at=rematch.expires_at if open_ and rematch else None,
        expires_in=(
            max(0, int((rematch.expires_at - now).total_seconds())) if open_ and rematch else None
        ),
        game_id=rematch.next_game_id if rematch else None,
        offered_by=offered.handle if offered else None,
        declined_by=declined.handle if declined else None,
        message=rematch.message if rematch else None,
    )


def player_game(db: Session, game_id: UUID, principal: Principal) -> Game:
    """A finished game the account played. Others' games look like missing ones, as anywhere;
    SysOp watching one may read its rematch, not play it."""
    game, owner = visible_game(db, game_id, principal)
    if not owner:
        raise ApiError(403, "not_a_player", "Only the game's players play it again.")
    if game.status == "active":
        raise ApiError(409, "game_running", "The game has not ended yet.")
    if match_goes_on(db, game):
        raise ApiError(409, "match_running", "The match goes on: its next game comes first.")
    return game


def free_to_play(db: Session, request: Request, principal: Principal) -> None:
    """Room for the rematch: under the account's limit of running games, and at no open table or
    queue. The account's row is locked, as a seat at a table locks it."""
    user_id = principal.user.id
    db.scalar(select(User.id).where(User.id == user_id).with_for_update())
    if open_table_of(db, user_id) is not None:
        raise ApiError(409, "at_a_table", "You sit at an open table. Leave it to play the rematch.")
    if waiting_of(db, user_id) is not None:
        raise ApiError(409, "in_queue", "You are waiting in a queue. Leave it to play the rematch.")
    limit = settings_of(request).games_per_account
    if not full_access(principal) and active_games_of(db, user_id) >= limit:
        raise ApiError(409, "game_limit", "Finish your running game before the rematch.")


def answer_yes(db: Session, request: Request, game: Game, principal: Principal) -> bool:
    """Offers a table's rematch, or accepts the one offered. True when every player asked has now
    accepted: the caller starts the game, which the rematch, now starting, waits for."""
    me = principal.user.id
    now = utcnow()
    started = rematch_of(db, game.id)
    if started is not None and started.status in ("starting", "started"):
        # Started already, or starting from another player's answer: the view tells which.
        return False
    for _ in range(2):
        free_to_play(db, request, principal)
        rematch = rematch_of(db, game.id, lock=True)
        if rematch is None:
            seats = still_there(db, game)
            if not any(seat.user_id == me for seat in seats):
                raise ApiError(
                    409,
                    "not_asked",
                    "You were removed from this game, so you are not in its rematch.",
                )
            if len(seats) < 2:
                raise ApiError(
                    409, "rematch_unavailable", "Too few players are left for a rematch."
                )
            rematch = Rematch(
                game_id=game.id,
                proposed_by=me,
                status="open",
                created_at=now,
                expires_at=now + timedelta(seconds=OFFER_SECONDS),
            )
            db.add(rematch)
            try:
                db.flush()
            except IntegrityError:
                # Another player offered it at the same moment: theirs is accepted instead.
                db.rollback()
                continue
            for seat in seats:
                assert seat.user_id is not None
                proposer = seat.user_id == me
                db.add(
                    RematchPlayer(
                        rematch_id=rematch.id,
                        seat=seat.seat,
                        user_id=seat.user_id,
                        answer="yes" if proposer else None,
                        answered_at=now if proposer else None,
                    )
                )
                if not proposer:
                    notify(db, seat.user_id, "rematch", me, now, game_id=game.id)
            db.commit()
            return False
        lapse_if_due(db, rematch, now)
        if rematch.status in ("starting", "started"):
            db.commit()
            return False
        if rematch.status != "open":
            db.commit()
            raise ApiError(409, "rematch_closed", "This rematch is over.")
        rows = list(db.scalars(select(RematchPlayer).where(RematchPlayer.rematch_id == rematch.id)))
        mine = next((row for row in rows if row.user_id == me), None)
        if mine is None:
            db.commit()
            raise ApiError(409, "not_asked", "This rematch is for the players still in the game.")
        mine.answer, mine.answered_at = "yes", now
        everyone = all(row.answer == "yes" for row in rows)
        if everyone:
            rematch.status = "starting"
        db.commit()
        return everyone
    raise ApiError(409, "rematch_changed", "The rematch changed as you answered. Try again.")


def reopen(db: Session, game_id: UUID, user_id: UUID) -> None:
    """A start that could not happen now (every game slot busy, the engine silent): the offer
    stands, and the last answer is asked again, so that click starts it once it can."""
    rematch = rematch_of(db, game_id, lock=True)
    if rematch is not None and rematch.status == "starting":
        rematch.status = "open"
        db.execute(
            update(RematchPlayer)
            .where(RematchPlayer.rematch_id == rematch.id, RematchPlayer.user_id == user_id)
            .values(answer=None, answered_at=None)
        )
    db.commit()


def fail(db: Session, game_id: UUID, message: str) -> None:
    rematch = rematch_of(db, game_id, lock=True)
    if rematch is not None and rematch.status in ("open", "starting"):
        rematch.message = message
        end(db, rematch, "failed", utcnow())
    db.commit()


def plan_rematch(
    db: Session, request: Request, game: Game, principal: Principal
) -> tuple[list[SeatPlan], list[UUID | None], list[UUID]]:
    """Every seat as the engine takes it: the players asked in their order at the finished game,
    each deck (the one they played, as it stands now) bound to a revision and checked with the
    table's rules, then the bots. Returns the plans, each seat's player and the players' decks.
    A player whose account or deck stops it fails the rematch, named to everyone; their own
    deck's problem is told to them in full, as at a table's start."""
    table = table_of(db, game)
    rematch = rematch_of(db, game.id)
    assert table is not None and rematch is not None
    rows = list(
        db.scalars(
            select(RematchPlayer)
            .where(RematchPlayer.rematch_id == rematch.id)
            .order_by(RematchPlayer.seat)
        )
    )
    seats = {
        seat.seat: seat for seat in db.scalars(select(GameSeat).where(GameSeat.game_id == game.id))
    }
    roster = roster_of(request)
    team = game.format == teams.FORMAT
    plans: list[SeatPlan] = []
    users: list[UUID | None] = []
    decks: list[UUID] = []
    for row in rows:
        user = db.get(User, row.user_id)
        assert user is not None
        permissions = permissions_for(user, roles_of(db, user))
        if user.status != "active" or not {"games.play", "decks.edit"} <= permissions:
            message = f"{user.handle or 'A player'} cannot play games now."
            fail(db, game.id, message)
            raise ApiError(409, "player_unavailable", message)
        revision_id = seats[row.seat].deck_revision_id
        revision = db.get(DeckRevision, revision_id) if revision_id else None
        try:
            if revision is None:
                raise ApiError(422, "invalid_deck", "That deck is gone.")
            library = library_of(db, user, permissions, roster)
            seat, bound, title = own_deck(
                db,
                user,
                permissions,
                revision.deck_id,
                DECK_FORMATS.get(game.format, game.format),
                library,
                rules_of(table),
            )
            if team:
                # MTR 9.5: Two-Headed Giant Constructed has no sideboards.
                cast(dict[str, object], seat["deck_list"]).pop("sideboard", None)
        except ApiError as refused:
            message = f"{user.handle or 'A player'}'s deck cannot be played now."
            db.rollback()
            fail(db, game.id, message)
            if user.id == principal.user.id:
                raise
            raise ApiError(409, "deck_not_playable", message) from refused
        plans.append(SeatPlan({"player": "human", **seat}, bound, title))
        users.append(user.id)
        decks.append(revision.deck_id)
    if team:
        # Two-Headed Giant (v0.5.1): every player keeps their seat, so the teams stay; bots take
        # the seats bots or removed players held.
        kept = {row.seat: (plan, row.user_id) for row, plan in zip(rows, plans, strict=True)}
        plans = [
            kept[s][0] if s in kept else SeatPlan({"player": "bot"}) for s in range(teams.SEATS)
        ]
        users = [kept[s][1] if s in kept else None for s in range(teams.SEATS)]
        check_teams(db, game, plans, users)
    else:
        bots = table.seats - len(plans)
        plans += bot_plans(db, request, game.format, bots)
        users += [None] * bots
    for index, held in custom_in_seats(db, [plan.engine for plan in plans]).items():
        plans[index].custom = held
    # Revisions made for the game are kept even if the engine refuses it.
    db.commit()
    return plans, users, decks


def check_teams(db: Session, game: Game, plans: list[SeatPlan], users: list[UUID | None]) -> None:
    """A Two-Headed Giant rematch's teams (v0.5.1): each team of two players' decks, as they stand
    now, share no card but basic lands, and each bot gets a fixture deck its teammate's shares
    none with. A failure names the players to everyone, never their cards."""
    handles = dict(
        db.execute(
            select(User.id, User.handle).where(User.id.in_([u for u in users if u is not None]))
        ).all()
    )
    for first, second in teams.TEAMS:
        one, other = users[first], users[second]
        if one is None or other is None:
            continue
        if teams.shared(
            teams.cards_of(plans[first].engine) or set(),
            teams.cards_of(plans[second].engine) or set(),
        ):
            message = (
                f"{handles.get(one) or 'A player'}'s and {handles.get(other) or 'a player'}'s "
                "decks now share a card, and Two-Headed Giant teammates' decks may share only "
                "basic lands."
            )
            db.rollback()
            fail(db, game.id, message)
            raise ApiError(409, "team_decks", message)
    try:
        teams.assign_and_check([plan.engine for plan in plans], True)
    except ApiError as refused:
        message = (
            "A player's deck shares a card with every bot deck, so no bot can be their teammate."
        )
        db.rollback()
        fail(db, game.id, message)
        raise ApiError(409, "team_decks", message) from refused


def record_rematch(
    db: Session,
    game: Game,
    created: dict[str, object],
    plans: list[SeatPlan],
    users: list[UUID | None],
    decks: list[UUID],
) -> Game:
    """The new table, started, with its game and seats, and the rematch started, in one
    transaction. The table keeps the old one's visibility, rules, skill, turn cap and origin."""
    rematch = rematch_of(db, game.id, lock=True)
    old = table_of(db, game)
    assert rematch is not None and old is not None
    if rematch.status != "starting":
        raise ApiError(409, "rematch_closed", "This rematch is over.")
    players = [user for user in users if user is not None]
    now = utcnow()
    table = GameTable(
        code=secrets.token_urlsafe(12),
        host_id=old.host_id if old.host_id in players else players[0],
        format=old.format,
        visibility=old.visibility,
        seats=old.seats,
        bots=old.seats - len(players),
        # Two-Headed Giant's bots (v0.5.1) take the seats nobody kept.
        bot_seats=(
            [seat for seat, user in enumerate(users) if user is None]
            if old.format == teams.FORMAT
            else None
        ),
        bot_skill=old.bot_skill,
        turn_cap=old.turn_cap,
        allow_banned=old.allow_banned,
        allow_not_legal=old.allow_not_legal,
        status="open",
        created_at=now,
        queued=old.queued,
        # A best-of-three match's rematch is another match (v0.5.0): add_table_game begins it.
        best_of=old.best_of,
    )
    db.add(table)
    db.flush()
    seated = [seat for seat, user in enumerate(users) if user is not None]
    for index, user_id, deck_id in zip(seated, players, decks, strict=True):
        db.add(
            TableSeat(
                table_id=table.id,
                seat=index,
                user_id=user_id,
                deck_id=deck_id,
                ready=True,
                joined_at=now,
            )
        )
    db.flush()
    started = add_table_game(db, table, created, plans, users)
    rematch.next_game_id = started.id
    end(db, rematch, "started", now)
    db.commit()
    return started


async def start_table_rematch(
    request: Request, game: Game, principal: Principal, db: Session
) -> None:
    """Starts a table's rematch once everyone has accepted, as a table's host starts its game:
    under the old game's lock and every player's, within their limits."""
    hub = hub_of(request)
    try:
        engine = hub.require_engine()
    except ApiError:
        await run_in_threadpool(reopen, db, game.id, principal.user.id)
        raise
    async with hub.locks[game.id]:
        plans, users, decks = await run_in_threadpool(plan_rematch, db, request, game, principal)
        players = [user for user in users if user is not None]
        async with AsyncExitStack() as stack:
            for user_id in sorted(players, key=str):
                await stack.enter_async_context(hub.locks[user_id])
            try:
                await run_in_threadpool(under_limits, db, request, players)
                await require_loaded(request, plans)
            except ApiError as refused:
                await run_in_threadpool(db.rollback)
                # Custom cards are named only to their own player, as their deck is theirs.
                said = (
                    "A player's deck holds custom cards this engine has not loaded."
                    if refused.code == "custom_not_loaded"
                    else refused.message
                )
                await run_in_threadpool(fail, db, game.id, said)
                raise
            try:
                hub.reserve()
            except ApiError:
                await run_in_threadpool(reopen, db, game.id, principal.user.id)
                raise
            try:
                try:
                    created = await engine_game(
                        engine,
                        {
                            "format": game.format,
                            "seats": [plan.engine for plan in plans],
                            "skill": game.bot_skill,
                            "turn_cap": game.turn_cap,
                            "idle_timeout_seconds": TABLE_IDLE_SECONDS,
                        },
                        request,
                    )
                except ApiError:
                    await run_in_threadpool(reopen, db, game.id, principal.user.id)
                    raise
                try:
                    started = await run_in_threadpool(
                        record_rematch, db, game, created, plans, users, decks
                    )
                except (ApiError, SQLAlchemyError):
                    await run_in_threadpool(db.rollback)
                    await engine.request("POST", f"/games/{created['game_id']}/close", body={})
                    raise
                tokens = {entry["seat"]: entry["seat_token"] for entry in created["seats"]}
                hub.register(
                    LiveGame(
                        id=started.id,
                        kind="table",
                        seats={
                            seat: LiveSeat(seat, user_id, tokens[seat])
                            for seat, user_id in enumerate(users)
                            if user_id is not None
                        },
                        teams=game.format == teams.FORMAT,
                    )
                )
            finally:
                hub.starting -= 1


def record_practice_rematch(db: Session, game_id: UUID, started: UUID, user_id: UUID) -> None:
    now = utcnow()
    db.add(
        Rematch(
            game_id=game_id,
            proposed_by=user_id,
            status="started",
            created_at=now,
            expires_at=now,
            ended_at=now,
            next_game_id=started,
        )
    )
    db.commit()


# Routes.


@router.get("/games/{game_id}/rematch", response_model=RematchView)
def get_rematch(game_id: UUID, principal: Player, db: Db) -> RematchView:
    """The game's rematch as it stands, for its players (and SysOp)."""
    game, _ = visible_game(db, game_id, principal)
    return view_of(db, game, principal)


@router.post(
    "/games/{game_id}/rematch",
    response_model=RematchView,
    responses={409: {"model": Error}, 429: {"model": Error}},
)
async def rematch(game_id: UUID, request: Request, principal: Player, db: Db) -> RematchView:
    """Rematch: a practice game starts again at once; at a table this offers the rematch, or
    accepts the one offered, and the last player to accept starts it."""
    hub = hub_of(request)
    game = await run_in_threadpool(player_game, db, game_id, principal)
    if game.kind == "practice":
        async with hub.locks[game.id]:
            if await run_in_threadpool(rematch_of, db, game.id) is None:
                if game.settings is None:
                    raise ApiError(
                        409,
                        "rematch_unavailable",
                        "This game began before rematches: start a new one from Play.",
                    )
                body = PracticeGameRequest.model_validate(game.settings)
                started = await create_practice_game(body, request, principal, db)
                await run_in_threadpool(
                    record_practice_rematch, db, game.id, started.id, principal.user.id
                )
    elif await run_in_threadpool(answer_yes, db, request, game, principal):
        await start_table_rematch(request, game, principal, db)
    return await run_in_threadpool(view_of, db, game, principal)


@router.post(
    "/games/{game_id}/rematch/decline",
    response_model=RematchView,
    responses={409: {"model": Error}},
)
def decline_rematch(game_id: UUID, principal: Player, db: Db) -> RematchView:
    """Declines the rematch offered (or withdraws your own): it ends for every player."""
    game = player_game(db, game_id, principal)
    rematch = rematch_of(db, game.id, lock=True)
    if rematch is not None and rematch.status == "open":
        mine = db.scalar(
            select(RematchPlayer).where(
                RematchPlayer.rematch_id == rematch.id,
                RematchPlayer.user_id == principal.user.id,
            )
        )
        if mine is not None:
            now = utcnow()
            mine.answer, mine.answered_at = "no", now
            rematch.declined_by = principal.user.id
            end(db, rematch, "declined", now)
    db.commit()
    return view_of(db, game, principal)
