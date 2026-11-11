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
from collections.abc import Callable
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

from api import kings_table, tables, warden_openings
from api.auth import INPUT_ERRORS
from api.custom_play import custom_in_seats
from api.decks import refresh_decks, store_draft
from api.economy import reward as pay_reward
from api.games import (
    TABLE_IDLE_SECONDS,
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
    GameTable,
    User,
)
from api.progression import winning_seats
from api.roster import load as load_roster
from api.roster import roster_of
from api.schemas import (
    Contract,
    Error,
    GameSummary,
    KingsTableSettings,
    PracticeGameRequest,
    casual,
    default_turn_cap,
)
from api.tables import TableView
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
# How a friend leaves the court (api/games.py LEFT_REASONS): by conceding, or voted out while
# away. A General eliminated in play has not left.
LEFT_THE_COURT = ("conceded", "removed")
# The campaign's games take the game-wide turn limit (v0.9.7, schemas.default_turn_cap): 40 turns
# for each player, so a ward's duel stops after 80 turns and the court's six seats after 240.
# Until v0.9.7 the content named one limit for every game, 60: ten turns each at the court.
DUEL_TURN_CAP = default_turn_cap("commander", 2)
COURT_TURN_CAP = default_turn_cap(kings_table.FORMAT, kings_table.SEATS)
# The handoff's optional post-campaign challenge (v0.9.3): the finale played again once it is won,
# with the tutorial's aids off, for a cosmetic badge of its own. It never replaces the ending.
CHALLENGE_NAME = "Apex Unbound"
CHALLENGE_REWARD = "badge:apex-unbound"
Tier = Literal["bronze", "silver", "gold", "platinum", "mythic", "godlike"]
Outcome = Literal["won", "lost", "draw", "unfinished"]


@dataclass(frozen=True)
class CourtGeneral:
    """One of the court's two Generals B (v0.9.6): a warden recalled by The Sphinx, playing the deck
    he gifted them. Its win gives that deck, as a warden's first defeat gives theirs."""

    seat: int
    opponent: str
    name: str
    deck_title: str
    commander: str
    cards: tuple[tuple[str, int], ...]

    def deck_list(self) -> dict[str, object]:
        return {
            "cards": [{"name": name, "count": count} for name, count in self.cards],
            "commanders": [self.commander],
        }


@dataclass(frozen=True)
class Court:
    """Ward 15, The Unbound Court (v0.9.6): a King's Table game. The player is King A, their two
    Generals friends or bots; team B is The Sphinx as King with his two recalled Generals, every
    one a bot at the encounter's skill."""

    kings_table: dict[str, object]
    player_seat: int
    king_seat: int
    generals: tuple[CourtGeneral, ...]
    # Tokens a friend who helps win the court is paid, once per player and friend, ever.
    helper_tokens: int

    @property
    def ally_seats(self) -> tuple[int, ...]:
        """King A's Generals' seats: the player's friends or bots."""
        return tuple(seat for seat in (0, 1, 2) if seat != self.player_seat)


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
    # Ward 15 (v0.9.6): the court, a King's Table game, instead of a duel.
    court: Court | None = None

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
    training_seed: int
    # Learn Commander's training seven (v0.9.1): the loaner's opening hand, stacked by the engine.
    training_hand: tuple[str, ...]
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

    @property
    def court(self) -> int | None:
        """The court's encounter (v0.9.6), ward 15, or None in content without one."""
        return next((e.number for e in self.encounters if e.court is not None), None)

    @property
    def flight(self) -> int | None:
        """The duel The Sphinx flees (v0.9.6), ward 14: the one before the court, played with it
        as one run. None without a court."""
        court = self.court
        return court - 1 if court is not None else None

    def loaner_list(self, learn: bool = False) -> dict[str, object]:
        """The loaner as a deck list; with learn, its opening hand stacked: the training seven."""
        listed: dict[str, object] = {
            "cards": [{"name": name, "count": count} for name, count in self.loaner_cards],
            "commanders": [self.loaner_commander],
        }
        if learn and self.training_hand:
            listed["opening"] = list(self.training_hand)
        return listed


def cards_of(entries: list[dict[str, Any]]) -> tuple[tuple[str, int], ...]:
    return tuple((str(entry["name"]), int(entry["count"])) for entry in entries)


