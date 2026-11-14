"""The deck workshop's foundations (v0.9.12, the specification's section 12; docs/decks.md).

What v1.0.0's deck workshop stands on, as services with their contracts and no page of their own
yet:

- **Folders and tags.** A deck is kept in one folder, by its name, and under any tags; the deck
  list filters by either, the shelves count both, and one request organizes several decks at
  once, all of them or none.
- **Versions.** Two saved versions of a deck, or a version and the draft, are compared card by
  card; a version is restored into the draft, which is a new draft and never a changed version:
  a revision is immutable (PostgreSQL refuses its update), so a game that played it keeps it.
- **Performance.** A deck's results, in all and by the version played, from the results the
  games recorded (player_results, by the revision its seat was bound to): each record with its
  sample size, and told apart by format, mode, opposition and the bots' skill. A result granted
  for testing names no game, and so no deck: it is in none of them.
- **Wishlist and missing cards.** The cards an account wants; and for a deck, what its library
  lacks, with where each might be had: the auctions open for it and the shop's packs that may
  hold it.
- **Substitutions.** For a card of a deck, the cards the library holds that could take its place,
  each with why: only cards the engine plays as written, legal in the deck's format, within its
  commanders' colour identity, with a copy the deck does not already use.
"""

from collections import defaultdict
from collections.abc import Iterable
from datetime import datetime
from typing import Annotated, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Query
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.auth import INPUT_ERRORS
from api.cards import CardSummary
from api.custom_play import deck_cards
from api.decks import (
    Builder,
    DeckSummary,
    DraftSaved,
    deck_summary,
    entries_of,
    now,
    owned,
    revision_entries,
    store_draft,
)
from api.identity import Active, ApiError, Db, not_found
from api.library import CurrentLibrary, Library
from api.models import (
    Auction,
    CardConcept,
    CardPrinting,
    CardTag,
    CardTagLink,
    CustomCard,
    Deck,
    DeckRevision,
    GameSeat,
    PlayerResult,
    ShopProduct,
    User,
    WishlistEntry,
)
from api.schemas import Contract, Error, StoredText
from api.validation import Card, DeckEntry, cards_of, rules_of
from catalog.text import normalize

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

MAX_TAGS = 12
MAX_ORGANIZED = 250
# Under this many games a record says little: the response says so.
SMALL_SAMPLE = 10
MAX_SUBSTITUTES = 8
# A substitute scores at least this: its type and mana value together, or tags enough.
MIN_LIKENESS = 40
# Tagger tags that say nothing of what a card does: its name, its history, the cycle it is of.
TAGS_APART = frozenset(
    {"meme", "alliteration", "portmanteau", "eponymous", "misnomer", "fun-ruling", "interrupt"}
)
TAG_PREFIXES_APART = ("cycle-", "type-errata", "unique-")
TAG_SUFFIXES_APART = ("-name", "-names")
Folder = Annotated[StoredText, Field(min_length=1, max_length=64)]
Tag = Annotated[StoredText, Field(min_length=1, max_length=32)]
COUNTED = ("commander", "companion", "main", "sideboard")


def clean_tags(tags: Iterable[str]) -> list[str]:
    """The tags once each, case aside, in the order given."""
    kept: dict[str, str] = {}
    for tag in tags:
        kept.setdefault(tag.casefold(), tag)
    return list(kept.values())


# Folders and tags.


class Shelf(Contract):
    name: str
    decks: int


class Shelves(Contract):
    folders: list[Shelf]
    tags: list[Shelf]
    unfiled: int = Field(description="Decks in no folder.")


class Organize(Contract):
    deck_ids: list[UUID] = Field(min_length=1, max_length=MAX_ORGANIZED)
    folder: Folder | None = Field(
        default=None, description="The folder to move them into; left out, they stay."
    )
    unfile: bool = Field(default=False, description="Take them out of their folders.")
    add_tags: list[Tag] = Field(default_factory=list, max_length=MAX_TAGS)
    remove_tags: list[Tag] = Field(default_factory=list, max_length=MAX_TAGS)


def kept_decks(db: Session, user_id: UUID) -> list[Deck]:
    return list(
        db.scalars(
            select(Deck).where(
                Deck.owner_id == user_id, Deck.deleted_at.is_(None), Deck.purged_at.is_(None)
            )
        )
    )


