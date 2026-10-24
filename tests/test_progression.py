"""The Planeswalker Alliance (v0.3.1) through the API: two starter decks chosen at onboarding,
players' libraries and collection-locked decks, alliances, wins counted once from committed
results, levels, SysOp's settings of wins, the custom cards only Godlike accounts see, and the
migration that carries existing accounts over. Custom cards here are made-up stand-ins."""

import base64
import json
import secrets
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from alembic import command
from alembic.config import Config
from catalog_fixtures import bulk, engine_list, import_bulk
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session
from test_decks_api import ACCOUNT_TABLES, starter
from test_games import SERVICE_TOKEN, SYSOP_ADDRESS, FakeEngine

from api import games
from api.config import Settings
from api.identity import hash_token, utcnow
from api.main import create_app
from api.models import (
    AuditEvent,
    CardConcept,
    Game,
    GameSeat,
    LibraryGrant,
    ProgressEntry,
    RoleGrant,
    User,
    UserSession,
)
from api.progression import count_win, sysop_start
from api.roster import TIERS, Planeswalker, belongs, load, tier_of

CONTENT = Path(__file__).resolve().parent.parent / "content"
PNG = b"\x89PNG\r\n\x1a\n" + bytes(range(64))


class Account:
    def __init__(
        self,
        client: TestClient,
        handle: str,
        *,
        kind: str = "player",
        onboarding: str = "complete",
        admin: bool = False,
    ) -> None:
        now = utcnow()
        self.token = secrets.token_urlsafe(32)
        with Session(client.app.state.database, expire_on_commit=False) as db:  # type: ignore[attr-defined]
            user = User(
                handle=handle,
                normalized_handle=handle.casefold(),
                display_name=handle.title(),
                kind=kind,
                status="active",
                onboarding=onboarding,
                created_at=now,
            )
            db.add(user)
            db.flush()
            if admin:
                db.add(RoleGrant(user_id=user.id, role="administrator", granted_at=now))
            if kind == "sysop":
                sysop_start(db, user)
            session = UserSession(
                token_hash=hash_token(self.token),
                user_id=user.id,
                kind="sysop" if kind == "sysop" else "google",
                csrf_token=secrets.token_urlsafe(32),
                privilege_version=0,
                created_at=now,
                authenticated_at=now,
                last_seen_at=now,
                idle_expires_at=now + timedelta(days=1),
                absolute_expires_at=now + timedelta(days=1),
            )
            db.add(session)
            db.commit()
            self.id, self.csrf = user.id, session.csrf_token
        self.http = client

    def headers(self) -> dict[str, str]:
        return {"cookie": f"cd_session={self.token}", "x-csrf-token": self.csrf}

    def get(self, path: str, **params: Any) -> httpx.Response:
        return self.http.get(path, params=params, headers=self.headers())

    def send(self, method: str, path: str, body: object = None) -> httpx.Response:
        return self.http.request(method, path, json=body, headers=self.headers())


def grant_basics(client: TestClient, user_id: UUID, entries: list[dict[str, Any]]) -> None:
    """Grants the basic lands the entries hold (since v0.6.0 a library holds only the basic lands
    granted to it), each in its default printing, as a starter deck would."""
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        wanted: dict[UUID, int] = {}
        for item in entries:
            card = UUID(str(item["card_id"]))
            wanted[card] = wanted.get(card, 0) + int(item["quantity"])
        key = f"grandfathered:test:{uuid4()}"
        for concept in db.scalars(
            select(CardConcept).where(
                CardConcept.id.in_(wanted), CardConcept.type_line.startswith("Basic ")
            )
        ):
            assert concept.default_printing_id is not None
            db.add(
                LibraryGrant(
                    user_id=user_id,
                    concept_id=concept.id,
                    printing_id=concept.default_printing_id,
                    quantity=wanted[concept.id],
                    source="grandfathered",
                    grant_key=key,
                    created_at=utcnow(),
                )
            )
        db.commit()


@pytest.fixture(scope="module")
def url(tmp_path_factory) -> str:
    folder = tmp_path_factory.mktemp("progression")
    url = f"sqlite:///{folder}/progression.db"
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("CD_DATABASE_URL", url)
        command.upgrade(Config("alembic.ini"), "head")
    engine = create_engine(url)
    import_bulk(engine, folder / "files", bulk(), engine_list())
    engine.dispose()
    return url


