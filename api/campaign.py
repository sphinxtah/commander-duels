"""The campaign (v0.8.0): The Final Concordance, fourteen one-on-one Commander duels against the
wardens of the Archive and then The Sphinx. docs/campaign.md describes it for players and staff;
the owner's handoff is in the gitignored campaign/ folder beside compose.yaml.

- **The content** is content/campaign.json: each encounter's opponent (a roster Planeswalker, whose
  portrait the table shows), its commander and 99-card deck, the bots' skill, its tier and seal,
  the chapters with their rewards, and the campaign's loaner deck. The story itself (every line of
  the scenes) is the browser's: web/src/campaign/script.ts.
- **The finale** is private. The Sphinx's own commander and the incarnation in reserve are the
  Godlike tier's custom cards, whose names never enter this repository: the owner's engine image
  serves them (GET /v1/service/content/campaign-finale, from its plugin), and the API puts them in
  the final opponent's deck list. An engine without that content (the public images) plays the
  finale with the deck's public stand-in commander and no incarnation, and says so.
- **A duel** is a practice game for one player against one bot (api/games.py), linked to its
  encounter by campaign_games. Its end is read in the transaction that records it (game_ended):
  a win records the encounter, its seal, the next encounter and a completed chapter's rewards, in
  that one transaction, and only once; a loss, a draw, a concession or a game that did not finish
  changes nothing. Campaign games count no win and advance no quest or achievement (the
  handoff's progression separation), and pay no tokens for the win itself.
- **The spoils** (the owner, 2026-10-31): a warden's first defeat gives the player that warden's
  deck, a deck of their own with every copy of its cards granted to their library, and tokens,
  1,000 for the first warden and doubling with each (content/campaign.json names each amount).
  The deck given is the list the duel served the opponent (its bot seat's, in game_seats). The
  Sphinx's deck comes with the commander he played: the owner's High Priest, a Godlike custom
  card, when the private finale ran (granted for good: custom_card_grants, so its winner sees and
  plays it whatever their tier), else the public stand-in. A private finale won while no custom
  card carries its commander's name gives no spoils yet: the win, its seal and its chapter count,
  and the first win after SysOp uploads the card gives them.
- **Progress** is campaign_progress: the furthest encounter open, those won, the scenes seen and
  the tutorial. Account wins and tiers never gate it.
"""

import json
import logging
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Request
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api.auth import INPUT_ERRORS
from api.custom_play import custom_in_seats
from api.decks import refresh_decks, store_draft
from api.economy import reward as pay_reward
from api.games import (
    EngineClient,
    EngineUnavailable,
    LiveGame,
    LiveSeat,
    Player,
    SeatPlan,
    active_games_of,
    engine_game,
    followed_or_closed,
    full_access,
    hub_of,
    own_deck,
    record_game,
    require_loaded,
    seat_tokens,
    summary_of,
)
from api.identity import ApiError, Db, permissions_for, roles_of, settings_of, utcnow
from api.library import grant_deck, library_of
from api.models import (
    CampaignGame,
    CampaignProgress,
    CampaignReward,
    CardConcept,
    CustomCard,
    CustomCardGrant,
    Deck,
    Game,
    GameSeat,
    User,
)
from api.progression import winning_seats
from api.roster import load as load_roster
from api.roster import roster_of
from api.schemas import Contract, Error, GameSummary, PracticeGameRequest, casual
from api.validation import DeckEntry
from catalog.text import normalize

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
log = logging.getLogger("api.campaign")

CAMPAIGN_FILE = "campaign.json"
# The engine's route for the owner's private finale (its plugin's resource), and how long the
# answer is kept: one engine start rarely changes it.
FINALE_CONTENT = "/content/campaign-finale"
FINALE_SECONDS = 300.0
# The story scenes an account's progress remembers seeing.
SCENES_KEPT = 200
SCENE_KEY = r"^FC\.[A-Z0-9]+(\.[A-Z0-9]+){0,3}$"
LESSON_KEY = r"^T(0[1-9]|1[0-2])$"
# The rule a warden's tokens are paid under, recorded with each payment.
SPOILS_POLICY = "campaign-v1"
Tier = Literal["bronze", "silver", "gold", "platinum", "mythic", "godlike"]
Outcome = Literal["won", "lost", "draw", "unfinished"]


