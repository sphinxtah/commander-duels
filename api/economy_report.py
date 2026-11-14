"""The economy's report and simulation (v0.9.12; docs/economy.md).

    python -m api.cli economy-report            # as text
    python -m api.cli economy-report --json     # the same, as JSON

The owner's specification asks for "a simulation/reporting tool for proposed rewards and
acquisition costs", so that "proposed policies can be evaluated against existing campaign
payouts and balances" (section 11). This reads, and changes nothing:

- **What is**: the balances of the accounts (how many, their total, median and largest), what
  the ledger paid and took by kind, what the campaign pays ward by ward, what the basic land
  packs have sold, and the farming signals kept with the games.
- **What the proposals would do**: a player's tokens from the daily boards, week by week, under
  the streak and catch-up policies as they stand and as proposed; and how long the
  starter-staple pool takes to claim. The simulated players differ only in the days of the
  week they finish their board; the arithmetic is the game's own (api/quests.py carried_streak,
  bonus_for; api/quest_pool.py), so a proposal is measured by the rule that would pay it.

Accounts are counted, never named: nothing here is one player's. SysOp's and deleted accounts
are left out of the balances, since SysOp's are its own grants.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from statistics import median
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api import policies
from api.entitlements import pool_in
from api.lands import LAND_SET
from api.models import Game, Pack, ShopProduct, TokenEntry, User
from api.quest_pool import DAILY_TOKENS, WEEKLY_GOALS, WEEKLY_TIERS, WEEKLY_TOKENS
from api.quests import bonus_for, carried_streak

# The simulated players: the days of the week (Sunday is 0) they finish their daily board.
PLAYERS: dict[str, tuple[int, ...]] = {
    "every day": (0, 1, 2, 3, 4, 5, 6),
    "weekdays": (1, 2, 3, 4, 5),
    "three days (Mon, Wed, Fri)": (1, 3, 5),
    "weekends": (0, 6),
    "one day": (6,),
}
WEEKS = 8


@dataclass(frozen=True)
class Proposal:
    """A set of quest policies to measure: the game as it is, or a proposal."""

    name: str
    streaks: policies.QuestStreaks = field(default_factory=policies.QuestStreaks)
    catch_up: policies.QuestCatchUp = field(default_factory=policies.QuestCatchUp)


def proposals(streaks: policies.QuestStreaks, catch_up: policies.QuestCatchUp) -> list[Proposal]:
    """The game as it is, each proposal alone, and both together."""
    return [
        Proposal("As it is: a missed day resets the streak"),
        Proposal(
            f"Forgiving streak: {streaks.grace} missed in a row kept"
            + (f", each costing {streaks.penalty}" if streaks.penalty else ""),
            streaks=streaks,
        ),
        Proposal(
            f"Catch-up: {catch_up.tokens} tokens a missed day, {catch_up.days} a week",
            catch_up=catch_up,
        ),
        Proposal("Both", streaks=streaks, catch_up=catch_up),
    ]


def simulate(days: tuple[int, ...], proposal: Proposal, weeks: int = WEEKS) -> dict[str, Any]:
    """A player's tokens from the daily boards over the weeks, finishing the board on the given
    days of each week: the five quests, the board's bonus by its streak, and the catch-up."""
    quests = sum(DAILY_TOKENS)
    streak, missed, started = 0, 0, False
    by_week: list[int] = []
    best = 0
    for _ in range(weeks):
        paid, caught, unpaid = 0, 0, 0
        for day in range(7):
            if day not in days:
                missed += 1
                # A day is missed only once the account has played: its first day starts it.
                unpaid += 1 if started else 0
                continue
            started = True
            streak = carried_streak(proposal.streaks, streak, missed) + 1
            best = max(best, streak)
            missed = 0
            paid += quests + bonus_for("daily", streak)
            if proposal.catch_up.enabled and unpaid and caught < proposal.catch_up.days:
                paid += proposal.catch_up.tokens
                caught += 1
                unpaid -= 1
        by_week.append(paid)
    settled = by_week[-1]
    return {
        "first_week": by_week[0],
        "settled_week": settled,
        "total": sum(by_week),
        "best_streak": best,
    }


def quest_simulation(
    streaks: policies.QuestStreaks, catch_up: policies.QuestCatchUp, weeks: int = WEEKS
) -> list[dict[str, Any]]:
    return [
        {
            "proposal": proposal.name,
            "players": {name: simulate(days, proposal, weeks) for name, days in PLAYERS.items()},
        }
        for proposal in proposals(streaks, catch_up)
    ]


