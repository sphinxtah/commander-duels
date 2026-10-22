"""Cards and decks through the API: search, the deck lifecycle, drafts and revisions, sharing,
import and export, starter decks, and that no deck reaches another account (T29's deck case).

Accounts that test deck mechanics are administrators, who build from the whole catalog; players'
libraries are tested in test_progression.py."""

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

from api.cards import artist_of, image_of
from api.config import Settings
from api.identity import hash_token, utcnow
from api.main import create_app
from api.models import CardConcept, CardPrinting, Deck, RoleGrant, User, UserSession

# Tables a test empties after itself, children first; the catalog stays.
ACCOUNT_TABLES = (
    "token_ledger",
    "site_settings",
    "library_grants",
    "progress_ledger",
    "deck_entries",
    "deck_revisions",
    "decks",
    "audit_events",
    "role_grants",
    "sessions",
    "users",
)
CONTENT = Path(__file__).resolve().parent.parent / "content"


class Account:
    def __init__(
        self, client: TestClient, handle: str, status: str = "active", admin: bool = False
    ) -> None:
        now = utcnow()
        self.token = secrets.token_urlsafe(32)
        with Session(client.app.state.database, expire_on_commit=False) as db:  # type: ignore[attr-defined]
            user = User(
                handle=handle,
                normalized_handle=handle.casefold(),
                display_name=handle.title(),
                kind="player",
                status=status,
                onboarding="complete",
                created_at=now,
            )
            db.add(user)
            db.flush()
            if admin:
                db.add(RoleGrant(user_id=user.id, role="administrator", granted_at=now))
            session = UserSession(
                token_hash=hash_token(self.token),
                user_id=user.id,
                kind="google",
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

    def send(self, method: str, path: str, body: object = None, **params: Any) -> httpx.Response:
        return self.http.request(method, path, json=body, params=params, headers=self.headers())


def starter(ident: str, number: int, title: str, cards: list[tuple[int, str]]) -> dict:
    return {
        "id": ident,
        "number": number,
        "title": title,
        "commander": cards[0][1],
        "colors": "R",
        "color_names": "Red",
        "guild": "Test",
        "description": f"{title}, from the test catalog.",
        "how_to_play": "Play it.",
        "teaches": "Testing.",
        "cards": [
            {
                "quantity": quantity,
                "name": name,
                "role": "Test",
                "set": "tst",
                "collector_number": "1",
            }
            for quantity, name in cards
        ],
    }


@pytest.fixture(scope="module")
def starters(tmp_path_factory) -> Path:
    """The roster, and two starter decks from the fixture catalog's cards, sharing Sol Ring."""
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
                (1, "Hill Giant"),
                (96, "Mountain"),
            ],
        ),
        starter(
            "starter_blue_test",
            2,
            "Blue Test",
            [
                (1, "Thrasios, Triton Hero"),
                (1, "Counterspell"),
                (1, "Brainstorm"),
                (1, "Sol Ring"),
                (1, "Llanowar Elves"),
                (95, "Island"),
            ],
        ),
    ]
    (folder / "starter-decks.json").write_text(
        json.dumps({"version": 1, "source": "tests", "decks": decks}), encoding="utf-8"
    )
    return folder


@pytest.fixture(scope="module")
def url(tmp_path_factory) -> str:
    folder = tmp_path_factory.mktemp("decks")
    url = f"sqlite:///{folder}/decks.db"
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("CD_DATABASE_URL", url)
        command.upgrade(Config("alembic.ini"), "head")
    engine = create_engine(url)
    import_bulk(engine, folder / "files", bulk(), engine_list())
    engine.dispose()
    return url


@pytest.fixture
def client(url: str, starters: Path):
    app = create_app(Settings(database_url=url, content_dir=str(starters)))
    with TestClient(app, base_url="https://testserver") as client:
        yield client
        with Session(app.state.database) as db:
            # Each test starts without decks or accounts; the catalog stays.
            for table in ACCOUNT_TABLES:
                db.execute(text(f"DELETE FROM {table}"))
            db.commit()


def card_id(client: TestClient, name: str) -> str:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return str(db.scalar(select(CardConcept.id).where(CardConcept.name == name)))


def entry(
    client: TestClient, name: str, quantity: int = 1, location: str = "main"
) -> dict[str, object]:
    return {"card_id": card_id(client, name), "quantity": quantity, "location": location}


def burn(client: TestClient) -> list[dict[str, object]]:
    return [entry(client, "Lightning Bolt", 4), entry(client, "Mountain", 56)]


