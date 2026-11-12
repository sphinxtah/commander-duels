"""SysOp's grants for testing (v0.8.8): wins by format, cards and campaign progress, on any account,
its own included. Tokens, packs and an account's total wins were SysOp's grants already
(api/economy.py, api/shop.py, api/progression.py); since v0.8.8 SysOp's own account is listed in
Administration (api/admin.py) so it gives them to itself there too.

- **Wins by format.** Granted results: rows of the results ledger (api/stats.py) with no game,
  marked with SysOp as their granter. They count towards the day's quests and the achievements
  (both checked at once, as after a game won, and paid as they would be), and the account's wins
  rise by as many, as a setting of wins (kept apart from wins counted from games). The profile's
  statistics and the match history leave them out, as they leave nothing else out: they are
  played games' records. No tokens are paid for the wins themselves.
- **Cards.** Copies of one edition and finish granted into the library for good (source grant,
  key grant:<id>), as a pack's are: they may be sold at the auction house. SysOp's own library is
  the whole catalog, so a grant to itself only gives it copies to list.
- **Campaign progress.** The encounters won through a number, with their seals, the next one open
  and the chapters' card backs and titles, as winning them would give, but never their spoils
  (decks and tokens), as with SysOp's passive bots (v0.8.6). A number below what the account has
  won starts its progress again first, a new epoch, so 0 starts the campaign over.

Every grant names its reason and is audited. Only SysOp grants (progress.manage); another root
account is never a target.
"""

from datetime import timedelta
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from api import campaign as campaigns
from api import kings_table, teams
from api.achievements import catch_up
from api.auth import INPUT_ERRORS
from api.decks import refresh_decks
from api.economy import lock_account, target
from api.identity import (
    ApiError,
    Db,
    Principal,
    audit,
    not_found,
    permissions_for,
    refuse_deleted,
    require_permission,
    roles_of,
    settings_of,
    utcnow,
)
from api.library import ONE_OF_A_KIND, default_printings, library_of
from api.models import (
    CampaignProgress,
    CardConcept,
    CardPrinting,
    LibraryGrant,
    PlayerResult,
    ProgressEntry,
    User,
)
from api.print_runs import left_of
from api.progression import POLICY as WINS_POLICY
from api.progression import Progress, progress_of, total_wins
from api.quests import count_game
from api.roster import roster_of
from api.schemas import Contract, StoredText
from api.stats import OUTCOME_POLICY
from catalog.statuses import in_game

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

Tester = Annotated[Principal, Depends(require_permission("progress.manage"))]
Reason = Annotated[StoredText, Field(min_length=3, max_length=200)]
GrantFormat = Literal["commander", "legacy", "two_headed_giant", "kings_table"]
MAX_RESULTS = 100
MAX_COPIES = 99
# How a granted result names its kind of game.
KIND = "granted"


class ResultsGrant(Contract):
    format: GrantFormat
    count: int = Field(ge=1, le=MAX_RESULTS, description="Wins to grant.")
    colors: Annotated[str, Field(pattern=r"^W?U?B?R?G?$")] = Field(
        default="",
        description="The deck's colours, WUBRG letters in that order; empty for colorless.",
    )
    against: Literal["bots", "players"] = "bots"
    bot_skill: int = Field(default=4, ge=1, le=6, description="The bots' skill, against bots.")
    seats: int | None = Field(
        default=None,
        ge=2,
        le=4,
        description="A Commander table's seats, 2 to 4 (v0.9.7), so a quest for a four-player "
        "game can be tested; the other formats' tables have one size, and take none.",
    )
    reason: Reason


class ResultsGranted(Contract):
    granted: int
    progress: Progress
    quest_tokens: int = Field(description="Tokens the day's quests paid for these wins.")
    achievement_tokens: int = Field(description="Tokens the achievements earned paid.")


class CardsGrant(Contract):
    card_id: UUID
    printing_id: UUID | None = Field(
        default=None, description="The edition; without one, the card's default printing."
    )
    quantity: int = Field(ge=1, le=MAX_COPIES)
    finish: Literal["nonfoil", "foil", "etched"] = "nonfoil"
    reason: Reason


class CardsGranted(Contract):
    card_id: UUID
    printing_id: UUID
    name: str
    quantity: int
    finish: str


class CampaignGrant(Contract):
    won_through: int = Field(
        ge=0, le=99, description="Encounters won, 1 through this; 0 starts the campaign over."
    )
    reason: Reason


