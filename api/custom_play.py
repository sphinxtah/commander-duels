"""The Godlike tier's custom cards in decks and at the table (v0.4.0).

The owner's custom cards (api/custom_cards.py) become playable in every game, practice games and
human tables alike, for accounts at the Godlike tier. Their rules live in a private engine plugin;
this repository holds no name, text or image of them, and its tests use made-up stand-ins.

- **Decks.** A Godlike account may put them in its decks like any card: drafts, revisions,
  validation (api/validation.py), statistics, import by name and export of its own decks. Copies
  follow the library (api/library.py). Below Godlike a deck holding one is collection-locked and
  shows it only as a hidden "Godlike card".
- **Nobody else** sees them in a deck list: shared decks, their exports and copies leave them out.
  Bots never play them.
- **At the table** they are public on the stack and the battlefield, so the image route serves a
  custom card's image to an account seated in, or allowed to observe, a game where some seat's deck
  holds it, as well as to Godlike accounts. Everyone else gets the answer any unknown name gets.
"""

from collections.abc import Iterable, Mapping
from datetime import timedelta
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from api.cards import CardSummary, mark_owned, summaries_by_id
from api.identity import Principal, utcnow
from api.library import Library, at_godlike
from api.models import CustomCard, Game, GameSeat
from api.validation import (
    CUSTOM_LEGAL,
    DeckEntry,
    custom_identity,
    custom_key,
    mana_value_of,
    symbol_colors,
)
from catalog.roles import roles
from catalog.text import colors_of, normalize

# What a deck shows of a custom card while its owner is below the Godlike tier.
HIDDEN_NAME = "Godlike card"
# Without a game named, an image is served for the account's running games and those that ended
# this long ago at most.
RECENT_GAMES = timedelta(days=1)


def image_url(card: CustomCard) -> str:
    return f"/api/v1/custom-cards/{card.id}/image?v={card.image_sha256[:12]}"


def custom_summary(card: CustomCard, library: Library) -> CardSummary:
    """A custom card as the deck builder shows it, for a Godlike account: legal in both formats,
    and playable once the running engine has loaded it."""
    found = roles(card.type_line, card.oracle_text, [])
    loaded = None if library.loaded is None else library.loaded.get(card.name.casefold())
    if loaded:
        status, reason, detail = "certified", None, None
    elif loaded is False:
        status, reason = "not_implemented", "not_loaded"
        detail = "Not loaded by this engine: a game here cannot play it."
    else:
        status, reason = "not_implemented", "engine_unchecked"
        detail = "The game engine could not be asked whether it has loaded this card."
    return CardSummary(
        id=card.id,
        name=card.name,
        layout="normal",
        mana_cost=card.mana_cost,
        mana_value=mana_value_of(card.mana_cost),
        type_line=card.type_line,
        oracle_text=card.oracle_text,
        power=card.power,
        toughness=card.toughness,
        loyalty=card.loyalty,
        defense=None,
        colors=colors_of(symbol_colors(card.mana_cost or "")),
        color_identity=colors_of(custom_identity(card.mana_cost, card.oracle_text)),
        keywords=[],
        produced_mana=[],
        faces=[],
        rarity=card.rarity,
        set_code=card.set_code,
        released_at=None,
        status=status,
        status_reason=reason,
        status_detail=detail,
        playable=loaded is True,
        text_differs=False,
        legalities=dict(CUSTOM_LEGAL),
        commander=found.commander,
        partner=found.partner,
        companion=found.companion,
        copy_limit=found.copy_limit,
        edhrec_rank=None,
        image=None,
        owned=library.owned(custom_key(card.id)),
        custom=True,
        custom_image=image_url(card),
    )


