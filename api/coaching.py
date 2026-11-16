"""Coaching (v1.0.0, the specification's section 24; docs/games.md).

A player lets one friend see what they see while they play: their seat's own view, their hand
included. The coach cannot act, and advises in the friends' chat the two already have.

The owner's decision (2026-11-16): **against bots, and at a private table**, where every player
is told that the seat has a coach. Never at a public table or in a queue's game.

It is the player's consent, given and taken back: an access grant of a seat's hand
(api/access.py, the resource ``hand``, with the seat in its scope), asked for every time the
coach reads the game or connects to it, so a withdrawal stops the next reading, and the hub
closes the connections the coach has open (``GameHub.drop_coach``). It lasts while the game
does: over, the grant gives nothing. A seat has one coach at a time, and a coach one seat of a
game: nobody sees two hands. A game's events are read through
the same grant (api/events.py), as its seat reads them. Behind the gate ``coaching``: while it
is not an account's to reach, these routes answer as paths that do not exist, and a grant gives
nothing.
"""

from uuid import UUID

from fastapi import Request
from pydantic import Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from api import access, rollout, social, watching
from api.auth import INPUT_ERRORS
from api.games import Player, hub_of
from api.identity import ApiError, Db, Principal, not_found, utcnow
from api.models import AccessGrant, Game, GameSeat, User
from api.schemas import Contract, Error
from api.social import PlayerRef, player_ref

WORKFLOW = "coaching"
router = rollout.router(WORKFLOW, prefix="/api/v1", tags=["coaching"], responses=INPUT_ERRORS)


class CoachView(Contract):
    seat: int = Field(description="The seat whose player is coached.")
    player: str | None = Field(description="That player's handle.")
    coach: PlayerRef
    yours: bool = Field(description="Whether the coach is yours: you may end it.")
    you: bool = Field(description="Whether you are the coach: you may leave.")


class Coaching(Contract):
    coaches: list[CoachView]
    can_invite: bool = Field(
        description="Whether you may let a friend coach you here now: you play in this game, "
        "it is one a player is coached in, and you have no coach."
    )
    reason: str | None = Field(
        description="For a player of the game who may not: why, in words. Null otherwise."
    )


class CoachInviting(Contract):
    player: UUID = Field(description="The friend who is to see what you see.")


def grants_of(db: Session, game_id: UUID) -> list[AccessGrant]:
    """The game's coaches now: every grant of a seat's hand that still gives its coach access,
    as ``access.active`` judges it, by seat. None once the game is over: a player's leave lasts
    while they play, and what the game's record keeps is not a coach's to read afterwards."""
    game = db.get(Game, game_id)
    if game is None or game.status not in ("active", "saved"):
        return []
    now = utcnow()
    given = db.scalars(
        select(AccessGrant).where(
            AccessGrant.resource_kind == "hand",
            AccessGrant.resource_id == game_id,
            AccessGrant.revoked_at.is_(None),
            or_(AccessGrant.expires_at.is_(None), AccessGrant.expires_at > now),
        )
    )
    usable = [
        grant
        for grant in given
        if isinstance(grant.scope.get("seat"), int)
        and any(
            found.id == grant.id
            for found in access.active(db, grant.subject_id, "hand", game_id, now)
        )
    ]
    return sorted(usable, key=lambda grant: int(str(grant.scope["seat"])))


def coached_seat(db: Session, game_id: UUID, user: User) -> int | None:
    """The seat the account coaches in the game now, or None. Asked at every reading."""
    for grant in grants_of(db, game_id):
        if grant.subject_id == user.id:
            return int(str(grant.scope["seat"]))
    return None


def wire(db: Session, game_id: UUID) -> list[dict[str, object]]:
    """The game's coaches as its socket tells them to everyone at it: each seat that has one,
    and the coach's handle."""
    grants = grants_of(db, game_id)
    handles = dict(
        db.execute(
            select(User.id, User.handle).where(User.id.in_({g.subject_id for g in grants}))
        ).all()
    )
    return [
        {"seat": int(str(grant.scope["seat"])), "handle": handles.get(grant.subject_id)}
        for grant in grants
    ]


def unfit(db: Session, game: Game, rows: list[GameSeat]) -> str | None:
    """Why nobody is coached in this game, in words; None where a player may be: against bots,
    and at a private table that no queue opened."""
    if game.status != "active":
        return "This game is over."
    humans = [row for row in rows if row.user_id is not None]
    if game.kind != "table" and len(humans) <= 1:
        return None
    table = watching.table_of(db, game.id)
    if table is None or table.visibility != "private" or table.queued:
        return "A player is coached against bots and at a private table only."
    return None