def court_of(raw: dict[str, Any] | None) -> Court | None:
    if raw is None:
        return None
    return Court(
        kings_table=dict(raw["kings_table"]),
        player_seat=int(raw["player_seat"]),
        king_seat=int(raw["king_seat"]),
        generals=tuple(
            CourtGeneral(
                seat=int(general["seat"]),
                opponent=general["opponent"],
                name=general["name"],
                deck_title=general["deck_title"],
                commander=general["commander"],
                cards=cards_of(general["cards"]),
            )
            for general in raw["generals"]
        ),
        helper_tokens=int(raw.get("helper_tokens", 0)),
    )


def encounter_cards(data: dict[str, Any], encounter: dict[str, Any]) -> tuple[tuple[str, int], ...]:
    """An encounter's 99, or since v0.9.6 another's (cards_from): The Sphinx keeps his deck."""
    source = encounter.get("cards_from")
    if source is not None:
        encounter = next(found for found in data["encounters"] if found["number"] == source)
    return cards_of(encounter["cards"])


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
        training_seed=int(data["training_seed"]),
        training_hand=tuple(str(name) for name in data.get("training_hand", [])),
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
                cards=encounter_cards(data, encounter),
                fallback_commander=encounter.get("fallback_commander"),
                private=encounter.get("private"),
                tokens=int(encounter.get("tokens", 0)),
                private_commander_title=encounter.get("private_commander_title"),
                court=court_of(encounter.get("court")),
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


class SpoilsDeck(Contract):
    title: str
    commander: str
    opponent: str = Field(description="Whose deck it is: their roster ID, naming their portrait.")


class EncounterSpoils(Contract):
    tokens: int = Field(description="Tokens the first win pays.")
    deck: str = Field(description="The title of the deck the first win gives (the first of them).")
    commander: str = Field(
        description="That deck's commander; for the private finale's, what the story calls it."
    )
    decks: list[SpoilsDeck] = Field(
        description="Every deck the first win gives: one for a warden, two at the court (v0.9.6)."
    )
    earned: bool


class CourtSeat(Contract):
    seat: int
    opponent: str = Field(description="The roster ID naming their portrait.")
    name: str
    role: Literal["king", "general"]
    commander: str | None = Field(description="Null for The Sphinx's, the owner's own.")