@dataclass(frozen=True)
class Encounter:
    number: int
    opponent: str
    name: str
    title: str
    tier: str
    location: str
    seal: str
    skill: int
    commander: str | None
    cards: tuple[tuple[str, int], ...]
    # The finale's stand-in commander, when the engine lacks the owner's private finale.
    fallback_commander: str | None = None
    # The engine content that replaces the commander and adds the reserve (the finale).
    private: str | None = None
    # The tokens the first win pays (the spoils, with the deck).
    tokens: int = 0
    # What the spoils call the private finale's commander, whose name this repository never holds.
    private_commander_title: str | None = None

    @property
    def prize_commander(self) -> str:
        """The catalog commander of the deck the first win gives: the opponent's own, or for the
        finale its public stand-in (the private finale gives its own commander instead)."""
        return self.commander or self.fallback_commander or "Morophon, the Boundless"

    @property
    def deck_title(self) -> str:
        return f"{self.name}'s Deck"

    def deck_list(self, commander: str) -> dict[str, object]:
        return {
            "cards": [{"name": name, "count": count} for name, count in self.cards],
            "commanders": [commander],
        }


@dataclass(frozen=True)
class Chapter:
    tier: str
    name: str
    encounters: tuple[int, ...]
    rewards: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class Campaign:
    id: str
    content_version: int
    title: str
    turn_cap: int
    training_seed: int
    loaner_title: str
    loaner_commander: str
    loaner_cards: tuple[tuple[str, int], ...]
    chapters: tuple[Chapter, ...]
    encounters: tuple[Encounter, ...]

    def encounter(self, number: int) -> Encounter:
        for encounter in self.encounters:
            if encounter.number == number:
                return encounter
        raise ApiError(404, "not_found", "There is no such encounter.")

    @property
    def last(self) -> int:
        return max(encounter.number for encounter in self.encounters)

    def loaner_list(self) -> dict[str, object]:
        return {
            "cards": [{"name": name, "count": count} for name, count in self.loaner_cards],
            "commanders": [self.loaner_commander],
        }


def cards_of(entries: list[dict[str, Any]]) -> tuple[tuple[str, int], ...]:
    return tuple((str(entry["name"]), int(entry["count"])) for entry in entries)


@lru_cache(maxsize=4)
def campaign_in(folder: str) -> Campaign | None:
    path = Path(folder) / CAMPAIGN_FILE
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return Campaign(
        id=data["id"],
        content_version=int(data["content_version"]),
        title=data["title"],
        turn_cap=int(data["turn_cap"]),
        training_seed=int(data["training_seed"]),
        loaner_title=data["loaner"]["title"],
        loaner_commander=data["loaner"]["commander"],
        loaner_cards=cards_of(data["loaner"]["cards"]),
        chapters=tuple(
            Chapter(
                tier=chapter["tier"],
                name=chapter["name"],
                encounters=tuple(chapter["encounters"]),
                rewards=tuple((reward["id"], reward["name"]) for reward in chapter["rewards"]),
            )
            for chapter in data["chapters"]
        ),
        encounters=tuple(
            Encounter(
                number=int(encounter["number"]),
                opponent=encounter["opponent"],
                name=encounter["name"],
                title=encounter["title"],
                tier=encounter["tier"],
                location=encounter["location"],
                seal=encounter["seal"],
                skill=int(encounter["skill"]),
                commander=encounter.get("commander"),
                cards=cards_of(encounter["cards"]),
                fallback_commander=encounter.get("fallback_commander"),
                private=encounter.get("private"),
                tokens=int(encounter.get("tokens", 0)),
                private_commander_title=encounter.get("private_commander_title"),
            )
            for encounter in data["encounters"]
        ),
    )


def campaign_of(request: Request) -> Campaign:
    campaign = campaign_in(settings_of(request).content_dir)
    if campaign is None:
        raise ApiError(503, "campaign_unavailable", "The campaign is not installed on this site.")
    return campaign


# Contracts.


class EncounterSpoils(Contract):
    tokens: int = Field(description="Tokens the first win pays.")
    deck: str = Field(description="The title of the deck the first win gives.")
    commander: str = Field(
        description="That deck's commander; for the private finale's, what the story calls it."
    )
    earned: bool


