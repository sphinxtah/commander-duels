"""The quest boards (v0.9.5, PROG04): a daily board of five quests and a weekly board of twenty
goals for every player, read from the server's own records. Until v0.9.4 three daily quests with a
swap (quests-v1); the owner's decisions for the boards are in docs/plans/0.9.5.md, and
docs/quests.md describes them for players and staff.

- **The pools** are in api/quest_pool.py. A daily quest asks for wins (or games played) and its
  slot is its difficulty (`step` in the code and the contract): the first is the easiest, the
  fifth the hardest, each paying its difficulty's tokens. The five are no steps to climb: each is
  judged by itself, so they complete in any order (v0.9.7: the screens say "Quest 5", not
  "Step 5"). A weekly goal is a family's variant at a tier; a week draws twenty families, six
  from the games and fourteen from outside them.
- **The periods** are Arizona's (api/economy.py): the day from midnight, the week from Sunday's
  midnight (api/sales.py, as the weekly sale's). A board is drawn the first time the account asks
  for its quests in the period, and stays the same all period: there is no swap. What happened
  earlier in the period counts.
- **Completion** is checked whenever the account asks for its quests, and in the transaction that
  records a game's end (api/awards.py) for every player whose result it wrote. Each quest pays
  once, through the economy ledger, keyed by the account, the period and the quest; a replayed end
  or a second look pays nothing. The bell tells the player (quest_completed).
- **Board bonuses.** A board whose quests are all complete in its period pays a bonus, once
  (quest_boards, keyed per period): 400 tokens for a daily board, 100 more for each day in a row up
  to 1,000; 2,000 for a weekly board, 200 more for each week in a row up to 5,000. A board not
  finished in its period starts the streak again. The streak is read from the previous period's
  recorded board, never from a request.
- **Every quest is one player's to finish** (the owner's choice), so a quest that needs
  something that may not be there is drawn only while it is (v0.9.7): a win with a colour's deck
  or in a format needs a playable deck of it among the account's own (reach_of), a sleeve to
  upload needs room under the limit, and an auction to win or to bid on needs other accounts'
  auctions, twice what the goal asks for (weekly_available).
- **Farming.** A weekly goal counts only what the server records, and only real exchanges: an
  auction won from another account at 50 tokens or more, a listing that stayed up an hour or sold,
  another account's auction bid on, a pack bought with tokens, a deck legal and complete that
  lasted a day, a sleeve still kept. Nothing a player gives themselves counts.
- **After a reset** (users.reset_at) the boards are drawn again, and count only what came since.
- **What never counts.** A campaign duel writes no result: only campaign_wins reads duels. A
  game whose bots were passive (the testing switch of SysOp and administrators, api/games.py)
  counts as any other since v0.9.7; until then it wrote no result and completed no quest.
"""

import random
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Literal, cast

from fastapi import APIRouter
from pydantic import Field
from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.orm import Session

from api.auth import INPUT_ERRORS
from api.economy import ARIZONA, arizona_day, lock_account, reward
from api.identity import Active, Db, utcnow
from api.library import reset_key, since_reset
from api.models import (
    Auction,
    AuctionBid,
    CampaignGame,
    CardConcept,
    CardPrinting,
    CardSleeve,
    DailyQuest,
    Deck,
    Pack,
    PackCard,
    PackOpening,
    PlayerResult,
    QuestBoard,
    ShopProduct,
    TokenEntry,
    User,
)
from api.products import era_of_product
from api.quest_pool import (
    DAILY,
    DAILY_BONUS,
    DAILY_BY_ID,
    DAILY_QUESTS,
    POLICY,
    WEEKLY,
    WEEKLY_BONUS,
    WEEKLY_BY_ID,
    WEEKLY_IN_GAME,
    WEEKLY_TIERS,
    WeeklyGoal,
)
from api.quest_pool import (
    DailyQuest as DailyDef,
)
from api.sales import week_of
from api.schemas import Contract
from api.social import notify_award
from api.stats import Rule, counted

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