class CourtView(Contract):
    """Ward 15, The Unbound Court (v0.9.6): a King's Table game against The Sphinx's court."""

    player_seat: int = Field(description="Your seat: King A's.")
    ally_seats: list[int] = Field(description="Your Generals' seats: friends or bots.")
    opponents: list[CourtSeat] = Field(description="Team B: The Sphinx as King, two Generals.")
    helper_tokens: int = Field(description="What a friend who helps win it is paid, once.")
    kings_table: KingsTableSettings = Field(
        description="The court's King's Table settings, as its game plays them (v0.9.7): the "
        "house rule with its guard, so a King attacks any opposing General, and the other King "
        "once one of that King's Generals is defeated."
    )
    turn_cap: int = Field(
        description="The court's turn limit (v0.9.7): 40 turns for each of its six players."
    )


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
    status: Literal["locked", "open", "won", "fled"] = Field(
        description="Since v0.9.6 ward 14 is fled once The Sphinx fled it in this run, until the "
        "court is won (then won) or lost (then open again)."
    )
    spoils: EncounterSpoils = Field(
        description="What the first win gives: the warden's deck and tokens."
    )
    court: CourtView | None = Field(
        default=None, description="Ward 15 (v0.9.6): the court's seats; null for a duel."
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


class CampaignChallenge(Contract):
    """The Apex Unbound challenge (v0.9.3)."""

    name: str
    open: bool = Field(description="The finale is won: the challenge may be taken.")
    earned: bool = Field(description="Its badge is yours.")
    at: int = Field(
        description="The encounter the challenge stands at: since v0.9.6 wards 14 and 15 as one "
        "run, so 15 once The Sphinx fled 14 in it."
    )


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
    challenge: CampaignChallenge


class StartEncounter(Contract):
    deck_id: UUID | None = Field(default=None, description="One of your Commander decks.")
    loaner: bool = Field(default=False, description="The campaign's loaner deck instead.")
    learn: bool = Field(
        default=False,
        description="Learn Commander: the loaner deck with the training seed and the hints.",
    )
    challenge: bool = Field(
        default=False,
        description="The Apex Unbound challenge (v0.9.3): the finale again, once it is won, for "
        "its badge alone.",
    )


class CourtStart(Contract):
    """Ward 15 with friends as your Generals (v0.9.6): a private King's Table table the campaign
    opens, you as King A with one of your Commander decks."""

    deck_id: UUID = Field(description="One of your Commander decks.")
    friends: list[UUID] = Field(
        min_length=1, max_length=2, description="One or two friends, invited as your Generals."
    )
    challenge: bool = Field(default=False, description="Apex Unbound's court (v0.9.6).")


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
        progress.fled_at = None
        progress.challenge_fled_at = None
        progress.started_at = now
        progress.updated_at = now
    return progress


def unlocked(progress: CampaignProgress, campaign: Campaign) -> int:
    """The furthest encounter open: since v0.9.6 the court too for an account that won ward 14
    before it existed (it opens directly, the one exception to the run), or whose Sphinx fled."""
    highest = progress.highest_unlocked
    court, flight = campaign.court, campaign.flight
    if court is not None and (flight in progress.completed or progress.fled_at is not None):
        highest = max(highest, court)
    return min(highest, campaign.last)


def challenge_at(progress: CampaignProgress, campaign: Campaign) -> int:
    """Where Apex Unbound stands: the court once The Sphinx fled ward 14 in the challenge's run,
    else the duel (ward 14; the last encounter in content without a court)."""
    if campaign.court is not None and campaign.flight is not None:
        return campaign.court if progress.challenge_fled_at is not None else campaign.flight
    return campaign.last


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


def spoils_decks(encounter: Encounter, finale: "FinaleCache | None") -> list[SpoilsDeck]:
    """The decks a first win gives: the warden's, or at the court (v0.9.6) the two gifted ones."""
    if encounter.court is not None:
        return [
            SpoilsDeck(
                title=general.deck_title, commander=general.commander, opponent=general.opponent
            )
            for general in encounter.court.generals
        ]
    return [
        SpoilsDeck(
            title=encounter.deck_title,
            commander=spoils_commander(encounter, finale),
            opponent=encounter.opponent,
        )
    ]


def court_view(encounter: Encounter) -> CourtView | None:
    court = encounter.court
    if court is None:
        return None
    seats = [
        CourtSeat(
            seat=court.king_seat,
            opponent=encounter.opponent,
            name=encounter.name,
            role="king",
            commander=encounter.commander,
        ),
        *(
            CourtSeat(
                seat=general.seat,
                opponent=general.opponent,
                name=general.name,
                role="general",
                commander=general.commander,
            )
            for general in court.generals
        ),
    ]
    return CourtView(
        player_seat=court.player_seat,
        ally_seats=list(court.ally_seats),
        opponents=sorted(seats, key=lambda seat: seat.seat),
        helper_tokens=court.helper_tokens,
        kings_table=kings_table.config_of(court.kings_table),
        turn_cap=COURT_TURN_CAP,
    )


def status_of(encounter: Encounter, progress: CampaignProgress, campaign: Campaign) -> str:
    if encounter.number in progress.completed:
        return "won"
    if encounter.number == campaign.flight and progress.fled_at is not None:
        return "fled"
    return "open" if encounter.number <= unlocked(progress, campaign) else "locked"


def state_of(
    db: Session, user: User, campaign: Campaign, finale: "FinaleCache | None" = None
) -> CampaignState:
    progress = progress_of(db, user, campaign)
    db.commit()
    done = set(progress.completed)
    rewards = earned(db, user.id, campaign, progress)
    encounters: list[CampaignEncounter] = []
    for encounter in campaign.encounters:
        decks = spoils_decks(encounter, finale)
        encounters.append(
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
                status=status_of(encounter, progress, campaign),  # type: ignore[arg-type]
                spoils=EncounterSpoils(
                    tokens=encounter.tokens,
                    deck=decks[0].title,
                    commander=decks[0].commander,
                    decks=decks,
                    earned=f"spoils:{encounter.number:02d}" in rewards,
                ),
                court=court_view(encounter),
            )
        )
    return CampaignState(
        id=campaign.id,
        title=campaign.title,
        content_version=campaign.content_version,
        loaner=campaign.loaner_title,
        loaner_commander=campaign.loaner_commander,
        encounters=encounters,
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
            highest_unlocked=unlocked(progress, campaign),
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
        challenge=CampaignChallenge(
            name=CHALLENGE_NAME,
            open=campaign.last in done,
            earned=CHALLENGE_REWARD in rewards,
            at=challenge_at(progress, campaign),
        ),
    )


# A duel's end.


