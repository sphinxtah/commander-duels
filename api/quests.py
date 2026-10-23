"""Daily quests (v0.5.0, PROG04): three a day for every player, read from results. The owner's
decisions are in docs/plans/0.5.0.md; docs/quests.md describes them for players and staff.

- **The pool** is QUESTS, in this file: each quest names the wins it needs (a Rule over the
  results of api/stats.py, and how many) and pays 100 to 250 tokens. Nothing happens inside a game
  for a quest to see: only how it ended and the deck played.
- **The day** is a calendar day in Arizona (api/economy.py), from midnight. The day's three are
  drawn the first time the account asks for its quests that day (GET /me/quests, which the main
  menu does), each from a group of its own, and stay the same all day. Wins earlier that day count.
- **One swap a day** replaces one quest not yet completed with another from a group the other two
  do not hold. Only games finished after the swap count towards the new one.
- **Completion** is checked in the transaction that records a game's end (api/awards.py), from the
  results it wrote, and again whenever the account asks for its quests, so wins from before the
  day's first look count too. Each quest pays once, through the economy ledger, keyed by the
  account, the day and the quest; a replayed end or a second look pays nothing. The bell tells the
  player (quest_completed).
- **After a reset** (users.reset_at) the day's quests are drawn again, and count only games
  finished since.
"""

import random
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from typing import Annotated

from fastapi import APIRouter, Path
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.auth import INPUT_ERRORS
from api.economy import ARIZONA, arizona_day, lock_account, reward
from api.identity import Active, ApiError, Db, utcnow
from api.library import reset_key, since_reset
from api.models import DailyQuest, PlayerResult, User
from api.schemas import Contract, Error
from api.social import notify_award
from api.stats import Rule, counted

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

# The rule quests are assigned and paid under, recorded on each (PROG05).
POLICY = "quests-v1"
QUESTS_A_DAY = 3
RANDOM = random.SystemRandom()


@dataclass(frozen=True)
class Quest:
    id: str
    name: str
    tokens: int
    # The day's quests come from groups of their own, so no two ask much the same thing.
    group: str
    rule: Rule
    target: int = 1


def colour(color: str, word: str) -> Quest:
    return Quest(f"win-{word}", f"Win with a {word} deck", 150, "colours", Rule(color=color))


QUESTS: tuple[Quest, ...] = (
    Quest("win", "Win a game", 100, "wins", Rule()),
    Quest("win-3", "Win three games", 200, "wins", Rule(), target=3),
    Quest("win-commander", "Win a Commander game", 125, "formats", Rule(format="commander")),
    Quest(
        "win-commander-2",
        "Win two Commander games",
        200,
        "formats",
        Rule(format="commander"),
        target=2,
    ),
    Quest("win-legacy", "Win a Legacy game", 150, "formats", Rule(format="legacy")),
    Quest(
        "win-four-players",
        "Win a four-player Commander game",
        200,
        "formats",
        Rule(format="commander", seats=4),
    ),
    colour("W", "white"),
    colour("U", "blue"),
    colour("B", "black"),
    colour("R", "red"),
    colour("G", "green"),
    Quest("win-mono", "Win with a mono-coloured deck", 150, "colours", Rule(mono=True)),
    Quest(
        "win-three-colours",
        "Win with a deck of three or more colours",
        175,
        "colours",
        Rule(colors_at_least=3),
    ),
    Quest("beat-skill-4", "Beat a bot of skill 4 or higher", 150, "bots", Rule(skill_at_least=4)),
    Quest("beat-skill-6", "Beat a skill-6 bot", 250, "bots", Rule(skill_at_least=6)),
    Quest("win-players", "Win at a human table", 250, "players", Rule(against_players=True)),
)
BY_ID = {quest.id: quest for quest in QUESTS}


class QuestView(Contract):
    slot: int
    id: str
    name: str
    tokens: int
    target: int = Field(description="The wins it needs.")
    progress: int = Field(description="The wins counted so far, at most the target.")
    completed_at: datetime | None
    swapped: bool = Field(description="Swapped in today: only games after the swap count.")


class DailyQuests(Contract):
    day: date = Field(description="The day, in Arizona.")
    resets_at: datetime = Field(description="Midnight in Arizona, when the next day's quests come.")
    can_swap: bool = Field(description="Whether today's swap is still unused.")
    paid: int = Field(
        description="Tokens this look itself paid, for quests that wins before it completed."
    )
    quests: list[QuestView]


def choose(quests: list[Quest], count: int) -> list[Quest]:
    """Quests at random, each from a group of its own: a group, then a quest of it. Tests replace
    this to pick the quests they need."""
    groups: dict[str, list[Quest]] = defaultdict(list)
    for quest in quests:
        groups[quest.group].append(quest)
    return [RANDOM.choice(groups[group]) for group in RANDOM.sample(sorted(groups), count)]


def day_of(moment: datetime) -> date:
    return moment.astimezone(ARIZONA).date()


def assigned(db: Session, user: User, day: date) -> list[DailyQuest]:
    """The day's quests, by slot: those drawn since the account's last reset."""
    return list(
        db.scalars(
            select(DailyQuest)
            .where(
                DailyQuest.user_id == user.id,
                DailyQuest.day == day,
                since_reset(user, DailyQuest.created_at),
            )
            .order_by(DailyQuest.slot)
        )
    )