RANDOM = random.SystemRandom()
Board = Literal["daily", "weekly"]
# A sleeve the account may still upload toward a goal: the upload limit (api/sleeves.py).
SLEEVE_LIMIT = 20
# The least an auction won counts at, and how long a listing must stay up.
AUCTION_MINIMUM = 50
LISTING_HOURS = 1
# A goal that needs other accounts' auctions is drawn only while the market holds this many times
# what it asks for, and an auction to bid on only while it has this long left to run (v0.9.7).
MARKET_MARGIN = 2
BIDDABLE_HOURS = 24
# How long a deck must last to count as built.
DECK_DAYS = 1
COMMANDER_SIZE = 100
LEGACY_SIZE = 60
# The old three-a-day quests' names, for the bell's notices from before v0.9.5.
LEGACY_NAMES = {
    "win": ("Win a game", 100),
    "win-3": ("Win three games", 200),
    "win-commander": ("Win a Commander game", 125),
    "win-commander-2": ("Win two Commander games", 200),
    "win-legacy": ("Win a Legacy game", 150),
    "win-four-players": ("Win a four-player Commander game", 200),
    "win-white": ("Win with a white deck", 150),
    "win-blue": ("Win with a blue deck", 150),
    "win-black": ("Win with a black deck", 150),
    "win-red": ("Win with a red deck", 150),
    "win-green": ("Win with a green deck", 150),
    "win-mono": ("Win with a mono-coloured deck", 150),
    "win-three-colours": ("Win with a deck of three or more colours", 175),
    "beat-skill-4": ("Beat a bot of skill 4 or higher", 150),
    "beat-skill-6": ("Beat a skill-6 bot", 250),
    "win-players": ("Win at a human table", 250),
}


# Contracts.


class QuestView(Contract):
    slot: int
    id: str
    name: str
    tokens: int
    target: int = Field(description="What it needs: wins, games, packs, cards, tokens…")
    progress: int = Field(description="Counted so far, at most the target.")
    completed_at: datetime | None
    step: int | None = Field(
        default=None,
        description="A daily quest's difficulty, 1 (easiest) to 5 (hardest), which sets its "
        "tokens. No order: the day's five complete in any order, each by itself (v0.9.7).",
    )
    tier: Literal["easy", "medium", "hard"] | None = Field(
        default=None, description="A weekly goal's tier."
    )
    in_game: bool = Field(description="Counted from games played, not from outside them.")


class Streak(Contract):
    current: int = Field(
        description="Boards finished in a row, up to the last one finished (this period's when "
        "it is finished, else the previous one's); 0 when the previous period's was not."
    )
    bonus: int = Field(
        description="What finishing this period's board pays (or paid, once finished)."
    )
    next_bonus: int = Field(description="What the next period's board pays if the streak holds.")
    best: int = Field(description="The most boards finished in a row since the last reset.")


class BoardView(Contract):
    board: Board
    period: date = Field(description="The day, or the Sunday the week starts on, in Arizona.")
    resets_at: datetime = Field(description="When the next board comes, midnight in Arizona.")
    completed_at: datetime | None = Field(description="When every quest was complete.")
    streak: Streak
    quests: list[QuestView]


class QuestBoards(Contract):
    daily: BoardView
    weekly: BoardView
    paid: int = Field(
        description="Tokens this look itself paid, for quests and boards it found complete."
    )


# Periods.


def day_of(moment: datetime) -> date:
    return moment.astimezone(ARIZONA).date()


def period_of(board: Board, moment: datetime) -> tuple[date, datetime, datetime]:
    """The board's period holding the moment: its date, and its start and end in UTC (SQLite
    keeps no zone, so bounds must be in the zone times are written in)."""
    if board == "weekly":
        sunday, start, end = week_of(moment)
        return sunday, start.astimezone(UTC), end.astimezone(UTC)
    start, end = arizona_day(moment)
    return day_of(moment), start, end