@pytest.fixture(scope="module")
def content(tmp_path_factory) -> Path:
    folder = tmp_path_factory.mktemp("content")
    (folder / "planeswalkers.json").write_text(
        (CONTENT / "planeswalkers.json").read_text(encoding="utf-8"), encoding="utf-8"
    )
    decks = [
        starter(
            "starter_red_test",
            1,
            "Red Test",
            [
                (1, "Kenrith, the Returned King"),
                (1, "Lightning Bolt"),
                (1, "Sol Ring"),
                (97, "Mountain"),
            ],
        ),
        starter(
            "starter_blue_test",
            2,
            "Blue Test",
            [(1, "Thrasios, Triton Hero"), (1, "Counterspell"), (1, "Sol Ring"), (97, "Island")],
        ),
    ]
    (folder / "starter-decks.json").write_text(
        json.dumps({"version": 1, "source": "tests", "decks": decks}), encoding="utf-8"
    )
    return folder


@pytest.fixture
def engine() -> FakeEngine:
    return FakeEngine()


@pytest.fixture
def client(url: str, content: Path, engine: FakeEngine):
    app = create_app(
        Settings(
            database_url=url,
            content_dir=str(content),
            sysop_networks="10.20.0.0/24",
            engine_service_token=SERVICE_TOKEN,
            games_per_account=4,
        )
    )
    app.state.engine_transport = httpx.MockTransport(engine)
    with TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS) as client:
        yield client
        with Session(app.state.database) as db:
            db.execute(text("DELETE FROM custom_cards"))
            db.execute(text("DELETE FROM progress_ledger"))
            db.execute(text("DELETE FROM token_ledger"))
            db.execute(text("DELETE FROM game_seats"))
            db.execute(text("DELETE FROM games"))
            for table in ACCOUNT_TABLES:
                db.execute(text(f"DELETE FROM {table}"))
            db.commit()


def card_id(client: TestClient, name: str) -> str:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return str(
            db.scalar(select(CardConcept.id).where(CardConcept.name == name, CardConcept.deck_card))
        )


def entry(client: TestClient, name: str, quantity: int = 1, location: str = "main") -> dict:
    return {"card_id": card_id(client, name), "quantity": quantity, "location": location}


def actions(client: TestClient) -> list[tuple[str, dict[str, Any]]]:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return [(event.action, event.details) for event in db.scalars(select(AuditEvent))]


def finished(client: TestClient, user_id: UUID, result: dict[str, Any], seat: int = 0) -> UUID:
    """A game the account played at seat 0, recorded as the API records an engine's result."""
    game_id = uuid4()
    database = client.app.state.database  # type: ignore[attr-defined]
    with Session(database) as db:
        db.add(
            Game(
                id=game_id,
                format="legacy",
                status="active",
                created_by=user_id,
                created_at=utcnow(),
                bot_skill=4,
                turn_cap=60,
            )
        )
        db.flush()
        db.add(GameSeat(game_id=game_id, seat=0, player="human", user_id=user_id, deck="x"))
        db.add(GameSeat(game_id=game_id, seat=1, player="bot", deck="y"))
        db.commit()
    games.record_end(database, game_id, "finished", result)
    return game_id


def completed(winner: int | None) -> dict[str, Any]:
    return {
        "kind": "completed",
        "winner_seat": winner,
        "draw": False,
        "turns": 9,
        "conceded_seats": [],
    }


def test_onboarding_chooses_two_starter_decks(client):
    ada = Account(client, "ada", onboarding="starters")
    assert ada.get("/api/v1/me").json()["onboarding"] == "starters"
    same = ada.send(
        "POST", "/api/v1/me/starters", {"decks": ["starter_red_test", "starter_red_test"]}
    )
    assert (same.status_code, same.json()["code"]) == (422, "same_starter")
    unknown = ada.send("POST", "/api/v1/me/starters", {"decks": ["starter_red_test", "nope"]})
    assert unknown.status_code == 404
    chosen = ada.send(
        "POST", "/api/v1/me/starters", {"decks": ["starter_red_test", "starter_blue_test"]}
    )
    assert chosen.status_code == 201, chosen.text
    assert ada.get("/api/v1/me").json()["onboarding"] == "complete"
    decks = ada.get("/api/v1/decks").json()
    assert sorted(deck["title"] for deck in decks) == ["Blue Test", "Red Test"]
    assert all(deck["playable"] and deck["source"] == "starter" for deck in decks)
    again = ada.send(
        "POST", "/api/v1/me/starters", {"decks": ["starter_red_test", "starter_blue_test"]}
    )
    assert (again.status_code, again.json()["code"]) == (409, "starters_chosen")
    assert all(deck["chosen"] for deck in ada.get("/api/v1/decks/starters").json())

    # Every copy of both decks is in the library for good; since v0.6.0 the basic lands too.
    library = ada.get("/api/v1/library").json()
    copies = {item["card"]["name"]: item for item in library["cards"]}
    assert library["unlimited"] is False
    assert copies["Sol Ring"]["copies"] == 2 and copies["Sol Ring"]["sources"] == ["starter"]
    assert copies["Lightning Bolt"]["copies"] == 1
    assert copies["Mountain"]["copies"] == 97 and copies["Island"]["sources"] == ["starter"]
    assert ("library.starters_chosen", {"decks": ["starter_red_test", "starter_blue_test"]}) in (
        actions(client)
    )
    # A handle comes first.
    bea = Account(client, "bea", onboarding="handle")
    early = bea.send(
        "POST", "/api/v1/me/starters", {"decks": ["starter_red_test", "starter_blue_test"]}
    )
    assert early.json()["code"] == "handle_first"


