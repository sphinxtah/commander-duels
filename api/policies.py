"""The economy's policies, each behind its own switch (v0.9.12; docs/economy.md).

The Preparation Framework builds the economy's next pieces before anyone decides to use them
(the owner's specification, section 11): what they do is a **policy**, a small typed record kept
as a site setting, and every policy's default is the game as it was. Nothing here changes what a
player has or earns until SysOp changes a policy, which is audited, and the owner's approval is
what that change stands for (section 30: "material economy changes receive final owner
approval").

- **functional_basics**: every account builds with the five basic lands without owning them.
  Functional access, never a grant: nothing is minted, sold or counted in a print run
  (api/library.py).
- **starter_staples**: an account claims staples from content/starter-staples.json with the picks
  its progress earned, as functional copies bound to it (api/entitlements.py).
- **quest_streaks**: what a board's streak does when a period is missed (api/quests.py).
- **quest_catch_up**: a finished weekly board pays for daily boards missed in its week.
- **quest_alternatives**: a daily quest is drawn with a second quest; either completes it.
- **farming**: the signals a game's end records are always recorded; enforcing them withholds
  what the game would have paid (api/farming.py).

Reading a policy never fails: a missing or malformed setting is the default. A setting is one
row, read through the session's identity map, so asking twice in a request costs one query.
"""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import Field, ValidationError
from sqlalchemy import null, update
from sqlalchemy.orm import Session

from api.auth import INPUT_ERRORS
from api.identity import (
    ApiError,
    Db,
    Principal,
    audit,
    not_found,
    require_permission,
    utcnow,
)
from api.models import Deck, SiteSetting
from api.schemas import Contract

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
Reader = Annotated[Principal, Depends(require_permission("admin.users.read"))]
EconomyManager = Annotated[Principal, Depends(require_permission("economy.manage"))]

PREFIX = "policy."


class FunctionalBasics(Contract):
    """Unlimited functional basic lands. Off: a deck holds the basic lands its library holds."""

    enabled: bool = False


class StarterStaples(Contract):
    """The starter-staple pool. Off: nothing can be claimed. On: an account has `initial` picks,
    and earns more for each campaign ward it has won and each weekly board it has finished; a
    pick claims one card of the pool, once."""

    enabled: bool = False
    initial: int = Field(default=0, ge=0, le=200)
    per_ward: int = Field(default=0, ge=0, le=20)
    per_weekly_board: int = Field(default=0, ge=0, le=20)


class QuestStreaks(Contract):
    """A board's streak when a period was missed. reset (as since v0.9.5): the streak starts
    again. forgiving: up to `grace` periods missed in a row keep it, each costing `penalty`
    steps; more than that starts it again."""

    mode: Literal["reset", "forgiving"] = "reset"
    grace: int = Field(default=1, ge=1, le=6)
    penalty: int = Field(default=0, ge=0, le=10)


class QuestCatchUp(Contract):
    """The weekly catch-up. On: finishing the weekly board pays `tokens` for each of that week's
    daily boards the account did not finish, for at most `days` of them."""

    enabled: bool = False
    tokens: int = Field(default=400, ge=1, le=5_000)
    days: int = Field(default=3, ge=1, le=7)


class QuestAlternatives(Contract):
    """Quest alternatives. On: each daily quest is drawn with a second quest of another kind,
    and completing either completes the slot."""

    enabled: bool = False


class Farming(Contract):
    """Farming signals (api/farming.py). They are recorded with every game whatever this says;
    `enforce` withholds a flagged seat's tokens and quest progress. The thresholds: a game is
    short under `short_turns` turns, and a pair of accounts is repeated from their
    `repeat_results`th result together in a day."""

    enforce: bool = False
    short_turns: int = Field(default=3, ge=1, le=20)
    repeat_results: int = Field(default=6, ge=2, le=100)


