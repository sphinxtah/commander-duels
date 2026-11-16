"""Spectators at a table (v1.0.0, the specification's section 24; docs/tables.md).

A table's game is watched by people who do not play it. A spectator sees what every seat sees:
the battlefield, the stack, the graveyards, the log; never a hand, a library or a card looked
at. A spectator cannot act. The engine has given every game one spectator token since v0.0.4,
which reads that public view and nothing else (docs/engine/commander-tables.md); this module
decides who the API lets through to it.

The owner's decisions (2026-11-16):

- **The host sets who may watch**: nobody (as every table was), the friends its players
  invited, or anyone, at a public table alone, which the lobby then lists to watch.
- **Any seated player invites their own friends** while the host's setting allows spectators.
  **The host removes any spectator**; a player withdraws their own invitations; a spectator
  leaves.
- **Invited spectators watch live; where anyone may watch, the game is shown a minute behind**
  (``watching.OPEN_DELAY_SECONDS``). The engine is told the delay as the game starts and keeps to
  it: nothing changes it afterwards, a reconnection and a recovery included.

Who may watch is asked every time a spectator reads the game or connects to it
(``watching.may_watch``),
so a removal stops the next reading; ``GameHub.drop_spectator`` closes the connections it has
open. Behind the gate ``spectators``: while it is not an account's to reach, these routes answer
as paths that do not exist, a table cannot be opened to spectators, and nobody watches.
"""

from datetime import datetime
from uuid import UUID

from fastapi import Request
from pydantic import Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from api import rollout, social, watching
from api.auth import INPUT_ERRORS
from api.games import Player, hub_of
from api.identity import ApiError, Db, Principal, not_found, utcnow
from api.models import GameTable, TableSeat, TableSpectator, User
from api.schemas import Contract, Error, TableFormatId
from api.social import PlayerRef, player_ref
from api.tables import Code, find, status_of
from api.watching import allowed, invited, seated

router = rollout.router(
    watching.WORKFLOW, prefix="/api/v1", tags=["spectators"], responses=INPUT_ERRORS
)

# The most friends invited to watch one table.
SPECTATORS_PER_TABLE = 20


class SpectatorView(Contract):
    player: PlayerRef
    invited_by: str = Field(description="The handle of the player who invited them.")
    yours: bool = Field(description="Whether you invited them: you may withdraw the invitation.")
    you: bool


class Spectators(Contract):
    setting: watching.Setting
    delay_seconds: int = Field(
        description="How far behind the game spectators watch: 0 where they were invited, a "
        "minute where anyone may watch."
    )
    invited: list[SpectatorView]
    limit: int
    can_invite: bool = Field(
        description="Whether you may invite: seated at the table, which lets spectators in."
    )
    can_remove: bool = Field(description="Whether you may remove any spectator: the host.")


class SpectatorInviting(Contract):
    players: list[UUID] = Field(min_length=1, max_length=SPECTATORS_PER_TABLE)


class Watchable(Contract):
    """A table whose game the account may watch."""

    code: str
    format: TableFormatId
    host: str
    players: list[str] = Field(description="Its players' handles, in seat order.")
    game_id: UUID | None = Field(description="Its game, once started; null while it waits.")
    invited: bool = Field(description="Whether you were invited; false for a table open to anyone.")
    delay_seconds: int


def view_of(db: Session, table: GameTable, principal: Principal) -> Spectators:
    rows = list(
        db.scalars(
            select(TableSpectator)
            .where(TableSpectator.table_id == table.id)
            .order_by(TableSpectator.created_at)
        )
    )
    users = {
        user.id: user
        for user in db.scalars(
            select(User).where(
                User.id.in_({row.user_id for row in rows} | {row.invited_by for row in rows})
            )
        )
    }
    me = principal.user.id
    return Spectators(
        setting=table.spectators,  # type: ignore[arg-type]
        delay_seconds=watching.delay(table),
        invited=[
            SpectatorView(
                player=player_ref(users[row.user_id]),
                invited_by=users[row.invited_by].handle or "" if row.invited_by in users else "",
                yours=row.invited_by == me,
                you=row.user_id == me,
            )
            for row in rows
            if row.user_id in users
        ],
        limit=SPECTATORS_PER_TABLE,
        can_invite=table.spectators != "nobody"
        and status_of(table) in ("open", "started")
        and seated(db, table, me),
        can_remove=table.host_id == me,
    )


def party(db: Session, table: GameTable, principal: Principal) -> None:
    """Only the table's players and the people invited to watch read its spectators."""
    me = principal.user.id
    if not (seated(db, table, me) or invited(db, table, me)):
        raise not_found()


@router.get("/tables/{code}/spectators", response_model=Spectators)
def read_spectators(code: Code, principal: Player, db: Db) -> Spectators:
    """Who is invited to watch the table's game, for its players and for those invited."""
    table = find(db, code)
    party(db, table, principal)
    return view_of(db, table, principal)