def test_card_search_and_details(client):
    ada = Account(client, "ada")
    found = ada.get("/api/v1/cards", q="t:legendary is:commander id:r").json()
    names = [item["name"] for item in found["items"]]
    assert "Karlach, Fury of Avernus" in names and "Kenrith, the Returned King" not in names
    assert found["total"] == len(names) and found["milliseconds"] >= 0
    bolt = ada.get("/api/v1/cards", q='!"lightning bolt"').json()["items"][0]
    assert (bolt["status"], bolt["playable"], bolt["legalities"]) == (
        "certified",
        True,
        {"legacy": "legal", "commander": "legal"},
    )
    assert bolt["image"]["printing_id"]
    # The card dialog credits the artist of the image it shows; a double-faced card's comes
    # from its printing (Scryfall's own, which joins the faces' artists when they differ).
    assert bolt["image"]["artist"]
    delver = next(
        item
        for item in ada.get("/api/v1/cards", q="delver").json()["items"]
        if item["name"].startswith("Delver of Secrets")
    )
    assert delver["image"]["faces"] == 2 and delver["image"]["artist"]
    unsupported = ada.get("/api/v1/cards", q="status:unsupported", extras="true").json()
    assert {"Goblin", "Temple of Khonshu"} <= {item["name"] for item in unsupported["items"]}
    # Tokens and other objects no deck holds are left out unless asked for.
    assert "Goblin" not in {i["name"] for i in ada.get("/api/v1/cards", q="goblin").json()["items"]}
    filtered = ada.get("/api/v1/cards", colors="u", colors_mode="exact", mv_max=2).json()
    assert {item["name"] for item in filtered["items"]} >= {"Counterspell", "Brainstorm"}
    assert ada.get("/api/v1/cards", q="mv:even c:u").json()["total"] >= 1
    tagged = ada.get("/api/v1/cards", q="otag:removal").json()
    assert "Swords to Plowshares" in {item["name"] for item in tagged["items"]}
    refused = ada.get("/api/v1/cards", q="pow>3")
    assert refused.status_code == 422 and refused.json()["code"] == "invalid_search"
    assert "Supported:" in refused.json()["message"]
    assert ada.get("/api/v1/cards", q="(t:elf").json()["code"] == "invalid_search"
    detail = ada.get(f"/api/v1/cards/{card_id(client, 'Lurrus of the Dream-Den')}").json()
    assert detail["rulings"] and detail["printings"] and detail["companion"] is True
    assert detail["all_legalities"]["legacy"] == "banned"
    page = ada.get("/api/v1/cards", page_size=5, sort="mana_value", descending="true").json()
    assert (
        len(page["items"]) == 5
        and page["items"][0]["mana_value"] >= page["items"][-1]["mana_value"]
    )
    assert ada.get("/api/v1/sets").json()
    status = ada.get("/api/v1/catalog").json()
    assert status["revision"]["id"] == 1 and status["playable"] > 0
    assert status["format_versions"] == {"legacy": 1, "commander": 1}
    coverage = ada.get("/api/v1/catalog/coverage").json()
    assert any(row["status"] == "certified" for row in coverage["formats"]["commander"])
    # The image's artist is its own printing's credit, as the printings list gives it.
    bolt_detail = ada.get(f"/api/v1/cards/{bolt['id']}").json()
    shown = next(p for p in bolt_detail["printings"] if p["id"] == bolt["image"]["printing_id"])
    assert bolt["image"]["artist"] == shown["artist"]
    # Signed out, or waiting for approval: no cards.
    assert client.get("/api/v1/cards").status_code == 401
    assert Account(client, "pending", status="pending").get("/api/v1/cards").status_code == 403


def test_a_chosen_printing_is_listed_with_its_artist(client, monkeypatch):
    """A deck entry may pin a printing older than the ones a card's details list first; asked for
    by name, it is listed too, so the card dialog can show and credit it."""
    ada = Account(client, "chooser")
    bolt = card_id(client, "Lightning Bolt")
    every = ada.get(f"/api/v1/cards/{bolt}/printings").json()
    assert len(every) > 1
    oldest = every[-1]
    monkeypatch.setattr("api.cards.MAX_PRINTINGS", 1)
    first = ada.get(f"/api/v1/cards/{bolt}").json()["printings"]
    assert [p["id"] for p in first] == [every[0]["id"]]
    pinned = ada.get(f"/api/v1/cards/{bolt}", printing=oldest["id"]).json()["printings"]
    assert [p["id"] for p in pinned] == [every[0]["id"], oldest["id"]]
    assert pinned[-1]["artist"] == oldest["artist"]
    # A printing already listed is not listed twice; another card's printing, or none at all,
    # adds nothing; an id that is not one is refused.
    again = ada.get(f"/api/v1/cards/{bolt}", printing=every[0]["id"]).json()["printings"]
    assert [p["id"] for p in again] == [every[0]["id"]]
    other = ada.get(f"/api/v1/cards/{card_id(client, 'Counterspell')}/printings").json()[0]
    for stranger in (other["id"], str(uuid4())):
        listed = ada.get(f"/api/v1/cards/{bolt}", printing=stranger).json()["printings"]
        assert [p["id"] for p in listed] == [every[0]["id"]]
    assert ada.get(f"/api/v1/cards/{bolt}", printing="not-a-uuid").status_code == 422