def previous(board: Board, period: date) -> date:
    return period - timedelta(days=7 if board == "weekly" else 1)


# Drawing.

# The decks a game's format is played with: Two-Headed Giant plays Legacy decks, King's Table
# either. A rule that names no format takes any deck.
DECK_FORMATS: dict[str, tuple[str, ...]] = {
    "commander": ("commander",),
    "legacy": ("legacy",),
    "two_headed_giant": ("legacy",),
    "kings_table": ("legacy", "commander"),
}
Reach = Callable[[Rule], bool]


def everything(_rule: Rule) -> bool:
    return True


def reach_of(db: Session, user: User) -> Reach:
    """Which wins the account can go for with a deck it has (v0.9.7): a quest asks only for a win
    one of its playable decks could bring, by the deck's format and colours, as the deck builder
    shows them. Players play their own decks alone (the practice table offers nobody else a
    fixture deck), so until v0.9.7 a day could ask a player with one black deck to win with a red
    one, which no game that day could do. SysOp plays any deck, and an account without a playable
    deck is asked for anything: nothing says what it will build."""
    if user.kind == "sysop":
        return everything
    decks = [
        (fmt, identity or "")
        for fmt, identity in db.execute(
            select(Deck.format, Deck.identity).where(
                Deck.owner_id == user.id,
                Deck.deleted_at.is_(None),
                Deck.archived_at.is_(None),
                Deck.playable.is_(True),
            )
        )
    ]
    if not decks:
        return everything

    def within_reach(rule: Rule) -> bool:
        formats = DECK_FORMATS.get(rule.format) if rule.format is not None else None
        return any(
            (formats is None or fmt in formats)
            and (rule.color is None or rule.color in identity)
            and (not rule.mono or len(identity) == 1)
            and len(identity) >= rule.colors_at_least
            for fmt, identity in decks
        )

    return within_reach


def choose_daily(_user: User, reach: Reach = everything) -> list[DailyDef]:
    """One quest a step, no two of one family, each within the account's reach. Every step has
    quests any deck can do (wins, games played, a bot's skill), so a step never runs dry. Tests
    replace this to pick the quests they need."""
    chosen: list[DailyDef] = []
    families: set[str] = set()
    for step in range(1, DAILY_QUESTS + 1):
        options = [
            q for q in DAILY if q.step == step and q.family not in families and reach(q.rule)
        ]
        quest = RANDOM.choice(options)
        chosen.append(quest)
        families.add(quest.family)
    return chosen


def choose_weekly(available: Callable[[WeeklyGoal], bool]) -> list[WeeklyGoal]:
    """Twenty goals of twenty families: WEEKLY_IN_GAME from the games, the rest from outside
    them, at the tiers WEEKLY_TIERS counts; easy first. Tests replace this."""
    by_family: dict[str, dict[str, WeeklyGoal]] = {}
    for goal in WEEKLY:
        if available(goal):
            by_family.setdefault(goal.family, {})[goal.tier] = goal
    tiers = [tier for tier, count in WEEKLY_TIERS.items() for _ in range(count)]
    RANDOM.shuffle(tiers)
    order = {"easy": 0, "medium": 1, "hard": 2}
    used: set[str] = set()
    chosen: list[WeeklyGoal] = []
    for index, tier in enumerate(tiers):
        in_game = index < WEEKLY_IN_GAME
        side = [
            family
            for family, goals in sorted(by_family.items())
            if family not in used and next(iter(goals.values())).in_game == in_game
        ]
        exact = [family for family in side if tier in by_family[family]]
        family = RANDOM.choice(exact or side)
        goals = by_family[family]
        # A family without the tier gives its nearest.
        goal = goals.get(tier) or min(
            goals.values(), key=lambda g: abs(order[g.tier] - order[tier])
        )
        used.add(family)
        chosen.append(goal)
    return sorted(chosen, key=lambda goal: (order[goal.tier], not goal.in_game, goal.name))


