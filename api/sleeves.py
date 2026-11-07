"""Card sleeves (v0.8.9): pictures players upload for the backs of their decks' cards, as real
players sleeve their decks (the owner, 2026-11-06). docs/sleeves.md describes them.

- **Uploading.** Up to 20 sleeves per account, each a PNG, BMP or JPEG of at most 5 MB, sent base64
  in JSON as a report's screenshot is. Pillow reads the size from the header and refuses an image
  past 40 million pixels before unpacking it; the picture is turned upright, cropped about its
  centre to a card's shape (63 by 88) and scaled to 504 by 704, then encoded again as WebP from its
  pixels alone, so nothing else of the file survives. It is kept in the database, as screenshots
  are, so the nightly backups hold it.
- **Choosing.** Each deck takes one sleeve (Deck.sleeve): one of the owner's, one of the three
  default sleeves every account has from the start (the site owner's designs), or a campaign
  card back the account has earned (api/cosmetics.py). A deck with none shows the account's campaign
  back if it chose one, else the official Magic card back, the default.
- **At a table** every seat's sleeve shows to everyone there, players and spectators: the game's
  summary gives each human seat's picture (api/games.py), and the table draws each player's
  cards with it. Bots show the official back.
- **Reporting.** Live at once and reportable (the owner's choice): from a player's profile at the
  table, any player reports another's sleeve. The report reaches Administration's Reports tab
  with the picture, where a moderator with reports.manage removes it: from then on it shows
  nowhere but to staff, and the decks wearing it go back to the default. Removal is audited.
- **Deleting** one's own sleeve clears its picture; decks wearing it go back to the default.
"""

import base64
import binascii
import io
import warnings
from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from PIL import Image, ImageOps
from pydantic import AfterValidator, Field, StringConstraints
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from api.auth import INPUT_ERRORS
from api.cosmetics import campaign_or_none, earned_slugs
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
from api.models import CardSleeve, Deck, DeckRevision, User
from api.reports import DECODING, MAX_PIXELS
from api.schemas import Contract, without_nul

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
CanManageReports = Annotated[Principal, Depends(require_permission("reports.manage"))]

MAX_SLEEVES = 20
MAX_BYTES = 5 * 1024 * 1024
FORMATS = ("PNG", "BMP", "JPEG")
# A card's shape, 63 by 88 mm, at 8 pixels a millimetre: sharp at the table's largest card.
WIDTH, HEIGHT = 504, 704
WEBP_QUALITY = 85
# The default sleeves every account has from the start (the owner's designs, 2026-11-06), served
# by the web (web/public/brand/sleeves/<slug>.webp): a deck wears one as default:<slug>.
DEFAULTS = {
    "duels-varragoth": "Commander Duels: Varragoth",
    "duels-crest": "Commander Duels crest",
    "the-sphinx": "The Sphinx",
}

Name = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=40),
    AfterValidator(without_nul),
]
Reason = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=3, max_length=200),
    AfterValidator(without_nul),
]


