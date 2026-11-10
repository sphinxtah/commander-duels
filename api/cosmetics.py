"""The campaign's cosmetics in use (v0.8.8): the card backs and titles its chapters reward
(api/campaign.py), recorded since v0.8.0 and listed on the Campaign page, chosen here to show.

- **A card back** replaces the official Magic card back on the player's own table: every
  face-down card they see, their library, their opponents' hands. The designs are the web's
  (web/public/brand/backs/<slug>.svg). Showing each player's back to the others at a shared table
  is not built yet.
- **A title** stands under the player's name on their profile, for everyone who may open it.
- **A badge** (v0.9.3), Apex Unbound's, shows on the profile once earned; nothing to choose.

Only what the account has earned in its current campaign progress may be chosen, and what it
shows is checked again on every read, so a reset of the account or of its campaign takes the
cosmetic away with the reward. Nothing chosen: the official back, and no title.
"""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Request
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from api import campaign as campaigns
from api.auth import INPUT_ERRORS
from api.identity import Active, ApiError, Db
from api.models import CampaignProgress, User
from api.schemas import Contract

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

Kind = Literal["card_back", "title"]
SUFFIXES = {"card_back": " card back", "title": " title"}


class Cosmetic(Contract):
    id: str = Field(description="The reward's slug, without its kind: broken-writ, unbowed.")
    name: str
    earned: bool


class Cosmetics(Contract):
    card_back: str | None = Field(description="The card back in use; null: the official one.")
    title: str | None = Field(description="The title in use; null: none.")
    title_name: str | None = Field(description="The title in use, in words.")
    card_backs: list[Cosmetic] = Field(description="Every card back the campaign rewards.")
    titles: list[Cosmetic] = Field(description="Every title the campaign rewards.")


class CosmeticsChange(Contract):
    card_back: str | None = Field(default=None, max_length=48)
    title: str | None = Field(default=None, max_length=48)


def offered(campaign: campaigns.Campaign, kind: Kind) -> dict[str, str]:
    """The campaign's rewards of a kind, by slug, with their names in words."""
    found: dict[str, str] = {}
    for chapter in campaign.chapters:
        for id_, name in chapter.rewards:
            prefix, _, slug = id_.partition(":")
            if prefix == kind:
                found[slug] = name.removesuffix(SUFFIXES[kind])
    return found


def earned_slugs(db: Session, user: User, campaign: campaigns.Campaign, kind: Kind) -> set[str]:
    progress = campaigns.progress_of(db, user, campaign)
    return {
        reward.partition(":")[2]
        for reward in campaigns.earned(db, user.id, campaign, progress)
        if reward.startswith(f"{kind}:")
    }


def in_use(
    db: Session, user: User, campaign: campaigns.Campaign | None
) -> tuple[str | None, str | None]:
    """The card back and the title (in words) the account shows, still earned; else none."""
    if campaign is None or (user.card_back is None and user.title is None):
        return None, None
    backs = earned_slugs(db, user, campaign, "card_back") if user.card_back else set()
    back = user.card_back if user.card_back in backs else None
    title = None
    if user.title is not None and user.title in earned_slugs(db, user, campaign, "title"):
        title = offered(campaign, "title").get(user.title)
    return back, title


def view_of(db: Session, user: User, campaign: campaigns.Campaign) -> Cosmetics:
    backs = earned_slugs(db, user, campaign, "card_back")
    titles = earned_slugs(db, user, campaign, "title")
    back, title_name = in_use(db, user, campaign)
    db.commit()
    return Cosmetics(
        card_back=back,
        title=user.title if title_name else None,
        title_name=title_name,
        card_backs=[
            Cosmetic(id=slug, name=name, earned=slug in backs)
            for slug, name in offered(campaign, "card_back").items()
        ],
        titles=[
            Cosmetic(id=slug, name=name, earned=slug in titles)
            for slug, name in offered(campaign, "title").items()
        ],
    )


def campaign_or_none(request: Request) -> campaigns.Campaign | None:
    try:
        return campaigns.campaign_of(request)
    except ApiError:
        return None


@router.get("/me/cosmetics", response_model=Cosmetics)
def my_cosmetics(request: Request, principal: Active, db: Db) -> Cosmetics:
    return view_of(db, principal.user, campaigns.campaign_of(request))


@router.put("/me/cosmetics", response_model=Cosmetics)
def change_cosmetics(
    body: CosmeticsChange, request: Request, principal: Active, db: Db
) -> Cosmetics:
    """Chooses the card back and the title to show: each one the account has earned, or none."""
    campaign = campaigns.campaign_of(request)
    user = db.get_one(User, principal.user.id)
    choices: tuple[tuple[Kind, str | None], ...] = (
        ("card_back", body.card_back),
        ("title", body.title),
    )
    for kind, chosen in choices:
        if chosen is not None and chosen not in earned_slugs(db, user, campaign, kind):
            raise ApiError(409, "not_earned", "Win that reward in the campaign before you use it.")
    user.card_back = body.card_back
    user.title = body.title
    db.commit()
    return view_of(db, user, campaign)


def title_of(db: Session, request: Request, user_id: UUID) -> str | None:
    """A player's title in words, for their profile; none when not chosen or no longer earned."""
    user = db.get(User, user_id)
    if user is None or user.title is None:
        return None
    return in_use(db, user, campaign_or_none(request))[1]


def badges_of(db: Session, request: Request, user_id: UUID) -> list[str]:
    """The campaign's badges a player holds in their current progress (v0.9.3), in words."""
    campaign = campaign_or_none(request)
    user = db.get(User, user_id)
    if campaign is None or user is None:
        return []
    # Read only: a profile's viewer never makes another player's campaign progress.
    progress = db.scalar(
        select(CampaignProgress).where(
            CampaignProgress.user_id == user.id, CampaignProgress.campaign_id == campaign.id
        )
    )
    if progress is None or (user.reset_at is not None and progress.started_at < user.reset_at):
        return []
    held = campaigns.earned(db, user.id, campaign, progress)
    return [campaigns.CHALLENGE_NAME] if campaigns.CHALLENGE_REWARD in held else []