def test_players_build_from_their_library(client, engine):
    ada = Account(client, "ada", onboarding="starters")
    ada.send("POST", "/api/v1/me/starters", {"decks": ["starter_red_test", "starter_blue_test"]})
    burn = [entry(client, "Lightning Bolt", 4), entry(client, "Mountain", 56)]
    deck = ada.send(
        "POST", "/api/v1/decks", {"title": "Burn", "format": "legacy", "entries": burn}
    ).json()
    assert deck["legal"] is True and deck["playable"] is False and deck["collection_locked"]
    (problem,) = deck["validation"]["errors"]
    assert (problem["code"], problem["kind"], problem["quantity"]) == (
        "collection.locked",
        "collection_locked",
        4,
    )
    assert "your library has 1 copy" in problem["message"]
    assert deck["cards"][card_id(client, "Lightning Bolt")]["owned"] == 1
    assert deck["cards"][card_id(client, "Mountain")]["owned"] == 97
    # A collection-locked deck is saved but cannot start a game.
    refused = ada.send(
        "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck["id"]}
    )
    assert (refused.status_code, refused.json()["code"]) == (422, "deck_not_playable")
    assert "library" in refused.json()["message"]
    fixed = [entry(client, "Lightning Bolt", 1), entry(client, "Mountain", 59)]
    saved = ada.send(
        "PUT", f"/api/v1/decks/{deck['id']}/draft", {"version": 1, "entries": fixed}
    ).json()
    assert saved["validation"]["playable"] is True
    listed = {item["id"]: item for item in ada.get("/api/v1/decks").json()}
    assert listed[deck["id"]]["collection_locked"] is False
    started = ada.send(
        "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck["id"]}
    )
    assert started.status_code == 201, started.text
    ada.send("POST", f"/api/v1/games/{started.json()['id']}/close", {})

    # Search keeps to the library on request, and every card says how many copies it holds.
    owned = ada.get("/api/v1/cards", owned="true", page_size=100).json()
    names = {item["name"] for item in owned["items"]}
    assert {"Sol Ring", "Lightning Bolt", "Mountain", "Island"} <= names
    assert "Black Lotus" not in names and "Grizzly Bears" not in names
    every = {item["name"]: item for item in ada.get("/api/v1/cards", page_size=100).json()["items"]}
    assert every["Grizzly Bears"]["owned"] == 0 and every["Sol Ring"]["owned"] == 2
    # The guided builder suggests only what the library holds.
    guided = ada.send(
        "POST", "/api/v1/decks/guided", {"format": "legacy", "colors": "R", "theme": "aggro"}
    ).json()
    for item in guided["entries"]:
        card = guided["cards"][item["card_id"]]
        assert card["owned"] is None or item["quantity"] <= card["owned"]

    # Administrators build from the whole catalog.
    root = Account(client, "admin", admin=True)
    assert root.get("/api/v1/library").json() == {"unlimited": True, "alliance": None, "cards": []}
    theirs = root.send(
        "POST", "/api/v1/decks", {"title": "Burn", "format": "legacy", "entries": burn}
    ).json()
    assert (
        theirs["playable"] is True
        and theirs["cards"][card_id(client, "Lightning Bolt")]["owned"] is None
    )


