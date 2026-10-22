"""Deleting an account (v0.4.1): what goes and what stays, table by table; the administrators'
route, its permissions and refusals; a later sign-in by the same person; and the daily job that
deletes requests never approved, with an injected clock. PostgreSQL's side (the foreign keys,
the append-only ledgers and the revisions' trigger) is in test_postgres.py."""

import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import test_identity
import test_tables
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text, update
from sqlalchemy.orm import Session
from test_identity import PASSWORD, browser, sign_in, sysop
from test_tables import Account, TableEngine, deck, served

from api import accounts
from api.cli import set_sysop_password
from api.config import Settings
from api.google import ISSUER
from api.models import (
    AuditEvent,
    Base,
    Deck,
    DeckEntryRow,
    DeckRevision,
    ExternalIdentity,
    Game,
    GameSeat,
    GameTable,
    ProgressEntry,
    RoleGrant,
    ScheduledJob,
    TableSeat,
    TokenEntry,
    User,
    UserSession,
)
from catalog import worker

url = test_tables.url
content = test_tables.content
database = test_identity.database
certs = test_identity.certs
REASON = "Asked by email to delete the account"


@pytest.fixture
def engine() -> TableEngine:
    return TableEngine()


@pytest.fixture
def client(url: str, content: Path, engine: TableEngine) -> Iterator[TestClient]:
    with served(url, content, engine) as client:
        yield client
    # served() empties the accounts' tables; these are the ones it leaves.
    cleanup = create_engine(url)
    with Session(cleanup) as db:
        db.execute(text("DELETE FROM external_identities"))
        db.commit()
    cleanup.dispose()


def rows(client: TestClient, model: Any, *where: Any) -> int:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return db.scalar(select(func.count()).select_from(model).where(*where)) or 0


def private_details(client: TestClient, account: Account) -> None:
    """What a Google sign-in and a profile give an account: its identity, a role, settings."""
    now = datetime.now(UTC)
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.add(
            ExternalIdentity(
                user_id=account.id,
                issuer=ISSUER,
                subject=f"sub-{account.id}",
                email="bob.smith@example.com",
                email_verified=True,
                created_at=now,
                last_login_at=now,
            )
        )
        db.add(RoleGrant(user_id=account.id, role="moderator", granted_at=now))
        user = db.get_one(User, account.id)
        user.avatar, user.locale = "moon", "fr"
        user.preferences = {"large_text": True, "reduced_motion": True}
        user.alliance, user.alliance_since = "ajani", now
        user.last_seen_at = now
        db.commit()


def until_ended(client: TestClient, game_id: str) -> None:
    for _ in range(200):
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            if db.scalar(select(Game.status).where(Game.id == uuid.UUID(game_id))) != "active":
                return
        time.sleep(0.02)
    raise AssertionError(f"game {game_id} never ended")


