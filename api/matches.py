"""Best-of-three Legacy matches with sideboards (v0.5.0, FMT05-FMT07, docs/matches.md).

A Legacy human table's host, and a player at the practice table against a bot, choose best of one
game or best of three. A match is games of its own: each is an engine game recorded as any other
(api/games.py), linked to its match with its number, so every game won counts as a win and pays
its tokens exactly as a single game does. The match keeps each player's game wins and its winner,
for the statistics. Whatever creates a first game (a practice game, a table, a queue) makes it a
match's with begin(), passing best_of.

- **Winning.** The first player to two game wins takes the match. A game without a winner (a
  draw, the turn limit, an engine error, a game the engine lost) counts for nobody and adds a
  game; after five games the player with more game wins takes the match, and with as many it is a
  draw. A game closed, or one the engine closed for doing nothing, ends the match without a result.
- **Between games.** Each human player sideboards in private: they swap cards between the main
  deck and the sideboard of the deck revision bound at the match's start (DECK01). The pool is
  locked, so an arrangement holds exactly that revision's main-deck and sideboard cards, and it is
  validated as a deck: in Legacy a main deck of 60 at least, a sideboard of 15 at most, the copy
  limits, and the player's library over both. Nobody else sees it (SysOp apart). Then they are
  ready. Bots keep their deck and are always ready. The loser of the game chooses to play or draw
  the next one (FMT06), and the engine seats that choice. The next game starts once every player
  is ready, or after 5 minutes of sideboarding with each deck as it is arranged.
- **Leaving.** Conceding the match concedes the game in play, and the match is the other player's.
  A player removed from a game while away loses the match the same way. Either player may concede
  between games too.
- **Limits.** A match counts as one running game against each player's limit, between games too
  (games.active_games_of).
"""

import asyncio
import logging
import random
import weakref
from collections import Counter
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Any, Literal, cast
from uuid import UUID, uuid4

from fastapi import APIRouter, Request
from pydantic import Field
from sqlalchemy import Engine, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api.auth import INPUT_ERRORS
from api.economy import tokens_from
from api.games import (
    CLOSE_WAIT_SECONDS,
    EngineUnavailable,
    GameHub,
    LiveGame,
    LiveSeat,
    Player,
    engine_deck_list,
    engine_names,
    full_access,
    hub_of,
    retried,
)
from api.identity import ApiError, Db, Principal, not_found, utcnow
from api.library import at_godlike, library_of
from api.models import (
    CardConcept,
    CatalogRevision,
    CustomCard,
    DeckEntryRow,
    DeckRevision,
    FormatVersion,
    Game,
    GameSeat,
    Match,
    MatchPlayer,
    User,
)
from api.roster import roster_of
from api.schemas import Contract, Error, GameFormatId, GameMatch, GameResult, MatchStatus
from api.validation import DeckContent, DeckEntry, Location, validate_deck

log = logging.getLogger("api.matches")
router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

# A match ends after this many games even when nobody has the game wins it needs.
MAX_GAMES = 5
# Sideboarding between games: the next game starts once every player is ready, or after this long
# with each deck as it is arranged.
SIDEBOARD_SECONDS = 300.0
# The next game asks again after this long when the engine is away, and sooner when every game
# slot is in use: a slot frees as any game ends, and asking costs no request to the engine.
RETRY_SECONDS = 30.0
BUSY_RETRY_SECONDS = 5.0
RUNNING = ("playing", "sideboarding")
# Results that end a match without one: someone closed the game, or the engine closed it after
# nobody did anything for its idle timeout. Any other game without a winner adds a game.
ENDING_KINDS = ("closed", "idle_timeout")
LISTED = 20
EndReason = Literal["games", "conceded", "removed", "closed", "failed"]


# What the routes say.


class SideboardCard(Contract):
    card_id: UUID
    printing_id: UUID | None
    name: str
    type_line: str
    mana_cost: str | None
    main: int = Field(description="Copies in the main deck for the next game.")
    sideboard: int = Field(description="Copies in the sideboard.")


class Sideboard(Contract):
    """A player's arrangement of their bound deck for the next game: theirs alone, SysOp apart."""

    deck: str | None = Field(description="The deck's title, as bound at the match's start.")
    can_sideboard: bool = Field(
        description="False for a deck with no sideboard to swap with: a fixture deck or a list."
    )
    main: int
    sideboard: int
    cards: list[SideboardCard] = Field(description="Every card of the locked pool.")


class MatchPlayerView(Contract):
    seat: int
    player: Literal["human", "bot"]
    handle: str | None
    portrait: str | None = Field(description="A player's allied Planeswalker.")
    you: bool
    game_wins: int
    ready: bool = Field(description="Bots always are.")
    left: Literal["conceded", "removed"] | None
    deck_cards: Sideboard | None = Field(
        description="Your own seat's arrangement; another seat's only to SysOp."
    )