def test_artists_of_printings():
    """Scryfall's own credit comes first (it joins the faces' artists when they differ); a
    printing without one is credited to its front face's artist."""
    joined = CardPrinting(id=uuid4(), artist="A & B", image_uris={"normal": "x"}, faces=[])
    assert artist_of(joined) == "A & B" and image_of(joined).artist == "A & B"
    faced = CardPrinting(
        id=uuid4(),
        artist=None,
        image_uris=None,
        faces=[
            {"artist": "Front", "image_uris": {"normal": "x"}},
            {"artist": "Back", "image_uris": {"normal": "y"}},
        ],
    )
    reference = image_of(faced)
    assert artist_of(faced) == "Front"
    assert reference is not None and (reference.faces, reference.artist) == (2, "Front")
    assert artist_of(CardPrinting(id=uuid4(), artist=None, faces=[{"artist": ""}])) is None


def test_deck_lifecycle_drafts_and_revisions(client):
    ada = Account(client, "ada", admin=True)
    created = ada.send("POST", "/api/v1/decks", {"title": "Burn", "format": "legacy"})
    assert created.status_code == 201
    deck = created.json()
    assert deck["draft"]["version"] == 1 and deck["legal"] is False
    assert deck["validation"]["errors"][0]["code"] == "legacy.min_main"
    path = f"/api/v1/decks/{deck['id']}"
    saved = ada.send("PUT", f"{path}/draft", {"version": 1, "entries": burn(client)}).json()
    assert saved["version"] == 2 and saved["validation"]["playable"] is True
    # A save from a stale tab is refused, and nothing is lost.
    stale = ada.send("PUT", f"{path}/draft", {"version": 1, "entries": []})
    assert stale.status_code == 409 and stale.json()["code"] == "draft_conflict"
    assert ada.get(path).json()["card_count"] == 60
    first = ada.send("POST", f"{path}/revisions").json()
    assert first["number"] == 1 and first["playable"] is True
    assert ada.send("POST", f"{path}/revisions").json()["number"] == 1
    smaller = [entry(client, "Lightning Bolt", 3), entry(client, "Mountain", 57)]
    assert ada.send("PUT", f"{path}/draft", {"version": 2, "entries": smaller}).status_code == 200
    assert ada.send("POST", f"{path}/revisions").json()["number"] == 2
    kept = ada.get(f"{path}/revisions/1").json()
    bolts = [e for e in kept["entries"] if e["card_id"] == card_id(client, "Lightning Bolt")]
    assert bolts[0]["quantity"] == 4
    renamed = ada.send("PATCH", path, {"title": "Red Deck Wins", "notes": "sideboard plan"}).json()
    assert (renamed["title"], renamed["notes"]) == ("Red Deck Wins", "sideboard plan")
    assert ada.send("POST", f"{path}/archive").json()["archived"] is True
    assert ada.get("/api/v1/decks").json() == []
    # A pair of commanders leaves 98 cards beside them.
    pair = ada.send(
        "POST",
        "/api/v1/decks/guided",
        {
            "format": "commander",
            "commander_id": card_id(client, "Thrasios, Triton Hero"),
            "partner_id": card_id(client, "Tymna the Weaver"),
        },
    ).json()
    assert sum(item["quantity"] for item in pair["entries"]) == 100
    assert pair["validation"]["errors"] == []
    assert [d["title"] for d in ada.get("/api/v1/decks", view="archived").json()] == [
        "Red Deck Wins"
    ]
    ada.send("POST", f"{path}/unarchive")
    copy = ada.send(
        "POST",
        "/api/v1/decks",
        {
            "title": "Burn II",
            "format": "legacy",
            "source": {"kind": "duplicate", "deck_id": deck["id"]},
        },
    ).json()
    assert copy["card_count"] == 60 and copy["notes"] == "sideboard plan"
    assert ada.send("DELETE", path).json()["deleted_at"] is not None
    assert ada.get(path).status_code == 404
    assert [d["title"] for d in ada.get("/api/v1/decks", view="trash").json()] == ["Red Deck Wins"]
    assert ada.send("POST", f"{path}/restore").json()["deleted_at"] is None
    assert len(ada.get("/api/v1/decks").json()) == 2


