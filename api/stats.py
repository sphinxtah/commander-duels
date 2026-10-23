"""Statistics and the match history (v0.5.0, PROG08): every player's results, from the server's own
record of each game that ended. docs/quests.md describes them for players and staff.

- **Results.** When the API records a game's end (api/games.py record_end, and the restart's sweep
  of games it interrupted), the same transaction writes one row per human seat: its outcome, the
  game's format, kind and seats, the bots' skill, the colours of the deck the seat played, the
  turns and the times. A replayed end finds the game no longer active and writes nothing, and a
  seat's row is unique anyway. Append-only: PostgreSQL refuses updates and deletes.
- **Outcomes** (OUTCOME_POLICY). A win is a game the engine reports completed with the seat as the
  winning seat, as wins count (api/progression.py). A loss is a completed game another seat won, a
  game that ended with every human out, or a game the seat left by conceding, being eliminated or
  being voted out. A draw is a game the engine reports drawn. Anything else has no result: a turn
  limit, an idle timeout, a closed game, a game the API interrupted.
- **Totals** count games, wins, losses, draws and games with no result: in all, by format, and
  against bots alone or with another player at the table, and best-of-three matches (v0.5.0,
  api/matches.py) once each beside their games. Whoever may open a profile sees them.
- **The history** lists the games one by one, newest first: when, the format, the opponents, the
  player's own deck and its revision, the outcome, the turns and the length. Only its player and
  SysOp (players.history) read it. It never names another seat's deck, and never a table's code.
  No game is recorded for replay, so the history offers none.
- **After a reset** (users.reset_at, v0.4.5) totals and the history count only games finished
  since, as the library counts only grants since.

Quests (api/quests.py) and achievements (api/achievements.py) count the same rows, through Rule.
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Query
from pydantic import Field
from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.orm import Session

from api.admin import decode_cursor, encode_cursor
from api.auth import INPUT_ERRORS
from api.decks import identity_of, revision_entries
from api.identity import Active, ApiError, Db, Principal, utcnow
from api.library import since_reset
from api.models import DeckRevision, Game, GameSeat, Match, MatchPlayer, PlayerResult, User
from api.progression import winning_seats
from api.schemas import Contract, Error
from api.social import PlayerRef, player_ref, visible_player
from api.teams import FORMAT as TEAM_FORMAT
from api.teams import teammate

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

# The rule outcomes are judged under, recorded on each row (PROG05).
OUTCOME_POLICY = "results-v1"
Outcome = Literal["win", "loss", "draw", "no_result"]
# A seat that left a game that went on lost it, whatever the game's end.
LOST_BY_LEAVING = ("conceded", "removed", "eliminated")
# The engine's fixture decks name their colour: legacy-mono-red-burn.
FIXTURE_COLORS = {"white": "W", "blue": "U", "black": "B", "red": "R", "green": "G"}
COLORS = ("W", "U", "B", "R", "G")
# The formats in the order the profile lists them; any other after them, alphabetically.
FORMAT_ORDER = ("commander", "legacy")
HISTORY_PAGE = 20


# Which results count towards a quest or an achievement.


@dataclass(frozen=True)
class Rule:
    """Wins that count towards a quest or an achievement: every condition set must hold. A win
    with a colour's deck is a win whose deck's colours include it; a bot's skill is the game's."""

    format: str | None = None
    color: str | None = None
    mono: bool = False
    colors_at_least: int = 0
    seats: int | None = None
    skill_at_least: int | None = None
    against_players: bool = False

    def matches(self, row: PlayerResult) -> bool:
        return (
            row.outcome == "win"
            and (self.format is None or row.format == self.format)
            and (self.color is None or self.color in row.colors)
            and (not self.mono or len(row.colors) == 1)
            and len(row.colors) >= self.colors_at_least
            and (self.seats is None or row.seats == self.seats)
            and (
                self.skill_at_least is None
                or (row.bots > 0 and (row.bot_skill or 0) >= self.skill_at_least)
            )
            and (not self.against_players or row.players > 0)
        )

    def condition(self) -> ColumnElement[bool]:
        """The same test in SQL, for counting a player's results in the database."""
        parts: list[ColumnElement[bool]] = [PlayerResult.outcome == "win"]
        if self.format is not None:
            parts.append(PlayerResult.format == self.format)
        if self.color is not None:
            parts.append(PlayerResult.colors.contains(self.color, autoescape=True))
        if self.mono:
            parts.append(func.length(PlayerResult.colors) == 1)
        if self.colors_at_least:
            parts.append(func.length(PlayerResult.colors) >= self.colors_at_least)
        if self.seats is not None:
            parts.append(PlayerResult.seats == self.seats)
        if self.skill_at_least is not None:
            parts.append(PlayerResult.bots > 0)
            parts.append(PlayerResult.bot_skill >= self.skill_at_least)
        if self.against_players:
            parts.append(PlayerResult.players > 0)
        return and_(*parts)


