"""Rollout: the gates of the workflows that are not finished (v0.9.13, the specification's
section 15; docs/operations.md).

The Preparation Framework put v1.0.0's foundations in the game ahead of the screens that use them.
A foundation is finished and tested; the workflow a player would walk through it is not. Each such
workflow is named here and has a **stage**:

- ``off``: unreachable. Its routes answer as paths that do not exist, its access cannot be given
  or used, and no game is made in its mode.
- ``staff``: SysOp and administrators alone, to try it on the live site before anyone else.
- ``on``: everyone.

Every workflow is ``off`` until SysOp sets it (``site_settings``, ``rollout.<workflow>``; each
change audited). Nothing here knows what a workflow does: it answers one question, whether an
account may reach it now, and is asked where the workflow begins:

- **Routes.** A workflow's routes are made on ``router(workflow)``, which checks the gate before
  the route runs. Each workflow also reserves the paths its routes live under, and the app does
  not start with a route under a reserved path that has no gate (``unguarded``): a route added
  in v1.0.0 cannot be left open by forgetting.
- **Access** (api/access.py). The kind of access a workflow gives (a lent deck, a spectator's
  seat, a seat's hand, a replay, the sandbox's cards) cannot be offered, and gives nothing, while
  its workflow is not available to the account.
- **Modes** (api/modes.py). No game is made in the sandbox's mode or a borrowed deck's until its
  workflow is available to the player who starts it.

What is finished needs no gate and has none: recovery, a game's timeline for its own players, the
deck workshop's services, table profiles and large boards are in the game for everyone.
"""

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, Literal, get_args

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.routing import iter_route_contexts
from pydantic import Field
from sqlalchemy.orm import Session

from api import metrics
from api.auth import INPUT_ERRORS
from api.identity import (
    Active,
    ApiError,
    Db,
    Principal,
    audit,
    not_found,
    require_permission,
    roles_of,
    utcnow,
)
from api.models import SiteSetting, User
from api.schemas import Contract

Stage = Literal["off", "staff", "on"]
STAGES: tuple[str, ...] = get_args(Stage)
PREFIX = "rollout."


@dataclass(frozen=True)
class Workflow:
    """An unfinished workflow of v1.0.0: its name, the specification's section (0 for one the
    owner asked for himself), the foundation it stands on, and the paths (after /api/v1) its
    routes are made under."""

    id: str
    name: str
    section: int
    stands_on: str
    paths: tuple[str, ...]


WORKFLOWS: dict[str, Workflow] = {
    found.id: found
    for found in (
        Workflow(
            "save_resume",
            "Save and resume",
            17,
            "Recording and recovery (v0.9.9)",
            ("/saves", "/games/{game_id}/save", "/tables/{table_id}/suspension"),
        ),
        Workflow(
            "sandbox",
            "All-card practice sandbox",
            19,
            "Access (v0.9.10); game modes (v0.9.10)",
            ("/sandbox",),
        ),
        Workflow(
            "deck_lending",
            "Friend deck lending",
            20,
            "Access (v0.9.10); game modes (v0.9.10)",
            ("/loans", "/decks/{deck_id}/loans"),
        ),
        Workflow(
            "replays",
            "Replays and review",
            23,
            "Recording (v0.9.9); structured events (v0.9.10)",
            ("/replays", "/games/{game_id}/replay"),
        ),
        Workflow(
            "spectators",
            "Spectators",
            24,
            "Structured events and access (v0.9.10)",
            ("/games/{game_id}/spectators", "/tables/{table_id}/spectators"),
        ),
        Workflow(
            "coaching",
            "Coaching",
            24,
            "Structured events and access (v0.9.10)",
            ("/games/{game_id}/coaches",),
        ),
        # The owner's own request (2026-11-14), which the specification has no section for.
        Workflow(
            "starter_tables",
            "A starter deck bought at the table",
            0,
            "Leng's card shop (v0.4.2, v0.9.8); tables and practice games",
            ("/starter-decks",),
        ),
    )
}

# The workflow each kind of access belongs to (api/access.py), and each mode a game is not yet
# made in (api/modes.py).
ACCESS: dict[str, str] = {
    "deck": "deck_lending",
    "spectator": "spectators",
    "hand": "coaching",
    "replay": "replays",
    "sandbox": "sandbox",
}
MODES: dict[str, str] = {"sandbox": "sandbox", "borrowed": "deck_lending"}


def stage_of(db: Session, workflow: str) -> str:
    """The workflow's stage; off when it was never set, or holds something that is no stage."""
    if workflow not in WORKFLOWS:
        return "off"
    setting = db.get(SiteSetting, PREFIX + workflow)
    return setting.value if setting and setting.value in STAGES else "off"  # type: ignore[return-value]


def is_staff(db: Session, user: User) -> bool:
    """SysOp, or an active administrator: who a workflow at ``staff`` is for."""
    return user.kind == "sysop" or "administrator" in roles_of(db, user)


def available(db: Session, workflow: str, user: User | None) -> bool:
    """Whether the account may reach the workflow now. A workflow no one named is never."""
    stage = stage_of(db, workflow)
    return stage == "on" or (stage == "staff" and user is not None and is_staff(db, user))


def require(db: Session, workflow: str, user: User | None) -> None:
    """Refuses as a path that does not exist, so a workflow that is off looks like nothing."""
    if not available(db, workflow, user):
        metrics.count("access.refused", code="not_rolled_out", workflow=workflow)
        raise not_found()