def outcome_of(game: Game, seat: int = 0) -> Outcome:
    """The campaign's word for how the game ended, for the player's seat (seat 0 in a duel, King
    A's at the court, v0.9.6). Only a completed game the player's side won is a win; a turn limit,
    a closed or idle game and an engine error are unfinished."""
    result = game.result or {}
    if game.status != "finished" or result.get("kind") != "completed":
        return "unfinished"
    if result.get("draw"):
        return "draw"
    return "won" if seat in winning_seats(result) else "lost"


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
    win without passive bots gives them as a first win would.

    Since v0.9.6 wards 14 and 15 are one run. The Sphinx flees ward 14 at the moment he would lose
    it: the win records the flight (fled_at) and opens the court, and pays nothing yet. Winning the
    court then wins both: ward 14's seal, spoils and chapter, and ward 15's, with the friends who
    helped paid once each. Losing the court (or a draw) ends the run: the player is back at ward
    14. An account that won ward 14 before the court existed plays the court alone: nothing sends
    it back. Apex Unbound runs the same way, for its badge alone."""
    outcome = outcome_of(game, link.seat)
    link.outcome = outcome
    link.finished_at = utcnow()
    if outcome == "unfinished" or campaign is None or link.campaign_id != campaign.id:
        return
    user = db.get_one(User, link.user_id)
    progress = progress_of(db, user, campaign, lock=True)
    if progress.started_at > link.created_at:
        # The account was reset after the duel began: it belongs to the old progress.
        return
    number = link.encounter
    court, flight = campaign.court, campaign.flight
    if outcome != "won":
        if court is not None and number == court:
            # The court lost: the run ends, and the player is back at ward 14.
            if link.challenge:
                progress.challenge_fled_at = None
            elif flight is not None and flight not in progress.completed:
                progress.fled_at = None
                progress.highest_unlocked = min(progress.highest_unlocked, flight)
            progress.updated_at = utcnow()
        return
    if link.challenge:
        if court is not None and number == flight:
            # Apex Unbound's Sphinx flees too: the challenge goes on at the court.
            progress.challenge_fled_at = utcnow()
            progress.updated_at = utcnow()
            return
        # Apex Unbound (v0.9.3): its badge, once, and nothing else; never with passive bots.
        if payouts:
            reward(db, user.id, campaign, progress, CHALLENGE_REWARD, game.id)
        progress.challenge_fled_at = None
        progress.updated_at = utcnow()
        return
    if court is not None and flight is not None and number == flight:
        if flight not in progress.completed:
            # The Sphinx flees (v0.9.6): the court opens, and the run pays when it is won.
            progress.fled_at = utcnow()
            progress.highest_unlocked = max(progress.highest_unlocked, court)
            progress.content_version = campaign.content_version
            progress.updated_at = utcnow()
        return
    won = [number]
    paying = [number]
    if court is not None and flight is not None and number == court:
        # The court won: ward 14 too, when the run began there.
        if flight not in progress.completed:
            won = [flight, number]
        # Ward 14's spoils and chapter are the court's to give, whenever they are still owed
        # (v0.9.7): a court first won without payouts (passive bots), or before the finale's
        # commander had its custom card, records ward 14 as won and gives none of them, and ward
        # 14 played again gives nothing. Each is keyed, so a court won again pays nothing twice.
        paying = [flight, number]
        progress.fled_at = None
    for each in won:
        if each not in progress.completed:
            progress.completed = sorted({*progress.completed, each})
        reward(db, user.id, campaign, progress, f"seal:{each:02d}", game.id)
    progress.highest_unlocked = max(progress.highest_unlocked, min(number + 1, campaign.last))
    progress.content_version = campaign.content_version
    progress.updated_at = utcnow()
    if not payouts:
        return
    for each in paying:
        encounter = campaign.encounter(each)
        if encounter.court is not None:
            if reward(db, user.id, campaign, progress, f"spoils:{each:02d}", game.id):
                give_court_spoils(db, user, campaign, progress, encounter, content_dir, game)
            pay_helpers(db, game, link, encounter, campaign)
        else:
            win_spoils(db, game, link, user, campaign, progress, encounter, content_dir)
    done = set(progress.completed)
    for chapter in campaign.chapters:
        if any(each in chapter.encounters for each in paying) and all(
            n in done for n in chapter.encounters
        ):
            for id_, _ in chapter.rewards:
                reward(db, user.id, campaign, progress, id_, game.id)


def win_spoils(
    db: Session,
    game: Game,
    link: CampaignGame,
    user: User,
    campaign: Campaign,
    progress: CampaignProgress,
    encounter: Encounter,
    content_dir: str | None,
) -> None:
    """A warden's spoils for a first win, once. The Sphinx's (ward 14) from the court's game since
    v0.9.6: his deck as the court served it, his commander as the finale's."""
    number = encounter.number
    if f"spoils:{number:02d}" in earned(db, user.id, campaign, progress):
        # Given already (a court won again, or ward 14 won before the court existed).
        return
    court = campaign.encounter(campaign.court).court if campaign.court is not None else None
    seat = court.king_seat if court is not None and link.encounter == campaign.court else None
    served = served_list(db, game, seat)
    prize_card = link.prize_card
    ready = True
    if link.finale == "private" and encounter.private:
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
            encounter,
            content_dir,
            prize_card,
            served,
            game.id,
        )