@router.get("/decks/shelves", response_model=Shelves)
def shelves(principal: Builder, db: Db) -> Shelves:
    """The account's folders and tags, each with how many of its decks it holds (the trash
    apart)."""
    folders: dict[str, int] = defaultdict(int)
    tags: dict[str, int] = defaultdict(int)
    unfiled = 0
    for deck in kept_decks(db, principal.user.id):
        if deck.folder:
            folders[deck.folder] += 1
        else:
            unfiled += 1
        for tag in deck.tags or []:
            tags[tag] += 1
    return Shelves(
        folders=[Shelf(name=name, decks=count) for name, count in sorted(folders.items())],
        tags=[Shelf(name=name, decks=count) for name, count in sorted(tags.items())],
        unfiled=unfiled,
    )


@router.post("/decks/organize", response_model=list[DeckSummary])
def organize(body: Organize, principal: Builder, db: Db) -> list[DeckSummary]:
    """Moves several decks into a folder, or out of theirs, and adds or removes tags on all of
    them: every deck named must be the account's and out of the trash, or nothing changes."""
    if body.folder is not None and body.unfile:
        raise ApiError(422, "invalid_request", "Name a folder, or take the decks out of theirs.")
    wanted = list(dict.fromkeys(body.deck_ids))
    decks = {
        deck.id: deck
        for deck in db.scalars(
            select(Deck)
            .where(
                Deck.id.in_(wanted),
                Deck.owner_id == principal.user.id,
                Deck.deleted_at.is_(None),
            )
            .with_for_update()
        )
    }
    if len(decks) != len(wanted):
        raise not_found()
    removing = {tag.casefold() for tag in body.remove_tags}
    for deck in decks.values():
        tags = [tag for tag in deck.tags or [] if tag.casefold() not in removing]
        tags = clean_tags([*tags, *body.add_tags])
        if len(tags) > MAX_TAGS:
            raise ApiError(
                422, "too_many_tags", f"{deck.title} would have more than {MAX_TAGS} tags."
            )
    for deck in decks.values():
        if body.folder is not None:
            deck.folder = body.folder
        elif body.unfile:
            deck.folder = None
        tags = [tag for tag in deck.tags or [] if tag.casefold() not in removing]
        deck.tags = clean_tags([*tags, *body.add_tags]) or None
    db.commit()
    return [deck_summary(db, decks[deck_id]) for deck_id in wanted]


# Versions: comparing two, and restoring one into the draft.


class DiffLine(Contract):
    card_id: UUID
    name: str
    location: str
    before: int = Field(description="Copies in the earlier side; 0 for a card added.")
    after: int = Field(description="Copies in the later side; 0 for a card removed.")


class DeckDiff(Contract):
    deck_id: UUID
    before: str = Field(description='The earlier side: a version\'s number, or "draft".')
    after: str
    added: int = Field(description="Copies the later side holds that the earlier does not.")
    removed: int
    same: bool = Field(description="The two hold the same cards in the same places.")
    lines: list[DiffLine] = Field(
        description="Each card and place whose copies differ, by place then name. Another "
        "edition of the same card is no difference."
    )


Side = Annotated[str, Query(pattern=r"^(draft|[1-9][0-9]{0,5})$")]


def revision_of(db: Session, deck: Deck, number: int) -> DeckRevision:
    revision = db.scalar(
        select(DeckRevision).where(DeckRevision.deck_id == deck.id, DeckRevision.number == number)
    )
    if revision is None:
        raise not_found()
    return revision


def side_entries(db: Session, deck: Deck, side: str) -> list[DeckEntry]:
    if side == "draft":
        return entries_of(deck)
    return revision_entries(db, revision_of(db, deck, int(side)))


def names_of(db: Session, ids: set[UUID]) -> dict[UUID, str]:
    """Each card's name: the catalog's, or a custom card's."""
    if not ids:
        return {}
    names = dict(
        db.execute(select(CardConcept.id, CardConcept.name).where(CardConcept.id.in_(ids))).all()
    )
    missing = ids - names.keys()
    if missing:
        names.update(
            db.execute(select(CustomCard.id, CustomCard.name).where(CustomCard.id.in_(missing)))
            .tuples()
            .all()
        )
    return names