def mode_available(db: Session, mode: str, user: User | None) -> bool:
    """Whether a game may be made in the mode: always for the modes that exist, and for the
    sandbox's and a borrowed deck's once their workflow is available to the player."""
    workflow = MODES.get(mode)
    return workflow is None or available(db, workflow, user)


def gate(workflow: str) -> Callable[..., None]:
    """A route's dependency: the caller is signed in, active, and may reach the workflow."""
    if workflow not in WORKFLOWS:
        raise ValueError(f"No such workflow: {workflow}")

    def check(principal: Active, db: Db) -> None:
        require(db, workflow, principal.user)

    check.rollout_workflow = workflow  # type: ignore[attr-defined]
    return check


def router(workflow: str, **options: Any) -> APIRouter:
    """The router a workflow's routes are made on: each is behind the workflow's gate."""
    dependencies = [Depends(gate(workflow)), *options.pop("dependencies", [])]
    return APIRouter(dependencies=dependencies, **options)


def gates_of(route: Any) -> set[str]:
    """The workflows whose gate a route is behind."""
    found: set[str] = set()
    pending = [getattr(route, "dependant", None)]
    while pending:
        dependant = pending.pop()
        if dependant is None:
            continue
        workflow = getattr(dependant.call, "rollout_workflow", None)
        if workflow:
            found.add(workflow)
        pending.extend(dependant.dependencies)
    return found


PARAMETER = re.compile(r"\{[^}]*\}")


def reserved_by(path: str) -> str | None:
    """The workflow that reserves the path, if one does, whatever its parameters are called."""
    asked = PARAMETER.sub("{}", path)
    for workflow in WORKFLOWS.values():
        for reserved in workflow.paths:
            full = PARAMETER.sub("{}", "/api/v1" + reserved)
            if asked == full or asked.startswith(full + "/"):
                return workflow.id
    return None


def unguarded(app: FastAPI) -> list[tuple[str, str]]:
    """The app's routes under a path a workflow reserves that are not behind its gate, each with
    the workflow: none, or the app does not start (api/main.py) and tests/test_rollout.py fails.
    Every route is read as it is served, a router's own gate and prefix included."""
    return [
        (path, workflow)
        for route in iter_route_contexts(app.routes)
        if (path := getattr(route, "path", None))
        and (workflow := reserved_by(path)) is not None
        and workflow not in gates_of(route)
    ]


# The routes: what the caller may reach, for the page's navigation; every stage, for staff; and
# SysOp's change of one.

routes = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
Reader = Annotated[Principal, Depends(require_permission("admin.audit.read"))]
Manager = Annotated[Principal, Depends(require_permission("rollout.manage"))]


class Reachable(Contract):
    id: str
    name: str
    available: bool = Field(description="Whether the caller may reach the workflow now.")


class Reach(Contract):
    workflows: list[Reachable]


class Staged(Contract):
    id: str
    name: str
    section: int = Field(
        description="The specification's section the workflow delivers; 0 for one the owner "
        "asked for himself."
    )
    stands_on: str
    stage: Stage
    changed_at: datetime | None = None


class Rollout(Contract):
    workflows: list[Staged]


class StageChange(Contract):
    stage: Stage


def staged(db: Session) -> Rollout:
    found = []
    for workflow in WORKFLOWS.values():
        setting = db.get(SiteSetting, PREFIX + workflow.id)
        found.append(
            Staged(
                id=workflow.id,
                name=workflow.name,
                section=workflow.section,
                stands_on=workflow.stands_on,
                stage=stage_of(db, workflow.id),  # type: ignore[arg-type]
                changed_at=setting.updated_at if setting else None,
            )
        )
    return Rollout(workflows=found)


@routes.get("/rollout", response_model=Reach)
def reach(principal: Active, db: Db) -> Reach:
    """The unfinished workflows and whether the caller may reach each: the page shows the way
    into a workflow only when it may."""
    return Reach(
        workflows=[
            Reachable(
                id=workflow.id,
                name=workflow.name,
                available=available(db, workflow.id, principal.user),
            )
            for workflow in WORKFLOWS.values()
        ]
    )


@routes.get("/admin/rollout", response_model=Rollout)
def read_rollout(principal: Reader, db: Db) -> Rollout:
    """Every workflow's stage, for SysOp and administrators."""
    return staged(db)


@routes.put("/admin/rollout/{workflow}", response_model=Rollout)
def change_stage(
    workflow: str, body: StageChange, request: Request, principal: Manager, db: Db
) -> Rollout:
    """SysOp sets a workflow's stage; audited. Setting the stage it has changes nothing."""
    if workflow not in WORKFLOWS:
        raise ApiError(404, "not_found", "No such workflow.")
    before = stage_of(db, workflow)
    if body.stage != before:
        setting = db.get(SiteSetting, PREFIX + workflow) or SiteSetting(key=PREFIX + workflow)
        setting.value = body.stage
        setting.updated_by = principal.user.id
        setting.updated_at = utcnow()
        db.add(setting)
        audit(
            db,
            request,
            "rollout.stage_changed",
            actor_id=principal.user.id,
            details={"workflow": workflow, "from": before, "to": body.stage},
        )
        db.commit()
    return staged(db)