def todays_quests(db: Session, user: User, now: datetime) -> list[DailyQuest]:
    """The day's three quests, drawn the first time they are asked for. The caller holds the
    account's lock, so two looks at once draw once."""
    day = day_of(now)
    rows = assigned(db, user, day)
    if rows:
        return rows
    start, _ = arizona_day(now)
    for slot, quest in enumerate(choose(list(QUESTS), QUESTS_A_DAY)):
        row = DailyQuest(
            user_id=user.id,
            day=day,
            slot=slot,
            key=reset_key(user, f"quest-slot:{user.id}:{day.isoformat()}:{slot}"),
            quest=quest.id,
            tokens=quest.tokens,
            target=quest.target,
            counts_from=start,
            policy=POLICY,
            created_at=now,
        )
        db.add(row)
        rows.append(row)
    db.flush()
    return rows


def wins_on(db: Session, user: User, day: date) -> list[PlayerResult]:
    """The account's wins that day, since its last reset."""
    start, end = arizona_day(datetime.combine(day, datetime.min.time(), ARIZONA))
    return list(
        db.scalars(
            select(PlayerResult).where(
                counted(user),
                PlayerResult.outcome == "win",
                PlayerResult.finished_at >= start,
                PlayerResult.finished_at < end,
            )
        )
    )


def progress_of(row: DailyQuest, wins: list[PlayerResult]) -> int:
    quest = BY_ID.get(row.quest)
    if quest is None:
        # A quest no longer in the pool counts nothing more.
        return 0
    found = sum(1 for win in wins if win.finished_at >= row.counts_from and quest.rule.matches(win))
    return min(row.target, found)


def settle(db: Session, user: User, rows: list[DailyQuest], now: datetime) -> int:
    """Completes the quests whose wins are in, paying each once and telling the bell; returns the
    tokens paid."""
    waiting = [row for row in rows if row.completed_at is None]
    if not waiting:
        return 0
    wins = wins_on(db, user, waiting[0].day)
    paid = 0
    for row in waiting:
        if progress_of(row, wins) < row.target:
            continue
        row.completed_at = now
        quest = BY_ID[row.quest]
        key = reset_key(user, f"quest:{user.id}:{row.day.isoformat()}:{row.quest}")
        if reward(db, user.id, "quest", row.tokens, key, quest.name, POLICY):
            paid += row.tokens
            notify_award(db, user.id, "quest_completed", row.quest, now)
    db.flush()
    return paid


def count_game(db: Session, user: User, finished_at: datetime) -> int:
    """After a game the account won: its quests of the day the game ended, if drawn yet (wins
    before the day's first look count when it comes). In the game's transaction, which holds the
    winner's lock (economy.pay_game)."""
    rows = assigned(db, user, day_of(finished_at))
    return settle(db, user, rows, utcnow()) if rows else 0


def view(db: Session, user: User, rows: list[DailyQuest], now: datetime, paid: int) -> DailyQuests:
    day = day_of(now)
    wins = wins_on(db, user, day)
    _, end = arizona_day(now)
    return DailyQuests(
        day=day,
        resets_at=end,
        can_swap=not any(row.swapped_at for row in rows),
        paid=paid,
        quests=[
            QuestView(
                slot=row.slot,
                id=row.quest,
                name=BY_ID[row.quest].name if row.quest in BY_ID else row.quest,
                tokens=row.tokens,
                target=row.target,
                progress=row.target if row.completed_at else progress_of(row, wins),
                completed_at=row.completed_at,
                swapped=row.swapped_at is not None,
            )
            for row in rows
        ],
    )


def locked(db: Session, user: User) -> None:
    """The account's row, locked for the request and read again, so two looks or a reset at once
    queue."""
    lock_account(db, user.id)
    db.refresh(user)


# Routes.


@router.get("/me/quests", response_model=DailyQuests)
def my_quests(principal: Active, db: Db) -> DailyQuests:
    """Today's three quests, drawn now if this is the day's first look, with their progress. Wins
    earlier today that complete one pay here."""
    user = principal.user
    locked(db, user)
    now = utcnow()
    rows = todays_quests(db, user, now)
    paid = settle(db, user, rows, now)
    db.commit()
    return view(db, user, rows, now, paid)


@router.post(
    "/me/quests/{slot}/swap",
    response_model=DailyQuests,
    responses={409: {"model": Error}},
)
def swap_quest(
    slot: Annotated[int, Path(ge=0, le=QUESTS_A_DAY - 1)], principal: Active, db: Db
) -> DailyQuests:
    """Today's swap: the slot's quest, not yet completed, gives way to another from a group the
    other two do not hold. Once a day."""
    user = principal.user
    locked(db, user)
    now = utcnow()
    rows = todays_quests(db, user, now)
    paid = settle(db, user, rows, now)
    row = rows[slot]
    refused = None
    if any(found.swapped_at for found in rows):
        refused = ApiError(
            409, "swap_used", "You have swapped a quest today. Tomorrow's quests bring a new swap."
        )
    elif row.completed_at is not None:
        refused = ApiError(409, "quest_completed", "That quest is complete already.")
    if refused is not None:
        # What the look completed stays paid.
        db.commit()
        raise refused
    others = {
        BY_ID[found.quest].group for found in rows if found is not row and found.quest in BY_ID
    }
    quest = choose(
        [found for found in QUESTS if found.group not in others and found.id != row.quest], 1
    )[0]
    row.quest, row.tokens, row.target = quest.id, quest.tokens, quest.target
    row.counts_from = row.swapped_at = now
    db.commit()
    return view(db, user, rows, now, paid)
