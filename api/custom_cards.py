"""The Godlike tier's custom cards (v0.3.1): uploaded by SysOp, seen only at Godlike.

The owner's own cards reach the site through SysOp's upload, over the site's HTTPS, and never
through the public repository: no name, text or image of them is in its code, tests or docs. They
live in a table of their own, outside the catalog's, so no search, card page, deck, import, export,
image route or list of the catalog can reach them. Only an account at the Godlike tier (100,000
wins; SysOp starts there) can list them or fetch their images, and to everyone else those routes
answer as routes for things that do not exist. An alliance with the Godlike tier's Planeswalker
puts them in the library. Since v0.4.0 a Godlike account may play them in its decks, wherever the
running engine has loaded them (the engine plugin from a private repository): api/custom_play.py.

The browser makes each image fit Scryfall's 745 x 1040 card size and at most 750 KB before it
uploads it, base64 in JSON, so a request stays under the proxies' 1 MB limit; the API checks what
it receives is an image.
"""

import base64
import binascii
import hashlib
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.auth import INPUT_ERRORS
from api.cards import CardSummary
from api.custom_play import custom_summary, image_url
from api.identity import (
    Active,
    ApiError,
    Db,
    Principal,
    audit,
    not_found,
    require_permission,
    utcnow,
)
from api.library import CurrentLibrary, Library
from api.models import CustomCard
from api.progression import godlike
from api.roster import roster_of
from api.schemas import Contract, StoredText

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
Uploader = Annotated[Principal, Depends(require_permission("custom_cards.manage"))]
MAX_IMAGE_BYTES = 900_000
ImageType = Literal["image/webp", "image/png", "image/jpeg"]
Short = Annotated[StoredText, Field(max_length=16)]


class CustomCardUpload(Contract):
    name: Annotated[StoredText, Field(min_length=1, max_length=160)]
    planeswalker: str = Field(min_length=1, max_length=48)
    mana_cost: Annotated[StoredText, Field(max_length=64)] | None = None
    type_line: Annotated[StoredText, Field(min_length=1, max_length=160)]
    oracle_text: Annotated[StoredText, Field(max_length=4000)] = ""
    flavor_text: Annotated[StoredText, Field(max_length=1000)] | None = None
    power: Annotated[StoredText, Field(max_length=8)] | None = None
    toughness: Annotated[StoredText, Field(max_length=8)] | None = None
    loyalty: Annotated[StoredText, Field(max_length=8)] | None = None
    rarity: Literal["common", "uncommon", "rare", "mythic", "special"] = "mythic"
    set_code: Short | None = None
    collector_number: Short | None = None
    artist: Annotated[StoredText, Field(max_length=128)] | None = None
    image: str = Field(
        min_length=1,
        max_length=(MAX_IMAGE_BYTES * 4) // 3 + 8,
        description="The card's image, base64, at most 900 KB decoded.",
    )
    image_type: ImageType


class CustomCardInfo(Contract):
    id: UUID
    name: str
    planeswalker: str
    mana_cost: str | None
    type_line: str
    oracle_text: str
    flavor_text: str | None
    power: str | None
    toughness: str | None
    loyalty: str | None
    rarity: str
    set_code: str | None
    collector_number: str | None
    artist: str | None
    image_url: str
    playable: bool = Field(
        default=False, description="The running engine has loaded it, so a game can play it."
    )
    loaded: bool | None = Field(
        default=None,
        description="Whether the running engine has loaded it (v0.4.0); null when the engine "
        "could not be asked.",
    )
    in_library: bool = Field(
        default=False,
        description="In your library: you are allied with its Planeswalker, or you build from "
        "the whole catalog.",
    )
    card: CardSummary = Field(description="The card as decks hold it (v0.4.0).")


def info(card: CustomCard, library: Library) -> CustomCardInfo:
    loaded = None if library.loaded is None else library.loaded.get(card.name.casefold())
    return CustomCardInfo(
        id=card.id,
        name=card.name,
        planeswalker=card.planeswalker,
        mana_cost=card.mana_cost,
        type_line=card.type_line,
        oracle_text=card.oracle_text,
        flavor_text=card.flavor_text,
        power=card.power,
        toughness=card.toughness,
        loyalty=card.loyalty,
        rarity=card.rarity,
        set_code=card.set_code,
        collector_number=card.collector_number,
        artist=card.artist,
        image_url=image_url(card),
        playable=loaded is True,
        loaded=loaded,
        in_library=library.unlimited or library.alliance == card.planeswalker,
        card=custom_summary(card, library),
    )