def assigned(db: Session, user: User, board: Board, period: date) -> list[DailyQuest]:
    """The period's board, by slot: drawn since the account's last reset, under quests-v2."""
    return list(
        db.scalars(
            select(DailyQuest)
            .where(
                DailyQuest.user_id == user.id,
                DailyQuest.board == board,
                DailyQuest.day == period,
                DailyQuest.policy == POLICY,
                since_reset(user, DailyQuest.created_at),
            )
            .order_by(DailyQuest.slot)
        )
    )


def sleeves_kept(db: Session, user: User) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(CardSleeve)
            .where(
                CardSleeve.user_id == user.id,
                CardSleeve.deleted_at.is_(None),
                CardSleeve.removed_at.is_(None),
            )
        )
        or 0
    )


def market_of(db: Session, user: User, now: datetime) -> tuple[int, int]:
    """What Tivit's Auction House holds for the account now: other accounts' live auctions it
    could win at AUCTION_MINIMUM or more (a Buy Now below it sells below it), and those among
    them it could bid on, which an unlimited listing never takes and one about to end hardly
    does."""
    live = (
        Auction.status == "active",
        Auction.seller_id != user.id,
        or_(Auction.ends_at.is_(None), Auction.ends_at > now),
    )
    winnable = db.scalar(
        select(func.count())
        .select_from(Auction)
        .where(*live, or_(Auction.buy_now.is_(None), Auction.buy_now >= AUCTION_MINIMUM))
    )
    biddable = db.scalar(
        select(func.count())
        .select_from(Auction)
        .where(*live, Auction.ends_at > now + timedelta(hours=BIDDABLE_HOURS))
    )
    return int(winnable or 0), int(biddable or 0)


def weekly_available(db: Session, user: User, now: datetime) -> Callable[[WeeklyGoal], bool]:
    """Which weekly goals the account can be asked for (v0.9.7): every goal must be one a player
    can finish alone (the owner's choice), so a goal is left out of the draw while what it needs
    is not there. A sleeve needs room under the upload limit. An auction to win or to bid on
    needs other accounts' auctions, which a quiet market does not have: until v0.9.7 a board
    could ask for three bids with no auction to bid on, and so never be finished. A win with a
    colour's deck, or in a format, needs a playable deck of it (reach_of)."""
    room = sleeves_kept(db, user) < SLEEVE_LIMIT
    winnable, biddable = market_of(db, user, now)
    reach = reach_of(db, user)

    def available(goal: WeeklyGoal) -> bool:
        if goal.metric == "sleeves":
            return room
        if goal.metric == "auctions_won":
            return winnable >= MARKET_MARGIN * goal.target
        if goal.metric == "bids":
            return biddable >= MARKET_MARGIN * goal.target
        if goal.metric == "wins":
            # Wins a deck of the account's could bring, as for the daily quests. Wins of any
            # kind, games played, a bot's skill, a table's game and King's Table take any deck,
            # so the games' six families are always there.
            return reach(goal.rule)
        return True

    return available


def drawn(db: Session, user: User, board: Board, now: datetime) -> list[DailyQuest]:
    """The period's board, drawn the first time it is asked for. The caller holds the account's
    lock, so two looks at once draw once."""
    period, start, _ = period_of(board, now)
    rows = assigned(db, user, board, period)
    if rows:
        return rows
    if board == "daily":
        picks: list[DailyDef | WeeklyGoal] = list(choose_daily(user, reach_of(db, user)))
    else:
        picks = list(choose_weekly(weekly_available(db, user, now)))
    for slot, quest in enumerate(picks):
        row = DailyQuest(
            user_id=user.id,
            day=period,
            board=board,
            slot=slot,
            key=reset_key(user, f"{board}-slot:{user.id}:{period.isoformat()}:{slot}"),
            quest=quest.id,
            tokens=quest.tokens,
            target=quest.target,
            counts_from=start,
            policy=POLICY,
            created_at=now,
        )
        db.add(row)
        rows.append(row)
    db.flush()
    return rows