# Contracts.


class Totals(Contract):
    games: int
    wins: int
    losses: int
    draws: int
    no_result: int = Field(
        description="Games with no result: a turn limit, an idle timeout, a closed or "
        "interrupted game."
    )


class FormatTotals(Totals):
    format: str


class Stats(Contract):
    totals: Totals
    formats: list[FormatTotals] = Field(description="Each format played, Commander first.")
    against_bots: Totals = Field(description="Games where every other seat was a bot.")
    against_players: Totals = Field(description="Games with at least one other player.")
    matches: Totals = Field(
        description="Best-of-three matches that ended (api/matches.py), each once: a match won, "
        "lost or drawn, or closed with no result. Their games count among the games too."
    )
    history: bool = Field(
        description="Whether you may read this player's games one by one: your own, or SysOp."
    )


class Opponent(Contract):
    seat: int
    bot: bool
    player: PlayerRef | None = Field(
        description="The player at the seat; null for a bot or a player who has left."
    )
    bot_skill: int | None
    won: bool = Field(description="Whether this seat won the game.")
    teammate: bool = Field(
        default=False,
        description="Two-Headed Giant (v0.5.1): the player's teammate, who won or lost with them.",
    )


class HistoryEntry(Contract):
    game_id: UUID
    format: str
    kind: str = Field(description="practice, table, or another kind of game.")
    outcome: Outcome
    seat: int
    started_at: datetime
    finished_at: datetime
    seconds: int = Field(description="How long the game lasted.")
    turns: int | None
    deck: str | None = Field(description="The player's own deck, as the seat names it.")
    revision: int | None = Field(description="The deck's revision the game played (DECK01).")
    colors: str = Field(description="The deck's colours, WUBRG letters.")
    opponents: list[Opponent] = Field(description="Every other seat. Never their decks.")


class HistoryPage(Contract):
    items: list[HistoryEntry]
    next: str | None = Field(description="The cursor of the next, older page.")


# Recording results.


def outcome_of(result: dict[str, object] | None, seat: GameSeat) -> Outcome:
    """The seat's outcome under OUTCOME_POLICY (the module's docstring says it in words)."""
    found = result or {}
    winner = found.get("winner_seat")
    kind = found.get("kind")
    if kind == "completed" and isinstance(winner, int):
        # A team wins together (Two-Headed Giant, v0.5.0): every seat of winner_seats won.
        team = found.get("winner_seats")
        won = seat.seat in team if isinstance(team, list) and team else winner == seat.seat
        return "win" if won else "loss"
    conceded = found.get("conceded_seats")
    if (
        kind == "humans_eliminated"
        or seat.left_reason in LOST_BY_LEAVING
        or (isinstance(conceded, list) and seat.seat in conceded)
    ):
        return "loss"
    if found.get("draw") is True:
        return "draw"
    return "no_result"


def deck_colors(db: Session, game: Game, seat: GameSeat) -> str:
    """The colours of the deck the seat played: its revision's, as the deck builder shows them
    (a Commander deck's commanders' color identity, a Legacy deck's cards' colors), or a fixture
    deck's. A deck list SysOp typed has none recorded."""
    if seat.deck_revision_id is not None:
        revision = db.get(DeckRevision, seat.deck_revision_id)
        if revision is not None:
            return identity_of(db, game.format, revision_entries(db, revision))
    for word, letter in FIXTURE_COLORS.items():
        if f"-mono-{word}-" in seat.deck:
            return letter
    return ""