def diff(db: Session, deck: Deck, before: str, after: str) -> DeckDiff:
    def counts(entries: list[DeckEntry]) -> dict[tuple[UUID, str], int]:
        found: dict[tuple[UUID, str], int] = defaultdict(int)
        for entry in entries:
            found[(entry.card_id, entry.location)] += entry.quantity
        return found

    earlier, later = (
        counts(side_entries(db, deck, before)),
        counts(side_entries(db, deck, after)),
    )
    changed = [key for key in earlier.keys() | later.keys() if earlier.get(key) != later.get(key)]
    names = names_of(db, {card_id for card_id, _ in changed})
    lines = sorted(
        (
            DiffLine(
                card_id=card_id,
                name=names.get(card_id, "A card no longer in the game"),
                location=location,
                before=earlier.get((card_id, location), 0),
                after=later.get((card_id, location), 0),
            )
            for card_id, location in changed
        ),
        key=lambda line: (line.location, normalize(line.name), str(line.card_id)),
    )
    return DeckDiff(
        deck_id=deck.id,
        before=before,
        after=after,
        added=sum(max(0, line.after - line.before) for line in lines),
        removed=sum(max(0, line.before - line.after) for line in lines),
        same=not lines,
        lines=lines,
    )


@router.get("/decks/{deck_id}/diff", response_model=DeckDiff)
def compare(
    deck_id: UUID, principal: Builder, db: Db, before: Side, after: Side = "draft"
) -> DeckDiff:
    """Two saved versions of the deck compared, or a version and the draft: `before` and `after`
    are each a version's number or "draft"."""
    return diff(db, owned(db, principal, deck_id), before, after)


class Restore(Contract):
    version: int = Field(ge=1, description="The draft version this restore starts from.")


@router.post(
    "/decks/{deck_id}/revisions/{number}/restore",
    response_model=DraftSaved,
    responses={409: {"model": Error}},
)
def restore_revision(
    deck_id: UUID,
    number: int,
    body: Restore,
    principal: Builder,
    library: CurrentLibrary,
    db: Db,
) -> DraftSaved:
    """Makes a saved version the draft again. The version is copied, never changed: it stays as
    the games that played it knew it, and the draft takes a new version of its own, saved like any
    other (the editions the library holds, the cards the game still plays). Refused, as an
    autosave is, when the draft changed since the request's `version`."""
    deck = db.scalar(select(Deck).where(Deck.id == deck_id).with_for_update())
    if deck is None or deck.owner_id != principal.user.id or deck.deleted_at is not None:
        raise not_found()
    revision = revision_of(db, deck, number)
    if body.version != deck.draft_version:
        raise ApiError(
            409,
            "draft_conflict",
            "This deck changed in another tab or window. Look at it again, then restore the "
            "version if you still want it.",
        )
    validation = store_draft(db, deck, revision_entries(db, revision), library)
    deck.draft_version += 1
    db.commit()
    entries = entries_of(deck)
    return DraftSaved(
        version=deck.draft_version,
        updated_at=deck.updated_at,
        entries=entries,
        validation=validation,
        cards=deck_cards(db, {entry.card_id for entry in entries}, library),
    )


# Performance: a deck's results, in all and by the version played.

Opposition = Literal["bots", "players", "mixed"]


class Record(Contract):
    games: int = Field(description="The sample: games that ended with a result.")
    wins: int
    losses: int
    draws: int
    win_rate: float | None = Field(description="Wins over games, 0 to 1; null with no game.")
    small_sample: bool = Field(description=f"Fewer than {SMALL_SAMPLE} games: it says little.")


class Split(Record):
    format: str
    mode: str = Field(description="The game's mode (api/modes.py): practice, table, campaign…")
    opposition: Opposition = Field(
        description="bots: no other player; players: no bot; mixed: both."
    )
    bot_skill: int | None = Field(description="The bots' skill, when the game had bots.")


class VersionRecord(Contract):
    number: int
    title: str
    created_at: datetime
    record: Record
    splits: list[Split]


class Performance(Contract):
    deck_id: UUID
    record: Record
    splits: list[Split] = Field(
        description="The record told apart by format, mode, opposition and the bots' skill."
    )
    versions: list[VersionRecord] = Field(
        description="By the version played, the newest first; a version never played is left out."
    )


