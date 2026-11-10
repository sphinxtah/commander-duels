"""Opening a warden's deck (v0.9.5, the owner's request): a warden's first defeat gives their whole
deck (api/campaign.py give_spoils), and the player then opens it as a pack, as if they had bought a
100-card deck at Leng's shop, card by card, the commander last. docs/campaign.md describes it.

- **Recorded with the spoils.** The same transaction that grants the deck writes the opening: the
  cards as given, one per copy, in the order they reveal (commons first, then uncommons, rares and
  mythic rares, by name; the commander last of all, the High Priest for The Sphinx), under the
  spoils' key. Opening it only shows what was given: it grants nothing, so it can be watched again.
- **It waits.** An opening not yet opened waits on the campaign map, and the bell says so
  (warden_deck), until the player opens it.
- **After a reset** (users.reset_at) only openings since count, as the spoils can be won again.
"""

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.auth import INPUT_ERRORS
from api.cards import image_of
from api.identity import Active, Db, not_found, utcnow
from api.library import since_reset
from api.models import CardConcept, CardPrinting, CustomCard, User, WardenOpening
from api.schemas import Contract
from api.shop import PulledCard
from api.social import notify_award
from api.validation import DeckEntry
from catalog.statuses import stands_in

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

# The order cards reveal in: the commonest first.
RARITY_ORDER = {"common": 0, "uncommon": 1, "rare": 2, "mythic": 3, "special": 4, "bonus": 5}


class WardenCard(PulledCard):
    commander: bool = Field(default=False, description="The deck's commander: revealed last.")
    custom: bool = Field(
        default=False,
        description="One of the Godlike tier's custom cards (the High Priest): its image is the "
        "custom card's, and printing_id is its card ID.",
    )


class WardenOpeningSummary(Contract):
    id: UUID
    encounter: int
    opponent: str = Field(description="The warden's roster ID, for their portrait.")
    opponent_name: str
    deck_title: str
    deck_id: UUID | None
    cards: int
    created_at: datetime
    opened_at: datetime | None


class WardenOpeningView(WardenOpeningSummary):
    pulled: list[WardenCard] = Field(description="The cards, in the order they reveal.")


def record(
    db: Session,
    user: User,
    key: str,
    campaign_id: str,
    encounter: int,
    opponent: str,
    opponent_name: str,
    deck_title: str,
    deck_id: UUID | None,
    game_id: UUID | None,
    entries: list[DeckEntry],
) -> WardenOpening:
    """The opening of a warden's deck just given, in the spoils' transaction, and the bell's
    notice. Each copy is a card; the commander comes last."""
    printing_ids = {entry.printing_id for entry in entries if entry.printing_id is not None}
    rows = {
        printing.id: (printing, concept)
        for printing, concept in db.execute(
            select(CardPrinting, CardConcept)
            .join(CardConcept, CardConcept.id == CardPrinting.concept_id)
            .where(CardPrinting.id.in_(printing_ids))
        ).all()
    }
    main: list[tuple[int, str, dict[str, object]]] = []
    last: list[dict[str, object]] = []
    for entry in entries:
        commander = entry.location == "commander"
        if entry.printing_id is None:
            custom = db.get(CustomCard, entry.card_id)
            card: dict[str, object] = {
                "card_id": str(entry.card_id),
                "printing_id": None,
                "commander": commander,
                "custom": True,
            }
            if custom is not None and commander:
                last.append(card)
            elif custom is not None:
                main.append((9, custom.name, card))
            continue
        found = rows.get(entry.printing_id)
        if found is None:
            continue
        printing, concept = found
        for _ in range(entry.quantity):
            card = {
                "card_id": str(concept.id),
                "printing_id": str(printing.id),
                "commander": commander,
                "custom": False,
            }
            if commander:
                last.append(card)
            else:
                main.append((RARITY_ORDER.get(printing.rarity, 6), concept.name, card))
    main.sort(key=lambda item: (item[0], item[1]))
    opening = WardenOpening(
        user_id=user.id,
        campaign_id=campaign_id,
        encounter=encounter,
        key=key,
        deck_id=deck_id,
        game_id=game_id,
        opponent=opponent,
        opponent_name=opponent_name,
        deck_title=deck_title,
        cards=[card for _, _, card in main] + last,
        created_at=utcnow(),
    )
    db.add(opening)
    db.flush()
    notify_award(db, user.id, "warden_deck", str(opening.id), opening.created_at)
    return opening


