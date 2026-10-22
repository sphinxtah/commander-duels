"""SysOp resets an account to a new one's state (v0.4.5): what is cleared and what stays, the
setup wizard's steps working again afterwards (a handle, the two free starter decks, the shop's
decks each sold once more, packs whose cards are new again), and the route's permission and
refusals. The shop's test catalog, collation and starter decks are test_shop's."""

import os
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import test_progression
import test_shop
from alembic import command
from alembic.config import Config
from catalog_fixtures import bulk, engine_list, import_bulk
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, make_url, select, text, update
from sqlalchemy.orm import Session
from test_accounts import until_ended
from test_games import SERVICE_TOKEN, SYSOP_ADDRESS
from test_progression import Account, completed, finished
from test_shop import SET_FILES, buy, buy_deck, fixture_product, no_sale
from test_tables import deck

from api.config import Settings
from api.main import create_app
from api.models import Friendship, LibraryGrant, Pack, TokenEntry, User, UserSession
from catalog import boosters

url = test_progression.url
engine = test_progression.engine
content = test_shop.content
collated = test_shop.collated
TABLES = (
    "shop_weekly_sales",
    "pack_cards",
    "pack_openings",
    "packs",
    "table_seats",
    "game_tables",
    "game_seats",
    "games",
    "notifications",
    "friendships",
    "deck_entries",
    "deck_revisions",
    "decks",
    "library_grants",
    "token_ledger",
    "progress_ledger",
    "scheduled_jobs",
    "audit_events",
    "role_grants",
    "sessions",
    "users",
)
REASON = "Account reset by SysOp"


@pytest.fixture
def client(collated: str, content: Path, engine, tmp_path) -> Iterator[TestClient]:
    app = create_app(
        Settings(
            database_url=collated,
            content_dir=str(content),
            catalog_dir=str(tmp_path / "catalog"),
            sysop_networks="10.20.0.0/24",
            engine_service_token=SERVICE_TOKEN,
        )
    )
    app.state.engine_transport = httpx.MockTransport(engine)
    with TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS) as client:
        # Prices are the shelf's: this week's sale is kept empty (test_shop).
        with Session(app.state.database) as db:
            no_sale(db)
        yield client
        with Session(app.state.database) as db:
            for table in TABLES:
                db.execute(text(f"DELETE FROM {table}"))
            db.commit()


def give(root: Account, account: Account, tokens: int) -> None:
    given = root.send(
        "POST",
        f"/api/v1/admin/users/{account.id}/tokens",
        {"amount": tokens, "reason": "Testing the reset"},
    )
    assert given.status_code == 200, given.text


def reset(root: Account, account: Account) -> httpx.Response:
    return root.send("POST", f"/api/v1/admin/users/{account.id}/reset")


def library(account: Account) -> dict[str, Any]:
    return {item["card"]["name"]: item for item in account.get("/api/v1/library").json()["cards"]}


def count(client: TestClient, model: Any, *where: Any) -> int:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return db.scalar(select(func.count()).select_from(model).where(*where)) or 0