def record_results(db: Session, game: Game) -> list[PlayerResult]:
    """One row per human seat of a game that ended, in the caller's transaction, after its end is
    recorded; a seat already recorded keeps its row. Returns the rows written."""
    seats = list(
        db.scalars(select(GameSeat).where(GameSeat.game_id == game.id).order_by(GameSeat.seat))
    )
    done = set(db.scalars(select(PlayerResult.seat).where(PlayerResult.game_id == game.id)))
    result = game.result or {}
    turns = result.get("turns")
    finished = game.finished_at or utcnow()
    rows: list[PlayerResult] = []
    for seat in seats:
        if seat.user_id is None or seat.seat in done:
            continue
        # The other players and bots are the seat's opponents: in Two-Headed Giant (v0.5.1) the
        # other team's, so a teammate, a player's or a bot's, is never one the seat beat.
        others = [
            other
            for other in seats
            if other is not seat
            and not (game.format == TEAM_FORMAT and other.seat == teammate(seat.seat))
        ]
        bots = sum(1 for other in others if other.player == "bot")
        row = PlayerResult(
            game_id=game.id,
            seat=seat.seat,
            user_id=seat.user_id,
            outcome=outcome_of(game.result, seat),
            format=game.format,
            kind=game.kind,
            seats=len(seats),
            players=sum(1 for other in others if other.user_id is not None),
            bots=bots,
            bot_skill=game.bot_skill if bots else None,
            colors=deck_colors(db, game, seat),
            turns=turns if isinstance(turns, int) else None,
            started_at=game.created_at,
            finished_at=finished,
            policy=OUTCOME_POLICY,
        )
        db.add(row)
        rows.append(row)
    db.flush()
    return rows


def counted(user: User) -> ColumnElement[bool]:
    """The account's results that count: since SysOp last reset it, or all of them."""
    return and_(PlayerResult.user_id == user.id, since_reset(user, PlayerResult.finished_at))


# Totals.


def empty() -> dict[str, int]:
    return {"games": 0, "wins": 0, "losses": 0, "draws": 0, "no_result": 0}


OUTCOME_FIELDS: dict[str, str] = {
    "win": "wins",
    "loss": "losses",
    "draw": "draws",
    "no_result": "no_result",
}


def stats_of(db: Session, user: User, *, history: bool) -> Stats:
    with_players = (PlayerResult.players > 0).label("with_players")
    rows = db.execute(
        select(PlayerResult.format, with_players, PlayerResult.outcome, func.count())
        .where(counted(user))
        .group_by(PlayerResult.format, with_players, PlayerResult.outcome)
    ).all()
    totals, bots, players = empty(), empty(), empty()
    formats: dict[str, dict[str, int]] = defaultdict(empty)
    for game_format, others, outcome, count in rows:
        column = OUTCOME_FIELDS.get(outcome, "no_result")
        for found in (totals, formats[game_format], players if others else bots):
            found["games"] += count
            found[column] += count
    order = [name for name in FORMAT_ORDER if name in formats] + sorted(
        name for name in formats if name not in FORMAT_ORDER
    )
    return Stats(
        totals=Totals(**totals),
        formats=[FormatTotals(format=name, **formats[name]) for name in order],
        against_bots=Totals(**bots),
        against_players=Totals(**players),
        matches=match_totals(db, user),
        history=history,
    )


def match_totals(db: Session, user: User) -> Totals:
    """The player's best-of-three matches that ended (v0.5.0), since a reset: won when their seat
    won the match, drawn on equal game wins, no result when it closed (a game closed or timed out,
    or the next game could not start), and lost otherwise."""
    found = empty()
    rows = db.execute(
        select(Match.status, Match.winner_seat, Match.draw, MatchPlayer.seat)
        .join(MatchPlayer, MatchPlayer.match_id == Match.id)
        .where(
            MatchPlayer.user_id == user.id,
            Match.status.in_(("finished", "closed")),
            since_reset(user, Match.finished_at),
        )
    ).all()
    for status, winner, draw, seat in rows:
        found["games"] += 1
        if status == "closed":
            found["no_result"] += 1
        elif draw:
            found["draws"] += 1
        elif winner == seat:
            found["wins"] += 1
        else:
            found["losses"] += 1
    return Totals(**found)


# The history.


