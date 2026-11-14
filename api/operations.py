"""What an operator reads about the running site (v0.9.13, the specification's section 15;
docs/operations.md): one route for SysOp and administrators.

``GET /api/v1/admin/operations`` gathers what was read in three places before, and what was not
counted at all:

- the API's counts since it started (api/metrics.py): access refused and settlements that waited
  or failed, by code;
- the games' record: how many are running, and how the last day's and week's ended;
- access given (api/access.py) by its state, and each unfinished workflow's stage
  (api/rollout.py);
- the worker's jobs: the newest of each kind, with how it ended;
- the engine's own numbers, passed through: its processes, their budgets and the bots'
  (docs/engine/isolation.md), and its recordings and recoveries (docs/engine/recovery.md).

Numbers, codes and ids, and nothing concealed: no hand, deck list, library or chat is read here,
so diagnosing a failure exposes none. A reading is not audited for the same reason.
"""

from datetime import datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from pydantic import Field
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api import metrics, rollout
from api.auth import INPUT_ERRORS
from api.database import migration_head
from api.games import EngineUnavailable, hub_of
from api.identity import Principal, require_permission, utcnow
from api.models import AccessGrant, Game, ScheduledJob
from api.schemas import Contract
from api.version import APP_VERSION

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
Reader = Annotated[Principal, Depends(require_permission("admin.audit.read"))]


class GamesEnded(Contract):
    finished: int
    interrupted: int


class GamesNow(Contract):
    running: int = Field(description="Games this process is following.")
    active: int = Field(description="Games recorded as running.")
    last_day: GamesEnded
    last_week: GamesEnded


class Job(Contract):
    kind: str
    status: str
    result_code: str | None
    due_at: datetime


class Operations(Contract):
    version: str
    migration: str
    since: datetime = Field(description="When this process started counting.")
    now: datetime
    counts: list[metrics.Count]
    games: GamesNow
    access: dict[str, int] = Field(description="Access given, by its state.")
    rollout: rollout.Rollout
    jobs: list[Job] = Field(description="The worker's newest job of each kind.")
    engine: dict[str, Any] | None = Field(
        description="The engine's processes and recordings as it reports them; none while it "
        "does not answer."
    )


def ended(db: Session, since: datetime) -> GamesEnded:
    counted = dict(
        db.execute(
            select(Game.status, func.count()).where(Game.finished_at >= since).group_by(Game.status)
        ).all()
    )
    return GamesEnded(
        finished=counted.get("finished", 0), interrupted=counted.get("interrupted", 0)
    )


def grants(db: Session, now: datetime) -> dict[str, int]:
    """Access given, by its state: a grant revoked or past its time is counted as that, whatever
    its subject answered."""
    found = {"offered": 0, "accepted": 0, "given": 0, "declined": 0, "revoked": 0, "expired": 0}
    for grant in db.scalars(select(AccessGrant)):
        if grant.revoked_at is not None:
            state = "revoked"
        elif grant.expires_at is not None and grant.expires_at <= now:
            state = "expired"
        else:
            state = grant.consent
        found[state] = found.get(state, 0) + 1
    return found


def jobs(db: Session) -> list[Job]:
    newest = (
        select(ScheduledJob.kind, func.max(ScheduledJob.due_at).label("due_at"))
        .group_by(ScheduledJob.kind)
        .subquery()
    )
    rows = db.scalars(
        select(ScheduledJob)
        .join(
            newest,
            (ScheduledJob.kind == newest.c.kind) & (ScheduledJob.due_at == newest.c.due_at),
        )
        .order_by(ScheduledJob.kind)
    )
    found: dict[str, Job] = {}
    for row in rows:
        found.setdefault(
            row.kind,
            Job(kind=row.kind, status=row.status, result_code=row.result_code, due_at=row.due_at),
        )
    return list(found.values())


async def engine_numbers(request: Request) -> dict[str, Any] | None:
    engine = hub_of(request).engine
    if engine is None:
        return None
    found: dict[str, Any] = {}
    for name in ("processes", "recordings"):
        try:
            status, body = await engine.request("GET", f"/{name}", timeout=3.0)
        except EngineUnavailable:
            return None
        if status == 200 and isinstance(body, dict):
            found[name] = body
    return found or None


class Recorded(Contract):
    """What the database holds of it, read in one go off the event loop."""

    games: GamesNow
    access: dict[str, int]
    rollout: rollout.Rollout
    jobs: list[Job]


def recorded(database: Engine, running: int, now: datetime) -> Recorded:
    with Session(database) as db:
        active = db.scalar(select(func.count()).select_from(Game).where(Game.status == "active"))
        return Recorded(
            games=GamesNow(
                running=running,
                active=active or 0,
                last_day=ended(db, now - timedelta(days=1)),
                last_week=ended(db, now - timedelta(days=7)),
            ),
            access=grants(db, now),
            rollout=rollout.staged(db),
            jobs=jobs(db),
        )


@router.get("/admin/operations", response_model=Operations)
async def operations(request: Request, principal: Reader) -> Operations:
    """The site's operating numbers, for SysOp and administrators: counts, codes and ids."""
    now = utcnow()
    hub = hub_of(request)
    found = await run_in_threadpool(recorded, request.app.state.database, hub.running(), now)
    return Operations(
        version=APP_VERSION,
        migration=migration_head(),
        since=metrics.COUNTERS.since,
        now=now,
        counts=metrics.COUNTERS.snapshot(),
        games=found.games,
        access=found.access,
        rollout=found.rollout,
        jobs=found.jobs,
        engine=await engine_numbers(request),
    )
