"""Development fixtures (v0.9.13, the specification's section 15: "development fixtures and
reproducible scenarios"; docs/operations.md).

What v1.0.0's workflows read and no route can make yet, written into a development database so
their screens can be built against something that is always the same:

- four accounts: ``fixture-ada`` and ``fixture-bea`` (the game's two players), ``fixture-cal``
  (a player with no seat in it) and ``fixture-eve`` (an administrator);
- one finished table game between ada and bea, with a short record of structured events of every
  visibility (docs/engine/events.md): a card only its seat sees, spells everyone sees, damage,
  a creature dying, the game's end;
- the access v1.0.0 will give (api/access.py): cal watches the game as a spectator, cal replays
  it through bea's seat, and eve is shown ada's hand as a coach.

Every id is derived from its name, so the command can be run again: it writes what is missing and
writes the game's events anew. The access gives nothing until its workflow is rolled out in that
database (api/rollout.py), which is the gate at work; ``--rollout`` stages every workflow there.

``python -m api.cli fixtures`` refuses the live site: a database whose settings say production.
"""

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID, uuid5

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from api import rollout
from api.identity import hash_token
from api.models import (
    AccessGrant,
    Game,
    GameEventRow,
    GameSeat,
    RoleGrant,
    SiteSetting,
    User,
    UserSession,
)

NAMESPACE = UUID("5c1f0a8e-7d7b-4f0e-9d0b-0f1c7a6e0913")
ACCOUNTS = ("fixture-ada", "fixture-bea", "fixture-cal", "fixture-eve")
ADMINISTRATOR = "fixture-eve"
GAME = "fixture-game"


def fixture_id(name: str) -> UUID:
    return uuid5(NAMESPACE, name)


def _card(ref: str, name: str, owner: int, seen_by: object) -> dict[str, object]:
    return {"ref": ref, "name": name, "owner": owner, "seen_by": seen_by}


# A short game between seat 0 (ada) and seat 1 (bea): each event as the engine makes them (v 1).
EVENTS: list[dict[str, Any]] = [
    {
        "v": 1, "seq": 1, "epoch": 0, "turn": 1, "step": "draw", "type": "zone_change",
        "from": "library", "to": "hand", "player": 0,
        "object": _card("o00000000000000a1", "Lightning Bolt", 0, [0]),
    },
    {
        "v": 1, "seq": 2, "epoch": 0, "turn": 1, "step": "precombat_main", "type": "cast",
        "player": 0, "object": _card("o00000000000000a2", "Goblin Guide", 0, "all"),
    },
    {
        "v": 1, "seq": 3, "epoch": 0, "turn": 2, "step": "draw", "type": "zone_change",
        "from": "library", "to": "hand", "player": 1,
        "object": _card("o00000000000000b1", "Counterspell", 1, [1]),
    },
    {
        "v": 1, "seq": 4, "epoch": 0, "turn": 2, "step": "precombat_main", "type": "cast",
        "player": 1, "object": _card("o00000000000000b2", "Grizzly Bears", 1, "all"),
    },
    {
        "v": 1, "seq": 5, "epoch": 0, "turn": 3, "step": "precombat_main", "type": "cast",
        "player": 0, "object": _card("o00000000000000a3", "Lightning Bolt", 0, "all"),
        "targets": [_card("o00000000000000b2", "Grizzly Bears", 1, "all")],
    },
    {
        "v": 1, "seq": 6, "epoch": 0, "turn": 3, "step": "precombat_main", "type": "damage",
        "target": {"object": _card("o00000000000000b2", "Grizzly Bears", 1, "all")},
        "amount": 3, "combat": False,
        "cause": _card("o00000000000000a3", "Lightning Bolt", 0, "all"),
    },
    {
        "v": 1, "seq": 7, "epoch": 0, "turn": 3, "step": "precombat_main", "type": "zone_change",
        "from": "battlefield", "to": "graveyard", "player": 1,
        "object": _card("o00000000000000b2", "Grizzly Bears", 1, "all"),
        "cause": _card("o00000000000000a3", "Lightning Bolt", 0, "all"),
    },
    {
        "v": 1, "seq": 8, "epoch": 0, "turn": 3, "step": "combat_damage", "type": "damage",
        "target": {"seat": 1}, "amount": 2, "combat": True,
        "cause": _card("o00000000000000a2", "Goblin Guide", 0, "all"),
    },
    {
        "v": 1, "seq": 9, "epoch": 0, "turn": 9, "step": "combat_damage", "type": "eliminated",
        "player": 1, "reason": "life",
    },
]  # fmt: skip