class CampaignEncounter(Contract):
    number: int
    opponent: str = Field(description="The opponent's roster ID, which names their portrait.")
    name: str
    title: str
    tier: Tier
    location: str
    seal: str
    commander: str | None = Field(
        description="The opponent's commander; null for the finale's, which is the owner's own."
    )
    skill: int = Field(description="The bot's skill, 1 to 6.")
    status: Literal["locked", "open", "won"]
    spoils: EncounterSpoils = Field(
        description="What the first win gives: the warden's deck and tokens."
    )


class ChapterReward(Contract):
    id: str
    name: str
    earned: bool


class CampaignChapter(Contract):
    tier: Tier
    name: str
    encounters: list[int]
    complete: bool
    rewards: list[ChapterReward]


class CampaignTutorial(Contract):
    complete: bool = Field(description="The first encounter won, or the teaching skipped.")
    hints: bool
    skipped: bool
    lessons: list[str] = Field(description="The tutorial's lessons seen, T01 to T12.")


class CampaignProgressView(Contract):
    highest_unlocked: int
    completed: list[int] = Field(description="The encounters won, whose seals are yours.")
    ending: Literal["standard", "early"] | None
    scenes_seen: list[str]
    tutorial: CampaignTutorial


class CampaignState(Contract):
    id: str
    title: str
    content_version: int
    loaner: str = Field(description="The campaign's loaner deck, Learn Commander's.")
    loaner_commander: str
    encounters: list[CampaignEncounter]
    chapters: list[CampaignChapter]
    progress: CampaignProgressView
    running: UUID | None = Field(description="Your campaign duel still running, to go back to.")


class StartEncounter(Contract):
    deck_id: UUID | None = Field(default=None, description="One of your Commander decks.")
    loaner: bool = Field(default=False, description="The campaign's loaner deck instead.")
    learn: bool = Field(
        default=False,
        description="Learn Commander: the loaner deck with the training seed and the hints.",
    )


class SceneSeen(Contract):
    scene: str = Field(pattern=SCENE_KEY, max_length=48)


class TutorialChange(Contract):
    hints: bool | None = None
    skip: bool | None = Field(default=None, description="Skip the teaching (never the duel).")
    lessons: list[Annotated[str, Field(pattern=LESSON_KEY)]] | None = Field(
        default=None, max_length=12, description="Lessons seen, added to those already seen."
    )


# Progress.


def progress_of(
    db: Session, user: User, campaign: Campaign, *, lock: bool = False
) -> CampaignProgress:
    """The account's progress, made on its first look, and started again after a reset."""
    query = select(CampaignProgress).where(
        CampaignProgress.user_id == user.id, CampaignProgress.campaign_id == campaign.id
    )
    if lock:
        query = query.with_for_update()
    progress = db.scalar(query)
    now = utcnow()
    if progress is None:
        progress = CampaignProgress(
            user_id=user.id,
            campaign_id=campaign.id,
            content_version=campaign.content_version,
            highest_unlocked=1,
            completed=[],
            ending=None,
            scenes_seen=[],
            hints=True,
            tutorial_skipped=False,
            lessons=[],
            started_at=now,
            updated_at=now,
        )
        db.add(progress)
        try:
            db.flush()
        except IntegrityError:
            # Two first looks at once: the other made it.
            db.rollback()
            return progress_of(db, user, campaign, lock=lock)
    elif user.reset_at is not None and progress.started_at < user.reset_at:
        progress.highest_unlocked = 1
        progress.completed = []
        progress.ending = None
        progress.scenes_seen = []
        progress.hints = True
        progress.tutorial_skipped = False
        progress.lessons = []
        progress.started_at = now
        progress.updated_at = now
    return progress


def epoch(progress: CampaignProgress) -> str:
    return progress.started_at.strftime("%Y%m%dT%H%M%S%f")


def earned(db: Session, user_id: UUID, campaign: Campaign, progress: CampaignProgress) -> set[str]:
    prefix = f"campaign:{user_id}:{campaign.id}:{epoch(progress)}:"
    return {
        key.removeprefix(prefix)
        for key in db.scalars(
            select(CampaignReward.key).where(
                CampaignReward.user_id == user_id, CampaignReward.key.startswith(prefix)
            )
        )
    }