class Tally:
    def __init__(self) -> None:
        self.wins = self.losses = self.draws = 0

    def add(self, outcome: str) -> None:
        if outcome == "win":
            self.wins += 1
        elif outcome == "loss":
            self.losses += 1
        elif outcome == "draw":
            self.draws += 1

    @property
    def games(self) -> int:
        return self.wins + self.losses + self.draws

    def record(self) -> Record:
        games = self.games
        return Record(
            games=games,
            wins=self.wins,
            losses=self.losses,
            draws=self.draws,
            win_rate=round(self.wins / games, 4) if games else None,
            small_sample=games < SMALL_SAMPLE,
        )


SplitKey = tuple[str, str, str, int | None]


def opposition_of(players: int, bots: int) -> Opposition:
    if bots == 0:
        return "players"
    return "bots" if players <= 1 else "mixed"


def split_rows(splits: dict[SplitKey, Tally]) -> list[Split]:
    return [
        Split(
            format=fmt,
            mode=mode,
            opposition=cast(Opposition, against),
            bot_skill=skill,
            **tally.record().model_dump(),
        )
        for (fmt, mode, against, skill), tally in sorted(
            splits.items(), key=lambda item: (item[0][0], item[0][1], item[0][2], item[0][3] or 0)
        )
    ]


def performance(db: Session, deck: Deck) -> Performance:
    """The deck's record from the results its games recorded: a result counts for the version its
    seat was bound to when the game started, whatever the draft or its versions became since."""
    rows = db.execute(
        select(
            DeckRevision.number,
            PlayerResult.outcome,
            PlayerResult.format,
            PlayerResult.mode,
            PlayerResult.kind,
            PlayerResult.players,
            PlayerResult.bots,
            PlayerResult.bot_skill,
        )
        .select_from(PlayerResult)
        .join(
            GameSeat,
            (GameSeat.game_id == PlayerResult.game_id) & (GameSeat.seat == PlayerResult.seat),
        )
        .join(DeckRevision, DeckRevision.id == GameSeat.deck_revision_id)
        .where(
            DeckRevision.deck_id == deck.id,
            PlayerResult.user_id == deck.owner_id,
            PlayerResult.outcome != "no_result",
        )
    )
    total = Tally()
    splits: dict[SplitKey, Tally] = defaultdict(Tally)
    by_version: dict[int, Tally] = defaultdict(Tally)
    version_splits: dict[int, dict[SplitKey, Tally]] = defaultdict(lambda: defaultdict(Tally))
    for number, outcome, fmt, mode, kind, players, bots, skill in rows:
        key: SplitKey = (
            fmt,
            mode or kind,
            opposition_of(players, bots),
            skill if bots else None,
        )
        for tally in (total, splits[key], by_version[number], version_splits[number][key]):
            tally.add(outcome)
    revisions = {
        revision.number: revision
        for revision in db.scalars(
            select(DeckRevision).where(
                DeckRevision.deck_id == deck.id, DeckRevision.number.in_(by_version)
            )
        )
    }
    return Performance(
        deck_id=deck.id,
        record=total.record(),
        splits=split_rows(splits),
        versions=[
            VersionRecord(
                number=number,
                title=revisions[number].title,
                created_at=revisions[number].created_at,
                record=by_version[number].record(),
                splits=split_rows(version_splits[number]),
            )
            for number in sorted(by_version, reverse=True)
        ],
    )


@router.get("/decks/{deck_id}/performance", response_model=Performance)
def deck_performance(deck_id: UUID, principal: Builder, db: Db) -> Performance:
    """The deck's results, in all and by the version played, each with its sample size."""
    return performance(db, owned(db, principal, deck_id))


# The wishlist, and what a deck's library lacks.


class Wish(Contract):
    card: CardSummary
    quantity: int
    deck_id: UUID | None = Field(description="The deck it is wanted for, when one was named.")
    owned: int | None = Field(description="Copies the library holds; null: the whole catalog.")


class Wishlist(Contract):
    wishes: list[Wish]


class WishSet(Contract):
    quantity: int = Field(default=1, ge=1, le=250)
    deck_id: UUID | None = None