def test_deleting_an_account_keeps_its_games_and_removes_the_rest(client, monkeypatch):
    ada = Account(client, "ada", admin=True)
    bob, cara = Account(client, "bob"), Account(client, "cara")
    root = Account(client, "sysop", kind="sysop")
    private_details(client, bob)
    called: list[uuid.UUID] = []
    monkeypatch.setattr(accounts, "CLEANUPS", (lambda db, user_id: called.append(user_id),))

    # Bob's decks: one he played, one a bot played against him, one never played, with a
    # revision of its own, and one shared by link.
    played = deck(bob, client, title="Bob Smith's Burn")
    shared = bob.send(
        "PATCH", f"/api/v1/decks/{played}", {"notes": "Ring me on 555-0100", "visibility": "link"}
    ).json()["share_code"]
    botted = deck(bob, client, title="For the bot")
    unplayed = deck(bob, client, title="Unplayed")
    assert bob.send("POST", f"/api/v1/decks/{unplayed}/revisions").status_code == 201
    assert cara.get(f"/api/v1/shared-decks/{shared}").status_code == 200
    started = bob.send(
        "POST",
        "/api/v1/practice-games",
        {"format": "legacy", "deck_id": played, "bots": [{"deck_id": botted}]},
    )
    assert started.status_code == 201, started.text
    game_id = started.json()["id"]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.add(
            TokenEntry(
                user_id=bob.id,
                kind="grant",
                amount=70,
                key="grant:test",
                policy="tokens-v1",
                reason="test",
                actor_id=root.id,
                created_at=datetime.now(UTC),
            )
        )
        db.commit()
    ledgers = (rows(client, TokenEntry, TokenEntry.user_id == bob.id), rows(client, ProgressEntry))

    # While Bob plays, his account cannot be deleted; once the game ends, it can.
    path = f"/api/v1/admin/users/{bob.id}/delete"
    busy = ada.send("POST", path, {"reason": REASON})
    assert (busy.status_code, busy.json()["code"]) == (409, "account_in_game")
    assert bob.send("POST", f"/api/v1/games/{game_id}/close", {}).status_code == 200
    until_ended(client, game_id)
    trail = rows(client, AuditEvent, AuditEvent.target_user_id == bob.id)
    response = ada.send("POST", path, {"reason": REASON})
    assert response.status_code == 200, response.text
    gone = response.json()
    assert gone["status"] == "deleted" and gone["deleted_at"] is not None
    assert (gone["handle"], gone["display_name"], gone["email"]) == (None, "Deleted player", None)
    assert gone["roles"] == [] and gone["alliance"] is None and gone["tokens"] == 70
    assert called == [bob.id]

    # His sign-in and his sessions are gone: the cookie he holds opens nothing.
    assert bob.get("/api/v1/me").status_code == 401
    assert rows(client, UserSession, UserSession.user_id == bob.id) == 0
    assert rows(client, ExternalIdentity, ExternalIdentity.user_id == bob.id) == 0
    assert rows(client, RoleGrant, RoleGrant.user_id == bob.id) == 0
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        user = db.get_one(User, bob.id)
        assert (user.handle, user.normalized_handle, user.display_name) == (
            None,
            None,
            "Deleted player",
        )
        assert (user.avatar, user.locale, user.preferences) == ("sigil", "en", {})
        assert (user.alliance, user.alliance_since, user.last_seen_at) == (None, None, None)

        # The decks no game played are gone with their revisions and entries; the played ones
        # stay as their games played them, without their words.
        decks = {str(found.id): found for found in db.scalars(select(Deck))}
        assert set(decks) == {played, botted}
        for kept in decks.values():
            assert (kept.title, kept.notes, kept.visibility, kept.share_code) == (
                "Deleted deck",
                "",
                "private",
                None,
            )
            assert kept.draft == {"entries": []} and kept.deleted_at is not None
        revisions = list(db.scalars(select(DeckRevision)))
        assert len(revisions) == 2
        assert {(found.title, found.notes) for found in revisions} == {("Deleted deck", "")}
        seats = list(
            db.scalars(
                select(GameSeat)
                .where(GameSeat.game_id == uuid.UUID(game_id))
                .order_by(GameSeat.seat)
            )
        )
        assert {seat.deck_revision_id for seat in seats} == {found.id for found in revisions}
        assert [seat.deck for seat in seats] == ["Deleted deck", "Deleted deck"]
        assert seats[1].deck_list == {"cards": [{"name": "Mountain", "count": 60}]}
        assert {row.revision_id for row in db.scalars(select(DeckEntryRow))} == {
            found.id for found in revisions
        }
    assert cara.get(f"/api/v1/shared-decks/{shared}").status_code == 404

    # What other records count stays: the ledgers and the audit trail.
    assert (
        rows(client, TokenEntry, TokenEntry.user_id == bob.id),
        rows(client, ProgressEntry),
    ) == (ledgers)
    assert rows(client, AuditEvent, AuditEvent.target_user_id == bob.id) == trail + 1
    summary = root.get(f"/api/v1/games/{game_id}").json()["game"]
    assert [(seat["handle"], seat["deck"]) for seat in summary["seats"]] == [
        (None, "Deleted deck"),
        (None, "Deleted deck"),
    ]

    # Administration lists a deleted account only when asked for, and labels it.
    listed = ada.get("/api/v1/admin/users").json()["items"]
    assert str(bob.id) not in {found["id"] for found in listed}
    deleted = ada.get("/api/v1/admin/users", status="deleted").json()["items"]
    assert [(found["id"], found["display_name"]) for found in deleted] == [
        (str(bob.id), "Deleted player")
    ]
    entry = ada.get("/api/v1/admin/audit", action="admin.user_deleted").json()["items"][0]
    assert entry["actor"]["label"] == "ada"
    assert entry["target"] == {"id": str(bob.id), "label": f"Deleted player ({str(bob.id)[:8]})"}
    assert entry["details"] == {"from": "active", "reason": REASON}