def staple_weeks(pool: int, policy: policies.StarterStaples, wards_a_week: float) -> float | None:
    """Weeks until the whole pool is claimed, by a player who wins that many wards a week (of the
    campaign's fifteen) and finishes no weekly board; None when the picks never reach it."""
    picks, wards, weeks = float(policy.initial), 0.0, 0
    while picks < pool:
        if wards >= 15 or policy.per_ward == 0:
            return None
        weeks += 1
        won = min(wards_a_week, 15 - wards)
        wards += won
        picks += won * policy.per_ward
    return float(weeks)


def campaign_payouts(folder: str) -> list[dict[str, Any]]:
    path = Path(folder) / "campaign.json"
    if not path.is_file():
        return []
    total = 0
    found = []
    for encounter in json.loads(path.read_text(encoding="utf-8"))["encounters"]:
        total += int(encounter["tokens"])
        found.append(
            {
                "ward": encounter["number"],
                "name": encounter["name"],
                "tokens": int(encounter["tokens"]),
                "cumulative": total,
            }
        )
    return found


def ledger(db: Session) -> dict[str, Any]:
    """The accounts' balances and the ledger by kind, SysOp's and deleted accounts apart."""
    players = select(User.id).where(User.kind != "sysop", User.status != "deleted")
    balances = sorted(
        int(total)
        for (total,) in db.execute(
            select(func.coalesce(func.sum(TokenEntry.amount), 0))
            .select_from(User)
            .outerjoin(TokenEntry, TokenEntry.user_id == User.id)
            .where(User.id.in_(players))
            .group_by(User.id)
        )
    )
    kinds = {
        kind: {"entries": int(entries), "tokens": int(tokens)}
        for kind, entries, tokens in db.execute(
            select(TokenEntry.kind, func.count(), func.coalesce(func.sum(TokenEntry.amount), 0))
            .where(TokenEntry.user_id.in_(players))
            .group_by(TokenEntry.kind)
            .order_by(TokenEntry.kind)
        )
    }
    return {
        "accounts": len(balances),
        "total": sum(balances),
        "median": int(median(balances)) if balances else 0,
        "largest": balances[-1] if balances else 0,
        "by_kind": kinds,
    }


def land_packs(db: Session) -> dict[str, int]:
    """What the basic land packs have sold: what functional basic lands would no longer need."""
    packs, tokens, accounts = db.execute(
        select(
            func.count(),
            func.coalesce(func.sum(Pack.tokens), 0),
            func.count(func.distinct(Pack.user_id)),
        )
        .select_from(Pack)
        .join(ShopProduct, ShopProduct.id == Pack.product_id)
        .where(ShopProduct.set_code == LAND_SET, Pack.source == "purchase")
    ).one()
    return {"packs": int(packs), "tokens": int(tokens), "accounts": int(accounts)}


def farming_signals(db: Session) -> dict[str, Any]:
    """The farming signals kept with the games (api/farming.py), counted by name."""
    counts: dict[str, int] = {}
    games = flagged = 0
    for (kept,) in db.execute(select(Game.eligibility).where(Game.eligibility.is_not(None))):
        games += 1
        signals = (kept or {}).get("signals") if isinstance(kept, dict) else None
        if not isinstance(signals, dict) or not signals:
            continue
        flagged += 1
        for names in signals.values():
            for name in names if isinstance(names, list) else []:
                counts[str(name)] = counts.get(str(name), 0) + 1
    return {"games": games, "flagged": flagged, "signals": dict(sorted(counts.items()))}