def wishlist_of(db: Session, user: User, library: Library) -> Wishlist:
    rows = list(
        db.scalars(
            select(WishlistEntry)
            .where(WishlistEntry.user_id == user.id)
            .order_by(WishlistEntry.created_at, WishlistEntry.id)
        )
    )
    cards = deck_cards(db, {row.card_id for row in rows}, library)
    return Wishlist(
        wishes=[
            Wish(
                card=cards[row.card_id],
                quantity=row.quantity,
                deck_id=row.deck_id,
                owned=cards[row.card_id].owned,
            )
            for row in rows
            if row.card_id in cards
        ]
    )


@router.get("/me/wishlist", response_model=Wishlist)
def my_wishlist(principal: Active, library: CurrentLibrary, db: Db) -> Wishlist:
    """The cards the account wants, in the order it wished for them."""
    return wishlist_of(db, principal.user, library)


@router.put("/me/wishlist/{card_id}", response_model=Wishlist)
def wish(
    card_id: UUID, body: WishSet, principal: Active, library: CurrentLibrary, db: Db
) -> Wishlist:
    """Wishes for a card, or changes the wish: how many copies, and for which of the account's
    decks. One wish a card."""
    card = db.get(CardConcept, card_id)
    if card is None or not card.deck_card:
        raise ApiError(404, "unknown_card", "The catalog has no such card.")
    if body.deck_id is not None:
        deck = db.get(Deck, body.deck_id)
        if deck is None or deck.owner_id != principal.user.id or deck.deleted_at is not None:
            raise not_found()
    stamp = now()
    row = db.scalar(
        select(WishlistEntry).where(
            WishlistEntry.user_id == principal.user.id, WishlistEntry.card_id == card_id
        )
    )
    if row is None:
        row = WishlistEntry(
            user_id=principal.user.id, card_id=card_id, quantity=body.quantity, created_at=stamp
        )
        db.add(row)
    row.quantity, row.deck_id, row.updated_at = body.quantity, body.deck_id, stamp
    db.commit()
    return wishlist_of(db, principal.user, library)


@router.delete("/me/wishlist/{card_id}", response_model=Wishlist)
def unwish(card_id: UUID, principal: Active, library: CurrentLibrary, db: Db) -> Wishlist:
    row = db.scalar(
        select(WishlistEntry).where(
            WishlistEntry.user_id == principal.user.id, WishlistEntry.card_id == card_id
        )
    )
    if row is not None:
        db.delete(row)
        db.commit()
    return wishlist_of(db, principal.user, library)


class Pack(Contract):
    product_id: UUID
    name: str
    set_code: str


class MissingCard(Contract):
    card: CardSummary
    needed: int = Field(description="Copies the deck holds, the maybeboard apart.")
    owned: int
    missing: int
    wished: int = Field(description="Copies on the account's wishlist.")
    auctions: int = Field(description="Auctions open for the card now, the account's own apart.")
    packs: list[Pack] = Field(
        description="The shop's packs whose set printed the card, the newest first, at most five."
    )


class Missing(Contract):
    deck_id: UUID
    cards: list[MissingCard]
    missing: int = Field(description="Copies missing in all.")
    complete: bool = Field(description="The library holds every card of the deck.")