class MatchGameView(Contract):
    game: int
    id: UUID
    status: Literal["active", "finished", "interrupted"]
    result: GameResult | None
    tokens: int | None = Field(description="What the game paid you, once it is recorded.")


class MatchView(Contract):
    id: UUID
    kind: Literal["practice", "table"]
    format: GameFormatId
    best_of: int
    status: MatchStatus
    game_number: int = Field(description="The game in play, or while sideboarding the next one.")
    players: list[MatchPlayerView]
    games: list[MatchGameView]
    your_seat: int | None
    game_id: UUID | None = Field(description="The game in play.")
    chooser_seat: int | None = Field(
        description="Who chooses to play or draw the next game: the last game's loser."
    )
    starting_seat: int | None = Field(description="The seat that plays first, once chosen.")
    sideboard_until: datetime | None = Field(
        description="When the next game starts with each deck as it is arranged."
    )
    winner_seat: int | None
    draw: bool
    end_reason: EndReason | None
    waiting: str | None = Field(
        description="Why the next game has not started although every player is ready."
    )
    created_at: datetime
    finished_at: datetime | None


class ArrangedCard(Contract):
    card_id: UUID
    printing_id: UUID | None = None
    main: int = Field(ge=0, le=250)
    sideboard: int = Field(ge=0, le=250)


class ArrangementRequest(Contract):
    cards: list[ArrangedCard] = Field(max_length=400)


class Readiness(Contract):
    ready: bool = True
    play_first: bool | None = Field(
        default=None,
        description="The chooser's choice: play first (true) or draw first (false). Left out, an "
        "earlier choice stands, else the chooser plays first.",
    )


# Arrangements: {"main": [{card_id, printing_id, quantity}], "sideboard": [...]}.

Key = tuple[str, str | None]


def arrangement_of(entries: list[DeckEntry]) -> dict[str, object]:
    """A revision's own main deck and sideboard, as the first game played it."""
    return {
        location: [
            {
                "card_id": str(entry.card_id),
                "printing_id": str(entry.printing_id) if entry.printing_id else None,
                "quantity": entry.quantity,
            }
            for entry in entries
            if entry.location == location
        ]
        for location in ("main", "sideboard")
    }


def arranged(arrangement: dict[str, object]) -> list[DeckEntry]:
    entries: list[DeckEntry] = []
    for location in ("main", "sideboard"):
        for item in cast(list[dict[str, Any]], arrangement.get(location) or []):
            entries.append(
                DeckEntry(
                    card_id=UUID(item["card_id"]),
                    printing_id=UUID(item["printing_id"]) if item.get("printing_id") else None,
                    quantity=int(item["quantity"]),
                    location=location,
                )
            )
    return entries


def pool(entries: list[DeckEntry]) -> Counter[Key]:
    """Copies of each card and printing over the main deck and the sideboard."""
    counted: Counter[Key] = Counter()
    for entry in entries:
        if entry.location in ("main", "sideboard"):
            key = (str(entry.card_id), str(entry.printing_id) if entry.printing_id else None)
            counted[key] += entry.quantity
    return counted


def revision_rows(db: Session, revision_id: UUID) -> list[DeckEntry]:
    rows = db.scalars(select(DeckEntryRow).where(DeckEntryRow.revision_id == revision_id))
    return [
        DeckEntry(
            card_id=row.concept_id or row.custom_card_id,  # type: ignore[arg-type]
            printing_id=row.printing_id,
            quantity=row.quantity,
            location=row.location,  # type: ignore[arg-type]
        )
        for row in rows
    ]


# The match's record.


def players_of(db: Session, match_id: UUID) -> list[MatchPlayer]:
    return list(
        db.scalars(
            select(MatchPlayer).where(MatchPlayer.match_id == match_id).order_by(MatchPlayer.seat)
        )
    )


def begin(
    db: Session,
    game: Game,
    best_of: int,
    *,
    idle_timeout_seconds: int | None = None,
) -> Match | None:
    """Makes a newly recorded game the first of a best-of-three match, in the caller's
    transaction: the match, and its players from the game's seats. Best of one makes none. Each
    player's deck revision the game bound is the match's (DECK01)."""
    if best_of == 1:
        return None
    if game.format != "legacy":
        raise ApiError(422, "invalid_table", "Only Legacy plays best of three.")
    db.flush()
    seats = list(
        db.scalars(select(GameSeat).where(GameSeat.game_id == game.id).order_by(GameSeat.seat))
    )
    match = Match(
        kind=game.kind,
        format=game.format,
        best_of=best_of,
        status="playing",
        created_by=game.created_by,
        bot_skill=game.bot_skill,
        turn_cap=game.turn_cap,
        idle_timeout_seconds=idle_timeout_seconds,
        game_number=1,
        draw=False,
        created_at=game.created_at,
    )
    db.add(match)
    db.flush()
    for seat in seats:
        revision = seat.deck_revision_id if seat.player == "human" else None
        db.add(
            MatchPlayer(
                match_id=match.id,
                seat=seat.seat,
                player=seat.player,
                user_id=seat.user_id,
                deck_revision_id=revision,
                engine_deck=None
                if revision
                else ({"deck_list": seat.deck_list} if seat.deck_list else {"deck": seat.deck}),
                arrangement=arrangement_of(revision_rows(db, revision)) if revision else None,
                ready=seat.player == "bot",
                game_wins=0,
            )
        )
    game.match_id = match.id
    game.match_game = 1
    return match