def test_alliances_open_by_tier_and_bring_their_cards(client):
    ada = Account(client, "ada")
    roster = {item["id"]: item for item in ada.get("/api/v1/planeswalkers").json()}
    assert len(roster) == 89
    assert roster["tibalt"]["open"] and roster["tibalt"]["cards"] == 1
    assert roster["teferi"]["open"] is False and roster["teferi"]["wins"] == 1_000
    assert roster["the-sphinx"]["custom"] and roster["the-sphinx"]["tier"] == "godlike"
    locked = ada.send("PUT", "/api/v1/me/alliance", {"planeswalker": "teferi"})
    assert (locked.status_code, locked.json()["code"]) == (403, "alliance_locked")
    assert ada.send("PUT", "/api/v1/me/alliance", {"planeswalker": "nobody"}).status_code == 404

    # Tibalt's only Planeswalker card in the test catalog is the back face of Valki, God of Lies.
    joined = ada.send("PUT", "/api/v1/me/alliance", {"planeswalker": "tibalt"}).json()
    assert joined["alliance"] == "tibalt" and joined["alliance_since"]
    assert ada.get("/api/v1/me").json()["alliance"] == "tibalt"
    library = {item["card"]["name"]: item for item in ada.get("/api/v1/library").json()["cards"]}
    valki = library["Valki, God of Lies // Tibalt, Cosmic Impostor"]
    assert valki["copies"] == 4 and valki["sources"] == ["alliance"]
    # An alliance's cards are never for sale (v0.6.0).
    assert valki["sellable"] == 0 and valki["finishes"]["nonfoil"] == 4
    grant_basics(client, ada.id, [entry(client, "Swamp", 56)])
    deck = ada.send(
        "POST",
        "/api/v1/decks",
        {
            "title": "Valki",
            "format": "legacy",
            "entries": [
                entry(client, "Valki, God of Lies // Tibalt, Cosmic Impostor", 4),
                entry(client, "Swamp", 56),
            ],
        },
    ).json()
    assert deck["playable"] is True
    # Leaving takes the cards away, and the deck's stored flags follow at once.
    left = ada.send("DELETE", "/api/v1/me/alliance").json()
    assert left["alliance"] is None
    listed = {item["id"]: item for item in ada.get("/api/v1/decks").json()}
    assert listed[deck["id"]]["playable"] is False and listed[deck["id"]]["legal"] is True
    assert listed[deck["id"]]["collection_locked"] is True
    done = [action for action, _ in actions(client)]
    assert "alliance.joined" in done and "alliance.left" in done


def test_the_alliance_tab_lists_the_allied_planeswalkers_cards(client):
    # v0.4.2: the Cards page's alliance tab follows the alliance, for SysOp as for players.
    ada, root = Account(client, "ada"), Account(client, "sysop", kind="sysop")
    none = {"alliance": None, "name": None, "custom": False, "cards": []}
    assert ada.get("/api/v1/me/alliance/cards").json() == none
    ada.send("PUT", "/api/v1/me/alliance", {"planeswalker": "tibalt"})
    tibalt = ada.get("/api/v1/me/alliance/cards").json()
    assert (tibalt["alliance"], tibalt["name"], tibalt["custom"]) == ("tibalt", "Tibalt", False)
    assert [(card["name"], card["owned"]) for card in tibalt["cards"]] == [
        ("Valki, God of Lies // Tibalt, Cosmic Impostor", 4)
    ]
    # Another alliance lists its own cards, and the library follows.
    root.send("POST", f"/api/v1/admin/users/{ada.id}/wins", {"wins": 1_000, "reason": "Platinum"})
    assert ada.send("PUT", "/api/v1/me/alliance", {"planeswalker": "teferi"}).status_code == 200
    teferi = ada.get("/api/v1/me/alliance/cards").json()
    assert [(card["name"], card["owned"]) for card in teferi["cards"]] == [
        ("Teferi, Temporal Archmage", 4)
    ]
    library = {item["card"]["name"] for item in ada.get("/api/v1/library").json()["cards"]}
    assert "Teferi, Temporal Archmage" in library
    assert "Valki, God of Lies // Tibalt, Cosmic Impostor" not in library
    # SysOp builds from the whole catalog: the tab shows the alliance's cards, without copies.
    root.send("PUT", "/api/v1/me/alliance", {"planeswalker": "tibalt"})
    theirs = root.get("/api/v1/me/alliance/cards").json()
    assert [(card["name"], card["owned"]) for card in theirs["cards"]] == [
        ("Valki, God of Lies // Tibalt, Cosmic Impostor", None)
    ]
    # The Godlike tier's Planeswalker has no catalog cards: its own are GET /custom-cards.
    root.send("PUT", "/api/v1/me/alliance", {"planeswalker": "the-sphinx"})
    sphinx = root.get("/api/v1/me/alliance/cards").json()
    assert (sphinx["custom"], sphinx["cards"]) == (True, [])