def hidden_summary(card_id: UUID) -> CardSummary:
    """A custom card in the deck of an owner below the Godlike tier: nothing of it but its ID."""
    return CardSummary(
        id=card_id,
        name=HIDDEN_NAME,
        layout="normal",
        mana_cost=None,
        mana_value=0,
        type_line="",
        oracle_text="",
        power=None,
        toughness=None,
        loyalty=None,
        defense=None,
        colors=[],
        color_identity=[],
        keywords=[],
        produced_mana=[],
        faces=[],
        rarity=None,
        set_code=None,
        released_at=None,
        status="not_implemented",
        status_reason="godlike_only",
        status_detail="Only an account at the Godlike tier may see or play this card.",
        playable=False,
        text_differs=False,
        legalities={"legacy": "not_legal", "commander": "not_legal"},
        commander=False,
        partner=None,
        companion=False,
        copy_limit=None,
        edhrec_rank=None,
        image=None,
        owned=None,
        custom=True,
    )


def deck_cards(db: Session, ids: set[UUID], library: Library) -> dict[UUID, CardSummary]:
    """The cards of a deck its owner is viewing: catalog cards with the copies the library
    holds, and custom cards as the owner's tier allows."""
    cards = summaries_by_id(db, ids)
    mark_owned(db, cards.values(), library)
    rest = ids - cards.keys()
    if rest:
        for card in db.scalars(select(CustomCard).where(CustomCard.id.in_(rest))):
            cards[card.id] = (
                custom_summary(card, library) if library.godlike else hidden_summary(card.id)
            )
    return cards


def custom_ids(db: Session, ids: Iterable[UUID]) -> set[UUID]:
    wanted = set(ids)
    if not wanted:
        return set()
    return set(db.scalars(select(CustomCard.id).where(CustomCard.id.in_(wanted))))


def without_custom(db: Session, entries: list[DeckEntry]) -> list[DeckEntry]:
    """A deck's entries as anyone but its owner sees them: no custom card."""
    custom = custom_ids(db, (entry.card_id for entry in entries))
    return [entry for entry in entries if entry.card_id not in custom]


def custom_by_name(db: Session) -> dict[str, tuple[UUID, str]]:
    """Every custom card by its normalized name, for a Godlike owner's import."""
    return {
        normalize(name): (card_id, name)
        for card_id, name in db.execute(select(CustomCard.id, CustomCard.name))
    }


def names_in(deck_list: object) -> set[str]:
    """The card names a seat's deck list holds, case aside, its sideboard's (v0.5.0) included."""
    if not isinstance(deck_list, Mapping):
        return set()
    found: set[str] = set()
    for card in [*(deck_list.get("cards") or []), *(deck_list.get("sideboard") or [])]:
        if isinstance(card, Mapping) and isinstance(card.get("name"), str):
            found.add(card["name"].casefold())
    for commander in deck_list.get("commanders") or []:
        if isinstance(commander, str):
            found.add(commander.casefold())
    return found


def custom_in_seats(db: Session, seats: list[dict[str, object]]) -> dict[int, list[str]]:
    """The custom cards each seat's deck list holds, by the seat's index; seats holding none are
    left out."""
    names = {name.casefold(): name for name in db.scalars(select(CustomCard.name))}
    held: dict[int, list[str]] = {}
    if not names:
        return held
    for index, seat in enumerate(seats):
        found = sorted(names[name] for name in names_in(seat.get("deck_list")) if name in names)
        if found:
            held[index] = found
    return held


def custom_named(db: Session, name: str) -> CustomCard | None:
    return db.scalar(select(CustomCard).where(CustomCard.name == name))


def may_see(db: Session, principal: Principal, card: CustomCard, game_id: UUID | None) -> bool:
    """Whether the account may see the card's image: at the Godlike tier, or seated in (or, for
    SysOp, observing) a game where some seat's deck holds it. Without a game named, the account's
    running games and those that ended in the last day count."""
    if at_godlike(db, principal.user.id):
        return True
    games = select(Game.id)
    if game_id is not None:
        games = games.where(Game.id == game_id)
    else:
        games = games.where(
            or_(Game.status == "active", Game.finished_at >= utcnow() - RECENT_GAMES)
        )
    if not principal.can("games.view_concealed"):
        games = games.where(
            Game.id.in_(select(GameSeat.game_id).where(GameSeat.user_id == principal.user.id))
        )
    wanted = card.name.casefold()
    lists = db.scalars(select(GameSeat.deck_list).where(GameSeat.game_id.in_(games)))
    return any(wanted in names_in(deck_list) for deck_list in lists)