def give_court_spoils(
    db: Session,
    user: User,
    campaign: Campaign,
    progress: CampaignProgress,
    encounter: Encounter,
    content_dir: str | None,
    game: Game,
) -> None:
    """The court's spoils (v0.9.6): the two gifted decks, each as the court served it, each with
    its own opening, and the ward's tokens."""
    court = encounter.court
    assert court is not None
    library: Any = None
    number = f"{encounter.number:02d}"
    for general in court.generals:
        served = served_list(db, game, general.seat)
        commander = served_commander(served) or general.commander
        entries = deck_entries(
            db, encounter.number, None, commander, served_cards(served) or general.cards
        )
        library = give_deck(
            db,
            user,
            campaign,
            f"campaign:{campaign.id}:{number}:{epoch(progress)}:{general.opponent}",
            encounter,
            general.opponent,
            general.name,
            general.deck_title,
            f"Gifted to {general.name} by The Sphinx; won in the campaign: {encounter.title}.",
            entries,
            content_dir,
            game.id,
        )
    if library is not None:
        refresh_decks(db, user.id, library)
    pay_tokens(db, user, campaign, progress, encounter)


def pay_helpers(
    db: Session, game: Game, link: CampaignGame, encounter: Encounter, campaign: Campaign
) -> None:
    """The friends who helped win the court (v0.9.6): each player seated with the winner who did
    not leave and is their friend is paid once, ever, per player and friend, whatever later wins
    or resets: the key names only the two accounts. A friend who conceded or was voted out left.
    One the court eliminated in play did not (v0.9.7): at King's Table a team wins together, a
    General out before the end too, as the results and the pay of any other table have it."""
    court = encounter.court
    if court is None or court.helper_tokens <= 0:
        return
    # Imported here: api.tables imports api.games, which imports this module late.
    from api.tables import friends_of

    friends = friends_of(db, link.user_id)
    host = db.get(User, link.user_id)
    for row in db.scalars(
        select(GameSeat).where(GameSeat.game_id == game.id, GameSeat.user_id.is_not(None))
    ):
        helper = row.user_id
        if helper is None or helper == link.user_id or row.left_reason in LEFT_THE_COURT:
            continue
        if helper not in friends:
            continue
        pay_reward(
            db,
            helper,
            "campaign",
            court.helper_tokens,
            f"campaign-helper:{campaign.id}:{link.user_id}:{helper}",
            f"Helped {host.handle if host and host.handle else 'a friend'} win {encounter.title}",
            SPOILS_POLICY,
        )


def served_list(db: Session, game: Game, seat: int | None = None) -> dict[str, Any] | None:
    """The opponent's deck list as the duel served it to the engine (the bot seat's); at the court
    (v0.9.6) the given seat's."""
    query = select(GameSeat.deck_list).where(GameSeat.game_id == game.id, GameSeat.player == "bot")
    if seat is not None:
        query = query.where(GameSeat.seat == seat)
    found = db.scalar(query.order_by(GameSeat.seat).limit(1))
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
    commander = encounter.prize_commander
    if not encounter.private:
        commander = served_commander(served) or commander
    return deck_entries(
        db, encounter.number, custom_commander, commander, served_cards(served) or encounter.cards
    )