def test_decks_keep_the_table_options_they_need(client):
    """A banned card, or one not legal in the format, makes a deck legal for casual tables only
    (v0.4.5). Each deck keeps the options it needs; one validated before is validated again when
    its owner's list is read."""
    ada = Account(client, "ada", admin=True)
    lotus = ada.send(
        "POST",
        "/api/v1/decks",
        {
            "title": "Lotus",
            "format": "legacy",
            "entries": [entry(client, "Black Lotus"), entry(client, "Mountain", 59)],
        },
    ).json()
    assert (lotus["legal"], lotus["playable"], lotus["needs"]) == (True, True, ["banned"])
    assert lotus["validation"]["needs"] == ["banned"]
    assert [p["code"] for p in lotus["validation"]["warnings"]] == ["card.banned"]
    path = f"/api/v1/decks/{lotus['id']}"
    saved = ada.send("PUT", f"{path}/draft", {"version": 1, "entries": burn(client)}).json()
    assert saved["validation"]["needs"] == []
    assert ada.get("/api/v1/decks").json()[0]["needs"] == []
    # As 0019_table_rules leaves a deck validated by v0.4.4, which called the lotus illegal.
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(
            text(
                "UPDATE decks SET draft = :draft, needs = NULL, legal = :no, playable = :no "
                "WHERE id = :id"
            ),
            {
                "draft": json.dumps({"entries": lotus["draft"]["entries"]}),
                "no": False,
                "id": UUID(lotus["id"]).hex,
            },
        )
        db.commit()
    listed = ada.get("/api/v1/decks").json()
    assert [(d["legal"], d["playable"], d["needs"]) for d in listed] == [(True, True, ["banned"])]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        assert db.scalar(select(Deck.needs)) == ["banned"]


def test_revisions_cannot_be_changed_in_postgresql_or_by_the_api(client):
    ada = Account(client, "ada")
    deck = ada.send(
        "POST", "/api/v1/decks", {"title": "Burn", "format": "legacy", "entries": burn(client)}
    ).json()
    ada.send("POST", f"/api/v1/decks/{deck['id']}/revisions")
    for method in ("PUT", "PATCH", "DELETE"):
        assert ada.send(method, f"/api/v1/decks/{deck['id']}/revisions/1", {}).status_code == 405


def test_t29_no_deck_reaches_another_account(client):
    ada, bob = Account(client, "ada"), Account(client, "bob")
    deck = ada.send(
        "POST",
        "/api/v1/decks",
        {
            "title": "Secret tech",
            "format": "legacy",
            "entries": burn(client),
            "notes": "private plan",
        },
    ).json()
    path = f"/api/v1/decks/{deck['id']}"
    ada.send("POST", f"{path}/revisions")
    missing = bob.get(f"/api/v1/decks/{'0' * 8}-0000-4000-8000-{'0' * 12}")
    for response in (
        bob.get(path),
        bob.get(f"{path}/revisions/1"),
        bob.get(f"{path}/export", kind="json"),
        bob.send("PUT", f"{path}/draft", {"version": 1, "entries": []}),
        bob.send("PATCH", path, {"visibility": "link"}),
        bob.send("POST", f"{path}/revisions"),
        bob.send("POST", f"{path}/archive"),
        bob.send("DELETE", path),
        bob.send(
            "POST",
            "/api/v1/decks",
            {
                "title": "x",
                "format": "legacy",
                "source": {"kind": "duplicate", "deck_id": deck["id"]},
            },
        ),
    ):
        assert (response.status_code, response.json()) == (
            404,
            {**missing.json(), "request_id": response.json()["request_id"]},
        )
    assert bob.get("/api/v1/decks").json() == []
    # Shared by link: bob sees the cards, never the notes, and may copy it.
    shared = ada.send("PATCH", path, {"visibility": "link"}).json()
    code = shared["share_code"]
    view = bob.get(f"/api/v1/shared-decks/{code}").json()
    assert view["title"] == "Secret tech" and view["owner"] == "ada"
    assert "notes" not in view and "private plan" not in json.dumps(view)
    exported = bob.get(f"/api/v1/shared-decks/{code}/export", kind="json").json()
    assert "notes" not in exported
    copied = bob.send("POST", f"/api/v1/shared-decks/{code}/copy").json()
    assert copied["notes"] == "" and copied["card_count"] == 60
    # Turning sharing off and on again ends the old link.
    ada.send("PATCH", path, {"visibility": "private"})
    assert bob.get(f"/api/v1/shared-decks/{code}").status_code == 404
    again = ada.send("PATCH", path, {"visibility": "link"}).json()["share_code"]
    assert again != code and bob.get(f"/api/v1/shared-decks/{again}").status_code == 200
    ada.send("DELETE", path)
    assert bob.get(f"/api/v1/shared-decks/{again}").status_code == 404
    assert client.get(f"/api/v1/shared-decks/{again}").status_code == 401