def test_deleting_leaves_open_tables(client):
    ada = Account(client, "ada", admin=True)
    bob, cara, dave, eve = (Account(client, name) for name in ("bob", "cara", "dave", "eve"))
    hosted = bob.send("POST", "/api/v1/tables", {"deck_id": deck(bob, client)}).json()["code"]
    assert dave.send(
        "POST", f"/api/v1/tables/{hosted}/join", {"deck_id": deck(dave, client)}
    ).json()["players"][1]["taken"]
    joined = cara.send("POST", "/api/v1/tables", {"deck_id": deck(cara, client)}).json()["code"]
    eve.send("POST", f"/api/v1/tables/{joined}/join", {"deck_id": deck(eve, client)})
    for account in (bob, eve):
        deleted = ada.send("POST", f"/api/v1/admin/users/{account.id}/delete", {"reason": REASON})
        assert deleted.status_code == 200, deleted.text

    # The host's table closed for everyone; the guest's seat is free again.
    assert dave.get(f"/api/v1/tables/{hosted}").json()["status"] == "closed"
    still = cara.get(f"/api/v1/tables/{joined}").json()
    assert still["status"] == "open" and [player["taken"] for player in still["players"]] == [
        True,
        False,
    ]
    assert rows(client, TableSeat, TableSeat.user_id.in_((bob.id, eve.id))) == 0
    assert rows(client, Deck, Deck.owner_id.in_((bob.id, eve.id))) == 0
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        assert db.scalar(select(GameTable.closed_at).where(GameTable.code == hosted)) is not None


def test_who_may_delete_and_what_a_deleted_account_refuses(client):
    ada = Account(client, "ada", admin=True)
    mod, bob = Account(client, "mod"), Account(client, "bob")
    chief = Account(client, "chief", admin=True)
    root = Account(client, "sysop", kind="sysop")
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.add(RoleGrant(user_id=mod.id, role="moderator", granted_at=datetime.now(UTC)))
        db.commit()
    path = f"/api/v1/admin/users/{bob.id}/delete"
    body = {"reason": REASON}

    refused = mod.send("POST", path, body)
    assert (refused.status_code, refused.json()["code"]) == (403, "forbidden")
    refused = ada.send("POST", f"/api/v1/admin/users/{ada.id}/delete", body)
    assert (refused.status_code, refused.json()["code"]) == (409, "self_change")
    assert ada.send("POST", f"/api/v1/admin/users/{root.id}/delete", body).status_code == 404
    assert ada.send("POST", f"/api/v1/admin/users/{uuid.uuid4()}/delete", body).status_code == 404
    for wrong in ({}, {"reason": "no"}, {"reason": "x" * 201}):
        assert ada.send("POST", path, wrong).status_code == 422

    # Only SysOp deletes an administrator, even a disabled one: grants outlast a disable.
    root.send("POST", f"/api/v1/admin/users/{chief.id}/status", {"status": "disabled"})
    refused = ada.send("POST", f"/api/v1/admin/users/{chief.id}/delete", body)
    assert (refused.status_code, refused.json()["code"]) == (403, "forbidden")
    assert root.send("POST", f"/api/v1/admin/users/{chief.id}/delete", body).status_code == 200

    # A sign-in older than the window must be renewed first.
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(
            update(UserSession)
            .where(UserSession.user_id == ada.id)
            .values(authenticated_at=datetime.now(UTC) - timedelta(days=1))
        )
        db.commit()
    refused = ada.send("POST", path, body)
    assert (refused.status_code, refused.json()["code"]) == (401, "reauthentication_required")
    assert root.send("POST", path, body).status_code == 200

    # Nothing changes a deleted account afterwards.
    base = f"/api/v1/admin/users/{bob.id}"
    for method, route, payload in (
        ("POST", f"{base}/delete", body),
        ("POST", f"{base}/status", {"status": "active"}),
        ("PUT", f"{base}/roles/moderator", None),
        ("DELETE", f"{base}/roles/moderator", None),
        ("POST", f"{base}/sign-out", None),
        ("POST", f"{base}/wins", {"wins": 5, "reason": "test"}),
        ("POST", f"{base}/tokens", {"amount": 5, "reason": "test"}),
        ("POST", f"{base}/packs", {"product": str(uuid.uuid4()), "count": 1, "reason": "test"}),
    ):
        refused = root.send(method, route, payload)
        assert (refused.status_code, refused.json()["code"]) == (409, "account_deleted"), route
    # Its records can still be read.
    assert root.get(f"{base}/tokens").status_code == 200


