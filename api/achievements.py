"""Achievements (v0.5.0, PROG07): badges earned once, each paying a one-time reward. The owner's
decisions are in docs/plans/0.5.0.md; docs/quests.md describes them for players and staff.

- **The definitions** are ACHIEVEMENTS, in this file, versioned with the code: each has a stable
  ID and its own version, raised if its condition ever changes. What an account earned stays
  earned, under the version it was earned by; no update removes it.
- **From the server's record only:** the account's results (api/stats.py), the daily quests it
  completed, the packs it opened and the friends it made. Wins are games won, as the profile's
  record counts them; SysOp's settings of wins do not earn achievements.
- **Earned when checked, so nothing is missed:** in the transaction that records a game's end, for
  its winner (api/awards.py); when a pack is opened, for its opener; and whenever the account asks
  for its achievements (Profile). A friend made counts at the next of these. A player's history
  from before v0.5.0 earns what it qualifies for at the first check, and so would an achievement
  added later. Each pays once, through the economy ledger under the achievement's key, and the
  bell tells the player (achievement_earned).
- **Badges.** Every achievement earned is a badge on the profile; the player pins up to three to
  show first. Whoever may open the profile sees them.
- **After a reset** (users.reset_at) the account starts again: only what happened since counts,
  and what it earned before stays recorded but no longer shows.

The reference game's own achievements are not inventoried yet (docs/reference_inventory.csv), so
none of these maps to one of them; those about Commander and Legacy are marked as additions
(PROG07).
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal, cast
from uuid import UUID

from fastapi import APIRouter
from pydantic import Field
from sqlalchemy import case, func, or_, select, true, update
from sqlalchemy.orm import Session

from api.auth import INPUT_ERRORS
from api.economy import lock_account, reward
from api.identity import Active, ApiError, Db, utcnow
from api.library import reset_key, since_reset
from api.models import DailyQuest, Friendship, PackOpening, PlayerAchievement, QuestBoard, User
from api.schemas import Contract, Error
from api.social import notify_award, visible_player
from api.stats import COLORS, Rule, counted

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

# The rule achievements are earned and paid under, recorded on each payment (PROG05).
# achievements-v2 (v0.9.5): every reward four times v1's, the owner's word; migration 0041 paid
# the difference for what was earned before.
POLICY = "achievements-v2"
PINS = 3
# What an achievement counts: wins its rule matches, the colours won with, daily quests
# completed, packs opened, friends made.
# Since v0.9.5 also the quest boards: daily and weekly boards finished, the longest streak of each,
# and weekly goals completed.
Metric = Literal[
    "wins",
    "colours",
    "quests",
    "packs",
    "friends",
    "daily_boards",
    "daily_streak",
    "weekly_boards",
    "weekly_streak",
    "weekly_goals",
]
Group = Literal[
    "victories", "commander", "legacy", "colours", "bots", "players", "quests", "shop", "friends"
]


@dataclass(frozen=True)
class Achievement:
    id: str
    name: str
    description: str
    group: Group
    tokens: int
    target: int = 1
    metric: Metric = "wins"
    rule: Rule = Rule()
    # A Commander or Legacy addition (PROG07).
    addition: bool = False
    # Raised when its condition changes; what was earned keeps the version it was earned by.
    version: int = 1


def colour(color: str, word: str) -> Achievement:
    return Achievement(
        f"win-{word}",
        f"Paragon of {word.title()}",
        f"Win with a {word} deck.",
        "colours",
        400,
        rule=Rule(color=color),
    )


ACHIEVEMENTS: tuple[Achievement, ...] = (
    Achievement("first-win", "First Victory", "Win a game.", "victories", 400),
    Achievement("wins-10", "Seasoned Planeswalker", "Win 10 games.", "victories", 800, 10),
    Achievement("wins-100", "Veteran Planeswalker", "Win 100 games.", "victories", 1_600, 100),
    Achievement(
        "wins-1000", "Legendary Planeswalker", "Win 1,000 games.", "victories", 4_000, 1_000
    ),
    Achievement(
        "commander-win",
        "Commander Victor",
        "Win a Commander game.",
        "commander",
        400,
        rule=Rule(format="commander"),
        addition=True,
    ),
    Achievement(
        "commander-wins-25",
        "Commander Captain",
        "Win 25 Commander games.",
        "commander",
        1200,
        25,
        rule=Rule(format="commander"),
        addition=True,
    ),
    Achievement(
        "commander-four",
        "Last One Standing",
        "Win a four-player Commander game.",
        "commander",
        600,
        rule=Rule(format="commander", seats=4),
        addition=True,
    ),
    Achievement(
        "commander-four-10",
        "King of the Table",
        "Win 10 four-player Commander games.",
        "commander",
        1200,
        10,
        rule=Rule(format="commander", seats=4),
        addition=True,
    ),
    Achievement(
        "legacy-win",
        "Legacy Victor",
        "Win a Legacy game.",
        "legacy",
        400,
        rule=Rule(format="legacy"),
        addition=True,
    ),
    Achievement(
        "legacy-wins-25",
        "Legacy Master",
        "Win 25 Legacy games.",
        "legacy",
        1200,
        25,
        rule=Rule(format="legacy"),
        addition=True,
    ),
    colour("W", "white"),
    colour("U", "blue"),
    colour("B", "black"),
    colour("R", "red"),
    colour("G", "green"),
    Achievement(
        "every-colour",
        "Master of the Five",
        "Win with a deck of each colour.",
        "colours",
        1000,
        5,
        metric="colours",
    ),
    Achievement(
        "five-colour-win",
        "Five-Colour Triumph",
        "Win with a five-colour deck.",
        "colours",
        800,
        rule=Rule(colors_at_least=5),
    ),
    Achievement(
        "beat-skill-4",
        "Rising Challenger",
        "Beat a bot of skill 4 or higher.",
        "bots",
        400,
        rule=Rule(skill_at_least=4),
    ),
    Achievement(
        "beat-skill-6",
        "Machine Breaker",
        "Beat a skill-6 bot.",
        "bots",
        800,
        rule=Rule(skill_at_least=6),
    ),
    Achievement(
        "beat-skill-6-10",
        "Master of Machines",
        "Beat skill-6 bots in 10 games.",
        "bots",
        1200,
        10,
        rule=Rule(skill_at_least=6),
    ),
    Achievement(
        "win-players",
        "Worthy Opponent",
        "Win at a human table.",
        "players",
        600,
        rule=Rule(against_players=True),
    ),
    Achievement(
        "win-players-10",
        "Table Champion",
        "Win 10 games against other players.",
        "players",
        1600,
        10,
        rule=Rule(against_players=True),
    ),
    Achievement(
        "quest-1", "First Quest", "Complete a daily quest.", "quests", 400, metric="quests"
    ),
    Achievement(
        "quests-10", "Quest Seeker", "Complete 10 daily quests.", "quests", 800, 10, "quests"
    ),
    Achievement(
        "quests-50", "Questing Knight", "Complete 50 daily quests.", "quests", 1_600, 50, "quests"
    ),
    Achievement(
        "pack-1", "Fresh Pack", "Open a pack from Leng's card shop.", "shop", 400, metric="packs"
    ),
    Achievement("packs-25", "Collector", "Open 25 packs.", "shop", 1_200, 25, "packs"),
    Achievement("friend-1", "Ally", "Make a friend.", "friends", 400, metric="friends"),
    Achievement("friends-10", "Fellowship", "Make 10 friends.", "friends", 800, 10, "friends"),
    # The quest boards (v0.9.5), on the same curve as the rest.
    Achievement(
        "daily-board-1",
        "Full Board",
        "Finish every quest on a daily board.",
        "quests",
        400,
        metric="daily_boards",
    ),
    Achievement(
        "daily-streak-7",
        "Seven Days Strong",
        "Finish the daily board seven days in a row.",
        "quests",
        1_200,
        7,
        "daily_streak",
    ),
    Achievement(
        "daily-boards-50",
        "Board Regular",
        "Finish 50 daily boards.",
        "quests",
        1_600,
        50,
        "daily_boards",
    ),
    Achievement(
        "weekly-goals-50",
        "Goal Getter",
        "Complete 50 weekly goals.",
        "quests",
        800,
        50,
        "weekly_goals",
    ),
    Achievement(
        "weekly-board-1",
        "A Week's Work",
        "Finish every goal on a weekly board.",
        "quests",
        800,
        metric="weekly_boards",
    ),
    Achievement(
        "weekly-streak-4",
        "Month of Mastery",
        "Finish the weekly board four weeks in a row.",
        "quests",
        1_600,
        4,
        "weekly_streak",
    ),
)
BY_ID = {achievement.id: achievement for achievement in ACHIEVEMENTS}


# Contracts.


class Badge(Contract):
    id: str
    name: str
    description: str
    group: Group
    addition: bool = Field(
        description="A Commander or Legacy addition (PROG07), not one from the reference inventory."
    )
    tokens: int = Field(description="Its one-time reward.")


class AchievementView(Badge):
    target: int
    progress: int = Field(description="Towards the target, at most the target.")
    earned_at: datetime | None
    pin: int | None = Field(description="Its place among the pinned badges, 1 to 3.")


class Achievements(Contract):
    achievements: list[AchievementView] = Field(description="Every achievement, in their order.")
    earned: int
    paid: int = Field(description="Tokens this look itself paid, for achievements it found earned.")


class EarnedBadge(Badge):
    earned_at: datetime


class PlayerBadges(Contract):
    pinned: list[EarnedBadge] = Field(description="Up to three, in the player's order.")
    earned: list[EarnedBadge] = Field(description="Every badge earned, newest first.")
    total: int = Field(description="How many achievements there are.")


class Pins(Contract):
    achievements: list[Annotated[str, Field(min_length=1, max_length=48)]] = Field(
        max_length=PINS, description="Up to three earned achievements, in order; none unpins all."
    )


def badge(achievement: Achievement) -> Badge:
    return Badge(
        id=achievement.id,
        name=achievement.name,
        description=achievement.description,
        group=achievement.group,
        addition=achievement.addition,
        tokens=achievement.tokens,
    )


# Earning.


def earned_of(db: Session, user: User) -> dict[str, PlayerAchievement]:
    """What the account earned since its last reset, by achievement."""
    rows = db.scalars(
        select(PlayerAchievement).where(
            PlayerAchievement.user_id == user.id, since_reset(user, PlayerAchievement.earned_at)
        )
    )
    return {row.achievement: row for row in rows}


def measure(db: Session, user: User) -> dict[str, int]:
    """Every achievement's count for the account, since its last reset: one query over its
    results, and one each for quests, packs and friends."""
    ruled = [found for found in ACHIEVEMENTS if found.metric == "wins"]
    columns = [
        func.coalesce(func.sum(case((found.rule.condition(), 1), else_=0)), 0) for found in ruled
    ] + [
        func.coalesce(func.sum(case((Rule(color=color).condition(), 1), else_=0)), 0)
        for color in COLORS
    ]
    values = [
        int(cast(int, value)) for value in db.execute(select(*columns).where(counted(user))).one()
    ]
    counts = {found.id: value for found, value in zip(ruled, values, strict=False)}
    colours = sum(1 for value in values[len(ruled) :] if value)
    quest_rows = db.execute(
        select(DailyQuest.board, func.count())
        .where(
            DailyQuest.user_id == user.id,
            DailyQuest.completed_at.is_not(None),
            since_reset(user, DailyQuest.created_at),
        )
        .group_by(DailyQuest.board)
    ).all()
    completed = {board: int(count) for board, count in quest_rows}
    boards = db.execute(
        select(QuestBoard.board, func.count(), func.max(QuestBoard.streak))
        .where(QuestBoard.user_id == user.id, since_reset(user, QuestBoard.completed_at))
        .group_by(QuestBoard.board)
    ).all()
    finished = {board: (int(count), int(streak or 0)) for board, count, streak in boards}
    packs = (
        db.scalar(
            select(func.count())
            .select_from(PackOpening)
            .where(PackOpening.user_id == user.id, since_reset(user, PackOpening.created_at))
        )
        or 0
    )
    friends = (
        db.scalar(
            select(func.count())
            .select_from(Friendship)
            .where(
                or_(Friendship.user_low == user.id, Friendship.user_high == user.id),
                Friendship.status == "accepted",
                Friendship.accepted_at > user.reset_at if user.reset_at is not None else true(),
            )
        )
        or 0
    )
    others = {
        "colours": colours,
        "quests": completed.get("daily", 0),
        "packs": packs,
        "friends": friends,
        "daily_boards": finished.get("daily", (0, 0))[0],
        "daily_streak": finished.get("daily", (0, 0))[1],
        "weekly_boards": finished.get("weekly", (0, 0))[0],
        "weekly_streak": finished.get("weekly", (0, 0))[1],
        "weekly_goals": completed.get("weekly", 0),
    }
    return {
        found.id: counts.get(found.id, 0) if found.metric == "wins" else others[found.metric]
        for found in ACHIEVEMENTS
    }


def catch_up(db: Session, user: User, now: datetime) -> int:
    """Earns every achievement the account qualifies for and has not earned since its last
    reset, in the caller's transaction, with its row locked: each recorded once, paid once and told
    to the bell. Returns the tokens paid."""
    lock_account(db, user.id)
    earned = earned_of(db, user)
    pending = [found for found in ACHIEVEMENTS if found.id not in earned]
    if not pending:
        return 0
    counts = measure(db, user)
    paid = 0
    for found in pending:
        if counts[found.id] < found.target:
            continue
        key = reset_key(user, f"achievement:{user.id}:{found.id}")
        db.add(
            PlayerAchievement(
                user_id=user.id,
                achievement=found.id,
                version=found.version,
                key=key,
                tokens=found.tokens,
                earned_at=now,
            )
        )
        # A key taken already (an achievement earned before going back a version and up again)
        # pays nothing more.
        if reward(db, user.id, "achievement", found.tokens, key, found.name, POLICY):
            paid += found.tokens
            notify_award(db, user.id, "achievement_earned", found.id, now)
    db.flush()
    return paid


def achievements_of(db: Session, user: User, paid: int) -> Achievements:
    earned = earned_of(db, user)
    counts = measure(db, user)
    return Achievements(
        achievements=[
            AchievementView(
                **badge(found).model_dump(),
                target=found.target,
                progress=min(found.target, counts[found.id]),
                earned_at=earned[found.id].earned_at if found.id in earned else None,
                pin=earned[found.id].pin if found.id in earned else None,
            )
            for found in ACHIEVEMENTS
        ],
        earned=sum(1 for found in ACHIEVEMENTS if found.id in earned),
        paid=paid,
    )


def badges_of(db: Session, user: User) -> PlayerBadges:
    earned = sorted(
        (row for row in earned_of(db, user).values() if row.achievement in BY_ID),
        key=lambda row: (row.earned_at, row.achievement),
        reverse=True,
    )

    def shown(row: PlayerAchievement) -> EarnedBadge:
        return EarnedBadge(**badge(BY_ID[row.achievement]).model_dump(), earned_at=row.earned_at)

    return PlayerBadges(
        pinned=[shown(row) for row in sorted(earned, key=lambda row: row.pin or 0) if row.pin],
        earned=[shown(row) for row in earned],
        total=len(ACHIEVEMENTS),
    )


# Routes.


@router.get("/me/achievements", response_model=Achievements)
def my_achievements(principal: Active, db: Db) -> Achievements:
    """Every achievement with the account's progress, earning what it now qualifies for: a
    history from before achievements existed earns here at the first look."""
    user = principal.user
    lock_account(db, user.id)
    db.refresh(user)
    paid = catch_up(db, user, utcnow())
    db.commit()
    return achievements_of(db, user, paid)


@router.put(
    "/me/achievements/pinned",
    response_model=Achievements,
    responses={422: {"model": Error}},
)
def pin_badges(body: Pins, principal: Active, db: Db) -> Achievements:
    """Pins up to three earned badges to the profile, in order, in place of those pinned before."""
    user = principal.user
    lock_account(db, user.id)
    db.refresh(user)
    wanted = body.achievements
    if len(set(wanted)) != len(wanted):
        raise ApiError(422, "invalid_request", "Pin each badge once.")
    earned = earned_of(db, user)
    missing = next((found for found in wanted if found not in earned), None)
    if missing is not None:
        named = BY_ID.get(missing)
        raise ApiError(
            422, "not_earned", f"Earn {named.name if named else 'that badge'} before pinning it."
        )
    ids: list[UUID] = [row.id for row in earned.values()]
    db.execute(update(PlayerAchievement).where(PlayerAchievement.id.in_(ids)).values(pin=None))
    for place, found in enumerate(wanted, start=1):
        earned[found].pin = place
    db.commit()
    return achievements_of(db, user, 0)


@router.get("/players/{player_id}/achievements", response_model=PlayerBadges)
def player_badges(player_id: UUID, principal: Active, db: Db) -> PlayerBadges:
    """A player's badges, pinned and earned, for whoever may open their profile."""
    return badges_of(db, visible_player(db, player_id))