# Measuring.


@dataclass
class Window:
    user: User
    start: datetime
    end: datetime
    now: datetime

    def within(self, column: ColumnElement[datetime] | object) -> ColumnElement[bool]:
        col = cast(ColumnElement[datetime], column)
        return and_(col >= self.start, col < self.end)


def count_results(db: Session, window: Window, condition: ColumnElement[bool]) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(PlayerResult)
            .where(counted(window.user), window.within(PlayerResult.finished_at), condition)
        )
        or 0
    )


def finished() -> ColumnElement[bool]:
    return PlayerResult.outcome.in_(("win", "loss", "draw"))


def rule_or_games(rule: Rule, metric: str) -> ColumnElement[bool]:
    if metric == "games":
        return finished()
    return rule.condition()


def measure_weekly(db: Session, goal: WeeklyGoal, window: Window) -> int:
    user = window.user
    params = goal.params
    match goal.metric:
        case "wins" | "games":
            return count_results(db, window, rule_or_games(goal.rule, goal.metric))
        case "table_games":
            return count_results(db, window, and_(finished(), PlayerResult.kind == "table"))
        case "campaign_wins":
            return (
                db.scalar(
                    select(func.count())
                    .select_from(CampaignGame)
                    .where(
                        CampaignGame.user_id == user.id,
                        CampaignGame.outcome == "won",
                        window.within(CampaignGame.finished_at),
                        since_reset(user, CampaignGame.created_at),
                    )
                )
                or 0
            )
        case "packs_bought":
            query = select(Pack, ShopProduct).join(ShopProduct, ShopProduct.id == Pack.product_id)
            query = query.where(
                Pack.user_id == user.id,
                Pack.source == "purchase",
                window.within(Pack.created_at),
                since_reset(user, Pack.created_at),
            )
            if params.sale:
                query = query.where(Pack.sale.is_(True))
            rows = db.execute(query).all()
            if params.era is not None:
                return sum(1 for _, product in rows if era_of_product(product) == params.era)
            return len(rows)
        case "tokens_spent":
            spent = db.scalar(
                select(func.coalesce(func.sum(-TokenEntry.amount), 0)).where(
                    TokenEntry.user_id == user.id,
                    TokenEntry.kind == "pack",
                    window.within(TokenEntry.created_at),
                    since_reset(user, TokenEntry.created_at),
                )
            )
            return int(spent or 0)
        case "packs_opened":
            opened = select(PackOpening, ShopProduct).join(
                ShopProduct, ShopProduct.id == PackOpening.product_id
            )
            openings = db.execute(
                opened.where(
                    PackOpening.user_id == user.id,
                    window.within(PackOpening.created_at),
                    since_reset(user, PackOpening.created_at),
                )
            ).all()
            if params.era is not None:
                return sum(1 for _, product in openings if era_of_product(product) == params.era)
            return len(openings)
        case "pulls":
            return measure_pulls(db, goal, window)
        case "listings":
            return measure_listings(db, goal, window)
        case "auctions_won":
            return (
                db.scalar(
                    select(func.count())
                    .select_from(Auction)
                    .where(
                        Auction.buyer_id == user.id,
                        Auction.seller_id != user.id,
                        Auction.status == "sold",
                        Auction.sold_price >= AUCTION_MINIMUM,
                        window.within(Auction.ended_at),
                        since_reset(user, Auction.ended_at),
                    )
                )
                or 0
            )
        case "bids":
            return (
                db.scalar(
                    select(func.count(func.distinct(AuctionBid.auction_id)))
                    .join(Auction, Auction.id == AuctionBid.auction_id)
                    .where(
                        AuctionBid.bidder_id == user.id,
                        Auction.seller_id != user.id,
                        window.within(AuctionBid.created_at),
                        since_reset(user, AuctionBid.created_at),
                    )
                )
                or 0
            )
        case "decks_built":
            return measure_decks(db, goal, window)
        case "sleeves":
            return (
                db.scalar(
                    select(func.count())
                    .select_from(CardSleeve)
                    .where(
                        CardSleeve.user_id == user.id,
                        CardSleeve.deleted_at.is_(None),
                        CardSleeve.removed_at.is_(None),
                        window.within(CardSleeve.created_at),
                        since_reset(user, CardSleeve.created_at),
                    )
                )
                or 0
            )
    return 0


