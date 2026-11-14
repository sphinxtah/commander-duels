"""Human tables (v0.4.0): the lobby, invite links, seats, and the start of a table's game.

- **The lobby.** A player opens a table: Legacy for two, or Commander for two to four, public or
  private, with bots of one skill (1-6) in the seats the players leave. Public tables are listed
  while they wait for players; a private one is reached only by its invite link, whose code is
  unguessable. SysOp sees every table. A table nobody started closes after 3 hours.
- **Rules** (v0.4.5). The host chooses which cards its decks may hold by their legality in the
  format: banned cards, and cards not legal in it (Un-cards, playtest and digital-only cards).
  A new table is casual, allowing both; tournament rules allow neither. Since v0.6.2 a third
  option allows the cards the engine plays as stand-ins, on at a casual table, off under
  tournament rules. The format's deck rules always apply. The lobby shows each table's rules.
- **Seats.** A player takes a seat with one of their own decks, checked as at the practice table:
  every copy in their library, no deck that cannot be played, and no card the table's rules do
  not allow (the player is told which). Administrators' whole-catalog decks play too. Players may
  change deck, mark themselves ready and leave. A player sits at one open table at a time, and
  the host leaving closes the table.
- **Starting.** The host starts once every player's seat is taken and ready, within every player's
  limit of running games (CD_GAMES_PER_ACCOUNT; SysOp has none), and every deck is checked again.
  That makes one engine game, with the players' seats first, then the bots'. The game runs as any
  other (api/games.py): each player's seat has its own token, lease, views and concession, and
  away players may be voted out.
- **Privacy.** Others see a seat's handle and portrait (its alliance), never its deck.
- **Two-Headed Giant** (v0.5.1, FMT10). A table of four seats in two teams, seats 0 and 1 against
  2 and 3 (api/teams.py): four players, or players with bots as teammates or opponents (the host
  chooses whether their teammate is a bot, and how many of the other team's seats bots fill), at
  least two players in all. Players choose a team or take the first free seat, and may move to a
  free seat of the other team. Each deck is a Legacy deck checked by the table's rules, and a
  team's two decks follow Unified Deck Construction: checked when a player gets ready, against
  their teammate's deck, and again at the start, the shared cards named to the team itself only.
  Each side is the revision its seat is bound to, checked against its player's library, never a
  draft; once cards are named, the two players stay on that team at the table until it closes.
  Changing deck or team makes the player and their teammate not ready again. Bots get fixture
  decks their teammate's deck shares no card with. A player's concession is their team's (810.8b),
  as the engine plays it.
- **King's Table** (v0.8.7, api/kings_table.py). Six named seats in two teams of three, a King
  and two Generals each, at least one of them a player's. The host chooses the settings (the
  decks' format, the starting life and whether a King attacks anyone), their own seat and the
  seats bots fill, and until the start may change the settings, the bots' seats and any player's
  seat (to an open one); players take an open seat by its number or team and may move to another.
  Any such change makes every player not ready again. Each deck is checked by the settings' deck
  format and the table's rules, when it is chosen, when its player gets ready and at the start;
  teammates may share cards. Bots play the engine's fixture decks of that format. The settings
  are the game's once it starts.
- **Finding a table** (v0.9.2). The lobby's cards come a page at a time (20, 50 or 100), newest
  first with your own table leading, filtered by format, rules (casual or tournament), open seats,
  no bots, best of three, and friends' tables: those a friend sits at or you were invited to.
- **The campaign's court** (v0.9.6). Ward 15 with friends as the player's Generals is a private
  King's Table table the campaign opens (api/campaign.py open_court): the player is its host,
  seated as King A, the court's three seats are bots, and the player's Generals' seats wait for
  the friends invited. Its settings and the court's seats are fixed; the host may still give an
  open General's seat to a bot. Its start serves team B the court's decks, and its game is the
  campaign's: its end is read as the court's, and counts nothing else for anyone.
- **Invitations** (v0.9.2). The host invites friends when opening a table, and any of its players
  invites more from its page: each friend gets a notice in the bell that leads to the table, and
  sees it in the lobby even when it is private. No seat is held; inviting a friend again sends
  nothing new.
"""

import random
import secrets
from collections.abc import Callable
from contextlib import AsyncExitStack
from datetime import datetime, timedelta
from typing import Annotated, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Path, Query, Request
from pydantic import Field
from sqlalchemy import Select, delete, func, not_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from api import kings_table, matches, table_profiles, teams
from api.auth import INPUT_ERRORS
from api.custom_play import custom_in_seats
from api.decks import entries_of, revision_entries, starters_of
from api.games import (
    FORMAT_NAMES,
    TABLE_IDLE_SECONDS,
    LiveGame,
    LiveSeat,
    Player,
    SeatPlan,
    active_games_of,
    deck_format_of,
    engine_game,
    engine_names,
    followed_or_closed,
    full_access,
    hub_of,
    own_deck,
    require_loaded,
    seat_tokens,
    starter_seat,
    team_play,
)
from api.identity import (
    ApiError,
    Db,
    Principal,
    not_found,
    permissions_for,
    roles_of,
    settings_of,
    utcnow,
)
from api.library import library_of
from api.models import (
    CatalogRevision,
    Deck,
    DeckRevision,
    FormatVersion,
    Game,
    GameSeat,
    GameTable,
    TableInvite,
    TableSeat,
    User,
)
from api.roster import roster_of
from api.schemas import (
    BEST_OF_TEXT,
    KINGS_TABLE_SEAT_TEXT,
    MAX_TURN_CAP,
    TURN_CAP_TEXT,
    BestOf,
    Contract,
    Error,
    KingsTableChange,
    KingsTableRole,
    KingsTableSettings,
    TableFormatId,
    TableRules,
    casual,
    default_turn_cap,
)
from api.table_profiles import Intent, Pace, ProfileView, TableProfile
from api.validation import DeckEntry

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