def deck_entries(
    db: Session,
    number: int,
    custom_commander: UUID | None,
    commander: str,
    cards: tuple[tuple[str, int], ...],
) -> list[DeckEntry]:
    """A won deck as entries: its commander first (a custom card when given), then each card the
    catalog has, in its default edition; a card it lacks is named in the log."""
    entries: list[DeckEntry] = []
    wanted: list[tuple[str, int, str]] = []
    if custom_commander is not None:
        entries.append(
            DeckEntry(card_id=custom_commander, printing_id=None, quantity=1, location="commander")
        )
    else:
        wanted.append((commander, 1, "commander"))
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
    missing: list[str] = []
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
        else:
            missing.append(name)
    if missing:
        # Every warden's deck is won whole (the owner, 2026-11-09): a card the catalog no longer
        # resolves is the one thing that can shorten it, so it is named, never dropped quietly.
        log.warning(
            "Campaign spoils for encounter %d: %d card(s) not in the catalog: %s",
            number,
            len(missing),
            ", ".join(sorted(missing)),
        )
    return entries


def library_for(db: Session, user: User, content_dir: str | None) -> Any:
    return (
        library_of(db, user, permissions_for(user, roles_of(db, user)), load_roster(content_dir))
        if content_dir
        else None
    )


def give_spoils(
    db: Session,
    user: User,
    campaign: Campaign,
    progress: CampaignProgress,
    encounter: Encounter,
    content_dir: str | None,
    prize_card: UUID | None = None,
    served: dict[str, Any] | None = None,
    game_id: UUID | None = None,
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
    library = give_deck(
        db,
        user,
        campaign,
        key,
        encounter,
        encounter.opponent,
        encounter.name,
        encounter.deck_title,
        f"Won from {encounter.name} in the campaign: {encounter.title}.",
        entries,
        content_dir,
        game_id,
        custom,
    )
    if library is not None:
        refresh_decks(db, user.id, library)
    pay_tokens(db, user, campaign, progress, encounter)


def give_deck(
    db: Session,
    user: User,
    campaign: Campaign,
    key: str,
    encounter: Encounter,
    opponent: str,
    name: str,
    title: str,
    notes: str,
    entries: list[DeckEntry],
    content_dir: str | None,
    game_id: UUID | None,
    custom: UUID | None = None,
) -> Any:
    """One won deck: its cards granted for good under the key, a custom commander with them, the
    deck among the player's own, and its opening waiting (v0.9.5). Returns the player's library
    as it stands with them, to refresh their decks by."""
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
    library = library_for(db, user, content_dir)
    stamp = utcnow()
    deck = Deck(
        owner_id=user.id,
        title=title,
        format="commander",
        visibility="private",
        notes=notes,
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
    # The deck waits to be opened as a pack (v0.9.5), under the spoils' own key.
    warden_openings.record(
        db,
        user,
        key,
        campaign.id,
        encounter.number,
        opponent,
        name,
        title,
        deck.id,
        game_id,
        entries,
    )
    return library


def pay_tokens(
    db: Session,
    user: User,
    campaign: Campaign,
    progress: CampaignProgress,
    encounter: Encounter,
) -> None:
    if encounter.tokens > 0:
        number = f"{encounter.number:02d}"
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
    incarnation, cast at its threshold; at the court since v0.9.6 on the battlefield from the
    start and back at each of his upkeeps) and its deck if it names one; without, the public deck
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
        deck_list["reserve"] = (
            [{"name": reserve["card"], "mode": "court"}]
            if encounter.court is not None
            else [{"name": reserve["card"], "threshold": int(reserve.get("threshold", 15))}]
        )
    return deck_list, "private"


def court_seats(
    encounter: Encounter,
    sphinx: dict[str, object],
    players: dict[int, SeatPlan],
    allies: dict[int, SeatPlan],
) -> list[SeatPlan]:
    """The court's six seats in King's Table order (v0.9.6): the players' (the King's and any
    friends'), the player's bot Generals, and team B, each of its three a named bot with its own
    deck: The Sphinx's (finale_seat) as King, and the two he gifted."""
    court = encounter.court
    assert court is not None
    generals = {general.seat: general for general in court.generals}
    plans: list[SeatPlan] = []
    for seat in range(kings_table.SEATS):
        if seat in players:
            plans.append(players[seat])
        elif seat == court.king_seat:
            plans.append(
                SeatPlan(
                    {"player": "bot", "deck_list": sphinx},
                    title=f"{encounter.name}'s deck",
                    starter=True,
                )
            )
        elif seat in generals:
            general = generals[seat]
            plans.append(
                SeatPlan(
                    {"player": "bot", "deck_list": general.deck_list()},
                    title=general.deck_title,
                    starter=True,
                )
            )
        else:
            plans.append(allies.get(seat) or SeatPlan({"player": "bot"}))
    return plans


def court_opponents(encounter: Encounter) -> dict[str, list[str]]:
    """The court's named bot seats, for the game's summary: {seat: [name, roster ID]}."""
    court = encounter.court
    assert court is not None
    named = {str(court.king_seat): [encounter.name, encounter.opponent]}
    for general in court.generals:
        named[str(general.seat)] = [general.name, general.opponent]
    return named


def court_body(
    campaign: Campaign, encounter: Encounter, plans: list[SeatPlan], idle: int | None = None
) -> dict[str, object]:
    court = encounter.court
    assert court is not None
    body: dict[str, object] = {
        "format": kings_table.FORMAT,
        "seats": [plan.engine for plan in plans],
        "skill": encounter.skill,
        "turn_cap": COURT_TURN_CAP,
        "kings_table": kings_table.engine_settings(kings_table.config_of(court.kings_table)),
    }
    if idle is not None:
        body["idle_timeout_seconds"] = idle
    return body


async def court_finale(
    request: Request, engine: EngineClient, encounter: Encounter, db: Session
) -> tuple[dict[str, object], str, UUID | None]:
    """The Sphinx's seat at the court, whether the owner's finale ran, and its prize card."""
    deck_list, finale = finale_seat(encounter, await finale_content(request, engine))
    prize_card: UUID | None = None
    if finale == "private":
        commanders = cast(list[str], deck_list["commanders"])
        prize_card = await run_in_threadpool(prize_card_named, db, commanders[0])
    return deck_list, finale, prize_card


def check_start(
    progress: CampaignProgress, campaign: Campaign, number: int, challenge: bool
) -> None:
    """Whether the encounter may start: open, and for Apex Unbound where its run stands."""
    if number > unlocked(progress, campaign):
        raise ApiError(409, "encounter_locked", "Win the encounter before this one to open it.")
    if challenge:
        if campaign.last not in progress.completed:
            raise ApiError(
                409, "challenge_locked", f"Win the finale before you take on {CHALLENGE_NAME}."
            )
        if number != challenge_at(progress, campaign):
            raise ApiError(
                409,
                "challenge_locked",
                f"{CHALLENGE_NAME} stands at encounter {challenge_at(progress, campaign)}.",
            )


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
    again, for no new reward. Since v0.9.6 ward 15, the court, starts here with bots as your two
    Generals: a King's Table game, you as King A (with friends instead: the court route)."""
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
    finals = {campaign.last, campaign.flight} - {None}
    if body.challenge and number not in finals:
        raise ApiError(422, "invalid_seat", f"{CHALLENGE_NAME} is the final encounters' challenge.")

    def plan() -> tuple[SeatPlan, CampaignProgress]:
        progress = progress_of(db, user, campaign)
        try:
            check_start(progress, campaign, number, body.challenge)
        except ApiError:
            db.commit()
            raise
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
                {"player": "human", "deck_list": campaign.loaner_list(learn=body.learn)},
                title=campaign.loaner_title,
                starter=True,
            )
        db.commit()
        return planned, progress

    human, progress = await run_in_threadpool(plan)
    await require_loaded(request, [human])
    finale: str | None = None
    prize_card: UUID | None = None
    court = encounter.court
    mine = court.player_seat if court is not None else 0
    opponents: dict[str, list[str]] | None = None
    if court is not None:
        sphinx, finale, prize_card = await court_finale(request, engine, encounter, db)
        plans = court_seats(encounter, sphinx, {mine: human}, {})
        opponents = court_opponents(encounter)
        engine_body = court_body(campaign, encounter, plans)
    else:
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
        plans = [human, bot]
        engine_body = {
            "format": "commander",
            "seats": [human.engine, bot.engine],
            "skill": encounter.skill,
            "turn_cap": DUEL_TURN_CAP,
        }
    hints = (
        (body.learn or (number == 1 and progress.hints))
        and not progress.tutorial_skipped
        and not body.challenge
    )
    request_body = PracticeGameRequest(
        format="kings_table" if court is not None else "commander",
        deck_id=body.deck_id,
        bot_skill=encounter.skill,
        turn_cap=COURT_TURN_CAP if court is not None else DUEL_TURN_CAP,
        seat=mine if court is not None else None,
        kings_table=(kings_table.config_of(court.kings_table) if court is not None else None),
    )
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
                game = record_game(db, request, principal, created, request_body, plans)
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
                        challenge=body.challenge,
                        seat=mine,
                        opponents=opponents,
                        created_at=utcnow(),
                    )
                )
                db.commit()
                return game

            async with followed_or_closed(hub, created, db):
                game = await run_in_threadpool(record)
                token = seat_tokens(created)[mine]
                hub.register(
                    LiveGame(
                        id=game.id,
                        seats={mine: LiveSeat(mine, user_id, token)},
                        kings=court is not None,
                    )
                )
        finally:
            hub.starting -= 1
        return await run_in_threadpool(summary_of, db, game, principal, campaign)


