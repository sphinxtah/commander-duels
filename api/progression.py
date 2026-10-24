"""The Planeswalker Alliance (v0.3.1): wins, levels, alliances and the starter decks.

- **Wins** come only from committed results (PROG04, NET10): when the API records a game as
  finished with a winning seat that a player owns, the same transaction writes one ledger entry
  keyed by the game and seat, so a retry or a replay counts nothing twice (PROG03, PROG05). Wins
  against bots of any skill count, in either format; a turn limit, a concession, an idle timeout or
  a closed game has no winner. A Two-Headed Giant team wins together: each of its players' seats
  counts its own win (v0.5.1). SysOp starts at 100,000 wins and may set any account's wins, its own
  included; each setting is a ledger entry of its own with a reason, audited, and kept apart from
  counted wins.
- **Levels** are the tiers of api/roster.py, from the account's wins.
- **An alliance** joins one Planeswalker the account's tier has opened, at any time; its cards are
  in the library while it lasts (api/library.py), and since v0.4.2 the Cards page lists them on a
  tab of their own. The alliance's portrait is the account's picture.
- **Starter decks.** After choosing a handle, every player chooses two of the ten starter decks:
  both become decks of their own, and every copy of their cards joins the library for good.
"""

from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.auth import INPUT_ERRORS
from api.cards import CardSummary, image_of, mark_owned, summaries_by_id
from api.decks import create_deck, refresh_decks, starters_of
from api.identity import (
    Active,
    ApiError,
    Db,
    Principal,
    audit,
    not_found,
    permissions_for,
    refuse_deleted,
    require_permission,
    roles_of,
    utcnow,
)
from api.library import CurrentLibrary, Library, grant_starter, library_of, starter_entries
from api.models import CardConcept, CardPrinting, Game, GameSeat, ProgressEntry, User
from api.roster import (
    GODLIKE,
    TIERS,
    Planeswalker,
    Tier,
    TierId,
    alliance_cards,
    next_tier,
    roster_of,
    tier_of,
)
from api.schemas import Contract, StoredText
from catalog.statuses import in_game

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
Builder = Annotated[Principal, Depends(require_permission("decks.edit"))]
ProgressManager = Annotated[Principal, Depends(require_permission("progress.manage"))]
# The rule wins are counted under, recorded on each entry (PROG05).
POLICY = "wins-v1"
SYSOP_START = 100_000
MAX_WINS = 10_000_000


class TierInfo(Contract):
    id: TierId
    name: str
    wins: int = Field(description="The wins that reach this tier.")


class Progress(Contract):
    wins: int
    counted_wins: int = Field(description="Wins from games.")
    set_wins: int = Field(description="Wins SysOp set, apart from games.")
    tier: TierInfo
    next_tier: TierInfo | None
    alliance: str | None
    alliance_since: datetime | None
    tiers: list[TierInfo]


class PlaneswalkerInfo(Contract):
    id: str
    name: str
    tier: TierId
    wins: int = Field(description="The wins that open it.")
    open: bool = Field(description="Whether your tier has opened it.")
    portrait: bool = Field(description="Whether it has a portrait (web/public/portraits).")
    description: str | None
    first_card: str | None
    cards: int = Field(description="Its Planeswalker cards in the catalog.")
    playable_cards: int = Field(description="Of those, the ones a game can be played with.")
    custom: bool


class AllianceChange(Contract):
    planeswalker: str = Field(min_length=1, max_length=48)


class StarterChoice(Contract):
    decks: list[Annotated[str, Field(min_length=1, max_length=64)]] = Field(
        min_length=2, max_length=2
    )


class StarterResult(Contract):
    decks: list[UUID] = Field(description="The two new decks.")


class LibraryEdition(Contract):
    """The edition (printing) a library item holds (v0.5.0)."""

    printing_id: UUID
    set_code: str
    set_name: str
    collector_number: str
    released_at: date | None
    rarity: str


class LibraryFinishes(Contract):
    """An edition's copies by finish (v0.6.0)."""

    nonfoil: int = 0
    foil: int = 0
    etched: int = 0


