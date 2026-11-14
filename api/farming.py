"""Farming signals and their hook (v0.9.12, the economy foundation; docs/economy.md).

The owner's specification asks the economy for "anti-farming instrumentation and policy hooks"
(section 11), ahead of v1.0.0's "prevent AFK, collusion, concession, and repeated-opponent
farming" (section 22). This is both, and by default only the first:

- **Signals** are read as a game's end is recorded (api/games.py record_end), from what that
  transaction already has: the engine's result, the game's seats and the results recorded
  before it. They are kept with the game (`games.eligibility`, under `signals`, by seat), so a
  game can always be asked what was seen. Recording them changes nothing a game pays.
- **The hook** is the farming policy's `enforce` (api/policies.py), off by default. On, a
  flagged seat's reward is withheld with the signal as its reason (`seats` in
  `games.eligibility`): record_end passes what `withheld` answers to the token payment and the
  settlement.

The signals, each one a seat's:

- `conceded_early`: the seat conceded before the policy's `short_turns`. Enforced, it keeps
  the game from the seat's quest boards.
- `opponent_conceded_early`: the seat won a game of two players whose other one did. Enforced,
  it withholds the win's tokens.
- `repeat_opponent`: the seat's player and another had `repeat_results` results together that
  day. Enforced, it withholds tokens and quest progress.
- `idle`: the seat's player sent no command in a game that reached turn 1. Enforced, it keeps
  the game from the seat's quest boards.
- `short_game`: the game finished before `short_turns` with no concession. Seen only.

What they stand for: a game conceded at once, to count as a game played or to hand a win; two
accounts that play each other over and over; a player who starts games and walks away. None is
proof, which is why each is a signal first: the thresholds are the owner's to set before the
hook is turned on. Nothing here pays by a game's length, so no reward is earned by drawing a
game out. A campaign duel is the campaign's to settle, and only its signals are kept.

`idle` needs the commands each seat sent, which the API counts while it follows a game; a game
whose end is recorded after an API restart has no count, and no `idle` signal either way.
"""

from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session, aliased

from api import policies
from api.economy import arizona_day
from api.models import Game, GameSeat, PlayerResult

CONCEDED_EARLY = "conceded_early"
OPPONENT_CONCEDED_EARLY = "opponent_conceded_early"
REPEAT_OPPONENT = "repeat_opponent"
IDLE = "idle"
SHORT_GAME = "short_game"
# What each signal withholds from its seat when the policy enforces it.
WITHHOLDS: dict[str, tuple[str, ...]] = {
    CONCEDED_EARLY: ("quests",),
    OPPONENT_CONCEDED_EARLY: ("tokens",),
    REPEAT_OPPONENT: ("tokens", "quests"),
    IDLE: ("quests",),
    SHORT_GAME: (),
}


@dataclass
class Observed:
    """What a game's end showed, by seat, and what the policy withholds for it."""

    signals: dict[int, list[str]] = field(default_factory=dict)
    withheld: dict[int, dict[str, str]] = field(default_factory=dict)

    def record(self, kept: dict[str, object]) -> dict[str, object]:
        """The game's eligibility record with what was seen, and what was withheld for it."""
        if self.signals:
            kept["signals"] = {str(seat): found for seat, found in sorted(self.signals.items())}
        if self.withheld:
            kept["seats"] = {str(seat): held for seat, held in sorted(self.withheld.items())}
        return kept

    def without(self, reward: str) -> frozenset[int]:
        """The seats the reward is withheld from."""
        return frozenset(seat for seat, held in self.withheld.items() if reward in held)


def results_together(db: Session, game: Game, one: UUID, other: UUID) -> int:
    """How many results the two accounts have from games they both played, in the Arizona day
    the game ended in: this game's are not recorded yet, so it counts the ones before it."""
    start, end = arizona_day(game.finished_at or game.created_at)
    mine, theirs = aliased(PlayerResult), aliased(PlayerResult)
    return int(
        db.scalar(
            select(func.count())
            .select_from(mine)
            .join(theirs, theirs.game_id == mine.game_id)
            .where(
                mine.user_id == one,
                theirs.user_id == other,
                mine.game_id.is_not(None),
                mine.finished_at >= start,
                mine.finished_at < end,
            )
        )
        or 0
    )


def observe(db: Session, game: Game, activity: Mapping[int, int] | None = None) -> Observed:
    """The game's farming signals, by seat, and what the farming policy withholds for them: in
    the transaction that records the game's end, before its results are written. activity is
    the commands each human seat sent, when the API followed the game to its end."""
    policy = policies.read(db, policies.Farming)
    result: dict[str, Any] = game.result or {}
    seats = list(
        db.scalars(select(GameSeat).where(GameSeat.game_id == game.id).order_by(GameSeat.seat))
    )
    humans = {seat.seat: seat.user_id for seat in seats if seat.user_id is not None}
    found: dict[int, list[str]] = defaultdict(list)
    if not result or not humans:
        return Observed()
    turns = result.get("turns")
    short = isinstance(turns, int) and turns < policy.short_turns
    conceded = {seat for seat in result.get("conceded_seats") or [] if isinstance(seat, int)}
    winners = set(result.get("winner_seats") or [])
    if short:
        for seat in humans:
            if seat in conceded:
                found[seat].append(CONCEDED_EARLY)
        if conceded and len(seats) == 2:
            for seat in humans:
                if seat in winners and seat not in conceded:
                    found[seat].append(OPPONENT_CONCEDED_EARLY)
        if not conceded:
            for seat in humans:
                found[seat].append(SHORT_GAME)
    by_seat = sorted(humans.items())
    for index, (seat, user_id) in enumerate(by_seat):
        for other_seat, other_id in by_seat[index + 1 :]:
            if user_id == other_id:
                continue
            if results_together(db, game, user_id, other_id) + 1 >= policy.repeat_results:
                for flagged in (seat, other_seat):
                    if REPEAT_OPPONENT not in found[flagged]:
                        found[flagged].append(REPEAT_OPPONENT)
    if activity is not None and isinstance(turns, int) and turns >= 1:
        for seat in humans:
            if activity.get(seat, 0) == 0 and seat not in conceded:
                found[seat].append(IDLE)
    signals = {seat: names for seat, names in found.items() if names}
    withheld: dict[int, dict[str, str]] = {}
    if policy.enforce:
        for seat, names in signals.items():
            held: dict[str, str] = {}
            for name in names:
                for reward in WITHHOLDS[name]:
                    held.setdefault(reward, f"farming_{name}")
            if held:
                withheld[seat] = held
    return Observed(signals=signals, withheld=withheld)