def finish(
    match: Match,
    *,
    reason: EndReason,
    winner: int | None = None,
    draw: bool = False,
    closed: bool = False,
) -> None:
    match.status = "closed" if closed else "finished"
    match.winner_seat = winner
    match.draw = draw
    match.end_reason = reason
    match.finished_at = utcnow()
    match.sideboard_until = None
    match.chooser_seat = None
    match.starting_seat = None


def other(players: list[MatchPlayer], seat: int) -> int | None:
    return next((player.seat for player in players if player.seat != seat), None)


def game_ended(db: Session, game: Game) -> None:
    """In the transaction that records a game's end (games.record_end): its match counts the game,
    then ends or goes on to sideboarding for the next. A game the engine lost (interrupted) is a
    game without a result."""
    if game.match_id is None:
        return
    match = db.scalar(select(Match).where(Match.id == game.match_id).with_for_update())
    if match is None or match.status != "playing" or match.game_number != game.match_game:
        return
    players = players_of(db, match.id)
    result = game.result if game.status == "finished" and game.result else {}
    winner = result.get("winner_seat")
    if isinstance(winner, int):
        for player in players:
            if player.seat == winner:
                player.game_wins += 1
    out = next((player for player in players if player.left_reason), None)
    if out is not None:
        finish(match, reason=cast(EndReason, out.left_reason), winner=other(players, out.seat))
        return
    needed = match.best_of // 2 + 1
    leader = max(players, key=lambda player: player.game_wins)
    if leader.game_wins >= needed:
        finish(match, reason="games", winner=leader.seat)
        return
    if result.get("kind") in ENDING_KINDS:
        finish(match, reason="closed", closed=True)
        return
    if match.game_number >= MAX_GAMES:
        tied = sum(player.game_wins == leader.game_wins for player in players) > 1
        finish(match, reason="games", winner=None if tied else leader.seat, draw=tied)
        return
    # The loser of a game chooses for the next; after a game without a winner, whoever chose for
    # it chooses again, and after a first game without one a player is drawn.
    if isinstance(winner, int):
        match.chooser_seat = other(players, winner)
    elif match.chooser_seat is None:
        match.chooser_seat = random.choice([player.seat for player in players])
    chooser = next(player for player in players if player.seat == match.chooser_seat)
    # A bot chooses to play first.
    match.starting_seat = chooser.seat if chooser.player == "bot" else None
    match.status = "sideboarding"
    match.game_number += 1
    match.sideboard_until = utcnow() + timedelta(seconds=SIDEBOARD_SECONDS)
    for player in players:
        player.ready = player.player == "bot"


def games_interrupted(db: Session, game_ids: list[UUID]) -> None:
    """Games the restart's sweep marked interrupted: their matches count them as games without a
    result, in the sweep's transaction."""
    for game in db.scalars(
        select(Game).where(Game.id.in_(game_ids), Game.match_id.is_not(None))
    ).all():
        game_ended(db, game)


def player_removed(db: Session, game_id: UUID, user_id: UUID) -> None:
    """A player the others removed from a match's game while away (games.record_removal): out of
    the match, which is the other player's once the game ends."""
    game = db.get(Game, game_id)
    if game is None or game.match_id is None:
        return
    match = db.scalar(select(Match).where(Match.id == game.match_id).with_for_update())
    player = db.scalar(
        select(MatchPlayer).where(
            MatchPlayer.match_id == game.match_id, MatchPlayer.user_id == user_id
        )
    )
    if match is None or match.status not in RUNNING or player is None or player.left_reason:
        return
    player.left_at = utcnow()
    player.left_reason = "removed"
    if match.status == "sideboarding":
        # The game's end was recorded first (the removal conceded the seat): the match is over.
        finish(match, reason="removed", winner=other(players_of(db, match.id), player.seat))


def match_ref(db: Session, game: Game) -> GameMatch | None:
    """The match a game belongs to, as its summary shows it (games.summary_of)."""
    if game.match_id is None or game.match_game is None:
        return None
    match = db.get(Match, game.match_id)
    if match is None:
        return None
    return GameMatch(
        id=match.id,
        best_of=match.best_of,
        game=game.match_game,
        status=match.status,  # type: ignore[arg-type]
        wins=[player.game_wins for player in players_of(db, match.id)],
        winner_seat=match.winner_seat,
        draw=match.draw,
    )


