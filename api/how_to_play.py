"""How to play (v0.8.6, docs/how-to-play.md): the guide's example cards, for anyone.

The guide is readable signed out, and its example cards are real cards: their printed images come
from the same Scryfall cache as the table's (api/card_images.py), by name. The table's route is for
signed-in accounts; this one serves the guide's own cards (content/how-to-play-cards.json) and no
others, to anyone, so it can never be used to fetch any other image through this server. Signed-out
visitors share one place in the Scryfall queue; the names are cached after their first fetch.
"""

import json
from functools import lru_cache
from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query, Request, Response

from api.auth import INPUT_ERRORS
from api.card_images import (
    IMAGE_CACHE_CONTROL,
    CardName,
    ImageSize,
    cache_of,
    media_type,
    missing,
    queue_account,
    release,
)
from api.identity import Db, OptionalPrincipal, settings_of

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

# The place in the Scryfall queue that every signed-out reader of the guide shares.
GUIDE_READERS = UUID("00000000-0000-0000-0000-000000000686")
CARDS_FILE = "how-to-play-cards.json"


@lru_cache(maxsize=4)
def guide_cards(content_dir: str) -> frozenset[str]:
    """The names of the guide's example cards."""
    data = json.loads((Path(content_dir) / CARDS_FILE).read_text(encoding="utf-8"))
    return frozenset(card["name"] for card in data["cards"].values())


@router.get(
    "/how-to-play/card-images",
    response_class=Response,
    responses={
        200: {
            "description": "The card's image.",
            "content": {
                "image/jpeg": {"schema": {"type": "string", "format": "binary"}},
                "image/png": {"schema": {"type": "string", "format": "binary"}},
            },
        }
    },
)
async def guide_card_image(
    request: Request,
    principal: OptionalPrincipal,
    db: Db,
    name: CardName,
    size: Annotated[ImageSize, Query()] = "normal",
) -> Response:
    """One of How to play's example cards by its exact name, signed in or not, from the server's
    Scryfall cache. 404 card_image_missing for any name that is not one of the guide's cards, as
    for a name Scryfall does not know."""
    if name not in guide_cards(settings_of(request).content_dir):
        cache_of(request).require_directory()
        raise missing()
    account = (
        queue_account(principal)
        if principal is not None and principal.user.status == "active"
        else GUIDE_READERS
    )
    # The sign-in's database connection goes back before any lookup, as the table's route does.
    await release(db)
    image = await cache_of(request).image(name, size, account)
    # Public: the same picture for everyone, so shared caches may keep it too.
    control = IMAGE_CACHE_CONTROL.replace("private", "public")
    return Response(image, media_type=media_type(image), headers={"Cache-Control": control})