class SleeveUpload(Contract):
    name: Name
    image: str = Field(
        min_length=1,
        max_length=4 * ((MAX_BYTES + 2) // 3),
        description="The picture, base64: PNG, BMP or JPEG, at most 5 MB decoded.",
    )


class Sleeve(Contract):
    id: UUID
    name: str
    url: str = Field(description="The picture, WebP, 504 by 704.")
    created_at: datetime
    removed: bool = Field(
        description="A moderator removed it after a report: it shows to nobody, and no deck may "
        "wear it."
    )


class DefaultSleeve(Contract):
    id: str = Field(description="Its slug; a deck wears it as default:<slug>.")
    name: str
    url: str


class Sleeves(Contract):
    defaults: list[DefaultSleeve] = Field(description="The sleeves every account has.")
    sleeves: list[Sleeve]
    limit: int
    backs: list[str] = Field(
        description="The campaign card backs the account has earned, by slug; a deck may wear "
        "one as back:<slug>."
    )


class DeckSleeve(Contract):
    sleeve: str | None = Field(
        max_length=64,
        description='"sleeve:<id>", one of your sleeves; "default:<slug>", one of the sleeves '
        'everyone has; "back:<slug>", a campaign card back you have earned; null, the official '
        "card back (or your campaign back, if you chose one).",
    )


class SleeveRemoval(Contract):
    reason: Reason


class RemovedSleeve(Contract):
    id: UUID
    removed_at: datetime


def image_url(sleeve_id: UUID) -> str:
    return f"/api/v1/sleeves/{sleeve_id}/image"


def default_url(slug: str) -> str:
    return f"/brand/sleeves/{slug}.webp"


def back_url(slug: str) -> str:
    """A campaign card back's picture, as the web serves it (web/public/brand/backs)."""
    return f"/brand/backs/{slug}.svg"


def unreadable() -> ApiError:
    return ApiError(422, "invalid_image", "The picture is not a PNG, BMP or JPEG image.")


def too_large() -> ApiError:
    return ApiError(
        422, "image_too_large", "The picture has more than 40 million pixels. Send a smaller one."
    )


def cropped(data: bytes) -> tuple[bytes, int, int]:
    """The picture as a sleeve: upright, cropped about its centre to a card's shape, scaled to
    WIDTH by HEIGHT and encoded again as WebP from its pixels alone."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data), formats=FORMATS) as image:
                if image.width * image.height > MAX_PIXELS:
                    raise too_large()
                image.draft("RGB", (WIDTH * 2, HEIGHT * 2))
                image.load()
                upright = ImageOps.exif_transpose(image)
                mode = "RGBA" if upright.has_transparency_data else "RGB"
                fitted = ImageOps.fit(
                    upright.convert(mode), (WIDTH, HEIGHT), Image.Resampling.LANCZOS
                )
    except ApiError:
        raise
    except Image.DecompressionBombError as error:
        raise too_large() from error
    except Exception as error:
        # Not one of the three formats, or a decoder's failure on a damaged or crafted file:
        # refused, never a 500.
        raise unreadable() from error
    clean = Image.frombytes(mode, fitted.size, fitted.tobytes())
    out = io.BytesIO()
    clean.save(out, "WEBP", quality=WEBP_QUALITY, method=4)
    return out.getvalue(), clean.width, clean.height


def decoded(encoded: str) -> bytes:
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ApiError(422, "invalid_image", "The picture is not valid base64.") from error
    if len(data) > MAX_BYTES:
        raise ApiError(422, "image_too_large", "The picture is larger than 5 MB.")
    return data


def live(sleeve: CardSleeve | None) -> bool:
    return sleeve is not None and sleeve.deleted_at is None and sleeve.removed_at is None


def sleeve_of(row: CardSleeve) -> Sleeve:
    return Sleeve(
        id=row.id,
        name=row.name,
        url=image_url(row.id),
        created_at=row.created_at,
        removed=row.removed_at is not None,
    )


def earned_backs(db: Session, request: Request, user: User) -> set[str]:
    campaign = campaign_or_none(request)
    return earned_slugs(db, user, campaign, "card_back") if campaign else set()


def view_of(db: Session, request: Request, user: User) -> Sleeves:
    rows = db.scalars(
        select(CardSleeve)
        .where(CardSleeve.user_id == user.id, CardSleeve.deleted_at.is_(None))
        .order_by(CardSleeve.created_at)
    )
    backs = earned_backs(db, request, user)
    db.commit()
    return Sleeves(
        defaults=[
            DefaultSleeve(id=slug, name=name, url=default_url(slug))
            for slug, name in DEFAULTS.items()
        ],
        sleeves=[sleeve_of(row) for row in rows],
        limit=MAX_SLEEVES,
        backs=sorted(backs),
    )


def forget(db: Session, sleeve_id: UUID) -> None:
    """Decks wearing a sleeve that is gone go back to the default."""
    db.execute(update(Deck).where(Deck.sleeve == f"sleeve:{sleeve_id}").values(sleeve=None))


def delete_sleeves_of(db: Session, user_id: UUID) -> int:
    """Deletes every sleeve of an account, as deleting the account does. The caller commits."""
    now = utcnow()
    return db.execute(  # type: ignore[no-any-return]
        update(CardSleeve)
        .where(CardSleeve.user_id == user_id)
        .values(image=None, deleted_at=func.coalesce(CardSleeve.deleted_at, now))
    ).rowcount  # type: ignore[attr-defined]


# What a table shows.


def picture_of(db: Session, choice: str | None, owner: User | None) -> str | None:
    """A deck's sleeve as a picture's path, else the account's campaign back, else None (the
    official back). A sleeve that is gone, or not the owner's, is the default."""
    if choice and choice.startswith("sleeve:") and owner is not None:
        try:
            sleeve_id = UUID(choice.removeprefix("sleeve:"))
        except ValueError:
            sleeve_id = None
        row = db.get(CardSleeve, sleeve_id) if sleeve_id else None
        if live(row) and row is not None and row.user_id == owner.id:
            return image_url(row.id)
    elif choice and choice.startswith("default:") and choice.removeprefix("default:") in DEFAULTS:
        return default_url(choice.removeprefix("default:"))
    elif choice and choice.startswith("back:"):
        return back_url(choice.removeprefix("back:"))
    if owner is not None and owner.card_back:
        return back_url(owner.card_back)
    return None