def test_import_preview_resolves_names_and_round_trips(client):
    ada = Account(client, "ada")
    text = "\n".join(
        [
            "// Izzet tricks",
            "Deck",
            "4x Lightning Bolt (M10) 146",
            "4 Counterspell",
            "2 fire/ice",
            "1 LIM-DUL'S VAULT",
            "1 Everythingamajig",
            "1 Lightnin Bolt",
            "48 Island",
            "",
            "Sideboard",
            "SB: 3 Brainstorm",
            "Tokens",
            "1 Goblin",
        ]
    )
    preview = ada.send(
        "POST", "/api/v1/decks/import/preview", {"format": "legacy", "text": text}
    ).json()
    assert preview["title"] == "Izzet tricks"
    statuses = {line["text"]: line["status"] for line in preview["lines"]}
    assert statuses["2 fire/ice"] == "resolved"
    assert statuses["1 LIM-DUL'S VAULT"] == "resolved"
    assert statuses["1 Everythingamajig"] == "ambiguous"
    assert statuses["1 Lightnin Bolt"] == "unresolved"
    unresolved = next(line for line in preview["lines"] if line["status"] == "unresolved")
    assert "Lightning Bolt" in [card["name"] for card in unresolved["candidates"]]
    assert (preview["ambiguous"], preview["unresolved"]) == (1, 1)
    assert "Goblin" not in json.dumps(preview["lines"])
    sideboard = next(line for line in preview["lines"] if "Brainstorm" in line["text"])
    assert sideboard["location"] == "sideboard"
    bolt = next(line for line in preview["lines"] if "Lightning Bolt (M10)" in line["text"])
    with Session(client.app.state.database) as db:
        printing = db.get(CardPrinting, bolt["printing_id"]) if bolt["printing_id"] else None
    assert printing is None or printing.set_code == "m10"
    # Commit the resolved entries as a new deck, export it, and read the export back.
    deck = ada.send(
        "POST",
        "/api/v1/decks",
        {
            "title": "Izzet",
            "format": "legacy",
            "entries": preview["entries"],
            "source": {"kind": "imported"},
        },
    ).json()
    exported = ada.get(f"/api/v1/decks/{deck['id']}/export", kind="json")
    assert exported.headers["content-disposition"].endswith('.json"')
    again = ada.send(
        "POST", "/api/v1/decks/import/preview", {"format": "legacy", "json_text": exported.text}
    ).json()
    assert sorted(again["entries"], key=json.dumps) == sorted(
        deck["draft"]["entries"], key=json.dumps
    )
    as_text = ada.get(f"/api/v1/decks/{deck['id']}/export").text
    assert as_text.startswith("// Izzet\n") and "\nSideboard\n3 Brainstorm\n" in as_text
    back = ada.send(
        "POST", "/api/v1/decks/import/preview", {"format": "legacy", "text": as_text}
    ).json()
    assert back["unresolved"] == 0 and back["ambiguous"] == 0
    # Limits: size, lines, counts.
    huge = ada.send(
        "POST", "/api/v1/decks/import/preview", {"format": "legacy", "text": "1 Island\n" * 700}
    )
    assert huge.status_code == 422
    assert (
        ada.send(
            "POST", "/api/v1/decks/import/preview", {"format": "legacy", "text": "999 Island"}
        ).json()["code"]
        == "invalid_deck_list"
    )
    assert (
        ada.send(
            "POST", "/api/v1/decks/import/preview", {"format": "legacy", "json_text": "{}"}
        ).json()["code"]
        == "invalid_deck_list"
    )