def measure_pulls(db: Session, goal: WeeklyGoal, window: Window) -> int:
    params = goal.params
    user = window.user
    query = (
        select(PackCard.finish, PackCard.new, CardPrinting.rarity, CardConcept)
        .join(PackOpening, PackOpening.id == PackCard.opening_id)
        .join(CardPrinting, CardPrinting.id == PackCard.printing_id)
        .join(CardConcept, CardConcept.id == PackCard.concept_id)
        .where(
            PackOpening.user_id == user.id,
            window.within(PackOpening.created_at),
            since_reset(user, PackOpening.created_at),
        )
    )
    if params.finish is not None:
        query = query.where(PackCard.finish == params.finish)
    if params.rarities:
        query = query.where(CardPrinting.rarity.in_(params.rarities))
    if params.new:
        query = query.where(PackCard.new.is_(True))
    rows = db.execute(query).all()
    found = 0
    for _finish, _new, _rarity, concept in rows:
        if params.color is not None and params.color not in (concept.colors or []):
            continue
        if params.card_type is not None and params.card_type not in concept.type_line.lower():
            continue
        found += 1
    return found


def measure_listings(db: Session, goal: WeeklyGoal, window: Window) -> int:
    """Listings that stayed up an hour or sold: a card listed and withdrawn at once counts not."""
    user = window.user
    params = goal.params
    query = (
        select(Auction, CardPrinting.rarity)
        .join(CardPrinting, CardPrinting.id == Auction.printing_id)
        .where(
            Auction.seller_id == user.id,
            Auction.status != "cancelled",
            window.within(Auction.created_at),
            since_reset(user, Auction.created_at),
        )
    )
    if params.rarities:
        query = query.where(CardPrinting.rarity.in_(params.rarities))
    if params.buy_now:
        query = query.where(Auction.buy_now.is_not(None))
    hour = timedelta(hours=LISTING_HOURS)
    found = 0
    for auction, _rarity in db.execute(query).all():
        if auction.status == "sold":
            found += 1
            continue
        until = auction.ended_at or window.now
        if until - auction.created_at >= hour:
            found += 1
    return found


def measure_decks(db: Session, goal: WeeklyGoal, window: Window) -> int:
    """Decks made, legal with a full list, kept a day: each counts in the week its day ends."""
    user = window.user
    params = goal.params
    lasted = timedelta(days=DECK_DAYS)
    query = select(Deck).where(
        Deck.owner_id == user.id,
        Deck.deleted_at.is_(None),
        Deck.legal.is_(True),
        Deck.source != "campaign",
        Deck.created_at >= window.start - lasted,
        Deck.created_at < window.end - lasted,
        Deck.created_at <= window.now - lasted,
        since_reset(user, Deck.created_at),
    )
    if params.format is not None:
        query = query.where(Deck.format == params.format)
    found = 0
    for deck in db.scalars(query):
        size = COMMANDER_SIZE if deck.format == "commander" else LEGACY_SIZE
        if deck.card_count < size:
            continue
        identity = deck.identity or ""
        if params.color is not None and params.color not in identity:
            continue
        if len(identity) < params.colors_at_least:
            continue
        found += 1
    return found


def measure_daily(quest: DailyDef, window: Window, db: Session) -> int:
    return count_results(db, window, rule_or_games(quest.rule, quest.metric))