class CampaignGranted(Contract):
    highest_unlocked: int
    completed: list[int]
    rewards: list[str] = Field(description="The seals, card backs and titles the account holds.")


# Wins by format.


def table_size(fmt: str) -> int:
    if fmt == kings_table.FORMAT:
        return 6
    if fmt == teams.FORMAT:
        return 4
    return 2


def grant_results(db: Session, user: User, body: ResultsGrant, actor: User) -> tuple[int, int]:
    """Writes the granted results and the wins, then settles the day's quests and the
    achievements as a game won would. Returns the tokens the quests and achievements paid."""
    lock_account(db, user.id)
    now = utcnow()
    seats = table_size(body.format)
    if body.seats is not None and body.seats != seats:
        if body.format != "commander":
            raise ApiError(
                422, "invalid_seats", f"A {body.format} table has {seats} seats, never another."
            )
        seats = body.seats
    # A team format's opponents are the other team; otherwise every other seat.
    opponents = seats // 2 if body.format in (teams.FORMAT, kings_table.FORMAT) else seats - 1
    for index in range(body.count):
        # Each a microsecond apart, so the history's order (were they shown) stays stable.
        finished = now + timedelta(microseconds=index)
        db.add(
            PlayerResult(
                game_id=None,
                granted_by=actor.id,
                seat=0,
                user_id=user.id,
                outcome="win",
                format=body.format,
                kind=KIND,
                seats=seats,
                players=opponents if body.against == "players" else 0,
                bots=opponents if body.against == "bots" else 0,
                bot_skill=body.bot_skill if body.against == "bots" else None,
                colors=body.colors,
                turns=None,
                started_at=finished,
                finished_at=finished,
                policy=OUTCOME_POLICY,
                mode="testing",
            )
        )
    db.add(
        ProgressEntry(
            user_id=user.id,
            kind="wins_set",
            wins=body.count,
            key=f"set:{uuid4()}",
            policy=WINS_POLICY,
            reason=body.reason,
            actor_id=actor.id,
            created_at=now,
        )
    )
    db.flush()
    quests = count_game(db, user, now)
    achievements = catch_up(db, user, utcnow())
    return quests, achievements


@router.post("/admin/users/{user_id}/results", response_model=ResultsGranted, status_code=201)
def give_results(
    user_id: UUID, body: ResultsGrant, request: Request, principal: Tester, db: Db
) -> ResultsGranted:
    """SysOp grants wins in a format, for testing quests, achievements and tiers: results with no
    game, counted by quests and achievements but never by statistics, and as many wins. Audited."""
    user = target(db, user_id, principal)
    refuse_deleted(user)
    before = total_wins(db, user.id)
    quests, achievements = grant_results(db, user, body, principal.user)
    audit(
        db,
        request,
        "testing.results_granted",
        actor_id=principal.user.id,
        target_user_id=user.id,
        details={
            "format": body.format,
            "count": body.count,
            "colors": body.colors,
            "against": body.against,
            "bot_skill": body.bot_skill if body.against == "bots" else None,
            "seats": body.seats,
            "wins_from": before,
            "wins_to": before + body.count,
            "reason": body.reason,
        },
    )
    db.commit()
    return ResultsGranted(
        granted=body.count,
        progress=progress_of(db, user),
        quest_tokens=quests,
        achievement_tokens=achievements,
    )


# Cards.