def test_the_picker_shows_any_planeswalkers_cards_before_an_alliance(client):
    # v0.6.2: the alliance picker shows what an alliance brings before it is chosen, locked ones
    # included, with the copies the library holds now. The custom cards stay private.
    ada = Account(client, "ada")
    tibalt = ada.get("/api/v1/planeswalkers/tibalt/cards").json()
    assert (tibalt["alliance"], tibalt["name"], tibalt["custom"]) == ("tibalt", "Tibalt", False)
    assert [(card["name"], card["owned"]) for card in tibalt["cards"]] == [
        ("Valki, God of Lies // Tibalt, Cosmic Impostor", 0)
    ]
    # Teferi is locked at Bronze, and still shows his cards; nothing changed on the account.
    teferi = ada.get("/api/v1/planeswalkers/teferi/cards").json()
    assert [card["name"] for card in teferi["cards"]] == ["Teferi, Temporal Archmage"]
    assert ada.get("/api/v1/me/progress").json()["alliance"] is None
    # Once allied, the same list says the playset.
    ada.send("PUT", "/api/v1/me/alliance", {"planeswalker": "tibalt"})
    allied = ada.get("/api/v1/planeswalkers/tibalt/cards").json()
    assert [card["owned"] for card in allied["cards"]] == [4]
    assert allied == ada.get("/api/v1/me/alliance/cards").json()
    # The Godlike tier's custom cards are never listed here, even to SysOp.
    root = Account(client, "sysop", kind="sysop")
    sphinx = root.get("/api/v1/planeswalkers/the-sphinx/cards").json()
    assert (sphinx["custom"], sphinx["cards"]) == (True, [])
    assert ada.get("/api/v1/planeswalkers/nobody/cards").status_code == 404


def test_copies_of_a_card_the_game_cannot_play_are_kept_but_hidden(client):
    """v0.4.5: a card out of the game (here suspended by the staff) leaves the library's list and
    the alliance tab. Its copies stay recorded, so they come back with the card. Since v0.6.2 a
    card the engine lacks stays, as a stand-in."""
    ada = Account(client, "ada", onboarding="starters")
    ada.send("POST", "/api/v1/me/starters", {"decks": ["starter_red_test", "starter_blue_test"]})
    ada.send("PUT", "/api/v1/me/alliance", {"planeswalker": "tibalt"})
    names = ("Lightning Bolt", "Valki, God of Lies // Tibalt, Cosmic Impostor")

    def mark(status: str, reason: str | None) -> None:
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            for concept in db.scalars(select(CardConcept).where(CardConcept.name.in_(names))):
                concept.status, concept.status_reason = status, reason
            db.commit()

    mark("unsupported", "not_implemented")
    try:
        shown = {
            item["card"]["name"]: item["card"]["stand_in"]
            for item in ada.get("/api/v1/library").json()["cards"]
        }
        assert shown["Lightning Bolt"] is True and shown["Sol Ring"] is False
        assert len(ada.get("/api/v1/me/alliance/cards").json()["cards"]) == 1
    finally:
        mark("certified", None)
    mark("suspended", "suspended_by_staff")
    try:
        library = {item["card"]["name"] for item in ada.get("/api/v1/library").json()["cards"]}
        assert "Sol Ring" in library and not library & set(names)
        assert ada.get("/api/v1/me/alliance/cards").json()["cards"] == []
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            granted = db.scalars(
                select(LibraryGrant.quantity)
                .join(CardConcept, CardConcept.id == LibraryGrant.concept_id)
                .where(LibraryGrant.user_id == ada.id, CardConcept.name == "Lightning Bolt")
            ).all()
            assert granted == [1]
    finally:
        mark("certified", None)
    library = {
        item["card"]["name"]: item["copies"] for item in ada.get("/api/v1/library").json()["cards"]
    }
    assert (library["Lightning Bolt"], library[names[1]]) == (1, 4)