def progress_of(db: Session, row: DailyQuest, user: User, now: datetime) -> int:
    board = cast(Board, row.board)
    _, start, end = period_of(board, row.counts_from)
    window = Window(user, max(start, row.counts_from), end, now)
    if board == "daily":
        daily = DAILY_BY_ID.get(row.quest)
        found = measure_daily(daily, window, db) if daily else 0
    else:
        goal = WEEKLY_BY_ID.get(row.quest)
        found = measure_weekly(db, goal, window) if goal else 0
    return min(row.target, found)


def name_of(row: DailyQuest) -> str:
    found = DAILY_BY_ID.get(row.quest) or WEEKLY_BY_ID.get(row.quest)
    return found.name if found else row.quest


# Paying.


def bonus_for(board: Board, streak: int) -> int:
    base, step, cap = DAILY_BONUS if board == "daily" else WEEKLY_BONUS
    return min(cap, base + step * (max(1, streak) - 1))


def board_row(db: Session, user: User, board: Board, period: date) -> QuestBoard | None:
    return db.scalar(
        select(QuestBoard).where(
            QuestBoard.user_id == user.id,
            QuestBoard.board == board,
            QuestBoard.period == period,
            since_reset(user, QuestBoard.completed_at),
        )
    )


def ledger_key(board: Board, user: User, period: date, quest: str) -> str:
    return reset_key(user, f"{board}:{user.id}:{period.isoformat()}:{quest}")


def settle(
    db: Session,
    user: User,
    board: Board,
    rows: list[DailyQuest],
    now: datetime,
    at: datetime | None = None,
) -> int:
    """Completes the board's quests whose counts are in and, once every one is complete, the board
    itself, paying each once and telling the bell; returns the tokens paid. A board's period must
    still be running at the moment (`at`, by default now; a game's end for a game just recorded):
    a quest is complete only within it."""
    if not rows:
        return 0
    period, _, end = period_of(board, rows[0].counts_from)
    if (at or now) >= end:
        return 0
    paid = 0
    for row in rows:
        if row.completed_at is not None:
            continue
        if progress_of(db, row, user, now) < row.target:
            continue
        row.completed_at = now
        name = name_of(row)
        if reward(
            db,
            user.id,
            "quest",
            row.tokens,
            ledger_key(board, user, period, row.quest),
            name,
            POLICY,
        ):
            paid += row.tokens
            notify_award(db, user.id, "quest_completed", row.quest, now)
    if (
        all(row.completed_at is not None for row in rows)
        and board_row(db, user, board, period) is None
    ):
        before = board_row(db, user, board, previous(board, period))
        streak = before.streak + 1 if before is not None else 1
        bonus = bonus_for(board, streak)
        key = reset_key(user, f"board:{user.id}:{board}:{period.isoformat()}")
        db.add(
            QuestBoard(
                user_id=user.id,
                board=board,
                period=period,
                key=key,
                streak=streak,
                bonus=bonus,
                policy=POLICY,
                completed_at=now,
            )
        )
        reason = f"{'Daily' if board == 'daily' else 'Weekly'} board complete (streak {streak})"
        if reward(db, user.id, "quest", bonus, key, reason, POLICY):
            paid += bonus
            notify_award(db, user.id, "quest_completed", f"board-{board}:{bonus}", now)
    db.flush()
    return paid


def settle_all(db: Session, user: User, now: datetime) -> int:
    """Both boards of the moment, drawn if not yet; the caller holds the account's lock."""
    boards: tuple[Board, ...] = ("daily", "weekly")
    return sum(settle(db, user, board, drawn(db, user, board, now), now) for board in boards)