@router.post(
    "/tables/{code}/spectators",
    response_model=Spectators,
    responses={409: {"model": Error}, 422: {"model": Error}},
)
def invite_spectators(code: Code, body: SpectatorInviting, principal: Player, db: Db) -> Spectators:
    """A seated player invites friends to watch, while the host's setting lets spectators in and
    the table is open or its game runs. Each is told by the bell, once."""
    table = find(db, code, lock=True)
    me = principal.user
    if not seated(db, table, me.id):
        raise ApiError(409, "not_seated", "Only the table's players invite spectators.")
    if status_of(table) not in ("open", "started"):
        raise ApiError(409, "table_closed", "This table is over.")
    if table.spectators == "nobody":
        raise ApiError(
            409, "spectators_off", "This table's host lets nobody watch: ask them to change it."
        )
    wanted = list(dict.fromkeys(body.players))
    friends = list(
        db.scalars(select(User).where(User.id.in_(wanted), social.befriended(me.id, User.id)))
    )
    if len(friends) != len(wanted):
        raise ApiError(422, "not_friend", "Only your friends are invited to watch.")
    now = utcnow()
    taken = set(
        db.scalars(
            select(TableSeat.user_id).where(
                TableSeat.table_id == table.id, TableSeat.user_id.in_(wanted)
            )
        )
    )
    if taken:
        raise ApiError(422, "already_seated", "A player of the table does not watch it.")
    already = set(
        db.scalars(
            select(TableSpectator.user_id).where(
                TableSpectator.table_id == table.id, TableSpectator.user_id.in_(wanted)
            )
        )
    )
    new = [friend for friend in friends if friend.id not in already]
    count = (
        db.scalar(
            select(func.count())
            .select_from(TableSpectator)
            .where(TableSpectator.table_id == table.id)
        )
        or 0
    )
    if count + len(new) > SPECTATORS_PER_TABLE:
        raise ApiError(
            409,
            "too_many_spectators",
            f"A table invites {SPECTATORS_PER_TABLE} spectators in all; {count} are invited "
            "already.",
        )
    invite(db, table, me, new, now)
    db.commit()
    return view_of(db, table, principal)


def invite(
    db: Session, table: GameTable, inviter: User, friends: list[User], now: datetime
) -> None:
    for friend in friends:
        db.add(
            TableSpectator(
                table_id=table.id, user_id=friend.id, invited_by=inviter.id, created_at=now
            )
        )
        social.notify(db, friend.id, "watch_invite", inviter.id, now, subject=table.code)
    db.flush()


@router.delete(
    "/tables/{code}/spectators/{player_id}",
    response_model=Spectators,
    responses={403: {"model": Error}},
)
def remove_spectator(
    code: Code, player_id: UUID, request: Request, principal: Player, db: Db
) -> Spectators:
    """Removes a spectator: the host any of them, a player one they invited, a spectator
    themselves. Their connections to the game close, and they read it no more."""
    table = find(db, code, lock=True)
    party(db, table, principal)
    row = db.scalar(
        select(TableSpectator).where(
            TableSpectator.table_id == table.id, TableSpectator.user_id == player_id
        )
    )
    if row is None:
        raise not_found()
    me = principal.user.id
    if me not in (table.host_id, row.invited_by, row.user_id):
        raise ApiError(
            403, "not_host", "The host removes a spectator; you withdraw only your own invitations."
        )
    db.delete(row)
    db.commit()
    # Their connections close: to the table's game, and of a match to the one played now.
    for game_id in {table.game_id, watching.current_game(db, table)}:
        if game_id is not None:
            hub_of(request).drop_spectator(game_id, player_id)
    if me == player_id:
        # Gone from the table's list, they read it no more: an empty answer, as they left.
        return Spectators(
            setting=table.spectators,  # type: ignore[arg-type]
            delay_seconds=watching.delay(table),
            invited=[],
            limit=SPECTATORS_PER_TABLE,
            can_invite=False,
            can_remove=False,
        )
    return view_of(db, table, principal)


@router.get("/spectating", response_model=list[Watchable])
def watchable(principal: Player, db: Db) -> list[Watchable]:
    """The tables whose game the account may watch now: those it was invited to, waiting or
    running, then the running games of public tables open to anyone, the newest first."""
    me = principal.user
    mine = select(TableSpectator.table_id).where(TableSpectator.user_id == me.id)
    tables = list(
        db.scalars(
            select(GameTable)
            .where(
                GameTable.spectators != "nobody",
                or_(
                    GameTable.id.in_(mine) & GameTable.status.in_(("open", "started")),
                    (GameTable.spectators == "anyone")
                    & (GameTable.visibility == "public")
                    & (GameTable.status == "started"),
                ),
            )
            .order_by(GameTable.created_at.desc())
            .limit(100)
        )
    )
    found: list[Watchable] = []
    for table in tables:
        if status_of(table) not in ("open", "started") or not allowed(db, table, me):
            continue
        handles = dict(
            db.execute(
                select(TableSeat.seat, User.handle)
                .join(User, User.id == TableSeat.user_id)
                .where(TableSeat.table_id == table.id)
            ).all()
        )
        host = db.get(User, table.host_id)
        found.append(
            Watchable(
                code=table.code,
                format=table.format,  # type: ignore[arg-type]
                host=(host.handle or "") if host else "",
                players=[handles[seat] or "" for seat in sorted(handles)],
                game_id=(watching.current_game(db, table) if table.status == "started" else None),
                invited=invited(db, table, me.id),
                delay_seconds=watching.delay(table),
            )
        )
    return found