def visible(db: Session, match_id: UUID, principal: Principal) -> tuple[Match, MatchPlayer | None]:
    """The match and the account's seat in it. Others' matches look like missing ones, except to
    SysOp."""
    match = db.get(Match, match_id)
    if match is None:
        raise not_found()
    mine = db.scalar(
        select(MatchPlayer).where(
            MatchPlayer.match_id == match_id, MatchPlayer.user_id == principal.user.id
        )
    )
    if mine is None and not full_access(principal):
        raise not_found()
    return match, mine


def deck_cards(db: Session, player: MatchPlayer) -> Sideboard:
    """The seat's pool, arranged as it is now."""
    if player.deck_revision_id is None or player.arrangement is None:
        return Sideboard(deck=None, can_sideboard=False, main=0, sideboard=0, cards=[])
    revision = db.get(DeckRevision, player.deck_revision_id)
    entries = arranged(player.arrangement)
    ids = {entry.card_id for entry in entries}
    known: dict[UUID, tuple[str, str, str | None]] = {
        row.id: (row.name, row.type_line, row.mana_cost)
        for row in db.execute(
            select(
                CardConcept.id, CardConcept.name, CardConcept.type_line, CardConcept.mana_cost
            ).where(CardConcept.id.in_(ids))
        )
    }
    known |= {
        row.id: (row.name, row.type_line, row.mana_cost)
        for row in db.execute(
            select(
                CustomCard.id, CustomCard.name, CustomCard.type_line, CustomCard.mana_cost
            ).where(CustomCard.id.in_(ids - known.keys()))
        )
    }
    by_key: dict[Key, SideboardCard] = {}
    for entry in entries:
        key = (str(entry.card_id), str(entry.printing_id) if entry.printing_id else None)
        name, type_line, cost = known.get(entry.card_id, ("Godlike card", "", None))
        card = by_key.setdefault(
            key,
            SideboardCard(
                card_id=entry.card_id,
                printing_id=entry.printing_id,
                name=name,
                type_line=type_line,
                mana_cost=cost,
                main=0,
                sideboard=0,
            ),
        )
        if entry.location == "main":
            card.main += entry.quantity
        else:
            card.sideboard += entry.quantity
    cards = sorted(by_key.values(), key=lambda card: (card.name, str(card.printing_id)))
    return Sideboard(
        deck=revision.title if revision is not None else None,
        can_sideboard=True,
        main=sum(card.main for card in cards),
        sideboard=sum(card.sideboard for card in cards),
        cards=cards,
    )


def view_of(
    db: Session,
    match: Match,
    principal: Principal,
    *,
    cards: bool = True,
    waiting: str | None = None,
) -> MatchView:
    """The match as the account may see it: every seat's handle, wins and readiness, and the deck
    arrangement of its own seat only (SysOp: every seat's)."""
    players = players_of(db, match.id)
    users = {player.user_id for player in players if player.user_id is not None}
    found = {
        user_id: (handle, alliance)
        for user_id, handle, alliance in db.execute(
            select(User.id, User.handle, User.alliance).where(User.id.in_(users))
        )
    }
    you = principal.user.id
    everything = full_access(principal)
    mine = next((player for player in players if player.user_id == you), None)
    games = list(
        db.scalars(select(Game).where(Game.match_id == match.id).order_by(Game.match_game))
    )
    live = next((game for game in games if game.status == "active"), None)
    return MatchView(
        id=match.id,
        kind=match.kind,  # type: ignore[arg-type]
        format=match.format,  # type: ignore[arg-type]
        best_of=match.best_of,
        status=match.status,  # type: ignore[arg-type]
        game_number=match.game_number,
        players=[
            MatchPlayerView(
                seat=player.seat,
                player=player.player,  # type: ignore[arg-type]
                handle=found.get(player.user_id, (None, None))[0] if player.user_id else None,
                portrait=found.get(player.user_id, (None, None))[1] if player.user_id else None,
                you=player.user_id == you,
                game_wins=player.game_wins,
                ready=player.ready,
                left=player.left_reason,  # type: ignore[arg-type]
                deck_cards=deck_cards(db, player)
                if cards and player.player == "human" and (player.user_id == you or everything)
                else None,
            )
            for player in players
        ],
        games=[
            MatchGameView(
                game=game.match_game or 0,
                id=game.id,
                status=game.status,  # type: ignore[arg-type]
                result=GameResult.model_validate(game.result) if game.result else None,
                tokens=tokens_from(db, game.id, you)
                if mine is not None and game.status == "finished"
                else None,
            )
            for game in games
        ],
        your_seat=mine.seat if mine is not None else None,
        game_id=live.id if live is not None and match.status == "playing" else None,
        chooser_seat=match.chooser_seat,
        starting_seat=match.starting_seat,
        sideboard_until=match.sideboard_until,
        winner_seat=match.winner_seat,
        draw=match.draw,
        end_reason=match.end_reason,  # type: ignore[arg-type]
        waiting=waiting if match.status == "sideboarding" else None,
        created_at=match.created_at,
        finished_at=match.finished_at,
    )