def test_commander_import_and_starters(client):
    ada = Account(client, "ada", admin=True)
    text = "1 Kenrith, the Returned King [Commander]\n99 Wastes\n"
    preview = ada.send(
        "POST", "/api/v1/decks/import/preview", {"format": "commander", "text": text}
    ).json()
    assert preview["validation"]["playable"] is True
    starters = {deck["name"]: deck for deck in ada.get("/api/v1/decks/starters").json()}
    assert list(starters) == ["starter_red_test", "starter_blue_test"]
    red = starters["starter_red_test"]
    assert (red["card_count"], red["format"], red["playable"]) == (100, "commander", True)
    assert red["commanders"] == ["Kenrith, the Returned King"] and red["chosen"] is False
    assert red["commander_card_id"] == card_id(client, "Kenrith, the Returned King")
    copy = ada.send(
        "POST",
        "/api/v1/decks",
        {
            "title": "My raiders",
            "format": "legacy",
            "source": {"kind": "starter", "starter": "starter_red_test"},
        },
    ).json()
    assert (copy["format"], copy["playable"], copy["source"]) == ("commander", True, "starter")
    # A player who did not choose it holds none of its cards: a copy is collection-locked.
    bea = Account(client, "bea")
    locked = bea.get("/api/v1/decks/starters").json()[0]
    assert locked["playable"] is False
    copied = bea.send(
        "POST",
        "/api/v1/decks",
        {
            "title": "Theirs",
            "format": "commander",
            "source": {"kind": "starter", "starter": red["name"]},
        },
    ).json()
    assert copied["legal"] is True and copied["playable"] is False
    assert {problem["kind"] for problem in copied["validation"]["errors"]} == {"collection_locked"}
    assert (
        ada.send(
            "POST",
            "/api/v1/decks",
            {"title": "x", "format": "legacy", "source": {"kind": "starter", "starter": "nope"}},
        ).status_code
        == 404
    )


class ImageHost:
    """Scryfall's image host: every download is recorded; Scryfall's API is never wanted."""

    def __init__(self) -> None:
        self.paths: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.host.endswith("scryfall.io"), request.url
        self.paths.append(request.url.path)
        return httpx.Response(
            200,
            content=b"\xff\xd8\xff\xe0" + request.url.path.encode(),
            headers={"content-type": "image/jpeg"},
        )


def test_card_images_come_from_the_catalog_and_your_own_printings(url, starters, tmp_path):
    from api.models import Deck, DeckEntryRow, DeckRevision, Game, GameSeat

    host = ImageHost()
    app = create_app(
        Settings(
            database_url=url,
            content_dir=str(starters),
            card_image_dir=str(tmp_path / "images"),
        )
    )
    app.state.scryfall_transport = httpx.MockTransport(host)
    with TestClient(app, base_url="https://testserver") as client:
        ada, bob = Account(client, "ada"), Account(client, "bob")
        bolt = ada.get("/api/v1/card-images", name="Lightning Bolt")
        assert bolt.status_code == 200 and bolt.headers["cache-control"].startswith("private")
        assert len(host.paths) == 1 and "/normal/" in host.paths[0]
        # Cached: no second download.
        ada.get("/api/v1/card-images", name="Lightning Bolt")
        assert len(host.paths) == 1
        # The back face of a double-faced card shows its own image.
        back = ada.get("/api/v1/card-images", name="Insectile Aberration")
        assert back.status_code == 200 and "/back/" in host.paths[-1]
        info = ada.get("/api/v1/card-images/info", name="Lightning Bolt").json()
        assert info["status"] == "found" and info["set_code"]
        with Session(app.state.database) as db:
            concept = db.scalar(select(CardConcept).where(CardConcept.name == "Lightning Bolt"))
            other = db.scalar(
                select(CardPrinting).where(
                    CardPrinting.concept_id == concept.id,
                    CardPrinting.id != concept.default_printing_id,
                )
            )
            other_id, other_path = (
                other.id,
                other.image_uris["normal"].split("scryfall.io", 1)[1].split("?")[0],
            )
        printed = ada.get(f"/api/v1/card-images/printings/{other_id}", size="normal")
        assert printed.status_code == 200 and host.paths[-1] == other_path
        assert ada.get(f"/api/v1/card-images/printings/{uuid4()}").status_code == 404
        # In a game, ada's own deck's printing shows; bob, who is not in the game, gets the default.
        with Session(app.state.database) as db:
            now = utcnow()
            deck = Deck(
                owner_id=ada.id,
                title="Burn",
                format="legacy",
                draft={},
                draft_hash="",
                created_at=now,
                updated_at=now,
            )
            db.add(deck)
            db.flush()
            revision = DeckRevision(
                deck_id=deck.id,
                number=1,
                format="legacy",
                title="Burn",
                content_hash="x",
                legal=True,
                playable=True,
                created_at=now,
            )
            db.add(revision)
            db.flush()
            db.add(
                DeckEntryRow(
                    revision_id=revision.id,
                    concept_id=concept.id,
                    printing_id=other_id,
                    quantity=4,
                    location="main",
                )
            )
            game = Game(
                id=uuid4(),
                kind="practice",
                format="legacy",
                status="active",
                created_by=ada.id,
                created_at=now,
                bot_skill=1,
                turn_cap=10,
            )
            db.add(game)
            db.flush()
            db.add(
                GameSeat(
                    game_id=game.id,
                    seat=0,
                    player="human",
                    user_id=ada.id,
                    deck="Burn",
                    deck_revision_id=revision.id,
                )
            )
            db.commit()
            game_id = game.id
        downloads = len(host.paths)
        mine = ada.get("/api/v1/card-images", name="Lightning Bolt", game=str(game_id))
        assert mine.content == printed.content and len(host.paths) == downloads
        theirs = bob.get("/api/v1/card-images", name="Lightning Bolt", game=str(game_id))
        assert theirs.content == bolt.content
        with Session(app.state.database) as db:
            db.execute(text("DELETE FROM game_seats"))
            db.execute(text("DELETE FROM games"))
            for table in ACCOUNT_TABLES:
                db.execute(text(f"DELETE FROM {table}"))
            db.commit()