def test_wins_count_once_and_raise_levels(client):
    ada = Account(client, "ada")
    progress = ada.get("/api/v1/me/progress").json()
    assert (progress["wins"], progress["tier"]["id"], progress["next_tier"]["wins"]) == (
        0,
        "bronze",
        10,
    )
    won = finished(client, ada.id, completed(0))
    finished(client, ada.id, completed(1))  # a bot won
    finished(client, ada.id, {**completed(None), "kind": "turn_limit"})
    finished(client, ada.id, {**completed(None), "draw": True})
    database = client.app.state.database
    # A replay of the end changes nothing: the game is no longer active, and its key is taken.
    games.record_end(database, won, "finished", completed(0))
    with Session(database) as db:
        count_win(db, db.get_one(Game, won))
        db.commit()
        entries = list(db.scalars(select(ProgressEntry).where(ProgressEntry.user_id == ada.id)))
    assert [(item.kind, item.wins, item.key, item.policy) for item in entries] == [
        ("game_win", 1, f"win:{won}:0", "wins-v1")
    ]
    progress = ada.get("/api/v1/me/progress").json()
    assert (progress["wins"], progress["counted_wins"], progress["set_wins"]) == (1, 1, 0)

    # SysOp sets wins, with a reason, audited and kept apart from counted wins.
    root = Account(client, "sysop", kind="sysop")
    assert root.get("/api/v1/me/progress").json()["tier"]["id"] == "godlike"
    refused = ada.send("POST", f"/api/v1/admin/users/{ada.id}/wins", {"wins": 50, "reason": "test"})
    assert refused.status_code == 403
    assert root.send("POST", f"/api/v1/admin/users/{ada.id}/wins", {"wins": 50}).status_code == 422
    changed = root.send(
        "POST", f"/api/v1/admin/users/{ada.id}/wins", {"wins": 150, "reason": "Testing Gold"}
    ).json()
    assert (changed["wins"], changed["counted_wins"], changed["set_wins"]) == (150, 1, 149)
    assert changed["tier"]["id"] == "gold" and changed["next_tier"]["id"] == "platinum"
    assert (
        "progress.wins_set",
        {"from": 1, "to": 150, "reason": "Testing Gold"},
    ) in actions(client)
    own = root.send(
        "POST", f"/api/v1/admin/users/{root.id}/wins", {"wins": 7, "reason": "Testing Bronze"}
    ).json()
    assert own["tier"]["id"] == "bronze"
    # Administrators see a player's wins, level and alliance.
    admin = Account(client, "admin", admin=True)
    row = next(
        item
        for item in admin.get("/api/v1/admin/users").json()["items"]
        if item["id"] == str(ada.id)
    )
    assert (row["wins"], row["tier"], row["alliance"]) == (150, "gold", None)
    assert (
        admin.send(
            "POST", f"/api/v1/admin/users/{ada.id}/wins", {"wins": 1, "reason": "no"}
        ).status_code
        == 403
    )


def test_tiers_and_roster():
    assert [tier_of(wins).id for wins in (0, 9, 10, 99, 100, 999, 1_000, 9_999, 10_000)] == [
        "bronze",
        "bronze",
        "silver",
        "silver",
        "gold",
        "gold",
        "platinum",
        "platinum",
        "mythic",
    ]
    assert tier_of(99_999).id == "mythic" and tier_of(100_000).id == "godlike"
    assert [tier.wins for tier in TIERS] == [0, 10, 100, 1_000, 10_000, 100_000]
    roster = load(str(CONTENT))
    tiers: dict[str, int] = {}
    for planeswalker in roster.values():
        tiers[planeswalker.tier] = tiers.get(planeswalker.tier, 0) + 1
    assert tiers == {
        "bronze": 32,
        "silver": 23,
        "gold": 21,
        "platinum": 10,
        "mythic": 2,
        "godlike": 1,
    }
    assert roster["jace"].tier == "mythic" and roster["the-sphinx"].custom
    wanderer = roster["the-wanderer"]
    # Luxior, whose subtype names an Equipment, left the roster in v0.4.2: none of its cards plays.
    luxior = Planeswalker("luxior", "Luxior", "bronze", "Luxior", None, None, None, False, False)
    assert "luxior" not in roster and "dungeon-master" not in roster
    assert belongs(wanderer, "The Wanderer", "Legendary Planeswalker")
    assert not belongs(wanderer, "Someone Else", "Legendary Planeswalker")
    assert belongs(luxior, "x", "Legendary Planeswalker — Equipment Luxior")
    assert not belongs(luxior, "x", "Legendary Artifact — Equipment")
    arlinn = roster["arlinn"]
    assert belongs(
        arlinn, "x", "Legendary Planeswalker — Arlinn // Legendary Planeswalker — Arlinn"
    )
    assert not belongs(roster["the-sphinx"], "x", "Legendary Planeswalker — Sphinx")
    stand_in = Planeswalker("x", "X", "bronze", "Kaya", None, None, None, True, False)
    assert not belongs(stand_in, "Kaya's Ghost", "Creature — Spirit")