def view_of(db: Session, game: Game, rows: list[GameSeat], principal: Principal) -> Coaching:
    me = principal.user.id
    grants = grants_of(db, game.id)
    users = {
        user.id: user
        for user in db.scalars(
            select(User).where(
                User.id.in_({g.subject_id for g in grants} | {g.grantor_id for g in grants})
            )
        )
    }
    mine = next((row for row in rows if row.user_id == me), None)
    reason: str | None = None
    if mine is not None:
        reason = unfit(db, game, rows)
        if reason is None and mine.left_reason is not None:
            reason = "You are out of this game."
        if reason is None and any(grant.grantor_id == me for grant in grants):
            reason = "You have a coach already: end that first."
    return Coaching(
        coaches=[
            CoachView(
                seat=int(str(grant.scope["seat"])),
                player=users[grant.grantor_id].handle if grant.grantor_id in users else None,
                coach=player_ref(users[grant.subject_id]),
                yours=grant.grantor_id == me,
                you=grant.subject_id == me,
            )
            for grant in grants
            if grant.subject_id in users
        ],
        can_invite=mine is not None and reason is None,
        reason=reason,
    )


def found(db: Session, game_id: UUID, principal: Principal) -> tuple[Game, list[GameSeat]]:
    """The game, for its players and its coaches; anyone else is told of no game."""
    game = db.get(Game, game_id)
    rows = list(db.scalars(select(GameSeat).where(GameSeat.game_id == game_id)))
    me = principal.user
    if game is None or not (
        any(row.user_id == me.id for row in rows) or coached_seat(db, game_id, me) is not None
    ):
        raise not_found()
    return game, rows


@router.get("/games/{game_id}/coaches", response_model=Coaching)
def read_coaches(game_id: UUID, principal: Player, db: Db) -> Coaching:
    """The game's coaches, for its players and for the coaches themselves."""
    game, rows = found(db, game_id, principal)
    return view_of(db, game, rows, principal)


@router.post(
    "/games/{game_id}/coaches",
    response_model=Coaching,
    responses={409: {"model": Error}, 422: {"model": Error}},
)
def invite_coach(
    game_id: UUID, body: CoachInviting, request: Request, principal: Player, db: Db
) -> Coaching:
    """A player of the game lets a friend see what they see, their hand included, until either
    of them ends it or the game is over. One coach a seat, and one seat a coach. The friend is
    told by the bell, and everyone at the game that the seat has a coach."""
    me = principal.user
    game = db.scalar(select(Game).where(Game.id == game_id).with_for_update())
    rows = list(db.scalars(select(GameSeat).where(GameSeat.game_id == game_id)))
    mine = next((row for row in rows if row.user_id == me.id), None)
    if game is None or mine is None:
        raise not_found()
    reason = unfit(db, game, rows)
    if reason is not None:
        raise ApiError(409, "not_coachable", reason)
    if mine.left_reason is not None:
        raise ApiError(409, "not_in_game", "You are out of this game.")
    friend = db.scalar(
        select(User).where(User.id == body.player, social.befriended(me.id, User.id))
    )
    if friend is None:
        raise ApiError(422, "not_friend", "Only a friend of yours coaches you.")
    if any(row.user_id == friend.id for row in rows):
        raise ApiError(422, "already_seated", "A player of the game does not coach in it.")
    grants = grants_of(db, game_id)
    if any(grant.grantor_id == me.id for grant in grants):
        raise ApiError(409, "coach_exists", "You have a coach already: end that first.")
    if any(grant.subject_id == friend.id for grant in grants):
        raise ApiError(
            409,
            "already_coaching",
            "They coach another player of this game: nobody sees two hands.",
        )
    now = utcnow()
    access.offer(db, me, friend, "hand", game_id, scope={"seat": mine.seat}, now=now)
    social.notify(db, friend.id, "coach_invite", me.id, now, game_id=game_id)
    db.commit()
    hub_of(request).coaches_changed(game_id, wire(db, game_id))
    return view_of(db, game, rows, principal)


@router.delete(
    "/games/{game_id}/coaches/{player_id}",
    response_model=Coaching,
)
def end_coaching(
    game_id: UUID, player_id: UUID, request: Request, principal: Player, db: Db
) -> Coaching:
    """Ends a coach's access: the player takes it back, or the coach leaves. Their connections
    to the game close, and they read it no more."""
    me = principal.user
    game = db.get(Game, game_id)
    grant = next(
        (
            each
            for each in grants_of(db, game_id)
            if each.subject_id == player_id and me.id in (each.grantor_id, each.subject_id)
        ),
        None,
    )
    if game is None or grant is None:
        raise not_found()
    access.revoke(db, grant, me)
    db.commit()
    hub = hub_of(request)
    hub.drop_coach(game_id, player_id)
    hub.coaches_changed(game_id, wire(db, game_id))
    rows = list(db.scalars(select(GameSeat).where(GameSeat.game_id == game_id)))
    if me.id == player_id:
        # Gone from the game, they read it no more: an empty answer, as they left.
        return Coaching(coaches=[], can_invite=False, reason=None)
    return view_of(db, game, rows, principal)