def seat_sleeves(db: Session, seats: list[tuple[int, UUID | None, UUID | None]]) -> dict[int, str]:
    """Each human seat's sleeve picture, by seat: (seat, owner, deck revision) in; a seat with
    the official back is left out."""
    revisions = {revision for _, _, revision in seats if revision is not None}
    decks: dict[UUID, str | None] = {}
    if revisions:
        decks = {
            revision_id: sleeve
            for revision_id, sleeve in db.execute(
                select(DeckRevision.id, Deck.sleeve)
                .join(Deck, Deck.id == DeckRevision.deck_id)
                .where(DeckRevision.id.in_(revisions))
            )
        }
    owners = {owner for _, owner, _ in seats if owner is not None}
    users = (
        {user.id: user for user in db.scalars(select(User).where(User.id.in_(owners)))}
        if owners
        else {}
    )
    found: dict[int, str] = {}
    for seat, owner, revision in seats:
        if owner is None:
            continue
        picture = picture_of(db, decks.get(revision) if revision else None, users.get(owner))
        if picture:
            found[seat] = picture
    return found


# Routes.


@router.get("/me/sleeves", response_model=Sleeves)
def my_sleeves(request: Request, principal: Active, db: Db) -> Sleeves:
    return view_of(db, request, db.get_one(User, principal.user.id))


@router.post("/me/sleeves", response_model=Sleeve, status_code=201)
def upload_sleeve(body: SleeveUpload, request: Request, principal: Active, db: Db) -> Sleeve:
    """Adds a sleeve to the account's: at most 20."""
    data = decoded(body.image)
    user = db.get_one(User, principal.user.id, with_for_update=True)
    held = db.scalar(
        select(func.count(CardSleeve.id)).where(
            CardSleeve.user_id == user.id,
            CardSleeve.deleted_at.is_(None),
            CardSleeve.removed_at.is_(None),
        )
    )
    if (held or 0) >= MAX_SLEEVES:
        raise ApiError(
            409, "too_many_sleeves", f"You have {MAX_SLEEVES} sleeves: delete one to add another."
        )
    with DECODING:
        image, width, height = cropped(data)
    row = CardSleeve(
        user_id=user.id,
        name=body.name,
        image=image,
        width=width,
        height=height,
        created_at=utcnow(),
    )
    db.add(row)
    db.commit()
    return sleeve_of(row)