def summary(opening: WardenOpening) -> WardenOpeningSummary:
    return WardenOpeningSummary(
        id=opening.id,
        encounter=opening.encounter,
        opponent=opening.opponent,
        opponent_name=opening.opponent_name,
        deck_title=opening.deck_title,
        deck_id=opening.deck_id,
        cards=len(opening.cards),
        created_at=opening.created_at,
        opened_at=opening.opened_at,
    )


def view(db: Session, opening: WardenOpening) -> WardenOpeningView:
    printing_ids = {
        UUID(str(card["printing_id"])) for card in opening.cards if card.get("printing_id")
    }
    custom_ids = {UUID(str(card["card_id"])) for card in opening.cards if card.get("custom")}
    rows = {
        printing.id: (printing, concept)
        for printing, concept in db.execute(
            select(CardPrinting, CardConcept)
            .join(CardConcept, CardConcept.id == CardPrinting.concept_id)
            .where(CardPrinting.id.in_(printing_ids))
        ).all()
    }
    customs = {
        card.id: card
        for card in db.scalars(select(CustomCard).where(CustomCard.id.in_(custom_ids)))
    }
    pulled: list[WardenCard] = []
    for card in opening.cards:
        commander = bool(card.get("commander"))
        if card.get("custom"):
            custom = customs.get(UUID(str(card["card_id"])))
            if custom is None:
                continue
            pulled.append(
                WardenCard(
                    position=len(pulled),
                    card_id=custom.id,
                    printing_id=custom.id,
                    name=custom.name,
                    mana_cost=None,
                    type_line="Legendary Creature",
                    rarity="mythic",
                    set_code="",
                    collector_number="",
                    finish="nonfoil",
                    sheet="",
                    new=True,
                    faces=0,
                    commander=commander,
                    custom=True,
                )
            )
            continue
        found = rows.get(UUID(str(card["printing_id"])))
        if found is None:
            continue
        printing, concept = found
        image = image_of(printing)
        pulled.append(
            WardenCard(
                position=len(pulled),
                card_id=concept.id,
                printing_id=printing.id,
                name=concept.name,
                mana_cost=concept.mana_cost,
                type_line=concept.type_line,
                rarity=printing.rarity,
                set_code=printing.set_code,
                set_name=printing.set_name,
                released_at=printing.released_at,
                collector_number=printing.collector_number,
                finish="nonfoil",
                sheet="",
                new=True,
                faces=image.faces if image else 0,
                stand_in=stands_in(
                    concept.status,
                    concept.status_reason,
                    concept.deck_card,
                    concept.removed_revision is not None,
                ),
                commander=commander,
            )
        )
    return WardenOpeningView(**summary(opening).model_dump(), pulled=pulled)


def openings_of(db: Session, user: User) -> list[WardenOpening]:
    return list(
        db.scalars(
            select(WardenOpening)
            .where(WardenOpening.user_id == user.id, since_reset(user, WardenOpening.created_at))
            .order_by(WardenOpening.encounter)
        )
    )


def owned(db: Session, user: User, opening_id: UUID) -> WardenOpening:
    opening = db.get(WardenOpening, opening_id)
    if (
        opening is None
        or opening.user_id != user.id
        or (user.reset_at is not None and opening.created_at <= user.reset_at)
    ):
        raise not_found()
    return opening


# Routes.


@router.get("/campaign/openings", response_model=list[WardenOpeningSummary])
def my_openings(principal: Active, db: Db) -> list[WardenOpeningSummary]:
    """The warden decks the account won, by ward: those not yet opened wait to be."""
    return [summary(opening) for opening in openings_of(db, principal.user)]


@router.get("/campaign/openings/{opening_id}", response_model=WardenOpeningView)
def an_opening(opening_id: UUID, principal: Active, db: Db) -> WardenOpeningView:
    """A warden deck's cards in the order they reveal, opened or not."""
    return view(db, owned(db, principal.user, opening_id))


@router.post("/campaign/openings/{opening_id}/open", response_model=WardenOpeningView)
def open_deck(opening_id: UUID, principal: Active, db: Db) -> WardenOpeningView:
    """Marks the deck opened, the first time; again, nothing changes. It gives nothing: the
    cards were the win's."""
    opening = owned(db, principal.user, opening_id)
    if opening.opened_at is None:
        opening.opened_at = utcnow()
        db.commit()
    return view(db, opening)
