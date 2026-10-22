"""Tokens (v0.4.0): the economy ledger, what wins pay, and SysOp's grants.

- **Wins pay** only from committed results (PROG04, NET10): when the API records a game as won by
  a player's seat, the same transaction pays that player for each seat it beat, keyed by the game,
  the winning seat and the beaten seat, so a retry, a replay or a restart pays nothing twice
  (PROG03, PROG05). A beaten bot pays by the game's bot skill, 5 to 20 tokens; a beaten player pays
  `50 + 90 x log10(1 + wins)` tokens by their wins, at most 500. Every entry records its rule.
- **Limits** (PROG05). Wins over the same player pay tokens for the first 3 a day; later ones are
  recorded with nothing paid. SysOp may set a daily cap on tokens from bots, off by default. A day
  is a calendar day in Arizona time.
- **The welcome grant** of 1,000 tokens comes with every new account, once.
- **Grants.** SysOp gives (or takes back) tokens on any account, its own included, with a reason,
  audited, and kept apart from tokens earned. Administrators see balances and ledgers.
- **Spending.** A purchase locks the account's row, so two purchases at once cannot spend the same
  tokens; a balance never goes below zero. Every purchase in Leng's shop is a "pack" entry, the
  starter decks sold there since v0.4.2 too (key deck:<account>:<deck>, named by the reason).
"""

import math
from datetime import UTC, datetime, timedelta, timezone
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.auth import INPUT_ERRORS
from api.identity import (
    Active,
    ApiError,
    Db,
    Principal,
    audit,
    not_found,
    refuse_deleted,
    require_permission,
    utcnow,
)
from api.models import Game, GameSeat, SiteSetting, TokenEntry, User
from api.progression import total_wins
from api.schemas import Contract, StoredText

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)
Reader = Annotated[Principal, Depends(require_permission("admin.users.read"))]
EconomyManager = Annotated[Principal, Depends(require_permission("economy.manage"))]

# The rule tokens are paid under, recorded on each entry (PROG05).
POLICY = "tokens-v1"
WELCOME = 1_000
BOT_TOKENS = {1: 5, 2: 8, 3: 11, 4: 14, 5: 17, 6: 20}
HUMAN_MIN = 50
HUMAN_MAX = 500
PAID_WINS_PER_OPPONENT = 3
# Arizona keeps Mountain Standard Time all year.
ARIZONA = timezone(timedelta(hours=-7), "MST")
BOT_CAP = "economy.bot_daily_cap"
MAX_GRANT = 100_000_000
MAX_BOT_CAP = 100_000
LEDGER_SHOWN = 50
EARNED = ("bot_win", "human_win", "back_pay")
GIVEN = ("welcome", "grant")

TokenKind = Literal["bot_win", "human_win", "back_pay", "welcome", "grant", "pack"]


class TokenLine(Contract):
    kind: TokenKind
    amount: int
    created_at: datetime
    game_id: UUID | None
    opponent: str | None = Field(description="Whom the win beat: a bot by its skill, or a handle.")
    reason: str | None


class Tokens(Contract):
    balance: int
    earned: int = Field(description="From wins, back pay included.")
    given: int = Field(description="The welcome grant and SysOp's grants, less any taken back.")
    spent: int = Field(description="On packs, as a positive number.")
    entries: list[TokenLine] = Field(description="The latest entries, newest first.")


class TokenGrant(Contract):
    amount: int = Field(
        ge=-MAX_GRANT, le=MAX_GRANT, description="Tokens to give; negative takes back."
    )
    reason: Annotated[StoredText, Field(min_length=3, max_length=200)]


class EconomySettings(Contract):
    bot_daily_cap: int | None = Field(
        ge=1,
        le=MAX_BOT_CAP,
        description="The most tokens bots pay one account in a day; null for no cap.",
    )


def human_tokens(wins: int) -> int:
    """What beating a player with these wins pays: 50 at none, 230 at 100, 500 from 100,000."""
    return min(HUMAN_MAX, round(HUMAN_MIN + 90 * math.log10(1 + max(0, wins))))


def arizona_day(moment: datetime) -> tuple[datetime, datetime]:
    """The calendar day in Arizona that holds the moment, as its start and end in UTC (SQLite
    stores times without their zone, so bounds must be in the zone the times were written in)."""
    local = moment.astimezone(ARIZONA)
    start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return start.astimezone(UTC), (start + timedelta(days=1)).astimezone(UTC)


def balance_of(db: Session, user_id: UUID) -> int:
    return int(
        db.scalar(
            select(func.coalesce(func.sum(TokenEntry.amount), 0)).where(
                TokenEntry.user_id == user_id
            )
        )
        or 0
    )