def test_a_reset_account_starts_again_as_a_new_one(client):
    root = Account(client, "sysop", kind="sysop")
    bob = Account(client, "bob", onboarding="starters")
    cara = Account(client, "cara")
    give(root, bob, 3_000)

    # Bob sets up his game: two free starter decks, a third bought in the shop, a pack opened,
    # two given and never opened, an alliance, wins counted and set, and decks of his own.
    chosen = bob.send(
        "POST", "/api/v1/me/starters", {"decks": ["starter_red_test", "starter_blue_test"]}
    )
    assert chosen.status_code == 201, chosen.text
    assert buy_deck(bob, "starter_karlach_test").status_code == 201
    product = fixture_product(client).id
    opened_before = bob.send("POST", f"/api/v1/shop/packs/{buy(bob, product).json()['pack']}/open")
    assert opened_before.status_code == 200
    gift = {"product": str(product), "count": 2, "reason": "Testing the reset"}
    assert root.send("POST", f"/api/v1/admin/users/{bob.id}/packs", gift).status_code == 201
    unopened = bob.get("/api/v1/shop").json()["inventory"][0]["next_pack"]
    roster = bob.get("/api/v1/planeswalkers").json()
    ally = next(item["id"] for item in roster if item["open"] and not item["custom"])
    assert bob.send("PUT", "/api/v1/me/alliance", {"planeswalker": ally}).status_code == 200
    finished(client, bob.id, completed(0))
    set_wins = {"wins": 15, "reason": "Testing the reset"}
    assert root.send("POST", f"/api/v1/admin/users/{bob.id}/wins", set_wins).status_code == 200
    shared = deck(bob, client, title="Shared burn")
    link = bob.send("PATCH", f"/api/v1/decks/{shared}", {"visibility": "link"}).json()
    assert cara.get(f"/api/v1/shared-decks/{link['share_code']}").status_code == 200
    archived = deck(bob, client, title="Archived burn")
    assert bob.send("POST", f"/api/v1/decks/{archived}/archive").status_code == 200
    # What stays: a friend, settings and privacy settings.
    assert bob.send("PUT", f"/api/v1/friends/{cara.id}").status_code == 200
    assert cara.send("PUT", f"/api/v1/friends/{bob.id}").status_code == 200
    settings = {"avatar": "moon", "preferences": {"large_text": True, "reduced_motion": True}}
    assert bob.send("PATCH", "/api/v1/me", settings).status_code == 200
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(update(User).where(User.id == bob.id).values(presence_visibility="everyone"))
        db.commit()
        # Every copy granted for good: three starter decks' and a pack's (not the alliance's).
        cards = db.scalar(
            select(func.sum(LibraryGrant.quantity)).where(LibraryGrant.user_id == bob.id)
        )
    before = bob.get("/api/v1/me/tokens").json()["balance"]
    grants, packs = count(client, LibraryGrant), count(client, Pack)
    assert cards and before != 1_000

    response = reset(root, bob)
    assert response.status_code == 200, response.text
    result = response.json()
    fresh = result["account"]
    assert (fresh["handle"], fresh["display_name"], fresh["status"]) == (None, "Bob", "active")
    assert (fresh["wins"], fresh["tier"], fresh["tokens"], fresh["alliance"]) == (
        0,
        "bronze",
        1_000,
        None,
    )
    assert {key: result[key] for key in ("decks", "cards", "packs", "wins", "tokens")} == {
        "decks": 5,
        "cards": cards,
        "packs": 2,
        "wins": 15,
        "tokens": before,
    }

    # Bob stays signed in, and his account is a new one's: the setup wizard's first step.
    me = bob.get("/api/v1/me").json()
    assert (me["handle"], me["onboarding"], me["alliance"]) == (None, "handle", None)
    assert me["avatar"] == "moon" and me["preferences"]["large_text"] is True
    assert bob.get("/api/v1/library").json() == {"unlimited": False, "alliance": None, "cards": []}
    progress = bob.get("/api/v1/me/progress").json()
    assert (progress["wins"], progress["counted_wins"], progress["set_wins"]) == (0, 1, -1)
    assert progress["tier"]["id"] == "bronze" and progress["alliance"] is None
    tokens = bob.get("/api/v1/me/tokens").json()
    assert tokens["balance"] == 1_000
    assert (tokens["entries"][0]["kind"], tokens["entries"][0]["reason"]) == ("grant", REASON)
    assert tokens["entries"][0]["amount"] == 1_000 - before
    shop = bob.get("/api/v1/shop").json()
    assert (shop["inventory"], shop["free_decks"]) == ([], True)
    assert [(item["owned"], item["price"]) for item in shop["decks"]] == [(False, None)] * 4
    assert bob.get("/api/v1/shop/openings").json() == []
    assert bob.get(f"/api/v1/shop/openings/{opened_before.json()['id']}").status_code == 404
    assert bob.send("POST", f"/api/v1/shop/packs/{unopened}/open").status_code == 404
    assert not any(item["chosen"] for item in bob.get("/api/v1/decks/starters").json())

    # His decks are in the trash, checked against the emptied library, and can be restored.
    assert bob.get("/api/v1/decks").json() == []
    trash = bob.get("/api/v1/decks", view="trash").json()
    assert len(trash) == 5 and all(item["visibility"] == "private" for item in trash)
    starters = [item for item in trash if item["source"] == "starter"]
    assert len(starters) == 3 and all(item["collection_locked"] for item in starters)
    assert cara.get(f"/api/v1/shared-decks/{link['share_code']}").status_code == 404
    assert bob.send("POST", f"/api/v1/decks/{archived}/restore").status_code == 200

    # The ledgers, grants and packs stay recorded; the friendship and the sessions stay too.
    assert (count(client, LibraryGrant), count(client, Pack)) == (grants, packs)
    assert count(client, Friendship, Friendship.status == "accepted") == 1
    assert [player["id"] for player in bob.get("/api/v1/friends").json()["friends"]] == [
        str(cara.id)
    ]
    assert count(client, UserSession, UserSession.user_id == bob.id) == 1
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        user = db.get_one(User, bob.id)
        assert (user.presence_visibility, user.normalized_handle, user.starter_decks) == (
            "everyone",
            None,
            None,
        )
        assert user.reset_at is not None
    entry = root.get("/api/v1/admin/audit", action="admin.user_reset").json()["items"][0]
    assert (entry["actor"]["label"], entry["target"]["id"]) == ("SysOp", str(bob.id))
    assert entry["details"] == {
        "wins": 15,
        "tokens": before,
        "cards": cards,
        "packs": 2,
        "decks": 5,
        "alliance": ally,
        "starters": ["starter_red_test", "starter_blue_test"],
    }

    # The setup wizard's steps work again: the same handle, the same two free starter decks.
    assert bob.send("PATCH", "/api/v1/me", {"handle": "bob"}).json()["onboarding"] == "starters"
    again = bob.send(
        "POST", "/api/v1/me/starters", {"decks": ["starter_red_test", "starter_blue_test"]}
    )
    assert again.status_code == 201, again.text
    assert bob.get("/api/v1/me").json()["onboarding"] == "complete"
    held = library(bob)
    kenrith = held["Kenrith, the Returned King"]
    assert (kenrith["copies"], kenrith["sources"]) == (1, ["starter"])
    assert "Karlach, Fury of Avernus" not in held
    # The shop sells the third deck once more, and a pack's cards are new again.
    shop = bob.get("/api/v1/shop").json()
    assert [(item["owned"], item["price"]) for item in shop["decks"]][:3] == [
        (True, 500),
        (True, 250),
        (False, 1_500),
    ]
    give(root, bob, 1_000)
    bought = buy_deck(bob, "starter_karlach_test")
    assert bought.status_code == 201, bought.text
    assert (bought.json()["repeated"], bought.json()["balance"]) == (False, 500)
    assert library(bob)["Karlach, Fury of Avernus"]["copies"] == 1
    pack = buy(bob, product).json()["pack"]
    pulled = bob.send("POST", f"/api/v1/shop/packs/{pack}/open").json()["cards"]
    assert any(card["new"] for card in pulled)
    assert len(bob.get("/api/v1/shop/openings").json()) == 1
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        keys = set(
            db.scalars(
                select(TokenEntry.key).where(
                    TokenEntry.user_id == bob.id, TokenEntry.key.startswith("deck:")
                )
            )
        )
        stamp = f"{user.reset_at.astimezone(UTC):%Y%m%dT%H%M%S%f}"
        assert keys == {
            f"deck:{bob.id}:starter_karlach_test",
            f"deck:{bob.id}:starter_karlach_test:{stamp}",
        }
        starters_granted = set(
            db.scalars(
                select(LibraryGrant.grant_key).where(LibraryGrant.grant_key.startswith("starter:"))
            )
        )
        assert f"starter:starter_red_test:{stamp}" in starters_granted
        assert "starter:starter_red_test" in starters_granted