def reward(
    db: Session,
    user_id: UUID,
    campaign: Campaign,
    progress: CampaignProgress,
    name: str,
    game_id: UUID | None,
) -> bool:
    """Records a reward once; True when this call earned it."""
    key = f"campaign:{user_id}:{campaign.id}:{epoch(progress)}:{name}"
    if db.scalar(select(CampaignReward.id).where(CampaignReward.key == key)) is not None:
        return False
    db.add(
        CampaignReward(
            user_id=user_id,
            campaign_id=campaign.id,
            key=key,
            reward=name,
            game_id=game_id,
            created_at=utcnow(),
        )
    )
    db.flush()
    return True


def tutorial_complete(progress: CampaignProgress) -> bool:
    return progress.tutorial_skipped or 1 in progress.completed


def running_of(db: Session, user_id: UUID) -> UUID | None:
    return db.scalar(
        select(Game.id)
        .join(CampaignGame, CampaignGame.game_id == Game.id)
        .where(CampaignGame.user_id == user_id, Game.status == "active")
        .order_by(Game.created_at.desc())
        .limit(1)
    )


def spoils_commander(encounter: Encounter, finale: "FinaleCache | None") -> str:
    """The commander the spoils name: the finale's private one by the story's word while the
    running engine serves the owner's finale (or has not been asked yet), else the stand-in."""
    if encounter.private and encounter.private_commander_title:
        if finale is None or not finale.at or finale.content is not None:
            return encounter.private_commander_title
    return encounter.prize_commander


def state_of(
    db: Session, user: User, campaign: Campaign, finale: "FinaleCache | None" = None
) -> CampaignState:
    progress = progress_of(db, user, campaign)
    db.commit()
    done = set(progress.completed)
    rewards = earned(db, user.id, campaign, progress)
    return CampaignState(
        id=campaign.id,
        title=campaign.title,
        content_version=campaign.content_version,
        loaner=campaign.loaner_title,
        loaner_commander=campaign.loaner_commander,
        encounters=[
            CampaignEncounter(
                number=encounter.number,
                opponent=encounter.opponent,
                name=encounter.name,
                title=encounter.title,
                tier=cast(Tier, encounter.tier),
                location=encounter.location,
                seal=encounter.seal,
                commander=encounter.commander,
                skill=encounter.skill,
                status=(
                    "won"
                    if encounter.number in done
                    else "open"
                    if encounter.number <= progress.highest_unlocked
                    else "locked"
                ),
                spoils=EncounterSpoils(
                    tokens=encounter.tokens,
                    deck=encounter.deck_title,
                    commander=spoils_commander(encounter, finale),
                    earned=f"spoils:{encounter.number:02d}" in rewards,
                ),
            )
            for encounter in campaign.encounters
        ],
        chapters=[
            CampaignChapter(
                tier=cast(Tier, chapter.tier),
                name=chapter.name,
                encounters=list(chapter.encounters),
                complete=all(number in done for number in chapter.encounters),
                rewards=[
                    ChapterReward(id=id_, name=name, earned=id_ in rewards)
                    for id_, name in chapter.rewards
                ],
            )
            for chapter in campaign.chapters
        ],
        progress=CampaignProgressView(
            highest_unlocked=progress.highest_unlocked,
            completed=sorted(done),
            ending=progress.ending,  # type: ignore[arg-type]
            scenes_seen=list(progress.scenes_seen),
            tutorial=CampaignTutorial(
                complete=tutorial_complete(progress),
                hints=progress.hints,
                skipped=progress.tutorial_skipped,
                lessons=list(progress.lessons),
            ),
        ),
        running=running_of(db, user.id),
    )


# A duel's end.


def outcome_of(game: Game) -> Outcome:
    """The campaign's word for how the game ended, for the player in seat 0. Only a completed game
    that seat 0's side won is a win; a turn limit, a closed or idle game and an engine error are
    unfinished."""
    result = game.result or {}
    if game.status != "finished" or result.get("kind") != "completed":
        return "unfinished"
    if result.get("draw"):
        return "draw"
    return "won" if 0 in winning_seats(result) else "lost"