# Starting the next game.


@dataclass
class NextSeat:
    """A seat of the next game: as the engine takes it, and as its record keeps it."""

    engine: dict[str, object]
    player: str
    user_id: UUID | None
    revision: UUID | None
    title: str | None


@dataclass
class NextGame:
    match_id: UUID
    number: int
    kind: str
    body: dict[str, object]
    seats: list[NextSeat] = field(default_factory=list)


# Why each match's next game waits although everyone is ready, by the hub that runs it.
WAITING: "weakref.WeakKeyDictionary[GameHub, dict[UUID, str]]" = weakref.WeakKeyDictionary()
# The matches that will ask for their next game again shortly, by hub.
RETRYING: "weakref.WeakKeyDictionary[GameHub, set[UUID]]" = weakref.WeakKeyDictionary()


def waiting_of(hub: GameHub) -> dict[UUID, str]:
    return WAITING.setdefault(hub, {})


def retrying_of(hub: GameHub) -> set[UUID]:
    return RETRYING.setdefault(hub, set())


def plan_next(db: Session, match_id: UUID) -> NextGame | None:
    """The next game, once the match is sideboarding and every player is ready, or the
    sideboarding's time is up; else None. Each player's deck is their arrangement of the bound
    revision, and a seat that never sideboards plays the deck it played first."""
    match = db.get(Match, match_id)
    if match is None or match.status != "sideboarding":
        return None
    players = players_of(db, match.id)
    due = match.sideboard_until is not None and match.sideboard_until <= utcnow()
    if not due and not all(player.ready for player in players):
        return None
    starting = match.starting_seat
    if starting is None:
        # Nobody chose by the start: the chooser plays first.
        starting = match.chooser_seat if match.chooser_seat is not None else 0
    body: dict[str, object] = {
        "format": match.format,
        "seats": [],
        "skill": match.bot_skill,
        "turn_cap": match.turn_cap,
        "starting_seat": starting,
    }
    if match.idle_timeout_seconds is not None:
        body["idle_timeout_seconds"] = match.idle_timeout_seconds
    plan = NextGame(match.id, match.game_number, match.kind, body)
    for player in players:
        if player.engine_deck is not None or player.arrangement is None:
            seat = NextSeat(
                {"player": player.player, **(player.engine_deck or {})},
                player.player,
                player.user_id,
                None,
                None,
            )
        else:
            revision = db.get(DeckRevision, player.deck_revision_id)
            entries = arranged(player.arrangement)
            godlike = player.user_id is not None and at_godlike(db, player.user_id)
            deck_list = engine_deck_list(
                db, entries, engine_names(db, entries, godlike), match.format
            )
            if deck_list is None or revision is None:
                raise ApiError(
                    422, "deck_not_playable", "A deck of this match holds a card the engine lacks."
                )
            seat = NextSeat(
                {"player": player.player, "deck_list": deck_list},
                player.player,
                player.user_id,
                revision.id,
                revision.title[:64],
            )
        plan.seats.append(seat)
        cast(list[dict[str, object]], body["seats"]).append(seat.engine)
    return plan


def record_next(db: Session, plan: NextGame, created: dict[str, Any]) -> Game:
    """The next game and its seats, and the match playing it, in one transaction. The match must
    still be waiting for that game."""
    match = db.scalar(select(Match).where(Match.id == plan.match_id).with_for_update())
    if match is None or match.status != "sideboarding" or match.game_number != plan.number:
        raise ApiError(409, "match_changed", "The match changed as its next game started.")
    now = utcnow()
    game = Game(
        id=UUID(str(created["game_id"])),
        kind=plan.kind,
        format=match.format,
        status="active",
        created_by=match.created_by,
        created_at=now,
        bot_skill=match.bot_skill,
        turn_cap=match.turn_cap,
        catalog_revision_id=db.scalar(select(func.max(CatalogRevision.id))),
        format_version=db.scalar(
            select(func.max(FormatVersion.version)).where(FormatVersion.format == match.format)
        ),
        match_id=match.id,
        match_game=plan.number,
        # A practice match's request, which its rematch replays once the match is over.
        settings=db.scalar(
            select(Game.settings).where(Game.match_id == match.id, Game.match_game == 1)
        ),
    )
    db.add(game)
    db.flush()
    decks = {entry["seat"]: entry["deck"] for entry in created["settings"]["seats"]}
    for index, seat in enumerate(plan.seats):
        db.add(
            GameSeat(
                game_id=game.id,
                seat=index,
                player=seat.player,
                user_id=seat.user_id,
                deck=seat.title or decks[index],
                deck_list=seat.engine.get("deck_list"),
                deck_revision_id=seat.revision,
            )
        )
    match.status = "playing"
    match.sideboard_until = None
    for player in players_of(db, match.id):
        player.ready = player.player == "bot"
    db.commit()
    return game