def welcome(db: Session, user: User) -> None:
    """The welcome grant, once per account, in the caller's transaction."""
    key = f"welcome:{user.id}"
    if db.scalar(select(TokenEntry.id).where(TokenEntry.key == key)) is None:
        db.add(
            TokenEntry(
                user_id=user.id,
                kind="welcome",
                amount=WELCOME,
                key=key,
                policy=POLICY,
                reason="Welcome to Leng's card shop",
                created_at=utcnow(),
            )
        )


def bot_cap(db: Session) -> int | None:
    setting = db.get(SiteSetting, BOT_CAP)
    return setting.value if setting and isinstance(setting.value, int) else None


def pay_game(db: Session, game: Game) -> None:
    """Pays the game's winner, if a player's seat won it, for every seat it beat: in the caller's
    transaction, after the game's result is recorded."""
    result = game.result or {}
    winner = result.get("winner_seat")
    if result.get("kind") != "completed" or not isinstance(winner, int):
        return
    seats = list(
        db.scalars(select(GameSeat).where(GameSeat.game_id == game.id).order_by(GameSeat.seat))
    )
    owner = next((seat.user_id for seat in seats if seat.seat == winner), None)
    if owner is None:
        return
    # Two of the winner's games ending at once count today's paid wins one after the other.
    lock_account(db, owner)
    now = utcnow()
    start, end = arizona_day(now)
    today = (
        TokenEntry.user_id == owner,
        TokenEntry.created_at >= start,
        TokenEntry.created_at < end,
    )
    cap = bot_cap(db)
    from_bots = int(
        db.scalar(
            select(func.coalesce(func.sum(TokenEntry.amount), 0)).where(
                *today, TokenEntry.kind == "bot_win"
            )
        )
        or 0
    )
    for seat in seats:
        key = f"tokens:{game.id}:{winner}:{seat.seat}"
        if seat.seat == winner or db.scalar(select(TokenEntry.id).where(TokenEntry.key == key)):
            continue
        reason = None
        if seat.player == "bot":
            kind = "bot_win"
            amount = BOT_TOKENS.get(game.bot_skill, BOT_TOKENS[4])
            if cap is not None and from_bots + amount > cap:
                amount = max(0, cap - from_bots)
                reason = f"Today's cap on tokens from bots is {cap:,}."
            from_bots += amount
        elif seat.user_id is not None and seat.user_id != owner:
            kind = "human_win"
            amount = human_tokens(total_wins(db, seat.user_id))
            paid = (
                db.scalar(
                    select(func.count()).where(
                        *today,
                        TokenEntry.kind == "human_win",
                        TokenEntry.opponent_id == seat.user_id,
                        TokenEntry.amount > 0,
                    )
                )
                or 0
            )
            if paid >= PAID_WINS_PER_OPPONENT:
                amount = 0
                reason = (
                    f"Only {PAID_WINS_PER_OPPONENT} wins a day over the same player pay tokens."
                )
        else:
            continue
        db.add(
            TokenEntry(
                user_id=owner,
                kind=kind,
                amount=amount,
                key=key,
                game_id=game.id,
                opponent_seat=seat.seat,
                opponent_id=seat.user_id,
                policy=POLICY,
                reason=reason,
                created_at=now,
            )
        )
        # The next seat's limits count this one.
        db.flush()


def tokens_from(db: Session, game_id: UUID, user_id: UUID) -> int:
    return int(
        db.scalar(
            select(func.coalesce(func.sum(TokenEntry.amount), 0)).where(
                TokenEntry.game_id == game_id, TokenEntry.user_id == user_id
            )
        )
        or 0
    )


def lock_account(db: Session, user_id: UUID) -> None:
    """Locks the account's row until the transaction ends, so changes to its balance queue."""
    db.scalar(select(User.id).where(User.id == user_id).with_for_update())


def spend(db: Session, user_id: UUID, amount: int, key: str, reason: str) -> TokenEntry:
    """Takes tokens for a purchase, in the caller's transaction; refuses when the balance is short.
    The key names what was bought, so a retried purchase finds it taken."""
    if amount < 0:
        raise ValueError("a purchase spends a positive amount")
    lock_account(db, user_id)
    balance = balance_of(db, user_id)
    if balance < amount:
        raise ApiError(
            409,
            "not_enough_tokens",
            f"This costs {amount:,} tokens, and you have {balance:,}.",
        )
    entry = TokenEntry(
        user_id=user_id,
        kind="pack",
        amount=-amount,
        key=key,
        policy=POLICY,
        reason=reason,
        created_at=utcnow(),
    )
    db.add(entry)
    db.flush()
    return entry