@router.post(
    "/campaign/encounters/{number}/court",
    response_model=TableView,
    status_code=201,
    responses={409: {"model": Error}},
)
def open_court(
    number: int, body: CourtStart, request: Request, principal: Player, db: Db
) -> TableView:
    """Ward 15 with friends as your Generals (v0.9.6): opens a private King's Table table for the
    court, you seated as King A with one of your Commander decks, and invites the friends named.
    Team B's three seats are the court's bots; your Generals' seats wait for the friends, and
    those not taken when you start are played by bots. The table starts as any other, from its
    page; its game is the campaign's, and its end is read as the court's."""
    campaign = campaign_of(request)
    encounter = campaign.encounter(number)
    court = encounter.court
    if court is None:
        raise ApiError(422, "invalid_seat", "Only the court is played with friends.")
    if not principal.can("decks.edit"):
        raise ApiError(403, "forbidden", "Your account cannot play its own decks.")
    if len(set(body.friends)) != len(body.friends):
        raise ApiError(422, "invalid_seat", "Name each friend once.")
    user = principal.user
    progress = progress_of(db, user, campaign)
    try:
        check_start(progress, campaign, number, body.challenge)
    except ApiError:
        db.commit()
        raise
    return tables.open_campaign_table(
        db,
        request,
        principal,
        body.deck_id,
        body.friends,
        {
            "campaign_id": campaign.id,
            "encounter": number,
            "user_id": str(user.id),
            "challenge": body.challenge,
            "title": encounter.title,
            "opponents": court_opponents(encounter),
        },
        court.player_seat,
        [
            seat
            for seat in range(kings_table.SEATS)
            if seat != court.player_seat and seat not in court.ally_seats[: len(body.friends)]
        ],
        court.kings_table,
        encounter.skill,
        COURT_TURN_CAP,
    )