@dataclass
class Written:
    accounts: dict[str, UUID]
    game: UUID
    # A session's cookie for each account, when asked for: the token is kept nowhere else.
    sessions: dict[str, str]


def refuse_production(environment: str) -> None:
    if environment == "production":
        raise SystemExit(
            "Fixtures are for a development database. This one's settings say production "
            "(CD_ENVIRONMENT); nothing was written."
        )


def write(
    db: Session, now: datetime, *, sessions: bool = False, stage: str | None = None
) -> Written:
    """Writes the fixtures in the caller's transaction: what is missing, and the game's events
    anew. ``sessions`` signs each account in; ``stage`` sets every workflow's stage."""
    accounts: dict[str, UUID] = {}
    for handle in ACCOUNTS:
        accounts[handle] = fixture_id(handle)
        if db.get(User, accounts[handle]) is None:
            db.add(
                User(
                    id=accounts[handle],
                    handle=handle,
                    normalized_handle=handle,
                    display_name=handle.removeprefix("fixture-").title(),
                    kind="player",
                    status="active",
                    onboarding="complete",
                    created_at=now,
                )
            )
    db.flush()
    eve = accounts[ADMINISTRATOR]
    if db.scalar(select(RoleGrant.id).where(RoleGrant.user_id == eve)) is None:
        db.add(RoleGrant(user_id=eve, role="administrator", granted_at=now))
    ada, bea, cal = (accounts[f"fixture-{name}"] for name in ("ada", "bea", "cal"))

    game_id = fixture_id(GAME)
    if db.get(Game, game_id) is None:
        ended = now - timedelta(hours=1)
        db.add(
            Game(
                id=game_id,
                kind="table",
                format="legacy",
                status="finished",
                created_by=ada,
                created_at=ended - timedelta(minutes=20),
                finished_at=ended,
                bot_skill=1,
                turn_cap=30,
                mode="table",
                result={
                    "kind": "completed",
                    "winner_seat": 0,
                    "draw": False,
                    "turns": 9,
                    "conceded_seats": [],
                },
            )
        )
        db.flush()
        for seat, owner in enumerate((ada, bea)):
            db.add(
                GameSeat(game_id=game_id, seat=seat, player="human", user_id=owner, deck="fixture")
            )
    db.execute(delete(GameEventRow).where(GameEventRow.game_id == game_id))
    for event in EVENTS:
        db.add(
            GameEventRow(
                game_id=game_id,
                seq=event["seq"],
                epoch=event["epoch"],
                turn=event["turn"],
                type=event["type"],
                event=event,
            )
        )

    # The access v1.0.0's routes will give, written as they will write it.
    for name, grantor, subject, kind, scope in (
        ("watches", ada, cal, "spectator", {}),
        ("replays", bea, cal, "replay", {"seat": 1}),
        ("coaches", ada, eve, "hand", {"seat": 0}),
    ):
        if db.get(AccessGrant, fixture_id(f"grant:{name}")) is None:
            db.add(
                AccessGrant(
                    id=fixture_id(f"grant:{name}"),
                    grantor_id=grantor,
                    subject_id=subject,
                    resource_kind=kind,
                    resource_id=game_id,
                    scope=scope,
                    consent="given",
                    created_at=now,
                )
            )

    if stage is not None:
        for workflow in rollout.WORKFLOWS:
            setting = db.get(SiteSetting, rollout.PREFIX + workflow) or SiteSetting(
                key=rollout.PREFIX + workflow
            )
            setting.value, setting.updated_at = stage, now
            db.add(setting)

    cookies: dict[str, str] = {}
    if sessions:
        for handle, user_id in accounts.items():
            token = secrets.token_urlsafe(32)
            db.add(
                UserSession(
                    token_hash=hash_token(token),
                    user_id=user_id,
                    kind="google",
                    csrf_token=secrets.token_urlsafe(32),
                    privilege_version=0,
                    created_at=now,
                    authenticated_at=now,
                    last_seen_at=now,
                    idle_expires_at=now + timedelta(days=1),
                    absolute_expires_at=now + timedelta(days=1),
                )
            )
            cookies[handle] = f"__Host-cd_session={token}"
    db.flush()
    return Written(accounts=accounts, game=game_id, sessions=cookies)