def test_content_files_hold_only_what_players_may_see():
    decks = json.loads((CONTENT / "starter-decks.json").read_text(encoding="utf-8"))["decks"]
    assert len(decks) == 10 and len({deck["colors"] for deck in decks}) == 10
    for deck in decks:
        assert sum(card["quantity"] for card in deck["cards"]) == 100
        assert deck["cards"][0]["role"] == "Commander"
        assert deck["cards"][0]["name"] == deck["commander"]
        assert set(deck["cards"][0]) == {"quantity", "name", "role", "set", "collector_number"}
        # The workbook's private notes (reference prices, a deck's bonus card) stay out.
        assert set(deck) == {
            "id",
            "number",
            "title",
            "commander",
            "colors",
            "color_names",
            "guild",
            "description",
            "how_to_play",
            "teaches",
            "cards",
        }
    roster = json.loads((CONTENT / "planeswalkers.json").read_text(encoding="utf-8"))
    ids = [entry["id"] for entry in roster["planeswalkers"]]
    assert len(ids) == len(set(ids)) == 89
    portraits = Path(__file__).resolve().parent.parent / "web" / "public" / "portraits"
    for entry in roster["planeswalkers"]:
        if entry["portrait"]:
            for size in (128, 256, 512):
                assert (portraits / f"{entry['id']}-{size}.webp").is_file(), entry["id"]


def upload(account: Account, **changed: Any) -> httpx.Response:
    body = {
        "name": "Stand-in Sigil",
        "planeswalker": "the-sphinx",
        "mana_cost": "{2}{U}",
        "type_line": "Legendary Planeswalker — Sphinx",
        "oracle_text": "+1: Draw a card.",
        "loyalty": "3",
        "rarity": "mythic",
        "image": base64.b64encode(PNG).decode(),
        "image_type": "image/png",
        **changed,
    }
    return account.send("POST", "/api/v1/admin/custom-cards", body)


def test_custom_cards_are_seen_only_at_godlike(client):
    root = Account(client, "sysop", kind="sysop")
    ada = Account(client, "ada")
    assert upload(ada).status_code == 403
    assert upload(root, planeswalker="jace").json()["code"] == "invalid_planeswalker"
    assert upload(root, image="not base64!").json()["code"] == "invalid_image"
    assert upload(root, image_type="image/webp").json()["code"] == "invalid_image"
    huge = base64.b64encode(PNG + bytes(900_001)).decode()
    assert upload(root, image=huge).status_code == 422
    saved = upload(root)
    assert saved.status_code == 200, saved.text
    card = saved.json()
    assert card["playable"] is False and card["image_url"].startswith(
        f"/api/v1/custom-cards/{card['id']}/image"
    )
    replaced = upload(root, oracle_text="+1: Scry 1.").json()
    assert replaced["id"] == card["id"] and replaced["oracle_text"] == "+1: Scry 1."
    # The audit trail names the card by ID only.
    recorded = [details for action, details in actions(client) if action.startswith("admin.custom")]
    assert recorded == [
        {"card": card["id"], "replaced": False},
        {"card": card["id"], "replaced": True},
    ]
    assert "Stand-in" not in json.dumps(recorded)

    # Below Godlike it does not exist: not listed, no image, nowhere in the catalog.
    missing = ada.get("/api/v1/custom-cards")
    nothing = ada.get("/api/v1/nothing-here").json()
    assert missing.status_code == 404
    assert {**missing.json(), "request_id": ""} == {**nothing, "request_id": ""}
    assert ada.get(card["image_url"]).status_code == 404
    assert ada.get("/api/v1/cards", q="Stand-in").json()["total"] == 0
    assert root.get("/api/v1/cards", q="Stand-in").json()["total"] == 0
    assert ada.send("PUT", "/api/v1/me/alliance", {"planeswalker": "the-sphinx"}).status_code == 403

    # At Godlike it is listed only while allied with its Planeswalker (v0.4.2), which puts it in
    # the library; allied with another, or with none, the list is empty, SysOp's too.
    root.send("POST", f"/api/v1/admin/users/{ada.id}/wins", {"wins": 100_000, "reason": "Godlike"})
    assert ada.get("/api/v1/custom-cards").json() == []
    assert ada.send("PUT", "/api/v1/me/alliance", {"planeswalker": "tibalt"}).status_code == 200
    assert ada.get("/api/v1/custom-cards").json() == []
    assert root.get("/api/v1/custom-cards").json() == []
    # SysOp's upload list stays whole.
    assert [item["name"] for item in root.get("/api/v1/admin/custom-cards").json()] == [
        "Stand-in Sigil"
    ]
    assert ada.send("PUT", "/api/v1/me/alliance", {"planeswalker": "the-sphinx"}).status_code == 200
    listed = ada.get("/api/v1/custom-cards").json()
    assert [item["name"] for item in listed] == ["Stand-in Sigil"] and listed[0]["in_library"]
    assert (
        root.send("PUT", "/api/v1/me/alliance", {"planeswalker": "the-sphinx"}).status_code == 200
    )
    assert [item["name"] for item in root.get("/api/v1/custom-cards").json()] == ["Stand-in Sigil"]
    image = ada.get(card["image_url"])
    assert image.status_code == 200 and image.content == PNG
    assert image.headers["content-type"] == "image/png"
    assert image.headers["cache-control"] == "private, no-store"
    assert root.send("DELETE", f"/api/v1/admin/custom-cards/{card['id']}").status_code == 204
    assert ada.get("/api/v1/custom-cards").json() == []


