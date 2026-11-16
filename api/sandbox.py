"""The all-card practice sandbox (v1.0.0, the specification's section 19; docs/decks.md and
docs/games.md).

A player tests cards they do not own, against bots, in games that earn nothing. The owner's
decisions (2026-11-16): every player has it once its gate is open; a sandbox deck is its own
kind of deck (``decks.sandbox``), listed apart and played nowhere else, which its owner turns
into a normal deck once they own its cards; a sandbox game is started from the deck; and a
running sandbox game is restarted from its menu.

Where the pieces are:

- **Decks** (api/decks.py). A sandbox deck is validated against every card in the game in
  place of its owner's library (``library_for``). The Godlike tier's custom cards and the
  one-of-a-kind printings stay what an account must hold itself.
- **Games** (api/games.py). ``POST /practice-games`` with ``sandbox`` seats a sandbox deck
  (``sandbox_seat``) and makes the game in the mode ``sandbox`` (api/modes.py: it earns
  nothing, reward by reward, and its results are counted apart). ``own_deck`` refuses a
  sandbox deck everywhere else: a table, a queue, the campaign, a lent deck's offer. Its
  player switches the bots to passive, at the start or in the game. A restart is the game
  closed and played again (``POST /games/{id}/close``, then its rematch, which replays the
  request kept with the game).
- **Nothing is owned.** No route here writes a library grant: the cards a sandbox deck holds
  can reach neither a collection nor an auction.

Behind the gate ``sandbox``: while it is not an account's to reach, this module's route
answers as a path that does not exist, a sandbox deck cannot be made, and no sandbox game is
started.
"""

from uuid import UUID

from api import rollout
from api.auth import INPUT_ERRORS
from api.decks import (
    Builder,
    DeckDetail,
    convertible,
    deck_detail,
    entries_of,
    now,
    owned,
    store_draft,
)
from api.identity import ApiError, Db
from api.library import CurrentLibrary
from api.schemas import Error

router = rollout.router("sandbox", prefix="/api/v1", tags=["sandbox"], responses=INPUT_ERRORS)


@router.post(
    "/sandbox/decks/{deck_id}/convert",
    response_model=DeckDetail,
    responses={409: {"model": Error}},
)
def convert(deck_id: UUID, principal: Builder, library: CurrentLibrary, db: Db) -> DeckDetail:
    """Makes a sandbox deck a normal deck, once its owner's library holds every copy it plays.
    Its copies take the editions the library holds; from then on it is validated against the
    library and played wherever a deck is. It cannot be made a sandbox deck again: duplicate
    it as one instead."""
    deck = owned(db, principal, deck_id)
    if not deck.sandbox:
        raise ApiError(409, "not_a_sandbox_deck", f"{deck.title} is a normal deck already.")
    if not convertible(db, deck, library):
        raise ApiError(
            409,
            "cards_missing",
            f"{deck.title} holds cards your library does not: its Workshop lists them under "
            "Missing cards.",
        )
    deck.sandbox = False
    validation = store_draft(db, deck, entries_of(deck), library, switch=True)
    deck.updated_at = now()
    db.commit()
    return deck_detail(db, deck, library, validation)
