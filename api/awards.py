"""What a game's end settles beyond its win and its pay (v0.5.0): the players' results, their
quest boards and the winner's achievements, in the transaction that records the end
(api/games.py record_end), so none is recorded without the others, or twice. docs/quests.md
describes them.

Every player with a result may complete a quest (since v0.9.5 some count games played, not only
wins); only the winner can earn an achievement, as achievements count wins. What the others earned
elsewhere (a friend made) waits for their next check (api/achievements.py).
"""

from sqlalchemy.orm import Session

from api.achievements import BY_ID as ACHIEVEMENTS
from api.achievements import catch_up
from api.identity import utcnow
from api.models import Game, User
from api.quests import award_name, count_game
from api.social import Award
from api.stats import record_results


def settle(db: Session, game: Game) -> None:
    """After the game's end is recorded, with its win counted and paid (economy.pay_game holds the
    winner's lock): a result for every human seat, then each player's quest boards and the
    winner's achievements."""
    for result in record_results(db, game):
        if result.outcome == "no_result":
            continue
        user = db.get_one(User, result.user_id)
        count_game(db, user, result.finished_at)
        if result.outcome == "win":
            catch_up(db, user, utcnow())


def award_of(kind: str, subject: str | None) -> Award | None:
    """The bell's words for a quest completed (or a board, v0.9.5) or an achievement earned."""
    if kind == "quest_completed" and subject:
        named = award_name(subject)
        if named is not None:
            return Award(id=subject, name=named[0], tokens=named[1])
    if kind == "achievement_earned" and subject in ACHIEVEMENTS:
        achievement = ACHIEVEMENTS[subject]
        return Award(id=achievement.id, name=achievement.name, tokens=achievement.tokens)
    return None