def test_practice_games_bind_your_own_deck_revisions(url, starters):
    from test_games import SERVICE_TOKEN, FakeEngine

    from api.models import DeckEntryRow, Game, GameSeat

    fake = FakeEngine()
    app = create_app(
        Settings(
            database_url=url,
            content_dir=str(starters),
            engine_service_token=SERVICE_TOKEN,
            games_per_account=4,
        )
    )
    app.state.engine_transport = httpx.MockTransport(fake)
    with TestClient(app, base_url="https://testserver") as client:
        ada, bob = Account(client, "ada", admin=True), Account(client, "bob")
        assert ada.get("/api/v1/practice-games/options").json()["own_decks"] is True
        deck = ada.send(
            "POST", "/api/v1/decks", {"title": "Burn", "format": "legacy", "entries": burn(client)}
        ).json()
        started = ada.send(
            "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck["id"]}
        )
        assert started.status_code == 201, started.json()
        sent = fake.created[-1]["seats"][0]
        assert sorted(sent["deck_list"]["cards"], key=lambda c: c["name"]) == [
            {"name": "Lightning Bolt", "count": 4},
            {"name": "Mountain", "count": 56},
        ]
        game_id = UUID(started.json()["id"])
        assert started.json()["seats"][0]["deck"] == "Burn"
        with Session(app.state.database) as db:
            seat = db.scalar(
                select(GameSeat).where(GameSeat.game_id == game_id, GameSeat.seat == 0)
            )
            game = db.get(Game, game_id)
            assert seat.deck_revision_id is not None
            assert (game.catalog_revision_id, game.format_version) == (1, 1)
            revision_id = seat.deck_revision_id
        # Editing the deck afterwards does not change what the game played.
        changed = [entry(client, "Lightning Bolt", 2), entry(client, "Mountain", 58)]
        ada.send("PUT", f"/api/v1/decks/{deck['id']}/draft", {"version": 1, "entries": changed})
        with Session(app.state.database) as db:
            quantities = db.scalars(
                select(DeckEntryRow.quantity).where(DeckEntryRow.revision_id == revision_id)
            ).all()
            assert sorted(quantities) == [4, 56]
        ada.send("POST", f"/api/v1/games/{game_id}/close", {})
        # A bot may play your deck too. A deck not yours, or not playable, is refused.
        bot = ada.send(
            "POST",
            "/api/v1/practice-games",
            {"format": "legacy", "deck": "legacy-mono-red-burn", "bots": [{"deck_id": deck["id"]}]},
        )
        assert bot.status_code == 201 and "deck_list" in fake.created[-1]["seats"][1]
        ada.send("POST", f"/api/v1/games/{bot.json()['id']}/close", {})
        theirs = bob.send(
            "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck["id"]}
        )
        assert (theirs.status_code, theirs.json()["code"]) == (422, "invalid_deck")
        short = ada.send(
            "POST",
            "/api/v1/decks",
            {"title": "Short", "format": "legacy", "entries": burn(client)[:1]},
        ).json()
        refused = ada.send(
            "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": short["id"]}
        )
        assert (refused.status_code, refused.json()["code"]) == (422, "deck_not_playable")
        wrong = ada.send(
            "POST", "/api/v1/practice-games", {"format": "commander", "deck_id": deck["id"]}
        )
        assert wrong.json()["code"] == "invalid_deck"
        # The game's rules choose which cards its decks may hold (v0.4.5): casual unless told.
        lotus = ada.send(
            "POST",
            "/api/v1/decks",
            {
                "title": "Lotus",
                "format": "legacy",
                "entries": [entry(client, "Black Lotus"), entry(client, "Mountain", 59)],
            },
        ).json()
        assert (lotus["playable"], lotus["needs"]) == (True, ["banned"])
        tournament = ada.send(
            "POST",
            "/api/v1/practice-games",
            {
                "format": "legacy",
                "deck_id": lotus["id"],
                "rules": {"banned": False, "not_legal": False},
            },
        )
        assert (tournament.status_code, tournament.json()["code"]) == (422, "deck_not_allowed")
        assert tournament.json()["message"] == (
            "This table does not allow banned cards: Black Lotus is banned in Legacy. Choose "
            "another deck, or take it out of this one."
        )
        for_bot = ada.send(
            "POST",
            "/api/v1/practice-games",
            {
                "format": "legacy",
                "deck_id": deck["id"],
                "bots": [{"deck_id": lotus["id"]}],
                "rules": {"banned": False, "not_legal": True},
            },
        )
        assert for_bot.json()["code"] == "deck_not_allowed"
        casual = ada.send(
            "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": lotus["id"]}
        )
        assert casual.status_code == 201, casual.json()
        ada.send("POST", f"/api/v1/games/{casual.json()['id']}/close", {})
        kenrith = ada.send(
            "POST",
            "/api/v1/decks",
            {
                "title": "Kenrith",
                "format": "commander",
                "entries": [
                    entry(client, "Kenrith, the Returned King", 1, "commander"),
                    entry(client, "Wastes", 99),
                ],
            },
        ).json()
        commander = ada.send(
            "POST",
            "/api/v1/practice-games",
            {"format": "commander", "deck_id": kenrith["id"], "bots": [{}]},
        )
        assert commander.status_code == 201, commander.json()
        assert fake.created[-1]["seats"][0]["deck_list"]["commanders"] == [
            "Kenrith, the Returned King"
        ]
        # A Commander bot with no deck chosen plays a starter deck, as a deck list of engine
        # names; it is not audited as SysOp's deck lists are.
        bot_seat = fake.created[-1]["seats"][1]
        assert bot_seat["deck_list"]["commanders"] in (
            ["Kenrith, the Returned King"],
            ["Thrasios, Triton Hero"],
        )
        assert sum(card["count"] for card in bot_seat["deck_list"]["cards"]) == 99
        ada.send("POST", f"/api/v1/games/{commander.json()['id']}/close", {})
        with Session(app.state.database) as db:
            db.execute(text("DELETE FROM game_seats"))
            db.execute(text("DELETE FROM games"))
            for table in ACCOUNT_TABLES:
                db.execute(text(f"DELETE FROM {table}"))
            db.commit()