def history_of(db: Session, user: User, limit: int, cursor: str | None) -> HistoryPage:
    query = select(PlayerResult).where(counted(user))
    if cursor:
        moment, row_id = decode_cursor(cursor)
        query = query.where(
            or_(
                PlayerResult.finished_at < moment,
                and_(PlayerResult.finished_at == moment, PlayerResult.id < row_id),
            )
        )
    rows = list(
        db.scalars(
            query.order_by(PlayerResult.finished_at.desc(), PlayerResult.id.desc()).limit(limit + 1)
        )
    )
    more = len(rows) > limit
    rows = rows[:limit]
    games = {row.game_id for row in rows}
    seats: dict[UUID, list[GameSeat]] = defaultdict(list)
    for seat in db.scalars(
        select(GameSeat).where(GameSeat.game_id.in_(games)).order_by(GameSeat.seat)
    ):
        seats[seat.game_id].append(seat)
    results = dict(db.execute(select(Game.id, Game.result).where(Game.id.in_(games))).all())
    others = {
        seat.user_id
        for found in seats.values()
        for seat in found
        if seat.user_id is not None and seat.user_id != user.id
    }
    players = {
        found.id: found
        for found in db.scalars(select(User).where(User.id.in_(others)))
        if found.normalized_handle
    }
    own = {
        seat.deck_revision_id
        for row in rows
        for seat in seats[row.game_id]
        if seat.seat == row.seat and seat.deck_revision_id is not None
    }
    numbers = {
        revision_id: number
        for revision_id, number in db.execute(
            select(DeckRevision.id, DeckRevision.number).where(DeckRevision.id.in_(own))
        )
    }
    items = []
    for row in rows:
        result = results.get(row.game_id) or {}
        won = winning_seats(result)
        mine = next((seat for seat in seats[row.game_id] if seat.seat == row.seat), None)
        items.append(
            HistoryEntry(
                game_id=row.game_id,
                format=row.format,
                kind=row.kind,
                outcome=row.outcome,  # type: ignore[arg-type]
                seat=row.seat,
                started_at=row.started_at,
                finished_at=row.finished_at,
                seconds=max(0, int((row.finished_at - row.started_at).total_seconds())),
                turns=row.turns,
                deck=mine.deck if mine else None,
                revision=numbers.get(mine.deck_revision_id)
                if mine and mine.deck_revision_id
                else None,
                colors=row.colors,
                opponents=[
                    Opponent(
                        seat=seat.seat,
                        bot=seat.player == "bot",
                        player=player_ref(players[seat.user_id])
                        if seat.user_id in players
                        else None,
                        bot_skill=row.bot_skill if seat.player == "bot" else None,
                        won=seat.seat in won,
                        teammate=row.format == TEAM_FORMAT and seat.seat == teammate(row.seat),
                    )
                    for seat in seats[row.game_id]
                    if seat.seat != row.seat
                ],
            )
        )
    return HistoryPage(
        items=items,
        next=encode_cursor(rows[-1].finished_at, rows[-1].id) if more and rows else None,
    )


def may_read_history(principal: Principal, user: User) -> bool:
    """A player's own history, and SysOp's view of anyone's (the owner's decision)."""
    return user.id == principal.user.id or principal.can("players.history")


# Routes.

Limit = Annotated[int, Query(ge=1, le=50)]
Cursor = Annotated[str | None, Query(max_length=200)]


@router.get("/me/stats", response_model=Stats)
def my_stats(principal: Active, db: Db) -> Stats:
    return stats_of(db, principal.user, history=True)


@router.get("/players/{player_id}/stats", response_model=Stats)
def player_stats(player_id: UUID, principal: Active, db: Db) -> Stats:
    """A player's totals, for whoever may open their profile."""
    user = visible_player(db, player_id)
    return stats_of(db, user, history=may_read_history(principal, user))


@router.get("/me/history", response_model=HistoryPage)
def my_history(
    principal: Active, db: Db, limit: Limit = HISTORY_PAGE, cursor: Cursor = None
) -> HistoryPage:
    return history_of(db, principal.user, limit, cursor)


@router.get(
    "/players/{player_id}/history",
    response_model=HistoryPage,
    responses={403: {"model": Error}},
)
def player_history(
    player_id: UUID,
    principal: Active,
    db: Db,
    limit: Limit = HISTORY_PAGE,
    cursor: Cursor = None,
) -> HistoryPage:
    """A player's games one by one: only their own, and SysOp's view of anyone's."""
    user = visible_player(db, player_id)
    if not may_read_history(principal, user):
        raise ApiError(
            403,
            "history_private",
            "A player's games are theirs to see: their profile shows only their totals.",
        )
    return history_of(db, user, limit, cursor)