@router.post("/admin/users/{user_id}/cards", response_model=CardsGranted, status_code=201)
def give_cards(
    user_id: UUID, body: CardsGrant, request: Request, principal: Tester, db: Db
) -> CardsGranted:
    """SysOp grants copies of a card in the game into an account's library for good, in one
    edition and finish: with a reason, audited."""
    user = target(db, user_id, principal)
    refuse_deleted(user)
    concept = db.scalar(select(CardConcept).where(CardConcept.id == body.card_id, in_game()))
    if concept is None:
        raise not_found()
    printing_id = body.printing_id or default_printings(db, {concept.id}).get(concept.id)
    printing = db.get(CardPrinting, printing_id) if printing_id else None
    if printing is None or printing.concept_id != concept.id:
        raise ApiError(422, "invalid_printing", "That edition is not one of this card's.")
    # A one-of-a-kind printing (The One Ring 001/001) is never granted, not even to SysOp: its one
    # copy is its owner's (v0.9.1; api/library.py ONE_OF_A_KIND).
    if printing.scryfall_id in ONE_OF_A_KIND:
        raise ApiError(
            409, "one_of_a_kind", "This edition is one of a kind: its only copy is already owned."
        )
    finishes = list(printing.finishes or ["nonfoil"])
    if body.finish not in finishes:
        raise ApiError(
            422, "invalid_finish", f"This edition comes {', '.join(finishes)}, not {body.finish}."
        )
    # A limited printing's copies come out of its print run (v0.8.9): a grant past what is left
    # is refused, except to SysOp, whose copies are not counted (api/print_runs.py).
    if user.kind != "sysop":
        left = left_of(db, settings_of(request).content_dir, printing.id, lock=True)
        if left is not None and body.quantity > left:
            raise ApiError(
                409,
                "print_run",
                f"Only {max(left, 0):,} of this edition's print run "
                f"{'is' if left == 1 else 'are'} left to give.",
            )
    grant_id = uuid4()
    db.add(
        LibraryGrant(
            user_id=user.id,
            concept_id=concept.id,
            printing_id=printing.id,
            finish=body.finish,
            quantity=body.quantity,
            source="grant",
            grant_key=f"grant:{grant_id}",
            created_at=utcnow(),
        )
    )
    db.flush()
    permissions = permissions_for(user, roles_of(db, user))
    refresh_decks(db, user.id, library_of(db, user, permissions, roster_of(request)))
    audit(
        db,
        request,
        "testing.cards_granted",
        actor_id=principal.user.id,
        target_user_id=user.id,
        details={
            "card": str(concept.id),
            "name": concept.name,
            "printing": str(printing.id),
            "finish": body.finish,
            "quantity": body.quantity,
            "grant": str(grant_id),
            "reason": body.reason,
        },
    )
    db.commit()
    return CardsGranted(
        card_id=concept.id,
        printing_id=printing.id,
        name=concept.name,
        quantity=body.quantity,
        finish=body.finish,
    )


# Campaign progress.


def set_campaign(
    db: Session, user: User, campaign: campaigns.Campaign, through: int
) -> CampaignProgress:
    """The encounters 1 through the number won, as winning them gives, without spoils."""
    progress = campaigns.progress_of(db, user, campaign, lock=True)
    through = min(through, campaign.last)
    now = utcnow()
    if through < max(progress.completed, default=0):
        # Fewer than won: the progress starts again, a new epoch whose rewards start empty.
        progress.highest_unlocked = 1
        progress.completed = []
        progress.ending = None
        progress.challenge_fled_at = None
        progress.started_at = now
    # Since v0.9.6 ward 14 won is no flight to finish: the court opens as for an earlier winner.
    progress.fled_at = None
    numbers = list(range(1, through + 1))
    if numbers:
        progress.completed = sorted({*progress.completed, *numbers})
        progress.highest_unlocked = max(progress.highest_unlocked, min(through + 1, campaign.last))
    progress.content_version = campaign.content_version
    progress.updated_at = now
    for number in numbers:
        campaigns.reward(db, user.id, campaign, progress, f"seal:{number:02d}", None)
    done = set(progress.completed)
    for chapter in campaign.chapters:
        if all(number in done for number in chapter.encounters):
            for id_, _ in chapter.rewards:
                campaigns.reward(db, user.id, campaign, progress, id_, None)
    return progress


@router.post("/admin/users/{user_id}/campaign", response_model=CampaignGranted)
def give_campaign(
    user_id: UUID, body: CampaignGrant, request: Request, principal: Tester, db: Db
) -> CampaignGranted:
    """SysOp sets how far an account has come in the campaign, for testing: the encounters won
    through a number, their seals and the chapters' rewards, never the spoils. Audited."""
    user = target(db, user_id, principal)
    refuse_deleted(user)
    campaign = campaigns.campaign_of(request)
    if campaigns.running_of(db, user.id) is not None:
        raise ApiError(409, "duel_running", "Finish or close the running campaign duel first.")
    before = campaigns.progress_of(db, user, campaign)
    was = sorted(before.completed)
    progress = set_campaign(db, user, campaign, body.won_through)
    audit(
        db,
        request,
        "testing.campaign_set",
        actor_id=principal.user.id,
        target_user_id=user.id,
        details={
            "campaign": campaign.id,
            "from": was,
            "won_through": min(body.won_through, campaign.last),
            "reason": body.reason,
        },
    )
    db.commit()
    return CampaignGranted(
        highest_unlocked=progress.highest_unlocked,
        completed=sorted(progress.completed),
        rewards=sorted(campaigns.earned(db, user.id, campaign, progress)),
    )