def game_ended(
    db: Session,
    game: Game,
    link: CampaignGame,
    campaign: Campaign | None,
    content_dir: str | None = None,
    *,
    payouts: bool = True,
) -> None:
    """In the transaction recording the game's end: its outcome, and for a win the encounter, its
    seal and spoils, the next encounter and a chapter's rewards, once. Called by
    games.record_end. Without payouts (SysOp's duel with passive bots, v0.8.6) a win still opens
    the next encounter and records its seal, but gives no spoils and no chapter rewards: a later
    win without passive bots gives them as a first win would."""
    outcome = outcome_of(game)
    link.outcome = outcome
    link.finished_at = utcnow()
    if outcome != "won" or campaign is None or link.campaign_id != campaign.id:
        return
    user = db.get_one(User, link.user_id)
    progress = progress_of(db, user, campaign, lock=True)
    if progress.started_at > link.created_at:
        # The account was reset after the duel began: it belongs to the old progress.
        return
    number = link.encounter
    if number not in progress.completed:
        progress.completed = sorted({*progress.completed, number})
    progress.highest_unlocked = max(progress.highest_unlocked, min(number + 1, campaign.last))
    progress.content_version = campaign.content_version
    progress.updated_at = utcnow()
    reward(db, user.id, campaign, progress, f"seal:{number:02d}", game.id)
    if not payouts:
        return
    served = served_list(db, game)
    prize_card = link.prize_card
    ready = True
    if link.finale == "private":
        # The private finale's spoils come with its commander, a custom card. Without one under
        # the commander's name, the spoils wait: a later win gives them once SysOp uploads it.
        prize_card = finale_prize(db, link, served)
        ready = prize_card is not None
        if not ready:
            log.warning(
                "Campaign finale won without its commander's custom card; spoils wait (game %s)",
                game.id,
            )
    if ready and reward(db, user.id, campaign, progress, f"spoils:{number:02d}", game.id):
        give_spoils(
            db,
            user,
            campaign,
            progress,
            campaign.encounter(number),
            content_dir,
            prize_card,
            served,
        )
    done = set(progress.completed)
    for chapter in campaign.chapters:
        if number in chapter.encounters and all(n in done for n in chapter.encounters):
            for id_, _ in chapter.rewards:
                reward(db, user.id, campaign, progress, id_, game.id)


def served_list(db: Session, game: Game) -> dict[str, Any] | None:
    """The opponent's deck list as the duel served it to the engine (the bot seat's)."""
    found = db.scalar(
        select(GameSeat.deck_list).where(GameSeat.game_id == game.id, GameSeat.player == "bot")
    )
    return found if isinstance(found, dict) else None


def served_commander(served: dict[str, Any] | None) -> str | None:
    commanders = (served or {}).get("commanders")
    if isinstance(commanders, list) and commanders and isinstance(commanders[0], str):
        return commanders[0]
    return None


def served_cards(served: dict[str, Any] | None) -> tuple[tuple[str, int], ...] | None:
    """The 99 the duel served, or None when the seat recorded no list."""
    cards = (served or {}).get("cards")
    if not isinstance(cards, list) or not cards:
        return None
    return tuple(
        (card["name"], int(card.get("count", 1)))
        for card in cards
        if isinstance(card, dict) and isinstance(card.get("name"), str)
    )


def finale_prize(db: Session, link: CampaignGame, served: dict[str, Any] | None) -> UUID | None:
    """The private finale's commander as a custom card: the one found when the duel began, or
    else one SysOp uploaded since under the name the engine served."""
    if link.prize_card is not None and db.get(CustomCard, link.prize_card) is not None:
        return link.prize_card
    name = served_commander(served)
    return prize_card_named(db, name) if name else None


def prize_card_named(db: Session, name: str) -> UUID | None:
    """The custom card SysOp uploaded under the name the engine serves for the finale's commander,
    case and surrounding spaces aside, as the engine reads names."""
    return db.scalar(
        select(CustomCard.id).where(func.lower(func.trim(CustomCard.name)) == name.strip().lower())
    )