def fail(database: Engine, match_id: UUID) -> None:
    """The engine refused the next game's decks: the match ends without a result."""
    with Session(database) as db:
        match = db.scalar(select(Match).where(Match.id == match_id).with_for_update())
        if match is not None and match.status == "sideboarding":
            finish(match, reason="failed", closed=True)
            db.commit()


BUSY = "Every game slot on the server is in use: the next game starts as soon as one frees."
AWAY = "The rules engine is not answering: the next game starts as soon as it does."


async def next_game(hub: GameHub, match_id: UUID) -> None:
    """Starts the match's next game when it is due: every player ready, or the sideboarding's time
    up. When every game slot is in use, or the engine or the database does not answer, it asks
    again shortly, and the match says why it waits. One start at a time for each match."""
    if hub.engine is None:
        return
    engine = hub.engine
    async with hub.locks[match_id]:
        with Session(hub.database) as db:
            try:
                plan = await run_in_threadpool(plan_next, db, match_id)
            except ApiError:
                await run_in_threadpool(fail, hub.database, match_id)
                return
            except SQLAlchemyError:
                log.warning("Could not plan match %s's next game", match_id, exc_info=True)
                retry(hub, match_id)
                return
            if plan is None:
                return
            # No pooled connection is held while the engine answers.
            await run_in_threadpool(db.rollback)
            try:
                hub.reserve()
            except ApiError:
                waiting_of(hub)[match_id] = BUSY
                retry(hub, match_id, BUSY_RETRY_SECONDS)
                return
            try:
                try:
                    status, created = await engine.request("POST", "/games", body=plan.body)
                except EngineUnavailable:
                    status, created = 503, None
                if status == 429 or status >= 500 or (status == 201 and not created):
                    waiting_of(hub)[match_id] = BUSY if status == 429 else AWAY
                    retry(hub, match_id, BUSY_RETRY_SECONDS if status == 429 else RETRY_SECONDS)
                    return
                if status != 201:
                    # The engine refused the decks (a card it no longer knows): nothing to retry.
                    log.warning("The engine refused match %s's next game: %s", match_id, created)
                    await run_in_threadpool(fail, hub.database, match_id)
                    return
                try:
                    game = await run_in_threadpool(record_next, db, plan, created)
                except (ApiError, SQLAlchemyError):
                    await run_in_threadpool(db.rollback)
                    with suppress(EngineUnavailable):
                        await engine.request("POST", f"/games/{created['game_id']}/close", body={})
                    return
                waiting_of(hub).pop(match_id, None)
                tokens = {entry["seat"]: entry["seat_token"] for entry in created["seats"]}
                hub.register(
                    LiveGame(
                        id=game.id,
                        kind=plan.kind,
                        seats={
                            index: LiveSeat(index, seat.user_id, tokens[index])
                            for index, seat in enumerate(plan.seats)
                            if seat.user_id is not None
                        },
                    )
                )
            finally:
                hub.starting -= 1


def retry(hub: GameHub, match_id: UUID, seconds: float | None = None) -> None:
    """Asks for the next game again shortly (RETRY_SECONDS unless said), once however often it is
    asked meanwhile."""
    pending = retrying_of(hub)
    if match_id not in pending:
        pending.add(match_id)
        hub.spawn(again(hub, match_id, RETRY_SECONDS if seconds is None else seconds))


async def again(hub: GameHub, match_id: UUID, seconds: float) -> None:
    await asyncio.sleep(seconds)
    retrying_of(hub).discard(match_id)
    await next_game(hub, match_id)


async def deadline(hub: GameHub, match_id: UUID, until: datetime) -> None:
    """Starts the next game when sideboarding's time is up, whoever is not ready yet."""
    await asyncio.sleep(max(0.0, (until - utcnow()).total_seconds()))
    await next_game(hub, match_id)


def sideboarding_until(database: Engine, game_id: UUID) -> tuple[UUID, datetime] | None:
    with Session(database) as db:
        found = db.execute(
            select(Match.id, Match.sideboard_until)
            .join(Game, Game.match_id == Match.id)
            .where(Game.id == game_id, Match.status == "sideboarding")
        ).first()
        return (found[0], found[1]) if found is not None and found[1] is not None else None


async def after_game(hub: GameHub, game_id: UUID) -> None:
    """Once a match's game is recorded (GameHub.end): sideboarding's time starts running."""
    found = await run_in_threadpool(sideboarding_until, hub.database, game_id)
    if found is not None:
        hub.spawn(deadline(hub, *found))


def sideboarding(database: Engine) -> list[tuple[UUID, datetime]]:
    with Session(database) as db:
        return [
            (match_id, until)
            for match_id, until in db.execute(
                select(Match.id, Match.sideboard_until).where(Match.status == "sideboarding")
            )
            if until is not None
        ]