def count_game(db: Session, user: User, finished_at: datetime) -> int:
    """After a game that gave the account a result: its boards of the moment the game ended, if
    drawn yet (what came before the first look counts when it comes). In the game's transaction."""
    now = utcnow()
    paid = 0
    boards: tuple[Board, ...] = ("daily", "weekly")
    for board in boards:
        period, _, _ = period_of(board, finished_at)
        rows = assigned(db, user, board, period)
        if rows:
            paid += settle(db, user, board, rows, now, finished_at)
    return paid


# Viewing.


def best_streak(db: Session, user: User, board: Board) -> int:
    return int(
        db.scalar(
            select(func.coalesce(func.max(QuestBoard.streak), 0)).where(
                QuestBoard.user_id == user.id,
                QuestBoard.board == board,
                since_reset(user, QuestBoard.completed_at),
            )
        )
        or 0
    )


def board_view(
    db: Session, user: User, board: Board, rows: list[DailyQuest], now: datetime
) -> BoardView:
    period, _, end = period_of(board, now)
    done = board_row(db, user, board, period)
    before = board_row(db, user, board, previous(board, period))
    if done is not None:
        current, bonus = done.streak, done.bonus
        next_bonus = bonus_for(board, done.streak + 1)
    else:
        current = before.streak if before is not None else 0
        bonus = bonus_for(board, current + 1)
        next_bonus = bonus_for(board, current + 2)
    quests = []
    for row in rows:
        daily = DAILY_BY_ID.get(row.quest)
        weekly = WEEKLY_BY_ID.get(row.quest)
        quests.append(
            QuestView(
                slot=row.slot,
                id=row.quest,
                name=name_of(row),
                tokens=row.tokens,
                target=row.target,
                progress=row.target if row.completed_at else progress_of(db, row, user, now),
                completed_at=row.completed_at,
                step=daily.step if daily else None,
                tier=weekly.tier if weekly else None,
                in_game=daily is not None or (weekly is not None and weekly.in_game),
            )
        )
    return BoardView(
        board=board,
        period=period,
        resets_at=end,
        completed_at=done.completed_at if done else None,
        streak=Streak(
            current=current,
            bonus=bonus,
            next_bonus=next_bonus,
            best=best_streak(db, user, board),
        ),
        quests=quests,
    )


def boards_of(db: Session, user: User, now: datetime, paid: int) -> QuestBoards:
    return QuestBoards(
        daily=board_view(db, user, "daily", drawn(db, user, "daily", now), now),
        weekly=board_view(db, user, "weekly", drawn(db, user, "weekly", now), now),
        paid=paid,
    )


def award_name(subject: str) -> tuple[str, int] | None:
    """The bell's words for a quest completed or a board finished."""
    if subject.startswith("board-"):
        board, _, amount = subject.removeprefix("board-").partition(":")
        name = "Daily board complete" if board == "daily" else "Weekly board complete"
        return name, int(amount) if amount.isdigit() else 0
    found = DAILY_BY_ID.get(subject) or WEEKLY_BY_ID.get(subject)
    if found is not None:
        return found.name, found.tokens
    return LEGACY_NAMES.get(subject)


def locked(db: Session, user: User) -> None:
    """The account's row, locked for the request and read again, so two looks or a reset at once
    queue."""
    lock_account(db, user.id)
    db.refresh(user)


# Routes.


@router.get("/me/quests", response_model=QuestBoards)
def my_quests(principal: Active, db: Db) -> QuestBoards:
    """Today's daily board and this week's weekly board, each drawn at its period's first look,
    with their progress and streaks. What already completed one pays here."""
    user = principal.user
    locked(db, user)
    now = utcnow()
    paid = settle_all(db, user, now)
    db.commit()
    return boards_of(db, user, now, paid)


def daily_completed(db: Session, user: User) -> ColumnElement[bool]:
    """Daily quests completed (either version), for the achievements that count them."""
    return and_(
        DailyQuest.user_id == user.id,
        DailyQuest.board == "daily",
        DailyQuest.completed_at.is_not(None),
        since_reset(user, DailyQuest.created_at),
    )