async def court_table(
    request: Request,
    engine: EngineClient,
    db: Session,
    table: GameTable,
    plans: list[SeatPlan],
    users: list[UUID | None],
) -> tuple[list[SeatPlan], dict[str, object], Callable[[Session, Game], None]]:
    """The start of a court the campaign opened as a table (v0.9.6, api/tables.py): the encounter
    still open to its host, team B's seats served the court's decks (The Sphinx's with the
    owner's finale when the engine has it), and the link that makes the game the campaign's."""
    info = table.campaign or {}
    campaign = campaign_of(request)
    if info.get("campaign_id") != campaign.id:
        raise ApiError(409, "table_closed", "This court belongs to another campaign.")
    number = int(str(info.get("encounter")))
    encounter = campaign.encounter(number)
    court = encounter.court
    if court is None:
        raise ApiError(409, "table_closed", "This table is no longer the campaign's.")
    host = db.get_one(User, table.host_id)
    challenge = bool(info.get("challenge"))

    def check() -> None:
        progress = progress_of(db, host, campaign)
        try:
            check_start(progress, campaign, number, challenge)
        finally:
            db.commit()

    await run_in_threadpool(check)
    sphinx, finale, prize_card = await court_finale(request, engine, encounter, db)
    players = {seat: plan for seat, plan in enumerate(plans) if users[seat] is not None}
    allies = {seat: plans[seat] for seat in court.ally_seats if users[seat] is None}
    seated = court_seats(encounter, sphinx, players, allies)
    body = court_body(campaign, encounter, seated, TABLE_IDLE_SECONDS)
    opponents = court_opponents(encounter)
    host_id = table.host_id

    def link(session: Session, game: Game) -> None:
        session.add(
            CampaignGame(
                game_id=game.id,
                user_id=host_id,
                campaign_id=campaign.id,
                encounter=number,
                opponent=encounter.opponent,
                opponent_name=encounter.name,
                title=encounter.title,
                deck="own",
                hints=False,
                finale=finale,
                prize_card=prize_card,
                challenge=challenge,
                seat=court.player_seat,
                opponents=opponents,
                created_at=utcnow(),
            )
        )
        session.flush()

    return seated, body, link


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
