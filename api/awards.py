"""What a game's end settles beyond its win and its pay (v0.5.0): the players' results, the
winner's daily quests and the winner's achievements, in the transaction that records the end
(api/games.py record_end), so none is recorded without the others, or twice. docs/quests.md
describes them.

Only the winner can complete a quest or earn an achievement from a game: both count wins. What
the others earned elsewhere (a friend made) waits for their next check (api/achievements.py).
"""

from sqlalchemy.orm import Session

from api.achievements import BY_ID as ACHIEVEMENTS
from api.achievements import catch_up
from api.identity import utcnow
from api.models import Game, User
from api.quests import BY_ID as QUESTS
from api.quests import count_game
from api.social import Award
from api.stats import record_results


def settle(db: Session, game: Game) -> None:
    """After the game's end is recorded, with its win counted and paid (economy.pay_game holds the
    winner's lock): a result for every human seat, then the winner's quests and achievements."""
    for result in record_results(db, game):
        if result.outcome != "win":
            continue
        user = db.get_one(User, result.user_id)
        count_game(db, user, result.finished_at)
        catch_up(db, user, utcnow())


def award_of(kind: str, subject: str | None) -> Award | None:
    """The bell's words for a quest completed or an achievement earned."""
    if kind == "quest_completed" and subject in QUESTS:
        quest = QUESTS[subject]
        return Award(id=quest.id, name=quest.name, tokens=quest.tokens)
    if kind == "achievement_earned" and subject in ACHIEVEMENTS:
        achievement = ACHIEVEMENTS[subject]
        return Award(id=achievement.id, name=achievement.name, tokens=achievement.tokens)
    return None