def test_the_migration_carries_accounts_over(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path}/carry.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    config = Config("alembic.ini")
    command.upgrade(config, "0006_decks")
    engine = create_engine(url)
    import_bulk(engine, tmp_path / "files", bulk(), engine_list())
    now = utcnow()
    ada, sysop, game_won, game_lost = uuid4(), uuid4(), uuid4(), uuid4()
    with Session(engine) as db:
        bolt = db.scalar(select(CardConcept.id).where(CardConcept.name == "Lightning Bolt"))
        ring = db.scalar(select(CardConcept.id).where(CardConcept.name == "Sol Ring"))
        for user_id, kind, handle in ((ada, "player", "ada"), (sysop, "sysop", "sysop")):
            db.execute(
                text(
                    "INSERT INTO users (id, normalized_handle, handle, display_name, kind, "
                    "status, onboarding, avatar, locale, preferences, privilege_version, "
                    "created_at) VALUES (:id, :handle, :handle, :handle, :kind, 'active', "
                    "'complete', 'sigil', 'en', '{}', 0, :now)"
                ),
                {"id": user_id.hex, "handle": handle, "kind": kind, "now": now},
            )
        for game_id, winner in ((game_won, 0), (game_lost, 1)):
            db.execute(
                text(
                    "INSERT INTO games (id, kind, format, status, created_by, created_at, "
                    "bot_skill, turn_cap, result) VALUES (:id, 'practice', 'legacy', 'finished', "
                    ":owner, :now, 4, 60, :result)"
                ),
                {
                    "id": game_id.hex,
                    "owner": ada.hex,
                    "now": now,
                    "result": json.dumps(completed(winner)),
                },
            )
            db.execute(
                text(
                    "INSERT INTO game_seats (id, game_id, seat, player, user_id, deck) VALUES "
                    "(:id, :game, 0, 'human', :owner, 'x')"
                ),
                {"id": uuid4().hex, "game": game_id.hex, "owner": ada.hex},
            )

        def deck(entries: list[dict[str, Any]]) -> None:
            db.execute(
                text(
                    "INSERT INTO decks (id, owner_id, title, format, visibility, notes, draft, "
                    "draft_version, draft_hash, card_count, legal, playable, identity, source, "
                    "created_at, updated_at) VALUES (:id, :owner, 'd', 'legacy', 'private', '', "
                    ":draft, 1, '', 60, 1, 1, '', 'empty', :now, :now)"
                ),
                {
                    "id": uuid4().hex,
                    "owner": ada.hex,
                    "draft": json.dumps({"entries": entries}),
                    "now": now,
                },
            )

        deck(
            [
                {"card_id": str(bolt), "quantity": 3, "location": "main"},
                {"card_id": str(bolt), "quantity": 1, "location": "sideboard"},
                {"card_id": str(ring), "quantity": 4, "location": "maybeboard"},
            ]
        )
        deck([{"card_id": str(bolt), "quantity": 2, "location": "main"}])
        db.commit()
    command.upgrade(config, "head")
    with Session(engine) as db:
        wins = {
            (row.user_id, row.kind, row.wins, row.key) for row in db.scalars(select(ProgressEntry))
        }
        assert wins == {
            (ada, "game_win", 1, f"win:{game_won}:0"),
            (sysop, "wins_set", 100_000, "set:sysop-start"),
        }
        grants = {
            (row.concept_id, row.quantity, row.source) for row in db.scalars(select(LibraryGrant))
        }
        # The most any one deck holds, outside the maybeboard.
        assert grants == {(bolt, 4, "grandfathered")}
        onboarding = dict(db.execute(select(User.handle, User.onboarding)).all())
        assert onboarding == {"ada": "starters", "sysop": "complete"}
    command.downgrade(config, "0006_decks")
    engine.dispose()
