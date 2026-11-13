"""Access, consent and temporary entitlement (v0.9.10, api/access.py): every kind of access is its
grantor's alone to give; a grant works only while it stands (consented to, not expired, not revoked,
between active accounts that do not block each other, of a deck still its grantor's); revoking one
changes no game started under it; the sandbox's cards never reach a library or the auction house;
and a grant opens a game's events through the right eyes, and only while it stands.
"""

from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from test_events import CAST, DRAW
from test_games import Account, build, connect

from api import access
from api.identity import ApiError, utcnow
from api.models import (
    AccessGrant,
    Auction,
    AuditEvent,
    Deck,
    DeckRevision,
    Game,
    GameEventRow,
    GameSeat,
    LibraryGrant,
    PlayerBlock,
    User,
)


@pytest.fixture
def database(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> str:
    url = f"sqlite:///{tmp_path}/access.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    return url


@pytest.fixture
def client(database: str) -> Any:
    with connect(build(database, None)) as client:
        yield client


def session(client: TestClient) -> Session:
    return Session(client.app.state.database, expire_on_commit=False)  # type: ignore[attr-defined]


def deck_of(db: Session, owner: UUID) -> Deck:
    now = utcnow()
    deck = Deck(
        owner_id=owner, title="Elves", format="commander", draft_hash="h", created_at=now,
        updated_at=now, latest_revision=1,
    )  # fmt: skip
    db.add(deck)
    db.flush()
    db.add(
        DeckRevision(
            deck_id=deck.id,
            number=1,
            format="commander",
            title="Elves",
            notes="",
            content_hash="c",
            legal=True,
            playable=True,
            created_at=now,
        )  # fmt: skip
    )
    db.flush()
    return deck


def game_of(db: Session, owner: UUID, status: str = "active") -> UUID:
    game = Game(
        id=uuid4(), kind="practice", format="legacy", status=status, created_by=owner,
        created_at=utcnow(), bot_skill=1, turn_cap=30,
    )  # fmt: skip
    db.add(game)
    db.flush()
    db.add(GameSeat(game_id=game.id, seat=0, player="human", user_id=owner, deck="d"))
    db.add(GameSeat(game_id=game.id, seat=1, player="bot", deck="d"))
    for event in (DRAW, CAST):
        db.add(
            GameEventRow(
                game_id=game.id, seq=event["seq"], epoch=0, turn=1, type=event["type"], event=event
            )
        )
    db.flush()
    return game.id


def refused(code: str, call: Any) -> None:
    with pytest.raises(ApiError) as error:
        call()
    assert error.value.code == code, error.value


def test_every_kind_of_access_is_its_grantors_alone_to_give(client: TestClient) -> None:
    ada, bea, cara = Account(client, "ada"), Account(client, "bea"), Account(client, "cara")
    with session(client) as db:
        a, b, c = (db.get_one(User, account.id) for account in (ada, bea, cara))
        deck = deck_of(db, a.id)
        game = game_of(db, a.id)
        # A deck, a game, a seat: only their owner's to give.
        refused("not_found", lambda: access.offer(db, b, c, "deck", deck.id))
        refused("not_found", lambda: access.offer(db, b, c, "spectator", game))
        refused("not_found", lambda: access.offer(db, b, c, "replay", game, scope={"seat": 0}))
        refused("invalid_grant", lambda: access.offer(db, a, c, "hand", game, scope={"seat": 1}))
        refused("invalid_grant", lambda: access.offer(db, a, a, "deck", deck.id))
        refused("invalid_grant", lambda: access.offer(db, a, b, "nothing", deck.id))
        # The sandbox's cards: SysOp's to give, nobody else's.
        refused("forbidden", lambda: access.offer(db, a, b, "sandbox", None))
        # Groups and pools come with v0.9.12.
        refused("not_available", lambda: access.offer(db, a, b, "group", uuid4()))
        refused("not_available", lambda: access.offer(db, a, b, "pool", uuid4()))
        # Never to an account that blocks or is blocked by the grantor.
        db.add(PlayerBlock(blocker_id=c.id, blocked_id=a.id, created_at=utcnow()))
        db.flush()
        refused("blocked", lambda: access.offer(db, a, c, "deck", deck.id))
        # Never backwards in time.
        refused(
            "invalid_grant",
            lambda: access.offer(db, a, b, "deck", deck.id, expires_at=utcnow() - timedelta(1)),
        )
        assert db.scalar(select(func.count()).select_from(AccessGrant)) == 0


def test_a_lent_deck_is_usable_only_while_its_grant_stands(client: TestClient) -> None:
    ada, bea, cara = Account(client, "ada"), Account(client, "bea"), Account(client, "cara")
    with session(client) as db:
        a, b, c = (db.get_one(User, account.id) for account in (ada, bea, cara))
        deck = deck_of(db, a.id)
        now = utcnow()
        grant = access.offer(db, a, b, "deck", deck.id, expires_at=now + timedelta(days=7))
        # Offered: not usable until accepted, and only by its subject.
        assert grant.consent == "offered"
        assert not access.deck_usable(db, b.id, deck)
        refused("not_found", lambda: access.answer(db, grant, c, True))
        access.answer(db, grant, b, True)
        refused("answered", lambda: access.answer(db, grant, b, True))
        assert access.deck_usable(db, b.id, deck)
        assert access.deck_usable(db, a.id, deck), "its owner's all along"
        assert not access.deck_usable(db, c.id, deck), "nobody else's"
        # Past its expiry, no more.
        assert not access.deck_usable(db, b.id, deck, now + timedelta(days=8))
        # Revoked by its grantor (or its subject, or SysOp; nobody else): no more.
        refused("not_found", lambda: access.revoke(db, grant, c))
        access.revoke(db, grant, a)
        assert not access.deck_usable(db, b.id, deck)

        # Lent again: a block, a deleted deck, an account deleted or disabled each end it.
        again = access.offer(db, a, b, "deck", deck.id)
        access.answer(db, again, b, True)
        assert access.deck_usable(db, b.id, deck)
        block = PlayerBlock(blocker_id=b.id, blocked_id=a.id, created_at=utcnow())
        db.add(block)
        db.flush()
        assert not access.deck_usable(db, b.id, deck)
        db.delete(block)
        db.flush()
        assert access.deck_usable(db, b.id, deck)
        b.status = "disabled"
        db.flush()
        assert not access.deck_usable(db, b.id, deck)
        b.status = "active"
        deck.deleted_at = utcnow()
        db.flush()
        assert not access.deck_usable(db, b.id, deck)

        actions = list(
            db.scalars(select(AuditEvent.action).where(AuditEvent.action.like("access.%")))
        )
        assert sorted(actions) == sorted(
            ["access.offered", "access.accepted", "access.revoked"]
            + ["access.offered", "access.accepted"]
        ), "every change audited"
        # A declined offer gives nothing.
        deck.deleted_at = None
        declined = access.offer(db, a, b, "deck", deck.id)
        access.answer(db, declined, b, False)
        assert not access.active(db, b.id, "deck", deck.id) or all(
            grant.id != declined.id for grant in access.active(db, b.id, "deck", deck.id)
        )


def test_revoking_a_lent_deck_changes_no_game_started_with_it(client: TestClient) -> None:
    ada, bea = Account(client, "ada"), Account(client, "bea")
    with session(client) as db:
        a, b = db.get_one(User, ada.id), db.get_one(User, bea.id)
        deck = deck_of(db, a.id)
        revision = db.scalars(select(DeckRevision).where(DeckRevision.deck_id == deck.id)).one()
        grant = access.offer(db, a, b, "deck", deck.id)
        access.answer(db, grant, b, True)
        game = game_of(db, b.id)
        seat = db.scalars(
            select(GameSeat).where(GameSeat.game_id == game, GameSeat.seat == 0)
        ).one()
        # The game binds the revision it started with, as for any deck.
        seat.deck_revision_id = revision.id
        db.flush()
        access.revoke(db, grant, a)
        db.flush()
        db.refresh(seat)
        assert seat.deck_revision_id == revision.id
        assert not access.deck_usable(db, b.id, deck), "no new game with it"


def test_the_sandboxs_cards_never_reach_a_library_or_the_auction_house(client: TestClient) -> None:
    root, bea = Account(client, "sysop", kind="sysop"), Account(client, "bea")
    with session(client) as db:
        r, b = db.get_one(User, root.id), db.get_one(User, bea.id)
        grant = access.offer(db, r, b, "sandbox", None, scope={"cards": ["Black Lotus"]})
        assert grant.consent == "given"
        assert [g.id for g in access.active(db, b.id, "sandbox", None)] == [grant.id]
        # Access only: nothing written where ownership lives, which is all the shop, the library and
        # the auction house read.
        assert db.scalar(select(func.count()).select_from(LibraryGrant)) == 0
        assert db.scalar(select(func.count()).select_from(Auction)) == 0
        assert db.scalar(select(func.count()).select_from(AccessGrant)) == 1


def test_access_given_opens_a_games_events_through_the_right_eyes(client: TestClient) -> None:
    ada, cara = Account(client, "ada"), Account(client, "cara")
    with session(client) as db:
        a, c = db.get_one(User, ada.id), db.get_one(User, cara.id)
        game = game_of(db, a.id)
        db.commit()

    def read() -> dict[str, Any] | None:
        reply = cara.get(f"/api/v1/games/{game}/timeline")
        return None if reply.status_code == 404 else reply.json()

    assert read() is None, "not at the table, given nothing"
    with session(client) as db:
        spectator = access.offer(
            db, db.get_one(User, a.id), db.get_one(User, c.id), "spectator", game
        )
        db.commit()
    page = read()
    assert page is not None and page["perspective"] == "spectator"
    assert page["events"][0]["object"] == {"hidden": True, "owner": 0}, "a spectator sees no hand"
    with session(client) as db:
        access.revoke(db, db.get_one(AccessGrant, spectator.id), db.get_one(User, a.id))
        # A coach shown seat 0's hand sees it as seat 0 does.
        coach = access.offer(
            db, db.get_one(User, a.id), db.get_one(User, c.id), "hand", game, scope={"seat": 0}
        )
        db.commit()
    page = read()
    assert page is not None and page["perspective"] == "seat" and page["seat"] == 0
    assert page["events"][0]["object"]["name"] == "Lightning Bolt"
    with session(client) as db:
        access.revoke(db, db.get_one(AccessGrant, coach.id), db.get_one(User, c.id))
        # A replay given opens only once the game is over.
        access.offer(
            db, db.get_one(User, a.id), db.get_one(User, c.id), "replay", game, scope={"seat": 0},
            expires_at=utcnow() + timedelta(days=1),
        )  # fmt: skip
        db.commit()
    assert read() is None, "revoked, and a replay of a running game is no replay"
    with session(client) as db:
        db.get_one(Game, game).status = "finished"
        db.commit()
    page = read()
    assert page is not None and page["seat"] == 0
    # Blocked: nothing, whatever stands.
    with session(client) as db:
        db.add(PlayerBlock(blocker_id=a.id, blocked_id=c.id, created_at=utcnow()))
        db.commit()
    assert read() is None