def missing_cards(db: Session, deck: Deck, library: Library) -> Missing:
    """What the deck holds that its owner's library lacks, by card (every edition of a card
    counts as the card), with where each might be had."""
    if library.unlimited:
        return Missing(deck_id=deck.id, cards=[], missing=0, complete=True)
    needed: dict[UUID, int] = defaultdict(int)
    for entry in entries_of(deck):
        if entry.location in COUNTED:
            needed[entry.card_id] += entry.quantity
    cards = deck_cards(db, set(needed), library)
    short = {
        card_id: count - (cards[card_id].owned or 0)
        for card_id, count in needed.items()
        if card_id in cards and count > (cards[card_id].owned or 0)
    }
    wished = dict(
        db.execute(
            select(WishlistEntry.card_id, WishlistEntry.quantity).where(
                WishlistEntry.user_id == deck.owner_id, WishlistEntry.card_id.in_(short)
            )
        ).all()
    )
    open_auctions = dict(
        db.execute(
            select(CardPrinting.concept_id, func.count())
            .select_from(Auction)
            .join(CardPrinting, CardPrinting.id == Auction.printing_id)
            .where(
                Auction.status == "active",
                Auction.seller_id != deck.owner_id,
                CardPrinting.concept_id.in_(short),
            )
            .group_by(CardPrinting.concept_id)
        ).all()
    )
    packs: dict[UUID, list[Pack]] = defaultdict(list)
    if short:
        sold = db.execute(
            select(CardPrinting.concept_id, ShopProduct.id, ShopProduct.name, ShopProduct.set_code)
            .select_from(CardPrinting)
            .join(
                ShopProduct, func.lower(ShopProduct.set_code) == func.lower(CardPrinting.set_code)
            )
            .where(CardPrinting.concept_id.in_(short), ShopProduct.on_sale)
            .order_by(ShopProduct.released.desc().nulls_last(), ShopProduct.name)
        )
        for card_id, product_id, name, set_code in sold:
            found = packs[card_id]
            if len(found) < 5 and all(pack.product_id != product_id for pack in found):
                found.append(Pack(product_id=product_id, name=name, set_code=set_code))
    found_cards = sorted(short, key=lambda card_id: normalize(cards[card_id].name))
    return Missing(
        deck_id=deck.id,
        cards=[
            MissingCard(
                card=cards[card_id],
                needed=needed[card_id],
                owned=cards[card_id].owned or 0,
                missing=short[card_id],
                wished=int(wished.get(card_id, 0)),
                auctions=int(open_auctions.get(card_id, 0)),
                packs=packs.get(card_id, []),
            )
            for card_id in found_cards
        ],
        missing=sum(short.values()),
        complete=not short,
    )


@router.get("/decks/{deck_id}/missing", response_model=Missing)
def deck_missing(deck_id: UUID, principal: Builder, library: CurrentLibrary, db: Db) -> Missing:
    """The cards of the deck its owner's library lacks, with the auctions open for each and the
    shop's packs that may hold it."""
    return missing_cards(db, owned(db, principal, deck_id), library)


# Substitutions: owned cards that could take a card's place.


class Substitute(Contract):
    card: CardSummary
    spare: int = Field(description="Copies the library holds that the deck does not use.")
    score: int = Field(description="How alike the two are, 0 to 100; the list is by this.")
    reasons: list[str] = Field(description="Why it is offered, in words.")


class Substitutions(Contract):
    deck_id: UUID
    card: CardSummary
    substitutes: list[Substitute]
    note: str | None = Field(
        default=None, description="Why there are none, when the rules leave none."
    )


def says_what_it_does(slug: str) -> bool:
    """Whether a Tagger tag is about what a card does, and not its name, history or cycle."""
    return not (
        slug in TAGS_APART
        or slug.startswith(TAG_PREFIXES_APART)
        or slug.endswith(TAG_SUFFIXES_APART)
    )


def tags_of(db: Session, ids: Iterable[UUID]) -> dict[UUID, dict[UUID, str]]:
    """Each card's Tagger tags that say what it does, by tag id with its label."""
    found: dict[UUID, dict[UUID, str]] = defaultdict(dict)
    for card_id, tag_id, slug, label in db.execute(
        select(CardTagLink.concept_id, CardTag.id, CardTag.slug, CardTag.label)
        .join(CardTag, CardTag.id == CardTagLink.tag_id)
        .where(CardTagLink.concept_id.in_(list(ids)))
    ):
        if says_what_it_does(slug):
            found[card_id][tag_id] = label
    return found


def kind_of(card: Card) -> str:
    """What a card is for a substitution: a land for a land, else its first card type."""
    types = card.front_types[1]
    return "Land" if "Land" in types else (types[0] if types else "")


def likeness(wanted: Card, other: Card, shared: int, most: int) -> tuple[int, list[str]]:
    """How alike two cards are, 0 to 100, and why: the tags they share (60), their type (25) and
    their mana value (15)."""
    score = round(60 * shared / most) if most else 0
    reasons: list[str] = []
    if kind_of(wanted) == kind_of(other):
        score += 25
        reasons.append(f"Also {'a land' if other.land else kind_of(other).lower()}")
    gap = abs(wanted.mana_value - other.mana_value)
    if not other.land:
        score += max(0, 15 - 5 * int(gap))
        if gap == 0:
            reasons.append(f"The same mana value, {other.mana_value:g}")
        else:
            reasons.append(f"Mana value {other.mana_value:g} against {wanted.mana_value:g}")
    return min(100, score), reasons