def report(
    db: Session | None,
    folder: str,
    *,
    streaks: policies.QuestStreaks | None = None,
    catch_up: policies.QuestCatchUp | None = None,
    staples: policies.StarterStaples | None = None,
    weeks: int = WEEKS,
) -> dict[str, Any]:
    """The report: what is (from the database, when one is given) and what the proposals would
    do. The proposals default to the ones docs/economy.md sets out."""
    streaks = streaks or policies.QuestStreaks(mode="forgiving", grace=2, penalty=0)
    catch_up = catch_up or policies.QuestCatchUp(enabled=True, tokens=400, days=3)
    staples = staples or policies.StarterStaples(enabled=True, initial=10, per_ward=2)
    pool = len(pool_in(folder))
    weekly = sum(WEEKLY_TOKENS[tier] * count for tier, count in WEEKLY_TIERS.items())
    found: dict[str, Any] = {
        "campaign": campaign_payouts(folder),
        "quests": {
            "daily_quests": sum(DAILY_TOKENS),
            "daily_bonus": [bonus_for("daily", streak) for streak in (1, 7)],
            "weekly_goals": weekly,
            "weekly_goal_count": WEEKLY_GOALS,
            "weekly_bonus": [bonus_for("weekly", streak) for streak in (1, 16)],
        },
        "simulation": {"weeks": weeks, "daily_boards": quest_simulation(streaks, catch_up, weeks)},
        "staples": {
            "pool": pool,
            "proposal": staples.model_dump(mode="json"),
            "picks_after_the_campaign": staples.initial + 15 * staples.per_ward,
            "weeks_to_the_whole_pool": {
                f"{wards} wards a week": staple_weeks(pool, staples, wards) for wards in (1, 2, 5)
            },
        },
    }
    if db is not None:
        found["ledger"] = ledger(db)
        found["land_packs"] = land_packs(db)
        found["farming"] = farming_signals(db)
        found["policies"] = [
            {"name": each.name, "changed": each.changed, "value": each.value}
            for each in policies.view(db).policies
        ]
    return found


def as_text(found: dict[str, Any]) -> str:
    """The report for reading."""
    lines: list[str] = []

    def title(text: str) -> None:
        lines.extend(["", text, "-" * len(text)])

    if "ledger" in found:
        book = found["ledger"]
        title("Balances (players' accounts; SysOp's and deleted ones left out)")
        lines.append(
            f"{book['accounts']:,} accounts hold {book['total']:,} tokens: median "
            f"{book['median']:,}, largest {book['largest']:,}."
        )
        title("The ledger by kind")
        for kind, row in book["by_kind"].items():
            lines.append(f"{kind:<12} {row['entries']:>8,} entries {row['tokens']:>16,} tokens")
        packs = found["land_packs"]
        title("Basic land packs sold")
        lines.append(
            f"{packs['packs']:,} packs for {packs['tokens']:,} tokens, to {packs['accounts']:,} "
            "accounts: what functional basic lands would no longer need."
        )
        seen = found["farming"]
        title("Farming signals kept with the games")
        lines.append(f"{seen['flagged']:,} of {seen['games']:,} games carry a signal.")
        for name, count in seen["signals"].items():
            lines.append(f"{name:<26} {count:>8,}")
        title("Policies as they stand")
        for each in found["policies"]:
            state = "changed" if each["changed"] else "default"
            lines.append(f"{each['name']:<20} {state:<8} {json.dumps(each['value'])}")
    if found["campaign"]:
        title("The campaign's tokens, ward by ward")
        for ward in found["campaign"]:
            lines.append(
                f"{ward['ward']:>2} {ward['name']:<18} {ward['tokens']:>12,} "
                f"{ward['cumulative']:>14,} in all"
            )
    quests = found["quests"]
    title("The quest boards")
    daily, weekly = quests["daily_bonus"], quests["weekly_bonus"]
    lines.append(
        f"A day's five quests pay {quests['daily_quests']:,}; its board {daily[0]:,} to "
        f"{daily[1]:,} by its streak. A week's {quests['weekly_goal_count']} goals pay "
        f"{quests['weekly_goals']:,}; its board {weekly[0]:,} to {weekly[1]:,}."
    )
    simulation = found["simulation"]
    title(f"Tokens from the daily boards over {simulation['weeks']} weeks, by who plays when")
    for board in simulation["daily_boards"]:
        lines.append(board["proposal"])
        for name, row in board["players"].items():
            lines.append(
                f"  {name:<28} first week {row['first_week']:>7,}  a settled week "
                f"{row['settled_week']:>7,}  in all {row['total']:>9,}  best streak "
                f"{row['best_streak']}"
            )
    staples = found["staples"]
    title("The starter-staple pool")
    lines.append(
        f"{staples['pool']} cards. Proposed: {staples['proposal']['initial']} picks to start, "
        f"{staples['proposal']['per_ward']} a ward won, "
        f"{staples['proposal']['per_weekly_board']} a weekly board finished: "
        f"{staples['picks_after_the_campaign']} picks once the campaign is won."
    )
    for pace, weeks in staples["weeks_to_the_whole_pool"].items():
        lines.append(
            f"  {pace}: " + ("never the whole pool" if weeks is None else f"{weeks:.0f} weeks")
        )
    return "\n".join(lines).strip() + "\n"