Policy = (
    FunctionalBasics | StarterStaples | QuestStreaks | QuestCatchUp | QuestAlternatives | Farming
)
POLICIES: dict[str, type[Contract]] = {
    "functional_basics": FunctionalBasics,
    "starter_staples": StarterStaples,
    "quest_streaks": QuestStreaks,
    "quest_catch_up": QuestCatchUp,
    "quest_alternatives": QuestAlternatives,
    "farming": Farming,
}
NAMES = {model: name for name, model in POLICIES.items()}


def read[P: Contract](db: Session, model: type[P]) -> P:
    """The policy as it stands; its default when it was never set, or cannot be read."""
    setting = db.get(SiteSetting, PREFIX + NAMES[model])
    if setting is None or not isinstance(setting.value, dict):
        return model()
    try:
        return model.model_validate(setting.value)
    except ValidationError:
        return model()


def write(db: Session, name: str, value: Contract, actor_id: UUID | None = None) -> None:
    """Sets a policy (the caller audits and commits)."""
    setting = db.get(SiteSetting, PREFIX + name) or SiteSetting(key=PREFIX + name)
    setting.value = value.model_dump(mode="json")
    setting.updated_by = actor_id
    setting.updated_at = utcnow()
    db.add(setting)
    db.flush()


class PolicyView(Contract):
    name: str
    value: dict[str, object] = Field(description="The policy as it stands.")
    default: dict[str, object] = Field(description="The game as it was: every switch off.")
    changed: bool = Field(description="Whether it differs from its default.")


class Policies(Contract):
    policies: list[PolicyView]


def view(db: Session) -> Policies:
    found = []
    for name, model in POLICIES.items():
        value, default = read(db, model).model_dump(mode="json"), model().model_dump(mode="json")
        found.append(PolicyView(name=name, value=value, default=default, changed=value != default))
    return Policies(policies=found)


def changed(db: Session, name: str, body: dict[str, object]) -> tuple[Contract, bool]:
    """Sets a policy from what was sent, a field left out taking its default; says whether it
    differs from what stood (the caller audits and commits). Refuses a name or a value that is
    not a policy's."""
    model = POLICIES.get(name)
    if model is None:
        raise not_found()
    try:
        value = model.model_validate(body)
    except ValidationError as error:
        first = error.errors()[0]
        where = ".".join(str(part) for part in first["loc"])
        raise ApiError(422, "invalid_policy", f"{where}: {first['msg']}") from error
    return value, value.model_dump(mode="json") != read(db, model).model_dump(mode="json")


def apply(db: Session, name: str, value: Contract, actor_id: UUID | None) -> dict[str, object]:
    """Writes the policy and what follows from it; returns what it was, for the audit."""
    before = read(db, POLICIES[name]).model_dump(mode="json")
    write(db, name, value, actor_id)
    if name == "functional_basics":
        # Every deck's kept flags were checked against a library with or without the basic
        # lands: each is checked again the next time its owner lists their decks, as a deck
        # last checked before v0.4.5 is (api/decks.py).
        db.execute(update(Deck).where(Deck.purged_at.is_(None)).values(needs=null()))
    return before


@router.get("/admin/policies", response_model=Policies)
def policies(principal: Reader, db: Db) -> Policies:
    """The economy's policies as they stand, with their defaults (v0.9.12)."""
    return view(db)


@router.put("/admin/policies/{name}", response_model=Policies)
def change_policy(
    name: str, body: dict[str, object], request: Request, principal: EconomyManager, db: Db
) -> Policies:
    """SysOp sets a policy: the owner's approval of an economy change, audited with what it was
    and what it became. A field left out takes its default."""
    value, differs = changed(db, name, body)
    if differs:
        before = apply(db, name, value, principal.user.id)
        audit(
            db,
            request,
            "economy.policy_changed",
            actor_id=principal.user.id,
            details={"policy": name, "from": before, "to": value.model_dump(mode="json")},
        )
        db.commit()
    return view(db)