# A table nobody started is closed after this long, so the lobby holds no forgotten tables.
OPEN_HOURS = 3
LISTED = 50
# The lobby's pages of tables (v0.9.2).
PAGE_SIZES = (20, 50, 100)
# Friends invited at once, and to one table in all (v0.9.2).
INVITES_AT_ONCE = 20
INVITES_PER_TABLE = 50
TEAM_FORMAT = teams.FORMAT
KINGS = kings_table.FORMAT
SEATS = {
    "legacy": [2],
    "commander": [2, 3, 4],
    TEAM_FORMAT: [teams.SEATS],
    KINGS: [kings_table.SEATS],
}
# A Two-Headed Giant player beside a bot whose deck leaves the bot no fixture deck (v0.5.1).
NO_BOT_TEAMMATE = (
    "Your deck shares a card with every bot deck, so no bot can be your teammate: choose another "
    "deck."
)
Code = Annotated[str, Path(min_length=8, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")]
KingsSeat = Annotated[int, Field(ge=0, le=5)]
Visibility = Literal["public", "private"]


class TableRequest(Contract):
    """A new table: the host takes the first seat with one of their decks."""

    format: TableFormatId = "legacy"
    seats: int = Field(
        default=2,
        ge=2,
        le=6,
        description="Every seat, bots included: 2 in Legacy, 2-4 in Commander, 4 in "
        "Two-Headed Giant, 6 at King's Table.",
    )
    bots: int = Field(
        default=0,
        ge=0,
        le=5,
        description="Seats bots fill: in Commander after the players'; in Two-Headed Giant (since "
        "v0.5.1) your teammate's when bot_teammate, the rest the other team's. At King's Table "
        "bot_seats names them; bots, if given, counts them.",
    )
    bot_teammate: bool = Field(
        default=False,
        description="Two-Headed Giant (v0.5.1): a bot is your teammate, in seat 1; one of bots.",
    )
    bot_skill: int = Field(default=4, ge=1, le=6)
    turn_cap: int | None = Field(default=None, ge=1, le=MAX_TURN_CAP, description=TURN_CAP_TEXT)
    visibility: Visibility = Field(
        default="public",
        description="public tables are listed; a private one is reached by its invite link only.",
    )
    rules: TableRules = Field(
        default_factory=casual,
        description="Which cards its decks may hold by their legality; casual unless told "
        "otherwise.",
    )
    best_of: BestOf = Field(default=1, description=BEST_OF_TEXT)
    deck_id: UUID = Field(description="The host's deck.")
    seat: KingsSeat | None = Field(
        default=None,
        description=f"{KINGS_TABLE_SEAT_TEXT} Your seat; team A's King (1) when left out.",
    )
    bot_seats: list[KingsSeat] | None = Field(
        default=None,
        max_length=5,
        description="King's Table (v0.8.7): the seats bots fill, any but yours; none when left "
        "out.",
    )
    kings_table: KingsTableSettings | None = Field(
        default=None,
        description="King's Table (v0.8.7): its settings, the defaults when left out. Refused at "
        "other tables.",
    )
    invite: list[UUID] = Field(
        default_factory=list,
        max_length=INVITES_AT_ONCE,
        description="Since v0.9.2: friends to invite, each told in the bell. Every one must be "
        "your friend.",
    )
    profile: TableProfile | None = Field(
        default=None,
        description="Since v0.9.12: the table's Rule Zero profile (what kind of game it is for, "
        "and the restrictions on its decks the server enforces); none when left out.",
    )


class TableInviting(Contract):
    """Friends a table's player invites (v0.9.2)."""

    players: list[UUID] = Field(min_length=1, max_length=INVITES_AT_ONCE)


class InvitesSent(Contract):
    invited: list[str] = Field(description="The friends invited now, each told in the bell.")
    already: list[str] = Field(
        description="Friends invited before or seated at the table already: told nothing new."
    )


Team = Annotated[int, Field(ge=0, le=1)]
TEAM_TEXT = (
    "Two-Headed Giant (v0.5.1): 0 for seats 0 and 1, 1 for seats 2 and 3; King's Table (v0.8.7): "
    "0 for seats 0-2, 1 for seats 3-5."
)


class SeatTaking(Contract):
    deck_id: UUID = Field(description="One of your decks, in the table's format.")
    team: Team | None = Field(
        default=None,
        description=f"{TEAM_TEXT} The team to join; the first free seat when left out.",
    )
    seat: KingsSeat | None = Field(
        default=None,
        description=f"{KINGS_TABLE_SEAT_TEXT} The open seat to take; the first open one (of team, "
        "when given) when left out.",
    )


class SeatChange(Contract):
    deck_id: UUID | None = Field(default=None, description="Another of your decks; unreadies.")
    ready: bool | None = None
    team: Team | None = Field(
        default=None,
        description=f"{TEAM_TEXT} Moves you to a free seat of that team; unreadies you, and the "
        "teammate you then have (at King's Table every player).",
    )
    seat: KingsSeat | None = Field(
        default=None,
        description=f"{KINGS_TABLE_SEAT_TEXT} Moves you to that open seat, which makes every "
        "player not ready.",
    )


class SeatMove(Contract):
    seat: KingsSeat = Field(description="The seat of the player to move.")
    to: KingsSeat = Field(description="An open seat: neither taken nor a bot's.")


class TableChange(Contract):
    """The host's changes to a table before its start: a King's Table table's settings and seats
    (v0.8.7), and since v0.9.12 any table's Rule Zero profile. Anything that changes makes every
    player not ready again; the host's start is their ready."""

    profile: TableProfile | None = Field(
        default=None,
        description="Since v0.9.12: the table's Rule Zero profile from now on; null removes it, "
        "and left out it stays. Any change to it, its note included, makes every player not "
        "ready again: getting ready again is how they accept it.",
    )

    kings_table: KingsTableChange | None = Field(
        default=None, description="Settings to change; one left out stays."
    )
    bot_seats: list[KingsSeat] | None = Field(
        default=None,
        max_length=5,
        description="Every seat bots fill from now on, none of a player's (after the move).",
    )
    move: SeatMove | None = Field(default=None, description="Moves a player to an open seat.")


class TablePlayer(Contract):
    seat: int
    player: Literal["human", "bot"]
    taken: bool = Field(description="Whether a player sits there; bots' seats always are.")
    handle: str | None
    portrait: str | None = Field(description="A player's allied Planeswalker.")
    host: bool
    ready: bool = Field(description="The host is always ready: starting is their ready.")
    you: bool
    deck: str | None = Field(description="Your own seat's deck title; others' decks are private.")
    deck_id: UUID | None = Field(description="Your own seat's deck.")
    team: int | None = Field(default=None, description=f"{TEAM_TEXT} Null in other formats.")
    role: KingsTableRole | None = Field(
        default=None, description="King's Table (v0.8.7): king or general; null elsewhere."
    )
    starting_life: int | None = Field(
        default=None,
        description="King's Table (v0.8.7): the seat's starting life under the settings.",
    )


class TableView(Contract):
    code: str = Field(description="The invite link's code: #tables/<code>.")
    format: TableFormatId
    visibility: Visibility
    status: Literal["open", "started", "closed"]
    seats: int
    bots: int
    bot_skill: int
    turn_cap: int
    rules: TableRules
    best_of: int = Field(default=1, description="Since v0.5.0: 3 for a best-of-three match.")
    kings_table: KingsTableSettings | None = Field(
        default=None,
        description="King's Table (v0.8.7): the host's settings, which its game starts with; "
        "null at other tables.",
    )
    host: str | None = Field(description="The host's handle.")
    players: list[TablePlayer] = Field(
        description="Every seat in turn order, bots last (at Two-Headed Giant and King's Table "
        "tables, in their own seats)."
    )
    your_seat: int | None
    can_start: bool = Field(description="You host it, every player's seat is taken and ready.")
    game_id: UUID | None = Field(description="Its game, once started; for its players and SysOp.")
    created_at: datetime
    open_seats: int = Field(
        default=0, description="Since v0.9.2: players' seats nobody has taken yet."
    )
    friends: list[str] = Field(
        default_factory=list,
        description="Since v0.9.2, in the lobby's pages: your friends seated at the table.",
    )
    invited_by: str | None = Field(
        default=None,
        description="Since v0.9.2, in the lobby's pages: who invited you to the table, if anyone.",
    )
    campaign: str | None = Field(
        default=None,
        description="Since v0.9.6: the campaign encounter's title when the campaign opened the "
        "table (ward 15's court); null for every other table.",
    )
    profile: ProfileView | None = Field(
        default=None,
        description="Since v0.9.12: the table's Rule Zero profile: what it describes, and every "
        "rule the server enforces on its decks. Null when its host gave none.",
    )


RulesFilter = Literal["casual", "tournament"]
# Find a game's orders (v0.9.3): newest first, the most players seated, the fewest seats open.
TableSort = Literal["newest", "players", "fewest_open"]


class TablePage(Contract):
    """A page of the lobby's open tables (v0.9.2)."""

    tables: list[TableView]
    total: int = Field(description="Every table the filters find, on every page.")
    page: int = Field(description="This page, from 1; the last one when asked for past it.")
    per_page: int
    yours: TableView | None = Field(
        default=None, description="The open table you sit at, whatever the filters."
    )


def cutoff() -> datetime:
    return utcnow() - timedelta(hours=OPEN_HOURS)


def status_of(table: GameTable) -> str:
    """A table left open too long counts as closed."""
    if table.status == "open" and table.created_at < cutoff():
        return "closed"
    return table.status


def rules_of(table: GameTable) -> TableRules:
    return TableRules(
        banned=table.allow_banned,
        not_legal=table.allow_not_legal,
        stand_in=table.allow_stand_in,
    )


def team_bot_seats(bots: int, teammate: bool) -> list[int]:
    """A Two-Headed Giant table's bots (v0.5.1): the host's teammate's seat when a bot is their
    teammate, then the other team's seats from its last."""
    others = bots - teammate
    return sorted(([1] if teammate else []) + list(range(teams.SEATS - others, teams.SEATS)))


def bot_seats_of(table: GameTable) -> list[int]:
    """The seats bots fill: the last ones, or (v0.5.1) those the table names."""
    if table.bot_seats is not None:
        return sorted(table.bot_seats)
    return list(range(table.seats - table.bots, table.seats))


def player_seats_of(table: GameTable) -> list[int]:
    """The seats players take, in turn order."""
    bots = bot_seats_of(table)
    return [seat for seat in range(table.seats) if seat not in bots]


def team_of(table: GameTable, seat: int) -> int | None:
    if table.format == KINGS:
        return kings_table.team_of(seat)
    return seat // 2 if table.format == TEAM_FORMAT else None


def kings_of(table: GameTable) -> KingsTableSettings | None:
    """A King's Table table's settings (v0.8.7); None at any other table."""
    return kings_table.config_of(table.kings_table) if table.format == KINGS else None


def deck_format_for(table: GameTable) -> str:
    """The format the table's decks are built for."""
    return deck_format_of(table.format, table.kings_table)


def team_cards(db: Session, deck_id: UUID) -> set[str]:
    """A deck's cards as Unified Deck Construction compares a team's (api/teams.py): the engine's
    names of its main deck's cards as the deck stands now, basic lands aside."""
    deck = db.get(Deck, deck_id)
    if deck is None:
        return set()
    return main_cards(db, entries_of(deck))


def bound_cards(db: Session, revision_id: UUID | None) -> set[str]:
    """A table seat's cards as Unified Deck Construction compares a team's (v0.5.1): those of the
    revision the seat is bound to, which its player's library was checked against, never the
    deck's draft, which may hold cards its player does not own."""
    revision = db.get(DeckRevision, revision_id) if revision_id is not None else None
    if revision is None:
        return set()
    return main_cards(db, revision_entries(db, revision))


def main_cards(db: Session, entries: list[DeckEntry]) -> set[str]:
    """The engine's names of the main deck's cards, basic lands aside."""
    main = [entry for entry in entries if entry.location == "main"]
    return {name for name in engine_names(db, main, True).values() if name} - teams.BASICS


# Two-Headed Giant (v0.5.1): once the cards two teammates' decks share are named to one of them,
# both stay on that team at the table until it closes, so what was named never reaches the other
# team.
KEPT = (
    "Cards your deck shares with a teammate's were named at this table, so you may sit only on "
    "that team until the table closes."
)


def kept_team(table: GameTable, user_id: UUID) -> int | None:
    """The team a player stays on at this table (v0.5.1), if any."""
    return (table.kept_teams or {}).get(str(user_id))


def keep_team(db: Session, table: GameTable, team: int, told: UUID, mate: UUID) -> None:
    """A player was told the cards their deck shares with their teammate's: the two stay on the
    team at this table until it closes (v0.5.1). Recorded on the table, so leaving and joining
    again does not lift it. SysOp, who may read every deck anyway, is never kept, nor is a player
    whose cards only SysOp was told."""
    if sees_all(db, told):
        return
    users = [told] if sees_all(db, mate) else [told, mate]
    table.kept_teams = {str(user): team for user in users} | (table.kept_teams or {})


def sees_all(db: Session, user_id: UUID) -> bool:
    """SysOp, whose inspection shows every seat's cards. Not an administrator (v0.8.9), who sees
    none of a game they play with other people."""
    user = db.get(User, user_id)
    return user is not None and user.kind == "sysop"


def stays_on(table: GameTable, user_id: UUID, team: int) -> None:
    """Refuses a player a seat in a team other than the one they stay on (v0.5.1)."""
    kept = kept_team(table, user_id)
    if kept is not None and kept != team:
        raise ApiError(409, "team_locked", KEPT)


def shared_with(mate: str | None, both: list[str]) -> str:
    """The remedy for two teammates' decks that share cards, as the team itself is told."""
    return (
        f"Your deck and {mate or 'your teammate'}'s share {teams.listed(both)}. In Two-Headed "
        "Giant teammates' decks may share only basic lands: one of you needs another deck."
    )


def team_banned(names: set[str], rules: TableRules, permissions: frozenset[str]) -> ApiError | None:
    """A deck holding a card banned in Two-Headed Giant itself (MTR 9.5) at a table refusing
    banned cards; SysOp's decks play whatever the table's rules say."""
    held = sorted(names & teams.BANNED)
    if rules.banned or not held or "cards.any" in permissions:
        return None
    return ApiError(
        422,
        "deck_not_allowed",
        f"This table does not allow banned cards: {teams.listed(held)} "
        f"{'is' if len(held) == 1 else 'are'} banned in Two-Headed Giant. Choose another deck, "
        "or take it out of this one.",
    )


def find(db: Session, code: str, *, lock: bool = False) -> GameTable:
    statement = select(GameTable).where(GameTable.code == code)
    table = db.scalar(statement.with_for_update() if lock else statement)
    if table is None:
        raise not_found()
    return table


def seats_of(db: Session, table: GameTable) -> list[TableSeat]:
    return list(
        db.scalars(select(TableSeat).where(TableSeat.table_id == table.id).order_by(TableSeat.seat))
    )


def open_table_of(db: Session, user_id: UUID) -> GameTable | None:
    """The open table the account sits at, if any: one at a time."""
    return db.scalar(
        select(GameTable)
        .join(TableSeat, TableSeat.table_id == GameTable.id)
        .where(
            TableSeat.user_id == user_id,
            GameTable.status == "open",
            GameTable.created_at >= cutoff(),
        )
    )


def view_of(db: Session, table: GameTable, principal: Principal) -> TableView:
    rows = seats_of(db, table)
    by_seat = {row.seat: row for row in rows}
    users = {row.user_id for row in rows} | {table.host_id}
    found = {
        user_id: (handle, alliance)
        for user_id, handle, alliance in db.execute(
            select(User.id, User.handle, User.alliance).where(User.id.in_(users))
        )
    }
    you = principal.user.id
    mine = next((row for row in rows if row.user_id == you), None)
    deck = db.get(Deck, mine.deck_id) if mine is not None else None
    bots = bot_seats_of(table)
    kings = kings_of(table)
    # The campaign's court (v0.9.6): team B's bots by name and portrait.
    named = campaign_names(table)
    players: list[TablePlayer] = []
    for index in range(table.seats):
        row = by_seat.get(index)
        role = kings_table.role_of(index) if kings else None
        life = kings_table.starting_life(kings, index) if kings else None
        if index in bots:
            name, portrait = named.get(index, (None, None))
            players.append(
                TablePlayer(
                    seat=index,
                    player="bot",
                    taken=True,
                    handle=name,
                    portrait=portrait,
                    host=False,
                    ready=True,
                    you=False,
                    deck=None,
                    deck_id=None,
                    team=team_of(table, index),
                    role=role,
                    starting_life=life,
                )
            )
            continue
        handle, alliance = found.get(row.user_id, (None, None)) if row else (None, None)
        own = row is not None and row.user_id == you
        host = row is not None and row.user_id == table.host_id
        players.append(
            TablePlayer(
                seat=index,
                player="human",
                taken=row is not None,
                handle=handle,
                portrait=alliance,
                host=host,
                ready=row is not None and (row.ready or host),
                you=own,
                deck=deck.title if own and deck is not None else None,
                deck_id=row.deck_id if own and row is not None else None,
                team=team_of(table, index),
                role=role,
                starting_life=life,
            )
        )
    status = status_of(table)
    ready = all(player.taken and player.ready for player in players)
    return TableView(
        code=table.code,
        format=table.format,  # type: ignore[arg-type]
        visibility=table.visibility,  # type: ignore[arg-type]
        status=status,  # type: ignore[arg-type]
        seats=table.seats,
        bots=table.bots,
        bot_skill=table.bot_skill,
        turn_cap=table.turn_cap,
        rules=rules_of(table),
        best_of=table.best_of,
        kings_table=kings,
        host=found.get(table.host_id, (None, None))[0],
        players=players,
        your_seat=mine.seat if mine is not None else None,
        can_start=status == "open" and table.host_id == you and ready,
        game_id=table.game_id if mine is not None or full_access(principal) else None,
        created_at=table.created_at,
        open_seats=sum(1 for player in players if player.player == "human" and not player.taken),
        campaign=str(table.campaign.get("title")) if table.campaign else None,
        profile=table_profiles.view(table_profiles.profile_of(table), rules_of(table)),
    )


def campaign_names(table: GameTable) -> dict[int, tuple[str, str]]:
    """The court's named bot seats (v0.9.6), as the campaign recorded them on its table."""
    found = (table.campaign or {}).get("opponents")
    if not isinstance(found, dict):
        return {}
    return {
        int(seat): (str(pair[0]), str(pair[1]))
        for seat, pair in found.items()
        if isinstance(pair, list) and len(pair) == 2
    }


def open_campaign_table(
    db: Session,
    request: Request,
    principal: Principal,
    deck_id: UUID,
    friends: list[UUID],
    campaign: dict[str, object],
    host_seat: int,
    bot_seats: list[int],
    settings: dict[str, object],
    skill: int,
    turn_cap: int,
) -> TableView:
    """The table the campaign opens for ward 15 with friends (v0.9.6, api/campaign.py): private,
    King's Table under the court's settings, its host seated as King A with one of their decks,
    the bots in the seats given, and the friends invited to the rest. Casual rules."""
    invitees = friends_to_invite(db, principal.user, friends)
    kings = kings_table.config_of(settings)
    rules = casual()
    revision = check_deck(
        db, request, principal.user, principal.permissions, deck_id, KINGS, rules, kings
    )
    may_sit(db, request, principal)
    now = utcnow()
    seats = kings_bot_seats(bot_seats, {host_seat})
    table = GameTable(
        code=secrets.token_urlsafe(12),
        host_id=principal.user.id,
        format=KINGS,
        visibility="private",
        seats=kings_table.SEATS,
        bots=len(seats),
        bot_seats=seats,
        kings_table=kings_table.engine_settings(kings),
        bot_skill=skill,
        turn_cap=turn_cap,
        allow_banned=rules.banned,
        allow_not_legal=rules.not_legal,
        allow_stand_in=rules.stand_in,
        best_of=1,
        status="open",
        created_at=now,
        campaign={**campaign, "player_seat": host_seat},
    )
    db.add(table)
    db.flush()
    db.add(
        TableSeat(
            table_id=table.id,
            seat=host_seat,
            user_id=principal.user.id,
            deck_id=deck_id,
            deck_revision_id=revision,
            ready=True,
            joined_at=now,
        )
    )
    invite(db, table, principal.user, invitees, now)
    db.commit()
    return view_of(db, table, principal)


def check_deck(
    db: Session,
    request: Request,
    user: User,
    permissions: frozenset[str],
    deck_id: UUID,
    fmt: str,
    rules: TableRules,
    kings: object = None,
    profile: TableProfile | None = None,
) -> UUID:
    """A deck the player may sit down with: theirs, of the table's format, playable with their
    library now (as at the practice table), and holding no card the table's rules do not allow.
    Two-Headed Giant (v0.5.1) takes a Legacy deck, and refuses its own banned card where banned
    cards are refused; King's Table (v0.8.7) a deck of its settings' (kings) deck format. Since
    v0.9.12 the table's Rule Zero profile's restrictions hold too, for every account (SysOp's
    included: they are what the table promised its players). Returns the revision the deck is
    bound to, as checked (v0.5.1)."""
    if "decks.edit" not in permissions:
        raise ApiError(403, "forbidden", "Your account cannot play its own decks.")
    library = library_of(db, user, permissions, roster_of(request))
    deck_format = deck_format_of(fmt, kings)
    seat, revision, _ = own_deck(db, user, permissions, deck_id, deck_format, library, rules)
    if fmt == TEAM_FORMAT:
        refused = team_banned(teams.cards_of(seat) or set(), rules, permissions)
        if refused is not None:
            raise refused
    table_profiles.refuse_revision(db, profile, revision)
    return revision


def may_sit(db: Session, request: Request, principal: Principal) -> None:
    """One open table at a time, and room under the account's limit of running games. The
    account's row is locked, so two requests at once sit down once."""
    db.scalar(select(User.id).where(User.id == principal.user.id).with_for_update())
    if open_table_of(db, principal.user.id) is not None:
        raise ApiError(409, "at_a_table", "You are at another open table. Leave it first.")
    # Imported here: api.queues imports this module. A player waits in a queue or sits at a table,
    # not both (v0.5.0).
    from api.queues import waiting_of

    if waiting_of(db, principal.user.id) is not None:
        raise ApiError(409, "in_queue", "You are waiting in a public queue. Leave it first.")
    limit = settings_of(request).games_per_account
    if not full_access(principal) and active_games_of(db, principal.user.id) >= limit:
        raise ApiError(
            409, "game_limit", "Finish your running game before you sit down at a table."
        )


# Routes.


def friends_of(db: Session, user_id: UUID) -> set[UUID]:
    # Imported here: api.social imports this module's cutoff.
    from api.social import friendships_of

    return {other for other, row in friendships_of(db, user_id).items() if row.status == "accepted"}


def invited_to(user_id: UUID) -> Select[UUID]:
    """The tables the account was invited to (v0.9.2), as a subquery of their ids."""
    return select(TableInvite.table_id).where(TableInvite.user_id == user_id)


@router.get(
    "/tables/browse",
    response_model=TablePage,
    responses={422: {"model": Error}},
)
def browse_tables(
    principal: Player,
    db: Db,
    format: Annotated[
        list[TableFormatId] | None, Query(description="Formats to show; all when left out.")
    ] = None,
    rules: Annotated[
        list[RulesFilter] | None,
        Query(
            description="casual (any of banned, not legal or stand-in cards allowed) or "
            "tournament (none); both when left out."
        ),
    ] = None,
    open_seats: Annotated[
        bool, Query(description="Only tables with a player's seat free.")
    ] = False,
    no_bots: Annotated[bool, Query(description="Only tables without bots.")] = False,
    best_of_three: Annotated[bool, Query(description="Only best-of-three matches.")] = False,
    friends: Annotated[
        bool, Query(description="Only tables a friend sits at or you were invited to.")
    ] = False,
    host: Annotated[
        str | None,
        Query(max_length=40, description="Only tables whose host's handle holds this."),
    ] = None,
    intent: Annotated[
        list[Intent] | None,
        Query(
            description="Since v0.9.12: only tables whose Rule Zero profile says one of these "
            "kinds of game; a table with no profile matches none."
        ),
    ] = None,
    pace: Annotated[
        list[Pace] | None,
        Query(description="Since v0.9.12: only tables whose profile says one of these paces."),
    ] = None,
    max_duration: Annotated[
        int | None,
        Query(
            ge=1,
            le=600,
            description="Since v0.9.12: only tables whose profile expects at most this many "
            "minutes; a table that says no length matches none.",
        ),
    ] = None,
    sort: Annotated[
        TableSort,
        Query(description="newest (default), players (most seated) or fewest_open (seats)."),
    ] = "newest",
    page: Annotated[int, Query(ge=1, le=10_000)] = 1,
    per_page: Annotated[int, Query(description="20, 50 or 100.")] = PAGE_SIZES[0],
) -> TablePage:
    """The lobby's open tables a page at a time (v0.9.2): the public ones, your own, those you were
    invited to (SysOp and administrators see every one), your own leading, then newest first, or
    since v0.9.3 the most players or the fewest open seats first, optionally by host."""
    if per_page not in PAGE_SIZES:
        raise ApiError(422, "invalid_page", "Show 20, 50 or 100 tables a page.")
    you = principal.user.id
    mine = select(TableSeat.table_id).where(TableSeat.user_id == you)
    statement = select(GameTable).where(
        GameTable.status == "open", GameTable.created_at >= cutoff()
    )
    if not full_access(principal):
        statement = statement.where(
            (GameTable.visibility == "public")
            | GameTable.id.in_(mine)
            | GameTable.id.in_(invited_to(you))
        )
    if format:
        statement = statement.where(GameTable.format.in_(set(format)))
    casual_rules = or_(GameTable.allow_banned, GameTable.allow_not_legal, GameTable.allow_stand_in)
    if rules and set(rules) == {"casual"}:
        statement = statement.where(casual_rules)
    elif rules and set(rules) == {"tournament"}:
        statement = statement.where(not_(casual_rules))
    taken = (
        select(func.count())
        .select_from(TableSeat)
        .where(TableSeat.table_id == GameTable.id)
        .scalar_subquery()
    )
    if open_seats:
        statement = statement.where(GameTable.seats - GameTable.bots > taken)
    term = (host or "").strip()
    if term:
        # By handle alone (v0.9.7). A display name is its account's and the staff's: it starts as
        # the Google account's name, so matching it here told any player, a letter at a time,
        # the name behind a host's handle.
        hosts = select(User.id).where(
            User.normalized_handle.contains(term.casefold(), autoescape=True)
        )
        statement = statement.where(GameTable.host_id.in_(hosts))
    if no_bots:
        statement = statement.where(GameTable.bots == 0)
    # A table's Rule Zero profile (v0.9.12), by the columns kept beside it.
    if intent:
        statement = statement.where(GameTable.intent.in_(set(intent)))
    if pace:
        statement = statement.where(GameTable.pace.in_(set(pace)))
    if max_duration is not None:
        statement = statement.where(GameTable.duration <= max_duration)
    if best_of_three:
        statement = statement.where(GameTable.best_of == 3)
    known = friends_of(db, you)
    if friends:
        theirs = select(TableSeat.table_id).where(TableSeat.user_id.in_(known))
        statement = statement.where(
            or_(GameTable.id.in_(theirs), GameTable.id.in_(invited_to(you)))
        )
    total = db.scalar(select(func.count()).select_from(statement.subquery())) or 0
    last = max(1, -(-total // per_page))
    page = min(page, last)
    found = list(
        db.scalars(
            statement.order_by(
                GameTable.id.in_(mine).desc(),
                *{
                    "newest": (),
                    "players": (taken.desc(),),
                    "fewest_open": ((GameTable.seats - GameTable.bots - taken).asc(),),
                }[sort],
                GameTable.created_at.desc(),
            )
            .offset((page - 1) * per_page)
            .limit(per_page)
        )
    )
    ids = [table.id for table in found]
    seated: dict[UUID, list[UUID]] = {}
    for table_id, user_id in db.execute(
        select(TableSeat.table_id, TableSeat.user_id)
        .where(TableSeat.table_id.in_(ids))
        .order_by(TableSeat.seat)
    ):
        seated.setdefault(table_id, []).append(user_id)
    inviters = dict(
        db.execute(
            select(TableInvite.table_id, TableInvite.invited_by).where(
                TableInvite.user_id == you, TableInvite.table_id.in_(ids)
            )
        ).all()
    )
    wanted = {user for users in seated.values() for user in users if user in known} | set(
        inviters.values()
    )
    handles = (
        dict(db.execute(select(User.id, User.handle).where(User.id.in_(wanted))).all())
        if wanted
        else {}
    )
    views = []
    for table in found:
        view = view_of(db, table, principal)
        view.friends = [
            handle
            for user in seated.get(table.id, [])
            if user in known and (handle := handles.get(user))
        ]
        inviter = inviters.get(table.id)
        view.invited_by = handles.get(inviter) if inviter else None
        views.append(view)
    seat_table = open_table_of(db, you)
    yours = next((view for view in views if view.code == getattr(seat_table, "code", None)), None)
    if seat_table is not None and yours is None:
        yours = view_of(db, seat_table, principal)
    return TablePage(tables=views, total=total, page=page, per_page=per_page, yours=yours)


@router.get("/tables", response_model=list[TableView])
def list_tables(principal: Player, db: Db) -> list[TableView]:
    """Open tables, newest first: the public ones and your own; SysOp sees every one."""
    statement = (
        select(GameTable)
        .where(GameTable.status == "open", GameTable.created_at >= cutoff())
        .order_by(GameTable.created_at.desc())
        .limit(LISTED)
    )
    if not full_access(principal):
        mine = select(TableSeat.table_id).where(TableSeat.user_id == principal.user.id)
        statement = statement.where((GameTable.visibility == "public") | GameTable.id.in_(mine))
    return [view_of(db, table, principal) for table in db.scalars(statement)]


@router.post(
    "/tables", response_model=TableView, status_code=201, responses={409: {"model": Error}}
)
def create_table(body: TableRequest, request: Request, principal: Player, db: Db) -> TableView:
    """Opens a table with the host in its first seat."""
    fmt = body.format
    if body.seats not in SEATS[fmt]:
        raise ApiError(
            422,
            "invalid_table",
            f"{FORMAT_NAMES[fmt]} seats {SEATS[fmt]} players, not {body.seats}.",
        )
    if fmt != KINGS and (
        body.seat is not None or body.bot_seats is not None or body.kings_table is not None
    ):
        raise ApiError(
            422,
            "invalid_table",
            "Only a King's Table table takes King's Table settings, a seat and bot seats.",
        )
    kings: KingsTableSettings | None = None
    host_seat, bots, bot_seats = 0, body.bots, None
    if fmt == KINGS:
        kings = kings_table.config_of(body.kings_table)
        host_seat = body.seat if body.seat is not None else kings_table.KINGS[0]
        bot_seats = kings_bot_seats(body.bot_seats or [], {host_seat})
        if body.bots not in (0, len(bot_seats)):
            raise ApiError(
                422, "invalid_table", "At King's Table bot_seats names the seats bots fill."
            )
        bots = len(bot_seats)
    elif body.bots > body.seats - 2:
        raise ApiError(422, "invalid_table", "A table needs at least two players' seats.")
    if body.best_of != 1 and fmt != "legacy":
        raise ApiError(422, "invalid_table", "Only Legacy plays best of three.")
    if body.bot_teammate and (fmt != TEAM_FORMAT or body.bots < 1):
        raise ApiError(
            422, "invalid_table", "A bot teammate is one of a Two-Headed Giant table's bots."
        )
    if fmt == TEAM_FORMAT:
        bot_seats = team_bot_seats(body.bots, body.bot_teammate)
    invitees = friends_to_invite(db, principal.user, body.invite)
    revision = check_deck(
        db,
        request,
        principal.user,
        principal.permissions,
        body.deck_id,
        fmt,
        body.rules,
        kings,
        body.profile,
    )
    may_sit(db, request, principal)
    now = utcnow()
    table = GameTable(
        code=secrets.token_urlsafe(12),
        host_id=principal.user.id,
        format=fmt,
        visibility=body.visibility,
        seats=body.seats,
        bots=bots,
        bot_seats=bot_seats,
        kings_table=kings_table.engine_settings(kings) if kings is not None else None,
        bot_skill=body.bot_skill,
        # 40 turns for each player unless the host named a limit (v0.9.7).
        turn_cap=(
            body.turn_cap if body.turn_cap is not None else default_turn_cap(fmt, body.seats)
        ),
        allow_banned=body.rules.banned,
        allow_not_legal=body.rules.not_legal,
        allow_stand_in=body.rules.stand_in,
        best_of=body.best_of,
        status="open",
        created_at=now,
    )
    table_profiles.keep(table, body.profile)
    db.add(table)
    db.flush()
    db.add(
        TableSeat(
            table_id=table.id,
            seat=host_seat,
            user_id=principal.user.id,
            deck_id=body.deck_id,
            deck_revision_id=revision,
            ready=True,
            joined_at=now,
        )
    )
    invite(db, table, principal.user, invitees, now)
    db.commit()
    return view_of(db, table, principal)


def friends_to_invite(db: Session, user: User, ids: list[UUID]) -> list[User]:
    """The friends a player invites to a table (v0.9.2), in the order given, each once; refuses
    anyone who is not their friend, as an account still active and named."""
    if not ids:
        return []
    known = friends_of(db, user.id)
    found: list[User] = []
    for user_id in dict.fromkeys(ids):
        friend = db.get(User, user_id) if user_id in known else None
        if friend is None or friend.status != "active" or not friend.normalized_handle:
            raise ApiError(422, "not_friend", "You may invite only your friends to a table.")
        found.append(friend)
    return found


def invite(
    db: Session, table: GameTable, inviter: User, friends: list[User], now: datetime
) -> InvitesSent:
    """Invites friends to an open table (v0.9.2): each not seated there nor invited before is told
    in the bell, the notice naming the table's code."""
    # Imported here: api.social imports this module's cutoff.
    from api.social import notify

    if not friends:
        return InvitesSent(invited=[], already=[])
    ids = [friend.id for friend in friends]
    seated = set(
        db.scalars(
            select(TableSeat.user_id).where(
                TableSeat.table_id == table.id, TableSeat.user_id.in_(ids)
            )
        )
    )
    invited = set(
        db.scalars(
            select(TableInvite.user_id).where(
                TableInvite.table_id == table.id, TableInvite.user_id.in_(ids)
            )
        )
    )
    new = [friend for friend in friends if friend.id not in seated | invited]
    count = (
        db.scalar(
            select(func.count()).select_from(TableInvite).where(TableInvite.table_id == table.id)
        )
        or 0
    )
    if count + len(new) > INVITES_PER_TABLE:
        raise ApiError(
            409,
            "too_many_invites",
            f"A table may invite {INVITES_PER_TABLE} players in all; {count} are invited already.",
        )
    for friend in new:
        db.add(
            TableInvite(table_id=table.id, user_id=friend.id, invited_by=inviter.id, created_at=now)
        )
        notify(db, friend.id, "table_invite", inviter.id, now, subject=table.code)
    db.flush()
    return InvitesSent(
        invited=[friend.handle or "" for friend in new],
        already=[friend.handle or "" for friend in friends if friend.id in seated | invited],
    )


@router.post(
    "/tables/{code}/invites",
    response_model=InvitesSent,
    responses={409: {"model": Error}, 422: {"model": Error}},
)
def invite_friends(code: Code, body: TableInviting, principal: Player, db: Db) -> InvitesSent:
    """A table's player invites friends to it (v0.9.2), while it waits for players."""
    table = find(db, code, lock=True)
    if status_of(table) != "open":
        raise ApiError(409, "table_closed", "This table is no longer open.")
    seated = db.scalar(
        select(TableSeat.id).where(
            TableSeat.table_id == table.id, TableSeat.user_id == principal.user.id
        )
    )
    if seated is None:
        raise ApiError(409, "not_seated", "Only a table's players invite friends to it.")
    friends = friends_to_invite(db, principal.user, body.players)
    sent = invite(db, table, principal.user, friends, utcnow())
    db.commit()
    return sent


@router.get("/tables/{code}", response_model=TableView)
def get_table(code: Code, principal: Player, db: Db) -> TableView:
    """A table by its code: the invite link."""
    return view_of(db, find(db, code), principal)


@router.post("/tables/{code}/join", response_model=TableView, responses={409: {"model": Error}})
def join_table(
    code: Code, body: SeatTaking, request: Request, principal: Player, db: Db
) -> TableView:
    """Takes the first free player's seat with one of your decks; at a Two-Headed Giant table the
    team's, and at a King's Table table (v0.8.7) the seat named, or the team's."""
    # Locked, as changing seat locks it (v0.5.1): a team a player stays on is read as it stands.
    table = find(db, code, lock=True)
    if status_of(table) != "open":
        raise ApiError(409, "table_closed", "This table is no longer taking players.")
    rows = seats_of(db, table)
    if any(row.user_id == principal.user.id for row in rows):
        raise ApiError(409, "already_seated", "You already sit at this table.")
    free = [seat for seat in player_seats_of(table) if seat not in {r.seat for r in rows}]
    if not free:
        raise ApiError(409, "table_full", "Every player's seat at this table is taken.")
    kept = kept_team(table, principal.user.id)
    if kept is not None:
        # Two-Headed Giant (v0.5.1): a player back at a table where their deck's shared cards were
        # named sits in that team again, or not at all.
        free = [seat for seat in free if seat // 2 == kept]
        if not free or body.team not in (None, kept):
            raise ApiError(409, "team_locked", KEPT)
    elif body.team is not None:
        free = free_in_team(table, free, body.team)
    if body.seat is not None:
        free = [open_seat(table, free, body.seat)]
    revision = check_deck(
        db,
        request,
        principal.user,
        principal.permissions,
        body.deck_id,
        table.format,
        rules_of(table),
        table.kings_table,
        table_profiles.profile_of(table),
    )
    may_sit(db, request, principal)
    db.add(
        TableSeat(
            table_id=table.id,
            seat=free[0],
            user_id=principal.user.id,
            deck_id=body.deck_id,
            deck_revision_id=revision,
            ready=False,
            joined_at=utcnow(),
        )
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ApiError(409, "table_full", "That seat was just taken. Try again.") from None
    return view_of(db, table, principal)


def free_in_team(table: GameTable, free: list[int], team: int) -> list[int]:
    """The free players' seats of a team (v0.5.1); refused outside Two-Headed Giant and (v0.8.7)
    King's Table, or when that team has none."""
    if table.format not in (TEAM_FORMAT, KINGS):
        raise ApiError(
            422, "invalid_table", "Only Two-Headed Giant and King's Table tables have teams."
        )
    seats = [seat for seat in free if team_of(table, seat) == team]
    if not seats:
        raise ApiError(409, "team_full", "That team has no free seat.")
    return seats


def open_seat(table: GameTable, free: list[int], seat: int) -> int:
    """A King's Table seat a player may take (v0.8.7): one of the free players' seats."""
    if table.format != KINGS:
        raise ApiError(422, "invalid_table", "Only King's Table tables seat players by number.")
    if seat not in free:
        raise ApiError(409, "seat_taken", "That seat is taken, or a bot's.")
    return seat


def kings_bot_seats(seats: list[int], players: set[int]) -> list[int]:
    """The seats a King's Table table's bots fill (v0.8.7): none twice and none of a player's, so
    a table keeps at least one player."""
    if len(set(seats)) != len(seats):
        raise ApiError(422, "invalid_table", "A seat takes one bot.")
    taken = sorted(set(seats) & players)
    if taken:
        raise ApiError(
            409, "seat_taken", f"A player sits in seat {taken[0]}: a bot cannot take it."
        )
    return sorted(seats)


def unready_all(db: Session, table: GameTable) -> None:
    """King's Table (v0.8.7): a setting or a seat changed, so every player gets ready again."""
    for row in seats_of(db, table):
        row.ready = False


def seat_at(db: Session, table: GameTable, principal: Principal) -> TableSeat:
    row = db.scalar(
        select(TableSeat).where(
            TableSeat.table_id == table.id, TableSeat.user_id == principal.user.id
        )
    )
    if row is None:
        raise ApiError(409, "not_seated", "You do not sit at this table.")
    if status_of(table) != "open":
        raise ApiError(409, "table_closed", "This table is no longer open.")
    return row


@router.patch("/tables/{code}/seat", response_model=TableView, responses={409: {"model": Error}})
def change_seat(
    code: Code, body: SeatChange, request: Request, principal: Player, db: Db
) -> TableView:
    """Changes your deck (which makes you not ready), or whether you are ready. At a Two-Headed
    Giant table (v0.5.1) also your team; a change of deck or team makes your teammate not ready
    too, and you are ready only once your deck and your teammate's share no card but basic lands.
    At a King's Table table (v0.8.7) also your seat, or your team, either of which makes every
    player not ready; getting ready checks your deck by the settings' deck format again."""
    # Locked (v0.5.1): what a ready check names is recorded before another change at the table.
    table = find(db, code, lock=True)
    row = seat_at(db, table, principal)
    if body.seat is not None and table.format != KINGS:
        raise ApiError(422, "invalid_table", "Only King's Table tables seat players by number.")
    if table.format == KINGS and (body.seat is not None or body.team is not None):
        target = body.seat if body.seat is not None else row.seat
        if body.seat is None and body.team is not None and team_of(table, row.seat) != body.team:
            taken = {other.seat for other in seats_of(db, table)}
            free = [seat for seat in player_seats_of(table) if seat not in taken]
            target = free_in_team(table, free, body.team)[0]
        if target != row.seat:
            # At the campaign's court the host is King A (v0.9.8): until then the host could take
            # a General's seat and give the King's to a bot. Harmless, as the campaign reads the
            # team's result, but not the court.
            if table.campaign and row.user_id == table.host_id:
                raise ApiError(
                    409,
                    "campaign_table",
                    "At the court you are its King: your seat is the campaign's.",
                )
            move_player(db, table, row, target)
    elif body.team is not None and team_of(table, row.seat) != body.team:
        stays_on(table, row.user_id, body.team)
        taken = {other.seat for other in seats_of(db, table)}
        free = [seat for seat in player_seats_of(table) if seat not in taken]
        row.seat = free_in_team(table, free, body.team)[0]
        row.ready = False
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            raise ApiError(409, "team_full", "That seat was just taken. Try again.") from None
        unready_teammate(db, table, row)
    if body.deck_id is not None and body.deck_id != row.deck_id:
        row.deck_revision_id = check_deck(
            db,
            request,
            principal.user,
            principal.permissions,
            body.deck_id,
            table.format,
            rules_of(table),
            table.kings_table,
            table_profiles.profile_of(table),
        )
        row.deck_id = body.deck_id
        row.ready = False
        unready_teammate(db, table, row)
    if body.ready is not None:
        if body.ready and table.format == TEAM_FORMAT:
            check_team(db, request, principal, table, row)
        profile = table_profiles.profile_of(table)
        if body.ready and (table.format == KINGS or profile is not None):
            # The settings' deck format may have changed since the deck was chosen, and since
            # v0.9.12 the table's profile: getting ready checks the deck by what stands now.
            row.deck_revision_id = check_deck(
                db,
                request,
                principal.user,
                principal.permissions,
                row.deck_id,
                table.format,
                rules_of(table),
                table.kings_table,
                profile,
            )
        row.ready = body.ready
    db.commit()
    return view_of(db, table, principal)


def move_player(db: Session, table: GameTable, row: TableSeat, seat: int) -> None:
    """Moves a King's Table player to an open seat (v0.8.7), which makes every player not ready."""
    taken = {other.seat for other in seats_of(db, table) if other is not row}
    open_seat(table, [s for s in player_seats_of(table) if s not in taken], seat)
    row.seat = seat
    unready_all(db, table)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise ApiError(409, "seat_taken", "That seat was just taken. Try again.") from None


@router.patch("/tables/{code}", response_model=TableView, responses={409: {"model": Error}})
def change_table(code: Code, body: TableChange, principal: Player, db: Db) -> TableView:
    """The host changes a table before its start: a King's Table table's settings, the seats
    its bots fill, or a player's seat (to an open one) (v0.8.7), and since v0.9.12 any table's
    Rule Zero profile. Anything that changes makes every player not ready again."""
    table = find(db, code, lock=True)
    if table.host_id != principal.user.id:
        raise ApiError(403, "not_host", "Only the table's host changes the table.")
    if status_of(table) != "open":
        raise ApiError(409, "table_closed", "This table is no longer open.")
    profiled = "profile" in body.model_fields_set
    seating = body.kings_table is not None or body.bot_seats is not None or body.move is not None
    if table.format != KINGS and (seating or not profiled):
        raise ApiError(422, "invalid_table", "Only King's Table tables have settings to change.")
    if table.queued and profiled:
        raise ApiError(409, "queue_table", "A table the queue opened has no profile to change.")
    court = set(campaign_names(table))
    if table.campaign and (
        profiled
        or body.kings_table is not None
        or body.move is not None
        or (body.bot_seats is not None and not court <= set(body.bot_seats))
    ):
        raise ApiError(
            409,
            "campaign_table",
            "The court's settings and seats are the campaign's; only your Generals' seats change.",
        )
    rows = seats_of(db, table)
    changed = profiled and table_profiles.keep(table, body.profile)
    if body.kings_table is not None:
        before = kings_table.config_of(table.kings_table)
        after = before.model_copy(update=body.kings_table.model_dump(exclude_none=True))
        if after != before:
            table.kings_table = kings_table.engine_settings(after)
            changed = True
    moved = None
    if body.move is not None:
        moved = next((row for row in rows if row.seat == body.move.seat), None)
        if moved is None:
            raise ApiError(409, "not_seated", "No player sits in that seat.")
    players = {row.seat for row in rows if row is not moved} | (
        {body.move.to} if body.move is not None else set()
    )
    if body.bot_seats is not None:
        seats = kings_bot_seats(body.bot_seats, players)
        if seats != bot_seats_of(table):
            table.bot_seats, table.bots = seats, len(seats)
            changed = True
    if moved is not None and body.move is not None and body.move.to != moved.seat:
        if body.move.to in bot_seats_of(table) or body.move.to in {r.seat for r in rows}:
            raise ApiError(409, "seat_taken", "That seat is taken, or a bot's.")
        moved.seat = body.move.to
        changed = True
    if changed:
        unready_all(db, table)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise ApiError(409, "seat_taken", "That seat was just taken. Try again.") from None
    return view_of(db, table, principal)


def teammate_row(db: Session, table: GameTable, row: TableSeat) -> TableSeat | None:
    """The player beside a seat in its Two-Headed Giant team, if one sits there."""
    if table.format != TEAM_FORMAT:
        return None
    return db.scalar(
        select(TableSeat).where(
            TableSeat.table_id == table.id, TableSeat.seat == teams.teammate(row.seat)
        )
    )


def unready_teammate(db: Session, table: GameTable, row: TableSeat) -> None:
    """A team's decks changed: the teammate must get ready again, which checks the two."""
    mate = teammate_row(db, table, row)
    if mate is not None:
        mate.ready = False


def check_team(
    db: Session, request: Request, principal: Principal, table: GameTable, row: TableSeat
) -> None:
    """Unified Deck Construction (MTR 8.4, 9.5) as a player gets ready: their deck and their
    teammate's share no card but basic lands. The shared cards are named to the team only. Beside
    a bot (v0.5.1), some fixture deck shares no card with theirs, or the start could not deal the
    bot one.

    Since v0.5.1 the player's deck is bound again as they get ready, checked against their library,
    and compared with the revision their teammate's seat is bound to: a draft holding cards its
    player does not own is never compared. Once cards are named, both players stay on this team at
    this table (keep_team). The refusal commits that with the rest of the request, a move to this
    team included, so who was told is what everyone sees."""
    row.deck_revision_id = check_deck(
        db,
        request,
        principal.user,
        principal.permissions,
        row.deck_id,
        table.format,
        rules_of(table),
    )
    if teams.teammate(row.seat) in bot_seats_of(table):
        if not teams.fits_a_fixture(bound_cards(db, row.deck_revision_id)):
            raise ApiError(422, "team_decks", NO_BOT_TEAMMATE)
        return
    mate = teammate_row(db, table, row)
    if mate is None:
        return
    both = teams.shared(
        bound_cards(db, row.deck_revision_id), bound_cards(db, mate.deck_revision_id)
    )
    if both:
        handle = db.scalar(select(User.handle).where(User.id == mate.user_id))
        keep_team(db, table, row.seat // 2, row.user_id, mate.user_id)
        row.ready = False
        db.commit()
        raise ApiError(422, "team_decks", shared_with(handle, both))


@router.post("/tables/{code}/leave", response_model=TableView, responses={409: {"model": Error}})
def leave_table(code: Code, principal: Player, db: Db) -> TableView:
    """Leaves the table before it starts. The host leaving closes it for everyone."""
    table = find(db, code)
    row = seat_at(db, table, principal)
    if table.host_id == principal.user.id:
        table.status = "closed"
        table.closed_at = utcnow()
        db.execute(delete(TableSeat).where(TableSeat.table_id == table.id))
    else:
        db.delete(row)
    db.commit()
    return view_of(db, table, principal)


def plan_table(
    db: Session, request: Request, table_id: UUID, principal: Principal
) -> tuple[list[SeatPlan], list[UUID | None]]:
    """Every seat as the engine takes it, the players' first: each player's deck bound to a
    revision now (DECK01), then the bots. Returns the plans and each seat's player. The table is
    locked, as changing seat locks it (v0.5.1): the teams the start checks are those that stand."""
    table = db.scalar(select(GameTable).where(GameTable.id == table_id).with_for_update())
    if table is None:
        raise not_found()
    if table.host_id != principal.user.id:
        raise ApiError(403, "not_host", "Only the table's host starts the game.")
    if status_of(table) != "open":
        raise ApiError(409, "table_closed", "This table is no longer open.")
    rows = seats_of(db, table)
    if len(rows) < len(player_seats_of(table)):
        raise ApiError(409, "table_not_full", "Wait until every player's seat is taken.")
    waiting = [row for row in rows if not row.ready and row.user_id != table.host_id]
    if waiting:
        raise ApiError(409, "not_ready", "Wait until every player is ready.")
    roster = roster_of(request)
    by_seat = {row.seat: row for row in rows}
    bots = bot_seats_of(table)
    # Bots with no deck chosen play the starter decks in Commander, a different one each, unless
    # the site keeps them on the engine's fixture decks. In Two-Headed Giant the team rules deal
    # them fixture decks (check_teams); at King's Table (v0.8.7) the engine does, of the settings'
    # deck format.
    starters = (
        list(starters_of(request).values())
        if settings_of(request).bot_decks == "starters" and table.format == "commander"
        else []
    )
    random.shuffle(starters)
    plans: list[SeatPlan] = []
    users: list[UUID | None] = []
    for index in range(table.seats):
        if index in bots:
            planned = starter_seat(db, starters.pop()) if starters else None
            plans.append(planned or SeatPlan({"player": "bot"}))
            users.append(None)
            continue
        row = by_seat[index]
        user = db.get(User, row.user_id)
        assert user is not None
        permissions = permissions_for(user, roles_of(db, user))
        if user.status != "active" or "games.play" not in permissions:
            raise ApiError(409, "player_unavailable", f"{user.handle} cannot play games now.")
        library = library_of(db, user, permissions, roster)
        try:
            seat, revision, title = own_deck(
                db,
                user,
                permissions,
                row.deck_id,
                deck_format_for(table),
                library,
                rules_of(table),
            )
            # The seat is bound to it now (v0.5.1): a ready check after a refused start compares
            # the decks the start compared.
            row.deck_revision_id = revision
            # The profile's restrictions (v0.9.12), checked at the start as at getting ready.
            table_profiles.refuse_revision(db, table_profiles.profile_of(table), revision)
            if table.format == TEAM_FORMAT:
                # MTR 9.5: Two-Headed Giant Constructed has no sideboards; a deck's stays home.
                cast(dict[str, object], seat["deck_list"]).pop("sideboard", None)
                banned = team_banned(teams.cards_of(seat) or set(), rules_of(table), permissions)
                if banned is not None:
                    raise banned
        except ApiError as refused:
            if user.id == principal.user.id:
                raise
            # Another player's deck stays private: the host learns only whose it is, not whether
            # its cards or the table's rules stop it.
            row.ready = False
            db.commit()
            raise ApiError(
                409,
                "deck_not_playable",
                f"{user.handle}'s deck cannot be played now; they need to choose another.",
            ) from refused
        plans.append(SeatPlan({"player": "human", **seat}, revision, title))
        users.append(user.id)
    if table.format == TEAM_FORMAT:
        check_teams(db, table, plans, users, principal)
    # A Godlike player's custom cards (v0.4.0) are checked against the running engine before the
    # game starts; bots here play starter or fixture decks, never them.
    for index, held in custom_in_seats(db, [plan.engine for plan in plans]).items():
        plans[index].custom = held
    # Revisions made for the game are kept even if the engine refuses it, and the connection
    # goes back before the engine is asked.
    db.commit()
    return plans, users


def check_teams(
    db: Session,
    table: GameTable,
    plans: list[SeatPlan],
    users: list[UUID | None],
    principal: Principal,
) -> None:
    """Two-Headed Giant's teams at the start (v0.5.1): each team of two players' decks, bound now,
    share no card but basic lands (Unified Deck Construction, MTR 8.4 and 9.5), and each bot gets
    a fixture deck its teammate's shares no card with (api/teams.py). The host's own team is told
    the cards, and the two then stay on it at this table (keep_team); another team's players are
    named, never their cards, and made not ready, as is a player whose deck leaves their bot
    teammate no fixture deck."""
    players = [user for user in users if user is not None]
    handles = dict(db.execute(select(User.id, User.handle).where(User.id.in_(players))).all())
    for first, second in teams.TEAMS:
        one, other = users[first], users[second]
        if one is None or other is None:
            continue
        both = teams.shared(
            teams.cards_of(plans[first].engine) or set(),
            teams.cards_of(plans[second].engine) or set(),
        )
        if not both:
            continue
        for row in db.scalars(
            select(TableSeat).where(
                TableSeat.table_id == table.id, TableSeat.seat.in_((first, second))
            )
        ):
            row.ready = False
        if principal.user.id in (one, other):
            mate = other if principal.user.id == one else one
            keep_team(db, table, first // 2, principal.user.id, mate)
            db.commit()
            raise ApiError(409, "team_decks", shared_with(handles.get(mate), both))
        db.commit()
        raise ApiError(
            409,
            "team_decks",
            f"{handles.get(one) or 'A player'}'s and {handles.get(other) or 'a player'}'s decks "
            "share a card, and Two-Headed Giant teammates' decks may share only basic lands: "
            "they need to choose again.",
        )
    engines = [plan.engine for plan in plans]
    try:
        teams.assign_and_check(engines, True)
    except ApiError as refused:
        # Only a bot's deck is left to refuse now: every fixture deck shares a card with its
        # teammate's. That player (v0.5.1) is named, never their cards, and made not ready, as
        # another team's players are above; the host is told of their own deck.
        stuck = [
            user for seat in teams.without_fixture(engines) if (user := users[seat]) is not None
        ]
        for row in db.scalars(
            select(TableSeat).where(TableSeat.table_id == table.id, TableSeat.user_id.in_(stuck))
        ):
            row.ready = False
        db.commit()
        if principal.user.id in stuck:
            raise ApiError(409, "team_decks", NO_BOT_TEAMMATE) from refused
        whose = handles.get(stuck[0]) if stuck else None
        raise ApiError(
            409,
            "team_decks",
            f"{whose or 'A player'}'s deck shares a card with every bot deck, so no bot can be "
            "their teammate: they need another deck.",
        ) from refused


def record_table_game(
    db: Session,
    table_id: UUID,
    created: dict[str, object],
    plans: list[SeatPlan],
    users: list[UUID | None],
    link: Callable[[Session, Game], None] | None = None,
) -> Game:
    """The table's game and its seats, and the table as started, in one transaction. The seats
    must be as they were when the game was planned. Since v0.9.6 the campaign's court links its
    game to the campaign in that transaction (link)."""
    table = db.scalar(select(GameTable).where(GameTable.id == table_id).with_for_update())
    assert table is not None
    seated = {row.seat: row.user_id for row in seats_of(db, table)}
    if status_of(table) != "open" or seated != {
        seat: user for seat, user in enumerate(users) if user is not None
    }:
        raise ApiError(409, "table_changed", "A player left as the game started. Try again.")
    game = add_table_game(db, table, created, plans, users)
    if link is not None:
        link(db, game)
    db.commit()
    return game


def add_table_game(
    db: Session,
    table: GameTable,
    created: dict[str, object],
    plans: list[SeatPlan],
    users: list[UUID | None],
) -> Game:
    """The table's game and its seats, and the table as started, in the caller's transaction:
    the lobby's start, and since v0.5.0 the queue's and a rematch's (api/queues.py)."""
    now = utcnow()
    game = Game(
        id=UUID(str(created["game_id"])),
        kind="table",
        format=table.format,
        status="active",
        created_by=table.host_id,
        created_at=now,
        bot_skill=table.bot_skill,
        turn_cap=table.turn_cap,
        catalog_revision_id=db.scalar(select(func.max(CatalogRevision.id))),
        # The decks' format: Two-Headed Giant plays Legacy decks (v0.5.1), King's Table those of
        # its settings (v0.8.7), which the game keeps.
        format_version=db.scalar(
            select(func.max(FormatVersion.version)).where(
                FormatVersion.format == deck_format_for(table)
            )
        ),
        kings_table=table.kings_table if table.format == KINGS else None,
        # The profile the players were ready for (v0.9.12): the game keeps what was agreed.
        table_profile=table.profile,
    )
    db.add(game)
    db.flush()
    settings = created["settings"]
    assert isinstance(settings, dict)
    decks = {entry["seat"]: entry["deck"] for entry in settings["seats"]}
    for index, plan in enumerate(plans):
        db.add(
            GameSeat(
                game_id=game.id,
                seat=index,
                player=plan.engine["player"],
                user_id=users[index],
                deck=plan.title or decks[index],
                deck_list=plan.engine.get("deck_list"),
                deck_revision_id=plan.revision,
            )
        )
    # Best of three (v0.5.0): the first game of the table's match.
    matches.begin(db, game, table.best_of, idle_timeout_seconds=TABLE_IDLE_SECONDS)
    table.status = "started"
    table.started_at = now
    table.game_id = game.id
    db.flush()
    return game


@router.post(
    "/tables/{code}/start",
    response_model=TableView,
    responses={409: {"model": Error}, 429: {"model": Error}},
)
async def start_table(code: Code, request: Request, principal: Player, db: Db) -> TableView:
    """The host starts the table's game: every player's seat taken and ready, and every player
    under their limit of running games. The reply names the game; each player plays it over its
    WebSocket."""
    hub = hub_of(request)
    engine = hub.require_engine()
    table = await run_in_threadpool(find, db, code)
    async with hub.locks[table.id]:
        plans, users = await run_in_threadpool(plan_table, db, request, table.id, principal)
        players = [user for user in users if user is not None]
        async with AsyncExitStack() as stack:
            # Every player's lock, in one order: no practice game or other table of theirs starts
            # meanwhile, and two starts cannot wait on each other.
            for user_id in sorted(players, key=str):
                await stack.enter_async_context(hub.locks[user_id])
            await run_in_threadpool(under_limits, db, request, players)
            await require_loaded(request, plans)
            link: Callable[[Session, Game], None] | None = None
            if table.campaign:
                # The campaign's court (v0.9.6): team B's decks, and the game the campaign's.
                # Imported here: api.campaign imports this module.
                from api import campaign

                plans, body, link = await campaign.court_table(
                    request, engine, db, table, plans, users
                )
            else:
                body = engine_body(table, [plan.engine for plan in plans])
            hub.reserve()
            try:
                created = await engine_game(engine, body, request)
                async with followed_or_closed(hub, created, db):
                    game = await run_in_threadpool(
                        record_table_game, db, table.id, created, plans, users, link
                    )
                    tokens = seat_tokens(created)
                    hub.register(
                        LiveGame(
                            id=game.id,
                            kind="table",
                            seats={
                                seat: LiveSeat(seat, user_id, tokens[seat])
                                for seat, user_id in enumerate(users)
                                if user_id is not None
                            },
                            **team_play(table.format),
                        )
                    )
            finally:
                hub.starting -= 1
    await run_in_threadpool(db.refresh, table)
    return await run_in_threadpool(view_of, db, table, principal)


def engine_body(table: GameTable, seats: list[dict[str, object]]) -> dict[str, object]:
    """The engine's request for a table's game, and since v0.8.7 King's Table's settings with
    it: the engine chooses which King plays first."""
    body: dict[str, object] = {
        "format": table.format,
        "seats": seats,
        "skill": table.bot_skill,
        "turn_cap": table.turn_cap,
        "idle_timeout_seconds": TABLE_IDLE_SECONDS,
    }
    if table.format == KINGS:
        body["kings_table"] = kings_table.engine_settings(kings_table.config_of(table.kings_table))
    return body


def under_limits(db: Session, request: Request, players: list[UUID]) -> None:
    """Every player has room for one more running game; SysOp has no limit."""
    limit = settings_of(request).games_per_account
    for user_id in players:
        user = db.get(User, user_id)
        assert user is not None
        if "games.view_concealed" in permissions_for(user, roles_of(db, user)):
            continue
        if active_games_of(db, user_id) >= limit:
            raise ApiError(
                409,
                "game_limit",
                f"{user.handle} has a game running; it must end before this one starts.",
            )
    db.commit()