def prize_entries(
    db: Session,
    encounter: Encounter,
    custom_commander: UUID | None = None,
    served: dict[str, Any] | None = None,
) -> list[DeckEntry]:
    """The deck a warden's first defeat gives, as entries: the commander first (the private
    finale's own, a custom card, when given), then each card the catalog has, in its default
    edition. The deck is the one the duel served (served), when the seat recorded it: the
    private finale's own list when the owner's content gives one; else the content's."""
    entries: list[DeckEntry] = []
    wanted: list[tuple[str, int, str]] = []
    if custom_commander is not None:
        entries.append(
            DeckEntry(card_id=custom_commander, printing_id=None, quantity=1, location="commander")
        )
    else:
        commander = encounter.prize_commander
        if not encounter.private:
            commander = served_commander(served) or commander
        wanted.append((commander, 1, "commander"))
    cards = served_cards(served) or encounter.cards
    wanted += [(name, count, "main") for name, count in cards]
    concepts = {
        concept.normalized_name: concept
        for concept in db.scalars(
            select(CardConcept).where(
                CardConcept.normalized_name.in_({normalize(name) for name, _, _ in wanted}),
                CardConcept.deck_card.is_(True),
                CardConcept.removed_revision.is_(None),
            )
        )
    }
    for name, count, location in wanted:
        concept = concepts.get(normalize(name))
        if concept is not None:
            entries.append(
                DeckEntry(
                    card_id=concept.id,
                    printing_id=concept.default_printing_id,
                    quantity=count,
                    location=location,  # type: ignore[arg-type]
                )
            )
    return entries


def give_spoils(
    db: Session,
    user: User,
    campaign: Campaign,
    progress: CampaignProgress,
    encounter: Encounter,
    content_dir: str | None,
    prize_card: UUID | None = None,
    served: dict[str, Any] | None = None,
) -> None:
    """A warden's spoils, in the transaction recording the win: their deck's cards granted to the
    library for good, the deck itself among the player's own (past the deck limit if need be:
    a prize is never refused), and their tokens. The private finale's commander, a custom card
    (prize_card), is granted for good with The Sphinx's deck (the owner's word). Keyed by the
    progress, so once per campaign and once more after an account reset."""
    number = f"{encounter.number:02d}"
    key = f"campaign:{campaign.id}:{number}:{epoch(progress)}"
    custom: UUID | None = None
    if prize_card is not None and db.get(CustomCard, prize_card) is not None:
        custom = prize_card
    entries = prize_entries(db, encounter, custom, served)
    catalog = [entry for entry in entries if entry.card_id != custom]
    grant_deck(db, user, key, catalog, "campaign")
    if custom is not None:
        db.add(
            CustomCardGrant(
                user_id=user.id,
                custom_card_id=custom,
                quantity=1,
                source="campaign",
                grant_key=key,
                created_at=utcnow(),
            )
        )
    db.flush()
    library = (
        library_of(db, user, permissions_for(user, roles_of(db, user)), load_roster(content_dir))
        if content_dir
        else None
    )
    stamp = utcnow()
    deck = Deck(
        owner_id=user.id,
        title=encounter.deck_title,
        format="commander",
        visibility="private",
        notes=f"Won from {encounter.name} in the campaign: {encounter.title}.",
        draft={},
        draft_version=1,
        draft_hash="",
        source="campaign",
        created_at=stamp,
        updated_at=stamp,
    )
    db.add(deck)
    store_draft(db, deck, entries, library)
    db.flush()
    if library is not None:
        refresh_decks(db, user.id, library)
    if encounter.tokens > 0:
        pay_reward(
            db,
            user.id,
            "campaign",
            encounter.tokens,
            f"campaign:{user.id}:{campaign.id}:{epoch(progress)}:tokens:{number}",
            f"{encounter.name}, {encounter.title}",
            SPOILS_POLICY,
        )


# The private finale.


@dataclass
class FinaleCache:
    content: dict[str, Any] | None = None
    at: float = 0.0


def finale_of(request: Request) -> FinaleCache | None:
    """What the running engine last said of the owner's finale, if it was asked."""
    return getattr(request.app.state, "campaign_finale", None)