class LibraryCard(Contract):
    card: CardSummary = Field(
        description="The card, its image that of the edition (v0.5.0); owned counts every "
        "edition of it."
    )
    edition: LibraryEdition = Field(description="The edition these copies are (v0.5.0).")
    copies: int | None = Field(description="Copies owned of this edition.")
    sources: list[Literal["starter", "grandfathered", "alliance", "pack", "unique", "auction"]] = (
        Field(description="Where this edition's copies came from.")
    )
    finishes: LibraryFinishes = Field(
        description="The copies held now in each finish (v0.6.0), after the auction house: "
        "those listed or sold are out, those bought are in; an alliance's are nonfoil.",
    )
    sellable: int = Field(
        description="Copies that may be listed at Tivit's Auction House (v0.6.0): granted ones, "
        "never an alliance's.",
    )


class LibraryView(Contract):
    unlimited: bool = Field(description="Builds from the whole catalog (administrators, SysOp).")
    alliance: str | None
    cards: list[LibraryCard]


class AllianceCards(Contract):
    alliance: str | None = Field(
        description="The allied Planeswalker, or the one asked for (GET /planeswalkers/{id}/cards, "
        "v0.6.2); null with no alliance."
    )
    name: str | None
    custom: bool = Field(
        description="The Godlike tier's Planeswalker, whose cards are its custom cards "
        "(GET /api/v1/custom-cards), none from the catalog."
    )
    cards: list[CardSummary] = Field(
        description="Its own Planeswalker cards a game can play, one per card (since v0.4.5, "
        "the only ones shown)."
    )


class WinsChange(Contract):
    wins: int = Field(ge=0, le=MAX_WINS)
    reason: Annotated[StoredText, Field(min_length=3, max_length=200)]


def tier_info(tier: Tier) -> TierInfo:
    return TierInfo(id=tier.id, name=tier.name, wins=tier.wins)


def wins_of(db: Session, user_id: UUID) -> tuple[int, int]:
    """Counted wins and set wins."""
    rows = dict(
        db.execute(
            select(ProgressEntry.kind, func.coalesce(func.sum(ProgressEntry.wins), 0))
            .where(ProgressEntry.user_id == user_id)
            .group_by(ProgressEntry.kind)
        ).all()
    )
    return int(rows.get("game_win", 0)), int(rows.get("wins_set", 0))


def total_wins(db: Session, user_id: UUID) -> int:
    counted, set_ = wins_of(db, user_id)
    return counted + set_


def progress_of(db: Session, user: User) -> Progress:
    counted, set_ = wins_of(db, user.id)
    tier = tier_of(counted + set_)
    following = next_tier(tier)
    return Progress(
        wins=counted + set_,
        counted_wins=counted,
        set_wins=set_,
        tier=tier_info(tier),
        next_tier=tier_info(following) if following else None,
        alliance=user.alliance,
        alliance_since=user.alliance_since,
        tiers=[tier_info(found) for found in TIERS],
    )


def godlike(db: Session, user: User) -> bool:
    return total_wins(db, user.id) >= GODLIKE.wins


def winning_seats(result: dict[str, object]) -> list[int]:
    """Every seat that won a completed game: the winner, or in Two-Headed Giant (v0.5.0) the
    winning team, whose players win together (810.8a). None for a game without a winner."""
    winner = result.get("winner_seat")
    if result.get("kind") != "completed" or not isinstance(winner, int):
        return []
    team = result.get("winner_seats")
    if isinstance(team, list) and team:
        return sorted({seat for seat in team if isinstance(seat, int)} | {winner})
    return [winner]


def count_win(db: Session, game: Game) -> None:
    """The game's win for each player's seat that won it: one entry a seat, in the caller's
    transaction. Since v0.5.1 both players of a winning Two-Headed Giant team count theirs."""
    for seat in winning_seats(game.result or {}):
        owner = db.scalar(
            select(GameSeat.user_id).where(GameSeat.game_id == game.id, GameSeat.seat == seat)
        )
        key = f"win:{game.id}:{seat}"
        if owner is None or db.scalar(select(ProgressEntry.id).where(ProgressEntry.key == key)):
            continue
        db.add(
            ProgressEntry(
                user_id=owner,
                kind="game_win",
                wins=1,
                key=key,
                game_id=game.id,
                policy=POLICY,
                created_at=utcnow(),
            )
        )