def sniffed(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def require_godlike(db: Session, principal: Principal) -> None:
    """Below Godlike, the custom cards do not exist: the same 404 as any missing route's."""
    if not godlike(db, principal.user):
        raise not_found()


@router.get("/custom-cards", response_model=list[CustomCardInfo])
def custom_cards(principal: Active, library: CurrentLibrary, db: Db) -> list[CustomCardInfo]:
    """The custom cards, for accounts at the Godlike tier only, each with whether the running
    engine has loaded it."""
    if not library.godlike:
        raise not_found()
    cards = db.scalars(select(CustomCard).order_by(CustomCard.name))
    return [info(card, library) for card in cards]


@router.get(
    "/custom-cards/{card_id}/image",
    response_class=Response,
    responses={200: {"content": {"image/webp": {}, "image/png": {}, "image/jpeg": {}}}},
)
def custom_card_image(card_id: UUID, principal: Active, db: Db) -> Response:
    require_godlike(db, principal)
    card = db.get(CustomCard, card_id)
    if card is None:
        raise not_found()
    # Kept out of every shared cache and of the installed app's offline copies.
    return Response(
        content=card.image,
        media_type=card.image_type,
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.get("/admin/custom-cards", response_model=list[CustomCardInfo])
def uploaded(principal: Uploader, library: CurrentLibrary, db: Db) -> list[CustomCardInfo]:
    cards = db.scalars(select(CustomCard).order_by(CustomCard.name))
    return [info(card, library) for card in cards]


@router.post("/admin/custom-cards", response_model=CustomCardInfo)
def upload(
    body: CustomCardUpload,
    request: Request,
    principal: Uploader,
    library: CurrentLibrary,
    db: Db,
) -> CustomCardInfo:
    """Adds a custom card, or replaces the one of the same name. The audit trail records its ID,
    never its name or text."""
    planeswalker = roster_of(request).get(body.planeswalker)
    if planeswalker is None or not planeswalker.custom:
        raise ApiError(
            422, "invalid_planeswalker", "Custom cards belong to the Godlike tier's Planeswalker."
        )
    try:
        data = base64.b64decode(body.image, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ApiError(422, "invalid_image", "The image is not valid base64.") from error
    if len(data) > MAX_IMAGE_BYTES:
        raise ApiError(422, "image_too_large", "The image is larger than 900 KB.")
    if sniffed(data) != body.image_type:
        raise ApiError(422, "invalid_image", "The image is not the PNG, JPEG or WebP it says.")
    now = utcnow()
    card = db.scalar(select(CustomCard).where(CustomCard.name == body.name))
    replaced = card is not None
    if card is None:
        card = CustomCard(name=body.name, uploaded_by=principal.user.id, created_at=now)
        db.add(card)
    for field in (
        "planeswalker",
        "mana_cost",
        "type_line",
        "oracle_text",
        "flavor_text",
        "power",
        "toughness",
        "loyalty",
        "rarity",
        "set_code",
        "collector_number",
        "artist",
        "image_type",
    ):
        setattr(card, field, getattr(body, field))
    card.image = data
    card.image_sha256 = hashlib.sha256(data).hexdigest()
    card.uploaded_by = principal.user.id
    card.updated_at = now
    db.flush()
    audit(
        db,
        request,
        "admin.custom_card_saved",
        actor_id=principal.user.id,
        details={"card": str(card.id), "replaced": replaced},
    )
    db.commit()
    return info(card, library)


@router.delete("/admin/custom-cards/{card_id}", status_code=204)
def remove(card_id: UUID, request: Request, principal: Uploader, db: Db) -> Response:
    card = db.get(CustomCard, card_id)
    if card is None:
        raise not_found()
    db.delete(card)
    audit(
        db,
        request,
        "admin.custom_card_removed",
        actor_id=principal.user.id,
        details={"card": str(card_id)},
    )
    db.commit()
    return Response(status_code=204)