async def resume(hub: GameHub) -> None:
    """At startup: the matches waiting between games keep their sideboarding's time, and those
    whose game the restart interrupted get theirs. Retried while the database is unreachable."""
    for match_id, until in await retried(
        partial(sideboarding, hub.database), "find the matches between games"
    ):
        hub.spawn(deadline(hub, match_id, until))


# Routes.


def listed_of(db: Session, principal: Principal) -> list[MatchView]:
    statement = (
        select(Match)
        .where(
            Match.id.in_(
                select(MatchPlayer.match_id).where(MatchPlayer.user_id == principal.user.id)
            )
        )
        .order_by(Match.created_at.desc())
        .limit(LISTED)
    )
    return [view_of(db, match, principal, cards=False) for match in db.scalars(statement)]


@router.get("/matches", response_model=list[MatchView])
def list_matches(principal: Player, db: Db) -> list[MatchView]:
    """Your matches, newest first: running ones say where they stand, and none shows decks."""
    return listed_of(db, principal)


def overdue(match: Match) -> bool:
    return (
        match.status == "sideboarding"
        and match.sideboard_until is not None
        and match.sideboard_until <= utcnow()
    )


@router.get("/matches/{match_id}", response_model=MatchView)
async def get_match(match_id: UUID, request: Request, principal: Player, db: Db) -> MatchView:
    """The match: its players, games and score, and your own deck's arrangement for the next
    game. A match whose sideboarding is over starts its next game."""
    hub = hub_of(request)
    match, _ = await run_in_threadpool(visible, db, match_id, principal)
    # Its timer may have gone with an earlier process. A start under way, or one already asked to
    # run again, is not asked twice.
    starting = hub.locks[match.id].locked() or match.id in retrying_of(hub)
    if overdue(match) and hub.engine is not None and not starting:
        hub.spawn(next_game(hub, match.id))
    return await run_in_threadpool(
        partial(view_of, waiting=waiting_of(hub).get(match.id)), db, match, principal
    )


def seated(db: Session, match_id: UUID, principal: Principal) -> tuple[Match, MatchPlayer]:
    """The match locked, and the account's seat, which must still be in it."""
    match, mine = visible(db, match_id, principal)
    if mine is None:
        raise not_found()
    db.refresh(match, with_for_update=True)
    if match.status not in RUNNING:
        raise ApiError(409, "match_over", "This match is over.")
    if mine.left_reason is not None:
        raise ApiError(409, "not_in_match", "You are out of this match.")
    return match, mine


def between_games(db: Session, match_id: UUID, principal: Principal) -> tuple[Match, MatchPlayer]:
    match, mine = seated(db, match_id, principal)
    if match.status != "sideboarding":
        raise ApiError(409, "not_sideboarding", "A game of this match is in play.")
    return match, mine


def save_arrangement(
    db: Session, request: Request, match_id: UUID, principal: Principal, body: ArrangementRequest
) -> None:
    """A new arrangement of the bound revision, checked against its locked pool and validated as a
    deck with the player's library now. Saving it makes the player not ready."""
    match, mine = between_games(db, match_id, principal)
    if mine.deck_revision_id is None or mine.arrangement is None:
        raise ApiError(
            422, "invalid_sideboard", "This deck has no sideboard: it plays as it is every game."
        )
    entries = revision_rows(db, mine.deck_revision_id)
    proposed = [
        DeckEntry(
            card_id=card.card_id, printing_id=card.printing_id, quantity=count, location=location
        )
        for card in body.cards
        for location, count in cast(
            tuple[tuple[Location, int], ...], (("main", card.main), ("sideboard", card.sideboard))
        )
        if count
    ]
    if pool(proposed) != pool(entries):
        raise ApiError(
            422,
            "invalid_sideboard",
            "An arrangement swaps cards between the main deck and the sideboard of the deck the "
            "match started with: it holds exactly those cards, no others.",
        )
    if not principal.can("cards.any"):
        # SysOp's decks need only keep to the pool, as they need only cards in the game to start.
        kept = [entry for entry in entries if entry.location not in ("main", "sideboard")]
        library = library_of(db, principal.user, principal.permissions, roster_of(request))
        validation = validate_deck(
            db,
            DeckContent(format=match.format, entries=kept + proposed),  # type: ignore[arg-type]
            datetime.now(UTC).date(),
            library.collection(),
        )
        if validation.errors:
            raise ApiError(
                422,
                "sideboard_not_legal",
                " ".join(problem.message for problem in validation.errors),
            )
    mine.arrangement = arrangement_of(proposed)
    mine.ready = False
    db.commit()


@router.put(
    "/matches/{match_id}/sideboard",
    response_model=MatchView,
    responses={409: {"model": Error}},
)
async def sideboard(
    match_id: UUID, body: ArrangementRequest, request: Request, principal: Player, db: Db
) -> MatchView:
    """Saves your arrangement for the next game: the same cards, between main deck and
    sideboard. It makes you not ready."""
    hub = hub_of(request)
    async with hub.locks[match_id]:
        await run_in_threadpool(save_arrangement, db, request, match_id, principal, body)
    match, _ = await run_in_threadpool(visible, db, match_id, principal)
    return await run_in_threadpool(
        partial(view_of, waiting=waiting_of(hub).get(match_id)), db, match, principal
    )