def set_wins(
    db: Session, user: User, wins: int, reason: str, actor: User | None
) -> tuple[int, int]:
    """Sets the account's wins by adding the difference as a setting; returns before and after."""
    before = total_wins(db, user.id)
    if wins != before:
        db.add(
            ProgressEntry(
                user_id=user.id,
                kind="wins_set",
                wins=wins - before,
                key=f"set:{uuid4()}",
                policy=POLICY,
                reason=reason,
                actor_id=actor.id if actor else None,
                created_at=utcnow(),
            )
        )
    return before, wins


def sysop_start(db: Session, sysop: User) -> None:
    """SysOp's 100,000 starting wins, once."""
    if db.scalar(select(ProgressEntry.id).where(ProgressEntry.key == "set:sysop-start")) is None:
        db.add(
            ProgressEntry(
                user_id=sysop.id,
                kind="wins_set",
                wins=SYSOP_START,
                key="set:sysop-start",
                policy=POLICY,
                reason="SysOp starts at 100,000 wins",
                created_at=utcnow(),
            )
        )


# Routes.


@router.get("/me/progress", response_model=Progress)
def my_progress(principal: Active, db: Db) -> Progress:
    return progress_of(db, principal.user)


@router.get("/planeswalkers", response_model=list[PlaneswalkerInfo])
def planeswalkers(request: Request, principal: Active, db: Db) -> list[PlaneswalkerInfo]:
    """The roster, with what the account's tier has opened."""
    roster = roster_of(request)
    tier = tier_of(total_wins(db, principal.user.id))
    cards = alliance_cards(db, roster)
    statuses = dict(
        db.execute(
            select(CardConcept.id, CardConcept.status).where(
                CardConcept.id.in_({card for found in cards.values() for card in found})
            )
        ).all()
    )
    return [
        PlaneswalkerInfo(
            id=planeswalker.id,
            name=planeswalker.name,
            tier=planeswalker.tier,
            wins=planeswalker.threshold,
            open=planeswalker.opened_by(tier),
            portrait=planeswalker.portrait,
            description=planeswalker.description,
            first_card=planeswalker.first_card,
            cards=len(cards.get(planeswalker.id, [])),
            playable_cards=sum(
                1 for card in cards.get(planeswalker.id, []) if statuses.get(card) == "certified"
            ),
            custom=planeswalker.custom,
        )
        for planeswalker in roster.values()
    ]


def allied(
    request: Request, db: Session, principal: Principal, planeswalker: Planeswalker | None
) -> Progress:
    user = principal.user
    before = user.alliance
    user.alliance = planeswalker.id if planeswalker else None
    user.alliance_since = utcnow() if planeswalker else None
    user.updated_at = utcnow()
    db.flush()
    library = library_of(db, user, principal.permissions, roster_of(request))
    refresh_decks(db, user.id, library)
    audit(
        db,
        request,
        "alliance.joined" if planeswalker else "alliance.left",
        actor_id=user.id,
        target_user_id=user.id,
        details={"from": before, "to": user.alliance},
    )
    db.commit()
    return progress_of(db, user)


@router.put("/me/alliance", response_model=Progress)
def join_alliance(body: AllianceChange, request: Request, principal: Active, db: Db) -> Progress:
    """Allies with a Planeswalker the account's tier has opened, leaving any other alliance."""
    planeswalker = roster_of(request).get(body.planeswalker)
    if planeswalker is None:
        raise not_found()
    tier = tier_of(total_wins(db, principal.user.id))
    if not planeswalker.opened_by(tier):
        raise ApiError(
            403,
            "alliance_locked",
            f"{planeswalker.name} opens at {planeswalker.threshold:,} wins.",
        )
    if principal.user.alliance == planeswalker.id:
        return progress_of(db, principal.user)
    return allied(request, db, principal, planeswalker)


@router.delete("/me/alliance", response_model=Progress)
def leave_alliance(request: Request, principal: Active, db: Db) -> Progress:
    if principal.user.alliance is None:
        return progress_of(db, principal.user)
    return allied(request, db, principal, None)