async def finale_content(request: Request, engine: EngineClient) -> dict[str, Any] | None:
    """The owner's finale as the running engine serves it, or None (the public images, or an
    engine that does not answer): its commander, its reserve and, if it gives one, its deck."""
    cache: FinaleCache = getattr(request.app.state, "campaign_finale", None) or FinaleCache()
    request.app.state.campaign_finale = cache
    now = time.monotonic()
    if cache.at and now - cache.at < FINALE_SECONDS:
        return cache.content
    try:
        status, body = await engine.request("GET", FINALE_CONTENT)
    except EngineUnavailable:
        return cache.content
    content = body if status == 200 and isinstance(body, dict) else None
    if content is not None and not isinstance(content.get("commander"), str):
        content = None
    cache.content, cache.at = content, now
    return content


def finale_seat(
    encounter: Encounter, content: dict[str, Any] | None
) -> tuple[dict[str, object], str]:
    """The finale's bot seat: with the owner's content, its commander, its reserve (the
    incarnation, cast at its threshold) and its deck if it names one; without, the public deck
    and its stand-in commander."""
    if content is None:
        fallback = encounter.fallback_commander or "Morophon, the Boundless"
        return encounter.deck_list(fallback), "public"
    deck_list = encounter.deck_list(str(content["commander"]))
    cards = content.get("cards")
    if isinstance(cards, list) and cards:
        deck_list["cards"] = [
            {"name": str(card["name"]), "count": int(card.get("count", 1))}
            for card in cards
            if isinstance(card, dict) and isinstance(card.get("name"), str)
        ]
    reserve = content.get("reserve")
    if isinstance(reserve, dict) and isinstance(reserve.get("card"), str):
        deck_list["reserve"] = [
            {"name": reserve["card"], "threshold": int(reserve.get("threshold", 15))}
        ]
    return deck_list, "private"


# Routes.


@router.get("/campaign", response_model=CampaignState)
def get_campaign(request: Request, principal: Player, db: Db) -> CampaignState:
    """The campaign and your way through it."""
    return state_of(db, principal.user, campaign_of(request), finale_of(request))