def test_who_may_reset_and_when_it_is_refused(client):
    root = Account(client, "sysop", kind="sysop")
    ada = Account(client, "ada", admin=True)
    bob, dave = Account(client, "bob"), Account(client, "dave")
    deleted = Account(client, "gone")
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(update(User).where(User.id == deleted.id).values(status="deleted"))
        db.commit()

    # SysOp's alone: administrators, who delete accounts, may not reset one.
    refused = ada.send("POST", f"/api/v1/admin/users/{bob.id}/reset")
    assert (refused.status_code, refused.json()["code"]) == (403, "forbidden")
    assert "admin.users.reset" not in ada.get("/api/v1/me").json()["permissions"]
    assert "admin.users.reset" in root.get("/api/v1/me").json()["permissions"]
    assert reset(root, root).status_code == 404
    assert root.send("POST", f"/api/v1/admin/users/{uuid.uuid4()}/reset").status_code == 404
    refused = reset(root, deleted)
    assert (refused.status_code, refused.json()["code"]) == (409, "account_deleted")

    # Never while the account plays a game: SysOp may close it first.
    started = bob.send(
        "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck(bob, client)}
    )
    assert started.status_code == 201, started.text
    game_id = started.json()["id"]
    refused = reset(root, bob)
    assert (refused.status_code, refused.json()["code"]) == (409, "account_in_game")
    assert "close the game" in refused.json()["message"]
    assert root.send("POST", f"/api/v1/games/{game_id}/close", {}).status_code == 200
    until_ended(client, game_id)

    # Nor while it sits at an open table, its own or another's, until it leaves.
    table = dave.send("POST", "/api/v1/tables", {"deck_id": deck(dave, client)}).json()["code"]
    joined = bob.send("POST", f"/api/v1/tables/{table}/join", {"deck_id": deck(bob, client)})
    assert joined.status_code == 200, joined.text
    for seated in (bob, dave):
        refused = reset(root, seated)
        assert (refused.status_code, refused.json()["code"]) == (409, "account_at_table")
    assert bob.send("POST", f"/api/v1/tables/{table}/leave").status_code == 200
    assert reset(root, bob).status_code == 200

    # A second reset finds nothing to clear, and writes no ledger entry.
    entries = count(client, TokenEntry, TokenEntry.user_id == bob.id)
    again = reset(root, bob).json()
    assert {key: again[key] for key in ("decks", "cards", "packs", "wins", "tokens")} == {
        "decks": 0,
        "cards": 0,
        "packs": 0,
        "wins": 0,
        "tokens": 1_000,
    }
    assert count(client, TokenEntry, TokenEntry.user_id == bob.id) == entries

    # A sign-in older than the window must be renewed first, as for every account change.
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(
            update(UserSession)
            .where(UserSession.user_id == root.id)
            .values(authenticated_at=datetime.now(UTC) - timedelta(days=1))
        )
        db.commit()
    refused = reset(root, bob)
    assert (refused.status_code, refused.json()["code"]) == (401, "reauthentication_required")


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_a_reset_on_postgresql(monkeypatch, tmp_path, content):
    """The reset writes only new rows to the append-only ledgers, grants and packs, and the
    starter decks granted again have keys of their own."""
    base = os.environ["CD_TEST_POSTGRES_URL"]
    schema = f"test_{uuid.uuid4().hex}"
    admin = create_engine(base, connect_args={"connect_timeout": 3})
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    scoped = (
        make_url(base)
        .update_query_dict({"options": f"-csearch_path={schema}"})
        .render_as_string(hide_password=False)
    )
    monkeypatch.setenv("CD_DATABASE_URL", scoped)
    engine = create_engine(scoped, connect_args={"connect_timeout": 3})
    try:
        command.upgrade(Config("alembic.ini"), "head")
        import_bulk(engine, tmp_path / "files", bulk(), engine_list())
        assert boosters.load_local(engine, SET_FILES, str(content))["ready"] == 1
        app = create_app(
            Settings(database_url=scoped, content_dir=str(content), sysop_networks="10.20.0.0/24")
        )
        with TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS) as http:
            root = Account(http, "sysop", kind="sysop")
            ada = Account(http, "ada", onboarding="starters")
            give(root, ada, 2_000)
            pair = {"decks": ["starter_red_test", "starter_blue_test"]}
            assert ada.send("POST", "/api/v1/me/starters", pair).status_code == 201
            pack = buy(ada, fixture_product(http).id).json()["pack"]
            assert ada.send("POST", f"/api/v1/shop/packs/{pack}/open").status_code == 200
            response = reset(root, ada)
            assert response.status_code == 200, response.text
            assert response.json()["account"]["tokens"] == 1_000
            assert ada.get("/api/v1/library").json()["cards"] == []
            assert ada.send("PATCH", "/api/v1/me", {"handle": "ada"}).status_code == 200
            assert ada.send("POST", "/api/v1/me/starters", pair).status_code == 201
            assert library(ada)["Kenrith, the Returned King"]["copies"] == 1
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