@router.post("/me/starters", response_model=StarterResult, status_code=201)
def choose_starters(
    body: StarterChoice, request: Request, principal: Builder, db: Db
) -> StarterResult:
    """The two starter decks: each becomes a deck of the player's own, and every copy of their
    cards joins the library for good. Chosen once."""
    user = principal.user
    if user.starter_decks is not None:
        raise ApiError(409, "starters_chosen", "Your starter decks are already chosen.")
    if user.onboarding == "handle":
        raise ApiError(409, "handle_first", "Choose your handle first.")
    first, second = body.decks
    if first == second:
        raise ApiError(422, "same_starter", "Choose two different starter decks.")
    found = starters_of(request)
    chosen = [found.get(first), found.get(second)]
    if None in chosen:
        raise not_found()
    # The account's row is locked, so two requests at once choose once.
    db.scalar(select(User.id).where(User.id == user.id).with_for_update())
    db.refresh(user)
    if user.starter_decks is not None:
        raise ApiError(409, "starters_chosen", "Your starter decks are already chosen.")
    roster = roster_of(request)
    decks = []
    for starter in chosen:
        assert starter is not None
        entries, missing = starter_entries(db, starter)
        if missing:
            raise ApiError(
                503,
                "starters_unavailable",
                "The card catalog is not ready for the starter decks yet. Try again later.",
            )
        grant_starter(db, user, starter, entries)
        db.flush()
        library = library_of(db, user, principal.permissions, roster)
        deck, _ = create_deck(
            db, principal, starter.title, "commander", entries, library, source="starter"
        )
        decks.append(deck.id)
    user.starter_decks = [first, second]
    if user.onboarding == "starters":
        user.onboarding = "complete"
    user.updated_at = utcnow()
    db.flush()
    refresh_decks(db, user.id, library_of(db, user, principal.permissions, roster))
    audit(
        db,
        request,
        "library.starters_chosen",
        actor_id=user.id,
        target_user_id=user.id,
        details={"decks": [first, second]},
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ApiError(409, "starters_chosen", "Your starter decks are already chosen.") from None
    return StarterResult(decks=decks)


@router.get("/library", response_model=LibraryView)
def my_library(principal: Active, library: CurrentLibrary, db: Db) -> LibraryView:
    """The cards in the account's library, one item per card and edition (v0.5.0), each with the
    edition's image, its copies and where they came from. An account that builds from the whole
    catalog has no list here. Copies of a card out of the game stay recorded but are not shown
    (v0.4.5); since v0.6.2 a stand-in is in the game, and shown with its badge."""
    if library.unlimited:
        return LibraryView(unlimited=True, alliance=library.alliance, cards=[])
    held = {printing_id for printing_id, edition in library.editions.items() if edition.copies}
    printings = {
        printing.id: printing
        for printing in db.scalars(
            select(CardPrinting)
            .join(CardConcept, CardConcept.id == CardPrinting.concept_id)
            .where(CardPrinting.id.in_(held), in_game())
        )
    }
    summaries = summaries_by_id(db, {printing.concept_id for printing in printings.values()})
    mark_owned(db, summaries.values(), library)
    cards = []
    for printing in printings.values():
        edition = library.editions[printing.id]
        card = summaries[printing.concept_id].model_copy(
            update={
                "image": image_of(printing),
                "rarity": printing.rarity,
                "set_code": printing.set_code,
            }
        )
        cards.append(
            LibraryCard(
                card=card,
                edition=LibraryEdition(
                    printing_id=printing.id,
                    set_code=printing.set_code,
                    set_name=printing.set_name,
                    collector_number=printing.collector_number,
                    released_at=printing.released_at,
                    rarity=printing.rarity,
                ),
                copies=edition.copies,
                sources=sorted(edition.sources),  # type: ignore[arg-type]
                finishes=LibraryFinishes(**library.finishes.get(printing.id, {})),
                sellable=library.sellable.get(printing.id, 0),
            )
        )
    # By name, and a card's editions newest first.
    cards.sort(
        key=lambda item: (
            item.card.name.casefold(),
            -(item.edition.released_at or date.min).toordinal(),
            item.edition.set_code,
            item.edition.collector_number,
        )
    )
    return LibraryView(unlimited=False, alliance=library.alliance, cards=cards)


def planeswalker_cards(
    db: Session, roster: dict[str, Planeswalker], planeswalker: Planeswalker, library: Library
) -> AllianceCards:
    """A Planeswalker's own cards in the game (the stand-ins too since v0.6.2), one per card, each with the copies the library
    holds. The Godlike tier's Planeswalker has none from the catalog: its custom cards are only
    GET /custom-cards, for a Godlike account allied with it."""
    ids = alliance_cards(db, roster).get(planeswalker.id, [])
    # One card per construction key, as the library counts them: the one with a default printing.
    chosen: dict[str, UUID] = {}
    for card_id, key in db.execute(
        select(CardConcept.id, CardConcept.construction_key)
        .where(CardConcept.id.in_(ids), in_game())
        .order_by(CardConcept.default_printing_id.is_(None), CardConcept.normalized_name)
    ):
        chosen.setdefault(key, card_id)
    summaries = summaries_by_id(db, set(chosen.values()))
    mark_owned(db, summaries.values(), library)
    return AllianceCards(
        alliance=planeswalker.id,
        name=planeswalker.name,
        custom=planeswalker.custom,
        cards=sorted(summaries.values(), key=lambda card: card.name.casefold()),
    )


@router.get("/me/alliance/cards", response_model=AllianceCards)
def my_alliance_cards(
    request: Request, principal: Active, library: CurrentLibrary, db: Db
) -> AllianceCards:
    """The allied Planeswalker's own cards (v0.4.2), which the Cards page's alliance tab shows, for
    every account, those that build from the whole catalog included: each says how many copies
    the library holds (a playset while the alliance lasts, or more from elsewhere). Only cards a
    game can play (v0.4.5)."""
    roster = roster_of(request)
    planeswalker = roster.get(library.alliance) if library.alliance else None
    if planeswalker is None:
        return AllianceCards(alliance=None, name=None, custom=False, cards=[])
    return planeswalker_cards(db, roster, planeswalker, library)


@router.get("/planeswalkers/{planeswalker_id}/cards", response_model=AllianceCards)
def a_planeswalkers_cards(
    planeswalker_id: str, request: Request, principal: Active, library: CurrentLibrary, db: Db
) -> AllianceCards:
    """Any Planeswalker's own cards (v0.6.2), so the alliance picker shows what an alliance brings
    before it is chosen, locked ones included: the same list the alliance tab shows once allied,
    with the copies the library holds now. The Godlike tier's custom cards stay private: for The
    Sphinx it says `custom` and lists none."""
    roster = roster_of(request)
    planeswalker = roster.get(planeswalker_id)
    if planeswalker is None:
        raise not_found()
    return planeswalker_cards(db, roster, planeswalker, library)


@router.post("/admin/users/{user_id}/wins", response_model=Progress)
def change_wins(
    user_id: UUID, body: WinsChange, request: Request, principal: ProgressManager, db: Db
) -> Progress:
    """SysOp sets an account's wins, and so its level: any player's, or its own. The setting is a
    ledger entry of its own, apart from counted wins, with the reason, and is audited (PROG03)."""
    user = db.get(User, user_id)
    if user is None or (user.kind == "sysop" and user.id != principal.user.id):
        raise not_found()
    refuse_deleted(user)
    before, after = set_wins(db, user, body.wins, body.reason, principal.user)
    if (before >= GODLIKE.wins) != (after >= GODLIKE.wins):
        # The custom cards open or close with the Godlike tier (v0.4.0): the account's decks
        # holding them are revalidated, as after any other change to a library.
        db.flush()
        permissions = permissions_for(user, roles_of(db, user))
        refresh_decks(db, user.id, library_of(db, user, permissions, roster_of(request)))
    if before != after:
        audit(
            db,
            request,
            "progress.wins_set",
            actor_id=principal.user.id,
            target_user_id=user.id,
            details={"from": before, "to": after, "reason": body.reason},
        )
    # An alliance stays when lowered wins no longer open it: it was a choice the tier allowed.
    db.commit()
    return progress_of(db, user)


def admin_progress(db: Session, user: User) -> tuple[int, TierId]:
    wins = total_wins(db, user.id)
    return wins, tier_of(wins).id