@router.delete("/me/sleeves/{sleeve_id}", status_code=204)
def delete_sleeve(sleeve_id: UUID, principal: Active, db: Db) -> Response:
    row = db.get(CardSleeve, sleeve_id)
    if row is None or row.user_id != principal.user.id or row.deleted_at is not None:
        raise not_found()
    row.deleted_at = utcnow()
    if row.removed_at is None:
        # A removed sleeve keeps its picture for the staff's review.
        row.image = None
    forget(db, row.id)
    db.commit()
    return Response(status_code=204)


@router.get(
    "/sleeves/{sleeve_id}/image",
    response_class=Response,
    responses={200: {"content": {"image/webp": {}}}},
)
def sleeve_image(sleeve_id: UUID, principal: Active, db: Db) -> Response:
    """A sleeve's picture, for anyone signed in: the table shows it to everyone. A removed one
    only to staff (reports.manage), for its report; a deleted one to nobody."""
    row = db.get(CardSleeve, sleeve_id)
    staff = principal.can("reports.manage")
    if row is None or row.deleted_at is not None and row.removed_at is None:
        raise not_found()
    if row.removed_at is not None and not staff:
        raise not_found()
    image = db.scalar(select(CardSleeve.image).where(CardSleeve.id == sleeve_id))
    if image is None:
        raise not_found()
    return Response(
        content=image,
        media_type="image/webp",
        headers={
            # Short, so a removal reaches every table within minutes.
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.put("/decks/{deck_id}/sleeve", response_model=DeckSleeve)
def choose_sleeve(
    deck_id: UUID, body: DeckSleeve, request: Request, principal: Active, db: Db
) -> DeckSleeve:
    """Puts a sleeve on one of your decks: one of your own, a campaign back you earned, or none."""
    deck = db.get(Deck, deck_id)
    if deck is None or deck.owner_id != principal.user.id or deck.deleted_at is not None:
        raise not_found()
    choice = body.sleeve
    if choice is not None:
        kind, _, value = choice.partition(":")
        if kind == "sleeve":
            try:
                row = db.get(CardSleeve, UUID(value))
            except ValueError:
                row = None
            if not live(row) or row is None or row.user_id != principal.user.id:
                raise ApiError(422, "invalid_sleeve", "That is not one of your sleeves.")
        elif kind == "default":
            if value not in DEFAULTS:
                raise ApiError(422, "invalid_sleeve", "There is no such sleeve.")
        elif kind == "back":
            if value not in earned_backs(db, request, db.get_one(User, principal.user.id)):
                raise ApiError(
                    409, "not_earned", "Win that card back in the campaign before you use it."
                )
        else:
            raise ApiError(
                422, "invalid_sleeve", "A sleeve is sleeve:<id>, default:<slug> or back:<slug>."
            )
    deck.sleeve = choice
    db.commit()
    return DeckSleeve(sleeve=choice)


@router.post("/admin/sleeves/{sleeve_id}/remove", response_model=RemovedSleeve)
def remove_sleeve(
    sleeve_id: UUID, body: SleeveRemoval, request: Request, principal: CanManageReports, db: Db
) -> RemovedSleeve:
    """A moderator takes a reported sleeve off every table: it shows to nobody but staff, and
    the decks wearing it go back to the default. Audited."""
    row = db.get(CardSleeve, sleeve_id)
    if row is None:
        raise not_found()
    if row.removed_at is None:
        row.removed_at = utcnow()
        row.removed_by = principal.user.id
        row.removed_reason = body.reason
        forget(db, row.id)
        audit(
            db,
            request,
            "sleeves.removed",
            actor_id=principal.user.id,
            target_user_id=row.user_id,
            details={"sleeve": str(row.id), "name": row.name, "reason": body.reason},
        )
        db.commit()
    return RemovedSleeve(id=row.id, removed_at=row.removed_at)


def reported_sleeve(db: Session, principal: Principal, sleeve_id: UUID) -> CardSleeve:
    """A sleeve a report names: one that shows (live), not the reporter's own."""
    row = db.get(CardSleeve, sleeve_id)
    if not live(row) or row is None:
        raise not_found()
    if row.user_id == principal.user.id:
        raise ApiError(409, "own_sleeve", "That is your own sleeve.")
    return row