def set_ready(db: Session, match_id: UUID, principal: Principal, body: Readiness) -> None:
    match, mine = between_games(db, match_id, principal)
    if body.play_first is not None:
        if match.chooser_seat != mine.seat:
            raise ApiError(
                409, "not_chooser", "The loser of the last game chooses who plays first."
            )
        players = players_of(db, match.id)
        match.starting_seat = mine.seat if body.play_first else other(players, mine.seat)
    mine.ready = body.ready
    db.commit()


@router.post(
    "/matches/{match_id}/ready",
    response_model=MatchView,
    responses={409: {"model": Error}, 429: {"model": Error}},
)
async def ready(
    match_id: UUID, body: Readiness, request: Request, principal: Player, db: Db
) -> MatchView:
    """Ready for the next game (or not), and for the last game's loser the choice to play or draw
    it. The next game starts once every player is ready; the reply names it."""
    hub = hub_of(request)
    hub.require_engine()
    async with hub.locks[match_id]:
        await run_in_threadpool(set_ready, db, match_id, principal, body)
    await run_in_threadpool(db.commit)
    if body.ready:
        await next_game(hub, match_id)
    match, _ = await run_in_threadpool(visible, db, match_id, principal)
    await run_in_threadpool(db.refresh, match)
    return await run_in_threadpool(
        partial(view_of, waiting=waiting_of(hub).get(match_id)), db, match, principal
    )


def leave(db: Session, match_id: UUID, principal: Principal) -> tuple[UUID | None, int]:
    """Marks the account out of the match. Between games the match is the other player's at once;
    during a game it is once the game ends. Returns the game in play, if any, and the seat."""
    match, mine = seated(db, match_id, principal)
    mine.left_at = utcnow()
    mine.left_reason = "conceded"
    playing = None
    if match.status == "sideboarding":
        finish(match, reason="conceded", winner=other(players_of(db, match.id), mine.seat))
    else:
        playing = db.scalar(
            select(Game.id).where(Game.match_id == match.id, Game.match_game == match.game_number)
        )
    db.commit()
    return playing, mine.seat


def stay(db: Session, match_id: UUID, principal: Principal) -> None:
    """The engine did not take the concession: the account is back in the match."""
    mine = db.scalar(
        select(MatchPlayer).where(
            MatchPlayer.match_id == match_id, MatchPlayer.user_id == principal.user.id
        )
    )
    match = db.get(Match, match_id)
    if mine is not None and match is not None and match.status == "playing":
        mine.left_at = None
        mine.left_reason = None
        db.commit()


async def concede_seat(hub: GameHub, game: LiveGame, seat: LiveSeat) -> bool:
    """Concedes the seat in the engine with its own token, as conceding from the game does."""
    seat.conceding = True
    body = {
        "v": 1,
        "game_id": str(game.id),
        "action_id": str(uuid4()),
        "expected_revision": seat.snapshot["revision"] if seat.snapshot else 0,
        "type": "concede",
        "payload": {},
    }
    try:
        status, answer = await hub.require_engine().request(
            "POST", f"{game.path}/commands", seat_token=seat.token, body=body
        )
    except EngineUnavailable:
        status, answer = 503, None
    finally:
        seat.conceding = False
    if status == 200:
        hub.seat_left(game, seat, "conceded")
        return True
    # A game that has just ended, or a seat already out, needs no concession.
    return isinstance(answer, dict) and answer.get("code") in ("game_over", "eliminated")


@router.post(
    "/matches/{match_id}/concede",
    response_model=MatchView,
    responses={409: {"model": Error}},
)
async def concede(match_id: UUID, request: Request, principal: Player, db: Db) -> MatchView:
    """Concedes the match: the game in play too, and the match is the other player's."""
    hub = hub_of(request)
    async with hub.locks[match_id]:
        playing, seat_number = await run_in_threadpool(leave, db, match_id, principal)
        live = hub.games.get(playing) if playing is not None else None
        seat = live.seats.get(seat_number) if live is not None else None
        if live is not None and seat is not None and not live.finished:
            if not await concede_seat(hub, live, seat):
                await run_in_threadpool(stay, db, match_id, principal)
                raise ApiError(
                    503, "engine_unavailable", "The game engine did not take the concession."
                )
            # The reply shows the match as it ended, once the game's end is recorded.
            with suppress(TimeoutError):
                await asyncio.wait_for(live.recorded.wait(), CLOSE_WAIT_SECONDS)
    match, _ = await run_in_threadpool(visible, db, match_id, principal)
    await run_in_threadpool(db.refresh, match)
    return await run_in_threadpool(
        partial(view_of, waiting=waiting_of(hub).get(match_id)), db, match, principal
    )