def test_guided_decks_are_playable_and_explain_every_card(client):
    """DECK06 on the test catalog: a Commander deck from its commander, a Legacy deck from its
    colors; every card playable and within the colors, with its reason, and nothing saved."""
    ada = Account(client, "ada", admin=True)
    kenrith = card_id(client, "Kenrith, the Returned King")
    commander = ada.send(
        "POST",
        "/api/v1/decks/guided",
        {"format": "commander", "commander_id": kenrith, "theme": "tokens", "experience": "new"},
    ).json()
    entries = commander["entries"]
    assert sum(item["quantity"] for item in entries) == 100
    assert [item["card_id"] for item in entries if item["location"] == "commander"] == [kenrith]
    assert commander["validation"]["errors"] == [] and commander["validation"]["playable"]
    assert all(commander["cards"][item["card_id"]]["playable"] for item in entries)
    assert all(item["reason"] for item in commander["suggestions"])
    assert commander["note"]

    legacy = ada.send(
        "POST", "/api/v1/decks/guided", {"format": "legacy", "colors": "R", "theme": "aggro"}
    ).json()
    main = [item for item in legacy["entries"] if item["location"] == "main"]
    assert sum(item["quantity"] for item in main) == 60
    assert legacy["validation"]["errors"] == []
    for item in main:
        assert set(legacy["cards"][item["card_id"]]["color_identity"]) <= {"R"}
    # A proposal saves nothing until the player keeps it.
    assert ada.get("/api/v1/decks").json() == []
    # A pair of commanders leaves 98 cards beside them.
    pair = ada.send(
        "POST",
        "/api/v1/decks/guided",
        {
            "format": "commander",
            "commander_id": card_id(client, "Thrasios, Triton Hero"),
            "partner_id": card_id(client, "Tymna the Weaver"),
        },
    ).json()
    assert sum(item["quantity"] for item in pair["entries"]) == 100
    assert pair["validation"]["errors"] == []
    # Another player's request needs the builder's permission like every deck route.
    pending = Account(client, "pat", status="pending")
    refused = pending.send("POST", "/api/v1/decks/guided", {"format": "legacy", "colors": "R"})
    assert refused.status_code == 403
