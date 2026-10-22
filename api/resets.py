"""Resetting an account (v0.4.5): SysOp's fresh start for a player, so the setup wizard runs again
as a new player sees it (the owner's request, for a beta tester who wanted to try it).

In one transaction, with the account's row locked:
- **The profile.** The handle goes, which anyone may then take; onboarding goes back to the handle,
  the two starter decks chosen are forgotten, and the alliance ends.
- **The library and the packs.** Grants and packs are append-only, so they stay recorded, and
  users.reset_at marks where the account's library and packs begin again (library.since_reset):
  every grant (starter decks, packs, the cards of decks saved before libraries existed) and every
  pack from before it no longer counts. A starter deck chosen or bought afterwards is a new grant
  and a new purchase (library.reset_key), so the shop sells each deck once more.
- **Decks** go to the trash, as their owner trashing them would, after a last check against the
  emptied library, so a deck restored from the trash says it is collection-locked.
- **Wins and tokens** go back to 0 and to the welcome's 1,000 through the ledgers' own entries, a
  setting of wins and a grant of tokens with the reason REASON, so both ledgers keep their history.

Friends, blocks, conversations and messages, table chats, problem reports, notifications, privacy
settings and preferences stay, and so do the account's sessions: its app sees the change at its
next account check. While the account plays a game or sits at an open table, a reset is refused.
"""

from dataclasses import dataclass, field

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from api.accounts import running_games
from api.decks import refresh_decks
from api.economy import WELCOME, balance_of, grant
from api.identity import ApiError, permissions_for, refuse_deleted, roles_of, utcnow
from api.library import library_of, since_reset
from api.models import Deck, LibraryGrant, Pack, PackOpening, User
from api.progression import set_wins, total_wins
from api.roster import Planeswalker
from api.tables import open_table_of

# The reason the ledgers' entries give.
REASON = "Account reset by SysOp"


@dataclass
class Cleared:
    """What one reset cleared, for the audit entry, the answer and tests."""

    wins: int
    tokens: int
    cards: int
    packs: int
    alliance: str | None
    starters: list[str] = field(default_factory=list)
    decks: int = 0

    def details(self) -> dict[str, object]:
        """The audit entry's details: counts and the IDs of what was chosen, never a name."""
        return {
            "wins": self.wins,
            "tokens": self.tokens,
            "cards": self.cards,
            "packs": self.packs,
            "decks": self.decks,
            "alliance": self.alliance,
            "starters": self.starters,
        }


def reset_account(db: Session, user: User, actor: User, roster: dict[str, Planeswalker]) -> Cleared:
    """Resets a player's account to a new one's state (the module's docstring says what goes and
    what stays), in the caller's transaction: the caller audits and commits. Refuses 409 while the
    account plays a game or sits at an open table."""
    if user.kind != "player":
        raise ValueError("Only a player's account can be reset.")
    # The account's row is locked, as a purchase, a pack's opening or a seat at a table locks it,
    # and read again, so what got there first is seen; the time is taken after, so everything
    # granted before the lock counts as before the reset.
    db.refresh(user, with_for_update=True)
    refuse_deleted(user)
    if running_games(db, user.id):
        raise ApiError(
            409,
            "account_in_game",
            "This account is playing a game. Reset it once the game ends, or close the game first.",
        )
    if open_table_of(db, user.id) is not None:
        raise ApiError(
            409,
            "account_at_table",
            "This account is seated at an open table. Reset it once it leaves the table, or the "
            "table starts or closes.",
        )
    now = utcnow()
    cleared = Cleared(
        wins=total_wins(db, user.id),
        tokens=balance_of(db, user.id),
        cards=db.scalar(
            select(func.coalesce(func.sum(LibraryGrant.quantity), 0)).where(
                LibraryGrant.user_id == user.id, since_reset(user, LibraryGrant.created_at)
            )
        )
        or 0,
        packs=db.scalar(
            select(func.count())
            .select_from(Pack)
            .outerjoin(PackOpening, PackOpening.pack_id == Pack.id)
            .where(
                Pack.user_id == user.id,
                PackOpening.id.is_(None),
                since_reset(user, Pack.created_at),
            )
        )
        or 0,
        alliance=user.alliance,
        starters=list(user.starter_decks or []),
    )
    user.handle = user.normalized_handle = None
    user.onboarding = "handle"
    user.starter_decks = None
    user.alliance = user.alliance_since = None
    user.reset_at = now
    user.updated_at = now
    set_wins(db, user, 0, REASON, actor)
    if cleared.tokens != WELCOME:
        grant(db, user, WELCOME - cleared.tokens, REASON, actor)
    db.flush()
    permissions = permissions_for(user, roles_of(db, user))
    refresh_decks(db, user.id, library_of(db, user, permissions, roster))
    # As trashing a deck does (api/decks.py): its link stops working, and it can be restored.
    cleared.decks = db.execute(
        update(Deck)
        .where(Deck.owner_id == user.id, Deck.deleted_at.is_(None))
        .values(deleted_at=now, visibility="private", share_code=None)
    ).rowcount  # type: ignore[attr-defined]
    db.flush()
    return cleared