@router.post(
    "/campaign/encounters/{number}/start",
    response_model=GameSummary,
    status_code=201,
    responses={409: {"model": Error}, 429: {"model": Error}},
)
async def start_encounter(
    number: int,
    body: StartEncounter,
    request: Request,
    principal: Player,
    db: Db,
) -> GameSummary:
    """Starts an encounter's duel: you in seat 0, with your deck or the loaner, against the
    encounter's opponent. An encounter opens once the one before it is won; one won may be played
    again, for no new reward."""
    campaign = campaign_of(request)
    encounter = campaign.encounter(number)
    hub = hub_of(request)
    engine = hub.require_engine()
    user = principal.user
    if body.deck_id is not None and (body.loaner or body.learn):
        raise ApiError(422, "invalid_seat", "Choose your deck or the loaner, not both.")
    if body.deck_id is None and not (body.loaner or body.learn):
        raise ApiError(422, "invalid_seat", "Choose a deck for the duel.")
    if body.learn and number != 1:
        # Learn Commander's seed is disclosed and fixes the shuffles (v0.8.3): on any other ward it
        # would let a player learn both decks' order and replay the same game for its spoils.
        raise ApiError(422, "invalid_seat", "Learn Commander is for the first ward only.")

    def plan() -> tuple[SeatPlan, CampaignProgress]:
        progress = progress_of(db, user, campaign)
        if number > progress.highest_unlocked:
            db.commit()
            raise ApiError(409, "encounter_locked", "Win the encounter before this one to open it.")
        if body.deck_id is not None:
            if not principal.can("decks.edit"):
                raise ApiError(403, "forbidden", "Your account cannot play its own decks.")
            library = library_of(db, user, principal.permissions, roster_of(request))
            seat, revision, title = own_deck(
                db, user, principal.permissions, body.deck_id, "commander", library, casual()
            )
            planned = SeatPlan({"player": "human", **seat}, revision, title)
            held = custom_in_seats(db, [planned.engine])
            planned.custom = held.get(0, [])
        else:
            planned = SeatPlan(
                {"player": "human", "deck_list": campaign.loaner_list()},
                title=campaign.loaner_title,
                starter=True,
            )
        db.commit()
        return planned, progress

    human, progress = await run_in_threadpool(plan)
    await require_loaded(request, [human])
    finale: str | None = None
    prize_card: UUID | None = None
    if encounter.private:
        deck_list, finale = finale_seat(encounter, await finale_content(request, engine))
        if finale == "private":
            # The private commander as a custom card, for the deck the win gives.
            commanders = cast(list[str], deck_list["commanders"])
            prize_card = await run_in_threadpool(prize_card_named, db, commanders[0])
    else:
        deck_list = encounter.deck_list(encounter.commander or "")
    bot = SeatPlan(
        {"player": "bot", "deck_list": deck_list},
        title=f"{encounter.name}'s deck",
        starter=True,
    )
    hints = (body.learn or (number == 1 and progress.hints)) and not progress.tutorial_skipped
    request_body = PracticeGameRequest(
        format="commander",
        deck_id=body.deck_id,
        bot_skill=encounter.skill,
        turn_cap=campaign.turn_cap,
    )
    engine_body: dict[str, object] = {
        "format": "commander",
        "seats": [human.engine, bot.engine],
        "skill": encounter.skill,
        "turn_cap": campaign.turn_cap,
    }
    if body.learn:
        # Learn Commander's disclosed training seed: the same shuffles every time.
        engine_body["seed"] = campaign.training_seed
    user_id = user.id
    async with hub.locks[user_id]:
        if not full_access(principal):
            running = await run_in_threadpool(active_games_of, db, user_id)
            if running >= hub.settings.games_per_account:
                raise ApiError(
                    409, "game_limit", "Finish or close your running game before starting another."
                )
        hub.reserve()
        try:
            created = await engine_game(engine, engine_body, request)

            def record() -> Game:
                game = record_game(db, request, principal, created, request_body, [human, bot])
                # A campaign duel is played again from the campaign, not by a rematch.
                game.settings = None
                db.add(
                    CampaignGame(
                        game_id=game.id,
                        user_id=user_id,
                        campaign_id=campaign.id,
                        encounter=number,
                        opponent=encounter.opponent,
                        opponent_name=encounter.name,
                        title=encounter.title,
                        deck="learn" if body.learn else "loaner" if body.loaner else "own",
                        hints=hints,
                        finale=finale,
                        prize_card=prize_card,
                        created_at=utcnow(),
                    )
                )
                db.commit()
                return game

            async with followed_or_closed(hub, created, db):
                game = await run_in_threadpool(record)
                token = seat_tokens(created)[0]
                hub.register(LiveGame(id=game.id, seats={0: LiveSeat(0, user_id, token)}))
        finally:
            hub.starting -= 1
        return await run_in_threadpool(summary_of, db, game, principal, campaign)


@router.post("/campaign/scenes", response_model=CampaignState)
def scene_seen(body: SceneSeen, request: Request, principal: Player, db: Db) -> CampaignState:
    """A story scene seen to its end or skipped, for the journal; the ending's scene records
    which ending was seen."""
    campaign = campaign_of(request)
    progress = progress_of(db, principal.user, campaign, lock=True)
    if body.scene not in progress.scenes_seen:
        progress.scenes_seen = [*progress.scenes_seen, body.scene][-SCENES_KEPT:]
    if campaign.last in progress.completed:
        if body.scene == "FC.END.WIN" and progress.ending is None:
            progress.ending = "standard"
        elif body.scene == "FC.END.EARLY" and progress.ending is None:
            progress.ending = "early"
    progress.updated_at = utcnow()
    db.commit()
    return state_of(db, principal.user, campaign, finale_of(request))


@router.put("/campaign/tutorial", response_model=CampaignState)
def change_tutorial(
    body: TutorialChange, request: Request, principal: Player, db: Db
) -> CampaignState:
    """The tutorial's hints on or off, its teaching skipped (which never wins the duel), and the
    lessons seen."""
    campaign = campaign_of(request)
    progress = progress_of(db, principal.user, campaign, lock=True)
    if body.hints is not None:
        progress.hints = body.hints
    if body.skip is not None:
        progress.tutorial_skipped = body.skip
    if body.lessons:
        progress.lessons = sorted({*progress.lessons, *body.lessons})
    progress.updated_at = utcnow()
    db.commit()
    return state_of(db, principal.user, campaign, finale_of(request))