def test_signing_in_again_after_deletion_makes_a_new_pending_account(
    database: str, certs: test_identity.Certs
) -> None:
    app = test_identity.build(database, certs, signup_policy="approval")
    set_sysop_password(database, PASSWORD)
    with TestClient(app, base_url="https://testserver"):
        test_identity.start(app)
        ada = browser(app)
        first = sign_in(ada).json()
        root = sysop(app)
        root.post(f"/api/v1/admin/users/{first['id']}/status", json={"status": "active"})
        assert ada.patch("/api/v1/me", json={"handle": "ada"}).status_code == 200
        deleted = root.post(f"/api/v1/admin/users/{first['id']}/delete", json={"reason": REASON})
        assert deleted.status_code == 200, deleted.text
        assert ada.get("/api/v1/me").status_code == 401

        # The same Google account is a stranger now: a new request, waiting for approval, and
        # the handle is free again.
        again = sign_in(browser(app)).json()
        assert again["id"] != first["id"] and again["status"] == "pending"
        assert (again["display_name"], again["email"]) == ("Ada", "ada@example.com")
        assert again["handle"] is None
        with Session(app.state.database) as db:
            assert (
                db.scalar(
                    select(func.count())
                    .select_from(ExternalIdentity)
                    .where(ExternalIdentity.user_id == uuid.UUID(first["id"]))
                )
                == 0
            )
            assert db.get_one(User, uuid.UUID(first["id"])).status == "deleted"


# The daily job.


def job_database(tmp_path: Path) -> Any:
    engine = create_engine(f"sqlite:///{tmp_path}/accounts.db")
    Base.metadata.create_all(engine)
    return engine


def account(db: Session, status: str, created: datetime, **fields: Any) -> uuid.UUID:
    user = User(display_name="Someone", status=status, created_at=created, **fields)
    db.add(user)
    db.flush()
    db.add(
        ExternalIdentity(
            user_id=user.id, issuer=ISSUER, subject=f"sub-{user.id}", email="someone@example.com"
        )
    )
    return user.id


def test_requests_never_approved_are_deleted_after_30_days(tmp_path: Path) -> None:
    engine = job_database(tmp_path)
    now = datetime(2026, 11, 30, 4, 0, tzinfo=UTC)
    old, young = now - timedelta(days=30), now - timedelta(days=29, hours=23)
    with Session(engine) as db:
        expired = {
            account(db, "pending", old, handle="Waiting", normalized_handle="waiting"),
            account(db, "denied", now - timedelta(days=90)),
        }
        kept = {
            account(db, "pending", young),
            account(db, "active", now - timedelta(days=90)),
            account(db, "disabled", now - timedelta(days=90)),
        }
        db.commit()

    assert accounts.remove_unapproved(engine, now) == 2
    with Session(engine) as db:
        statuses = dict(db.execute(select(User.id, User.status)).all())
        assert {statuses[user_id] for user_id in expired} == {"deleted"}
        assert "deleted" not in {statuses[user_id] for user_id in kept}
        assert set(db.scalars(select(ExternalIdentity.user_id))) == kept
        assert db.scalar(select(User.handle).where(User.normalized_handle == "waiting")) is None
        events = list(db.scalars(select(AuditEvent)))
        assert [(event.action, event.actor_id, event.target_user_id) for event in events] == [
            ("account.unapproved_deleted", None, None)
        ]
        assert events[0].details == {"count": 2, "after_days": 30}

    # A second run, or a later one, finds nothing new and records nothing.
    assert accounts.remove_unapproved(engine, now) == 0
    assert accounts.remove_unapproved(engine, now + timedelta(minutes=59)) == 0
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(AuditEvent)) == 1
    # A day later the young request is old enough too.
    assert accounts.remove_unapproved(engine, now + timedelta(days=1)) == 1
    engine.dispose()


def test_the_cleanup_runs_daily_in_the_worker(tmp_path: Path, monkeypatch) -> None:
    engine = job_database(tmp_path)
    now = datetime(2026, 11, 30, 15, 0, tzinfo=UTC)
    accounts.ensure_scheduled(engine, now)
    accounts.ensure_scheduled(engine, now)
    with Session(engine) as db:
        jobs = list(db.scalars(select(ScheduledJob).order_by(ScheduledJob.due_at)))
        assert [(job.kind, job.deduplication_key) for job in jobs] == [
            ("account_cleanup", "account_cleanup:2026-11-30"),
            ("account_cleanup", "account_cleanup:2026-12-01"),
        ]
        assert jobs[0].due_at.replace(tzinfo=UTC) == datetime(2026, 11, 30, 4, 0, tzinfo=UTC)
        db.execute(text("DELETE FROM scheduled_jobs"))
        stale = account(db, "pending", datetime.now(UTC) - timedelta(days=31))
        db.commit()

    # The worker queues today's run, claims it and settles it.
    monkeypatch.setattr(accounts, "CLEANUP_TIME", datetime.min.time())
    config = Settings(database_url=str(engine.url))
    with httpx.Client() as http:
        worker.work(engine, config, http)
    with Session(engine) as db:
        assert db.get_one(User, stale).status == "deleted"
        done = db.scalar(select(ScheduledJob).where(ScheduledJob.status == "completed"))
        assert done is not None and (done.kind, done.result_code) == ("account_cleanup", "deleted")
    engine.dispose()