def grant(db: Session, user: User, amount: int, reason: str, actor: User) -> TokenEntry:
    """SysOp's grant, in the caller's transaction: tokens given, or taken back down to zero."""
    lock_account(db, user.id)
    balance = balance_of(db, user.id)
    if amount == 0:
        raise ApiError(422, "invalid_amount", "Give or take back at least one token.")
    if balance + amount < 0:
        raise ApiError(
            409, "balance_negative", f"The account has {balance:,} tokens; that would go below 0."
        )
    entry = TokenEntry(
        user_id=user.id,
        kind="grant",
        amount=amount,
        key=f"grant:{uuid4()}",
        policy=POLICY,
        reason=reason,
        actor_id=actor.id,
        created_at=utcnow(),
    )
    db.add(entry)
    db.flush()
    return entry


def tokens_of(db: Session, user_id: UUID) -> Tokens:
    totals = dict(
        db.execute(
            select(TokenEntry.kind, func.coalesce(func.sum(TokenEntry.amount), 0))
            .where(TokenEntry.user_id == user_id)
            .group_by(TokenEntry.kind)
        ).all()
    )
    rows = list(
        db.scalars(
            select(TokenEntry)
            .where(TokenEntry.user_id == user_id)
            .order_by(TokenEntry.created_at.desc(), TokenEntry.key)
            .limit(LEDGER_SHOWN)
        )
    )
    games = {row.game_id for row in rows if row.game_id is not None}
    skills = (
        dict(db.execute(select(Game.id, Game.bot_skill).where(Game.id.in_(games))).all())
        if games
        else {}
    )
    players = {row.opponent_id for row in rows if row.opponent_id is not None}
    handles = (
        dict(db.execute(select(User.id, User.handle).where(User.id.in_(players))).all())
        if players
        else {}
    )

    def opponent(row: TokenEntry) -> str | None:
        if row.opponent_id is not None:
            return handles.get(row.opponent_id) or "a player"
        if row.game_id is not None:
            return f"a skill-{skills.get(row.game_id, '?')} bot"
        return None

    return Tokens(
        balance=sum(int(value) for value in totals.values()),
        earned=sum(int(totals.get(kind, 0)) for kind in EARNED),
        given=sum(int(totals.get(kind, 0)) for kind in GIVEN),
        spent=-int(totals.get("pack", 0)),
        entries=[
            TokenLine(
                kind=row.kind,  # type: ignore[arg-type]
                amount=row.amount,
                created_at=row.created_at,
                game_id=row.game_id,
                opponent=opponent(row),
                reason=row.reason,
            )
            for row in rows
        ],
    )


# Routes.


@router.get("/me/tokens", response_model=Tokens)
def my_tokens(principal: Active, db: Db) -> Tokens:
    return tokens_of(db, principal.user.id)


def target(db: Session, user_id: UUID, principal: Principal) -> User:
    """An account SysOp or an administrator may look at: any but another root account."""
    user = db.get(User, user_id)
    if user is None or (user.kind == "sysop" and user.id != principal.user.id):
        raise not_found()
    return user


@router.get("/admin/users/{user_id}/tokens", response_model=Tokens)
def account_tokens(user_id: UUID, principal: Reader, db: Db) -> Tokens:
    """An account's balance and latest entries, for administrators and SysOp."""
    return tokens_of(db, target(db, user_id, principal).id)


@router.post("/admin/users/{user_id}/tokens", response_model=Tokens)
def give_tokens(
    user_id: UUID, body: TokenGrant, request: Request, principal: EconomyManager, db: Db
) -> Tokens:
    """SysOp gives tokens to any account, its own included, or takes them back: a ledger entry of
    its own, apart from tokens earned, with the reason, and audited (PROG03)."""
    user = target(db, user_id, principal)
    refuse_deleted(user)
    entry = grant(db, user, body.amount, body.reason, principal.user)
    audit(
        db,
        request,
        "economy.tokens_granted",
        actor_id=principal.user.id,
        target_user_id=user.id,
        details={"amount": entry.amount, "reason": body.reason},
    )
    db.commit()
    return tokens_of(db, user.id)


@router.get("/admin/economy", response_model=EconomySettings)
def economy_settings(principal: Reader, db: Db) -> EconomySettings:
    return EconomySettings(bot_daily_cap=bot_cap(db))


@router.put("/admin/economy", response_model=EconomySettings)
def change_economy(
    body: EconomySettings, request: Request, principal: EconomyManager, db: Db
) -> EconomySettings:
    """SysOp's daily cap on tokens from bots (PROG05), off by default; audited."""
    before = bot_cap(db)
    if body.bot_daily_cap != before:
        setting = db.get(SiteSetting, BOT_CAP) or SiteSetting(key=BOT_CAP)
        setting.value = body.bot_daily_cap
        setting.updated_by = principal.user.id
        setting.updated_at = utcnow()
        db.add(setting)
        audit(
            db,
            request,
            "economy.settings_changed",
            actor_id=principal.user.id,
            details={"bot_daily_cap": {"from": before, "to": body.bot_daily_cap}},
        )
        db.commit()
    return EconomySettings(bot_daily_cap=bot_cap(db))