def substitutions(db: Session, deck: Deck, library: Library, card_id: UUID) -> Substitutions:
    """Cards the library holds that could take the card's place in the deck. Every one is in the
    game as written (no stand-in), legal in the deck's format and not banned in it, within the
    deck's commanders' colour identity, a land for a land and a spell for a spell, and has a copy
    the deck does not already use. They are ranked by what they share with the card: its Tagger
    tags that say what it does ("ramp", "spot removal"), then its type and mana value; a card
    that shares too little is not offered."""
    wanted = cards_of(db, {card_id}).get(card_id)
    if wanted is None:
        raise ApiError(404, "unknown_card", "The catalog has no such card.")
    shown = deck_cards(db, {card_id}, library)[card_id]
    if library.unlimited:
        return Substitutions(
            deck_id=deck.id,
            card=shown,
            substitutes=[],
            note="This account builds from the whole catalog: it has every card.",
        )
    entries = entries_of(deck)
    in_deck = cards_of(db, {entry.card_id for entry in entries})
    used: dict[str, int] = defaultdict(int)
    for entry in entries:
        if entry.location in COUNTED and entry.card_id in in_deck:
            used[in_deck[entry.card_id].construction_key] += entry.quantity
    identity: int | None = None
    if deck.format == "commander":
        identity = 0
        for entry in entries:
            if entry.location == "commander" and entry.card_id in in_deck:
                identity |= in_deck[entry.card_id].identity_mask
    rules = rules_of(db, deck.format)
    limit = 1 if deck.format == "commander" else 4
    spare_keys = {
        key: copies - used.get(key, 0)
        for key, copies in library.copies.items()
        if copies > used.get(key, 0) and key != wanted.construction_key
    }
    if not spare_keys:
        return Substitutions(
            deck_id=deck.id, card=shown, substitutes=[], note="Every card you own is in the deck."
        )
    wanted_tags = tags_of(db, [card_id]).get(card_id, {})
    query = select(CardConcept.id).where(
        CardConcept.construction_key.in_(list(spare_keys)),
        CardConcept.deck_card,
        CardConcept.status == "certified",
        CardConcept.removed_revision.is_(None),
    )
    candidates = cards_of(db, set(db.scalars(query)))
    tags = tags_of(db, candidates) if wanted_tags else {}
    found: list[tuple[int, int, str, Card, list[str]]] = []
    seen: set[str] = set()
    for other in candidates.values():
        key = other.construction_key
        if key in seen or other.land != wanted.land:
            continue
        if other.legalities.get(deck.format) != "legal" or normalize(other.name) in rules.banned:
            continue
        if identity is not None and other.identity_mask & ~identity:
            continue
        allowed = other.copy_limit if other.copy_limit is not None else limit
        if allowed and used.get(key, 0) >= allowed:
            continue
        shared = [
            label for tag_id, label in tags.get(other.id, {}).items() if tag_id in wanted_tags
        ]
        score, reasons = likeness(wanted, other, len(shared), len(wanted_tags))
        if shared:
            reasons.insert(0, "Both: " + ", ".join(sorted(shared)[:4]))
        if score < MIN_LIKENESS:
            continue
        seen.add(key)
        found.append((score, spare_keys[key], normalize(other.name), other, reasons))
    found.sort(key=lambda item: (-item[0], item[2]))
    best = found[:MAX_SUBSTITUTES]
    cards = deck_cards(db, {item[3].id for item in best}, library)
    return Substitutions(
        deck_id=deck.id,
        card=shown,
        substitutes=[
            Substitute(card=cards[other.id], spare=spare, score=score, reasons=reasons)
            for score, spare, _, other, reasons in best
        ],
        note=None if best else "Nothing you own is close enough to offer.",
    )


@router.get("/decks/{deck_id}/substitutions", response_model=Substitutions)
def deck_substitutions(
    deck_id: UUID, card_id: UUID, principal: Builder, library: CurrentLibrary, db: Db
) -> Substitutions:
    """For a card (in the deck or wanted for it), the cards the library holds that could take its
    place, each with why it is offered."""
    return substitutions(db, owned(db, principal, deck_id), library, card_id)
