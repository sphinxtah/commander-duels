"""The Godlike tier's custom cards become playable (v0.4.0): in Godlike accounts' decks, through
validation, revisions, import and export; checked against the cards the running engine has loaded,
asked once per engine start; at the table, where every seat sees their images; and hidden from
everyone else: shared decks, search, card pages, catalog counts and image routes.

Every custom card here is a made-up stand-in; this repository holds nothing of the real ones."""

import asyncio
import os
import time
from datetime import date
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from alembic import command
from alembic.config import Config
from catalog_fixtures import bulk, engine_list, import_bulk
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session
from test_decks_api import ACCOUNT_TABLES, entry
from test_games import SERVICE_TOKEN, SYSOP_ADDRESS, FakeEngine
from test_progression import PNG, Account, upload

from api import games
from api.config import Settings
from api.engine_cards import EngineCards
from api.main import create_app
from api.models import CardImage, DeckEntryRow, GameSeat
from api.validation import (
    DeckContent,
    DeckEntry,
    Rules,
    custom_identity,
    custom_rules,
    mana_value_of,
    validate,
)
from catalog.formats import RULES
from catalog.text import COLOR_BITS

CONTENT = Path(__file__).resolve().parent.parent / "content"
SIGIL = "Stand-in Sigil"
PARAGON = "Placeholder Paragon"


class CardsEngine(FakeEngine):
    """The fake engine, with a /health and a card search that knows the cards in names."""

    def __init__(self) -> None:
        super().__init__()
        self.names: set[str] = set()
        self.build = "public"
        self.ready = True
        self.asked: list[str] = []
        self.healths = 0

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            self.healths += 1
            return httpx.Response(
                200,
                json={
                    "status": "ready" if self.ready else "loading",
                    "xmage": {"commit": "stand-in"},
                    "cards": {"printings": 10 + len(self.names), "distinct_names": 9},
                    "implementations": {"build": self.build},
                },
            )
        if request.url.path == "/v1/service/cards":
            if request.headers.get("x-service-token") != SERVICE_TOKEN:
                return httpx.Response(401, json={"code": "service_unauthorized"})
            wanted = request.url.params["q"]
            self.asked.append(wanted)
            known = sorted(self.names | {"Lightning Bolt", "Mountain"})
            found = [name for name in known if wanted.casefold() in name.casefold()]
            return httpx.Response(200, json={"names": found})
        return await super().__call__(request)


class Clock:
    def __init__(self) -> None:
        self.now = time.monotonic()

    def __call__(self) -> float:
        return self.now


def scryfall(request: httpx.Request) -> httpx.Response:
    """Scryfall knows none of the names asked here."""
    return httpx.Response(404, json={"object": "error", "code": "not_found"})


@pytest.fixture(scope="module")
def url(tmp_path_factory) -> str:
    folder = tmp_path_factory.mktemp("custom")
    url = f"sqlite:///{folder}/custom.db"
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("CD_DATABASE_URL", url)
        command.upgrade(Config("alembic.ini"), "head")
    engine = create_engine(url)
    import_bulk(engine, folder / "files", bulk(), engine_list())
    engine.dispose()
    return url


@pytest.fixture
def engine() -> CardsEngine:
    return CardsEngine()


@pytest.fixture
def client(url: str, engine: CardsEngine, tmp_path: Path):
    content = tmp_path / "content"
    content.mkdir()
    (content / "planeswalkers.json").write_text(
        (CONTENT / "planeswalkers.json").read_text(encoding="utf-8"), encoding="utf-8"
    )
    app = create_app(
        Settings(
            database_url=url,
            content_dir=str(content),
            sysop_networks="10.20.0.0/24",
            engine_service_token=SERVICE_TOKEN,
            games_per_account=4,
            card_image_dir=str(tmp_path / "images"),
        )
    )
    app.state.engine_transport = httpx.MockTransport(engine)
    app.state.scryfall_transport = httpx.MockTransport(scryfall)
    with TestClient(app, base_url="https://testserver", client=SYSOP_ADDRESS) as client:
        clock = Clock()
        app.state.engine_cards.clock = clock
        client.clock = clock  # type: ignore[attr-defined]
        yield client
        with Session(app.state.database) as db:
            for table in ("game_seats", "games", "card_images", "custom_cards", *ACCOUNT_TABLES):
                db.execute(text(f"DELETE FROM {table}"))
            db.commit()


def later(client: TestClient) -> None:
    """Past the engine start's check: the next request looks at /health again."""
    client.clock.now += 60  # type: ignore[attr-defined]


def stand_ins(root: Account) -> tuple[dict[str, Any], dict[str, Any]]:
    """A Planeswalker and a five-color legendary creature: made-up cards."""
    sigil = upload(
        root,
        type_line="Legendary Planeswalker — Stand-in",
        oracle_text="+1: Add {R}. (Pay {B} for nothing.)",
    )
    paragon = upload(
        root,
        name=PARAGON,
        type_line="Legendary Creature — Stand-in",
        mana_cost="{W}{U}{B}{R}{G}",
        oracle_text="Flying",
        loyalty=None,
        power="5",
        toughness="5",
    )
    assert sigil.status_code == paragon.status_code == 200, sigil.text
    return sigil.json(), paragon.json()


def wins(root: Account, account: Account, count: int) -> None:
    changed = root.send(
        "POST", f"/api/v1/admin/users/{account.id}/wins", {"wins": count, "reason": "Testing"}
    )
    assert changed.status_code == 200, changed.text


def custom(card: dict[str, Any], quantity: int = 1, location: str = "main") -> dict[str, Any]:
    return {"card_id": card["id"], "quantity": quantity, "location": location}


def test_custom_cards_as_validation_reads_them():
    assert mana_value_of("{2}{W/U}{X}{G/P}") == 4
    assert mana_value_of("{2/W}{B}") == 3 and mana_value_of(None) == 0
    # The cost's and the rules text's symbols, reminder text aside.
    bits = custom_identity("{2}{U}", "+1: Add {R}. (Pay {B} for nothing.)")
    assert bits == COLOR_BITS["U"] | COLOR_BITS["R"]

    class Row:
        def __init__(self, **fields: Any) -> None:
            self.__dict__.update(fields)

    walker = Row(
        id=UUID(int=1),
        name="Stand-in Walker",
        type_line="Legendary Planeswalker — Stand-in",
        mana_cost="{3}{U}",
        oracle_text="Stand-in Walker can be your commander.",
    )
    card = custom_rules(walker, loaded=None)  # type: ignore[arg-type]
    assert card.commander and card.status == "certified"
    assert card.legalities == {"legacy": "legal", "commander": "legal"}
    assert card.construction_key == f"custom:{UUID(int=1)}"
    unloaded = custom_rules(walker, loaded=False)  # type: ignore[arg-type]
    assert unloaded.status == "not_loaded"

    # A deck holding a custom card while its owner is below Godlike: locked, its commander still
    # counted as one, and nothing of the card named.
    rules = Rules("commander", None, RULES["commander"], frozenset())
    hidden = UUID(int=2)
    content = DeckContent(
        format="commander",
        entries=[
            DeckEntry(card_id=hidden, quantity=1, location="commander"),
            DeckEntry(card_id=hidden, quantity=1, location="maybeboard"),
        ],
    )
    report = validate(content, {}, rules, date(2026, 10, 21), None, frozenset({hidden}))
    assert [problem.code for problem in report.errors] == ["custom.godlike_only", "commander.size"]
    assert report.errors[0].kind == "collection_locked"
    assert report.errors[0].card_ids == [hidden]
    assert "1 Godlike card" in report.errors[0].message


def test_godlike_decks_hold_custom_cards(client, engine):
    root = Account(client, "sysop", kind="sysop")
    ada, bob = Account(client, "ada"), Account(client, "bob")
    before = root.get("/api/v1/catalog").json()
    sigil, paragon = stand_ins(root)
    wins(root, ada, 100_000)
    assert ada.send("PUT", "/api/v1/me/alliance", {"planeswalker": "the-sphinx"}).status_code == 200

    # Each card as decks hold it: a playset in the library, legal in both formats; the public
    # engine has not loaded it.
    listed = {card["name"]: card for card in ada.get("/api/v1/custom-cards").json()}
    held = listed[PARAGON]["card"]
    assert held["custom"] and held["owned"] == 4 and held["commander"]
    assert held["color_identity"] == ["W", "U", "B", "R", "G"] and held["mana_value"] == 5
    assert listed[SIGIL]["card"]["color_identity"] == ["U", "R"]
    assert not listed[SIGIL]["card"]["commander"]
    assert listed[SIGIL]["loaded"] is False and listed[SIGIL]["playable"] is False
    assert listed[SIGIL]["card"]["status_reason"] == "not_loaded"
    assert held["custom_image"] == listed[PARAGON]["image_url"]

    legacy = ada.send(
        "POST",
        "/api/v1/decks",
        {
            "title": "Sigils",
            "format": "legacy",
            "entries": [custom(sigil, 4), entry(client, "Mountain", 56)],
        },
    )
    assert legacy.status_code == 201, legacy.text
    deck = legacy.json()
    assert deck["validation"]["legal"] and not deck["validation"]["playable"]
    [unloaded] = deck["validation"]["errors"]
    assert unloaded["kind"] == "not_implemented"
    assert "not loaded by this engine" in unloaded["message"]
    assert deck["cards"][sigil["id"]]["name"] == SIGIL and deck["identity"] == "U"

    # The private engine starts: once its /health says so, the cards are asked about again.
    engine.names, engine.build = {SIGIL, PARAGON}, "private"
    later(client)
    opened = ada.get(f"/api/v1/decks/{deck['id']}").json()
    assert opened["validation"]["playable"] and opened["cards"][sigil["id"]]["playable"]
    asked = len(engine.asked)
    ada.get(f"/api/v1/decks/{deck['id']}")
    assert len(engine.asked) == asked, "asked again within one engine start"

    # Copies follow the library and the format.
    five = ada.send(
        "PUT",
        f"/api/v1/decks/{deck['id']}/draft",
        {"version": 1, "entries": [custom(sigil, 5), entry(client, "Mountain", 55)]},
    ).json()["validation"]
    assert {problem["code"] for problem in five["errors"]} == {
        "deck.copy_limit",
        "collection.locked",
    }
    ada.send(
        "PUT",
        f"/api/v1/decks/{deck['id']}/draft",
        {"version": 2, "entries": [custom(sigil, 4), entry(client, "Mountain", 56)]},
    )
    commander = ada.send(
        "POST",
        "/api/v1/decks",
        {
            "title": "Paragon",
            "format": "commander",
            "entries": [custom(paragon, 1, "commander"), entry(client, "Wastes", 99)],
        },
    ).json()
    assert commander["validation"]["playable"], commander["validation"]
    assert commander["identity"] == "WUBRG" and commander["commanders"] == [PARAGON]
    walker = ada.send(
        "POST",
        "/api/v1/decks",
        {
            "title": "Walker",
            "format": "commander",
            "entries": [custom(sigil, 1, "commander"), entry(client, "Wastes", 99)],
        },
    ).json()
    assert "commander.eligible" in {problem["code"] for problem in walker["validation"]["errors"]}

    # A revision keeps the custom card as itself.
    revision = ada.send("POST", f"/api/v1/decks/{deck['id']}/revisions").json()
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        rows = db.scalars(select(DeckEntryRow)).all()
        assert {(row.concept_id, row.custom_card_id) for row in rows if row.quantity == 4} == {
            (None, UUID(sigil["id"]))
        }
    read = ada.get(f"/api/v1/decks/{deck['id']}/revisions/{revision['number']}").json()
    assert read["cards"][sigil["id"]]["name"] == SIGIL

    # Exported by name for its owner, and imported back by name for a Godlike owner only.
    text_export = ada.get(f"/api/v1/decks/{deck['id']}/export").text
    assert f"4 {SIGIL}" in text_export
    exported = ada.get(f"/api/v1/decks/{deck['id']}/export", kind="json").json()
    [named] = [item for item in exported["entries"] if item["name"] == SIGIL]
    assert "oracle_id" not in named
    preview = ada.send(
        "POST", "/api/v1/decks/import/preview", {"format": "legacy", "text": text_export}
    ).json()
    assert preview["unresolved"] == 0 and preview["validation"]["playable"]
    assert sigil["id"] in {line["card_id"] for line in preview["lines"]}
    theirs = bob.send(
        "POST", "/api/v1/decks/import/preview", {"format": "legacy", "text": text_export}
    )
    assert theirs.json()["unresolved"] == 1 and sigil["id"] not in theirs.text

    # Nobody else sees them: the shared deck, its export and a copy leave them out.
    shared = ada.send("PATCH", f"/api/v1/decks/{deck['id']}", {"visibility": "link"}).json()
    code = shared["share_code"]
    for path in (f"/api/v1/shared-decks/{code}", f"/api/v1/shared-decks/{code}/export"):
        seen = bob.get(path)
        assert seen.status_code == 200 and SIGIL not in seen.text and sigil["id"] not in seen.text
    copied = bob.send("POST", f"/api/v1/shared-decks/{code}/copy")
    assert copied.status_code == 201 and sigil["id"] not in copied.text

    # Nor do search, card pages or the catalog's counts.
    for account in (root, ada, bob):
        assert account.get("/api/v1/cards", q="Stand-in").json()["total"] == 0
        assert account.get(f"/api/v1/cards/{sigil['id']}").status_code == 404
    after = root.get("/api/v1/catalog").json()
    assert (after["cards"], after["playable"]) == (before["cards"], before["playable"])

    # Below Godlike the decks are collection-locked and show nothing of the cards.
    wins(root, ada, 0)
    listing = {item["title"]: item for item in ada.get("/api/v1/decks").json()}
    assert listing["Sigils"]["collection_locked"] and listing["Paragon"]["collection_locked"]
    assert listing["Paragon"]["commanders"] == ["Godlike card"]
    locked = ada.get(f"/api/v1/decks/{deck['id']}")
    assert "Stand-in" not in locked.text
    body = locked.json()
    assert body["cards"][sigil["id"]]["name"] == "Godlike card"
    assert [problem["code"] for problem in body["validation"]["errors"]] == ["custom.godlike_only"]
    assert body["validation"]["legal"] and body["collection_locked"]
    assert SIGIL not in ada.get(f"/api/v1/decks/{deck['id']}/export").text
    assert ada.get("/api/v1/custom-cards").status_code == 404
    table = {"format": "legacy", "deck_id": deck["id"]}
    refused = ada.send("POST", "/api/v1/practice-games", table)
    assert refused.json()["code"] == "deck_not_playable" and SIGIL not in refused.text


def test_games_play_custom_cards_the_engine_has_loaded(client, engine):
    root = Account(client, "sysop", kind="sysop")
    ada, bob = Account(client, "ada"), Account(client, "bob")
    sigil, _ = stand_ins(root)
    wins(root, ada, 100_000)
    ada.send("PUT", "/api/v1/me/alliance", {"planeswalker": "the-sphinx"})
    deck = ada.send(
        "POST",
        "/api/v1/decks",
        {
            "title": "Sigils",
            "format": "legacy",
            "entries": [custom(sigil, 4), entry(client, "Mountain", 56)],
        },
    ).json()
    table = {"format": "legacy", "deck_id": deck["id"]}

    # The public engine has not loaded it: the game is refused, with the reason.
    refused = ada.send("POST", "/api/v1/practice-games", table)
    assert refused.status_code == 422 and refused.json()["code"] == "custom_not_loaded"
    assert refused.json()["names"] == [SIGIL] and "not loaded by this engine" in refused.text
    assert engine.created == []

    # Bots never play custom cards.
    bot = ada.send(
        "POST",
        "/api/v1/practice-games",
        {"format": "legacy", "deck": "legacy-mono-red-burn", "bots": [{"deck_id": deck["id"]}]},
    )
    assert bot.status_code == 422 and bot.json()["code"] == "custom_cards_for_bots"

    # On an engine that has loaded it, the deck plays, its custom card by name. The start asks
    # the engine afresh, whatever it said before.
    engine.names = {SIGIL}
    started = ada.send("POST", "/api/v1/practice-games", table)
    assert started.status_code == 201, started.text
    sent = engine.created[-1]["seats"]
    assert {"name": SIGIL, "count": 4} in sent[0]["deck_list"]["cards"]
    assert "deck_list" not in sent[1]
    game_id = started.json()["id"]

    # The table's images: a seat in a game where some deck holds the card sees it; anyone else
    # gets what any unknown name gets, and Scryfall is never asked about it.
    def image(account: Account, name: str, **params: str) -> httpx.Response:
        return account.get("/api/v1/card-images", name=name, **params)

    unknown = image(bob, "Stand-in Name Nobody Has")
    hidden = image(bob, SIGIL)
    assert unknown.status_code == hidden.status_code == 404
    assert {**unknown.json(), "request_id": ""} == {**hidden.json(), "request_id": ""}
    unknown_info = bob.get("/api/v1/card-images/info", name="Another Unknown Stand-in")
    hidden_info = bob.get("/api/v1/card-images/info", name=SIGIL)
    assert unknown_info.status_code == hidden_info.status_code == 404
    assert {**unknown_info.json(), "request_id": ""} == {**hidden_info.json(), "request_id": ""}
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        assert db.get(CardImage, SIGIL) is None
        db.add(GameSeat(game_id=UUID(game_id), seat=7, player="human", user_id=bob.id, deck="x"))
        db.commit()
    for params in ({}, {"game": game_id}):
        seen = image(bob, SIGIL, **params)
        assert seen.status_code == 200 and seen.content == PNG
        assert seen.headers["cache-control"] == "private, no-store"
        assert seen.headers["content-type"] == "image/png"
    credit = bob.get("/api/v1/card-images/info", name=SIGIL, game=game_id).json()
    assert credit["status"] == "found"
    # The owner sees it as a Godlike account; SysOp below Godlike still observes every game.
    assert image(ada, SIGIL).status_code == 200
    wins(root, root, 0)
    assert image(root, SIGIL).status_code == 200
    ada.send("POST", f"/api/v1/games/{game_id}/close", {})


def test_the_engine_is_asked_once_per_start():
    fake = CardsEngine()
    fake.names = {SIGIL}
    clock = Clock()

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    async def check() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(fake)) as http:
            cards = EngineCards(games.EngineClient("http://engine:8090", SERVICE_TOKEN, http))
            cards.clock = clock
            assert await cards.loaded([SIGIL, PARAGON]) == {
                SIGIL.casefold(): True,
                PARAGON.casefold(): False,
            }
            assert await cards.loaded([SIGIL.upper()]) == {SIGIL.casefold(): True}
            assert fake.asked == [SIGIL, PARAGON] and fake.healths == 1
            # The same start, seen again after a while: nothing is asked again.
            clock.now += 60
            await cards.loaded([SIGIL])
            assert fake.asked == [SIGIL, PARAGON] and fake.healths == 2
            # Another start (another image): everything is asked again.
            fake.build, fake.names = "private", {SIGIL, PARAGON}
            clock.now += 60
            assert await cards.loaded([PARAGON]) == {PARAGON.casefold(): True}
            # A game's start asks afresh; a refusal forgets every answer.
            await cards.loaded([SIGIL], fresh=True)
            cards.forget()
            await cards.loaded([SIGIL])
            assert fake.asked == [SIGIL, PARAGON, PARAGON, SIGIL, SIGIL]
            # An engine still loading is asked each time, and its answers are not kept.
            fake.ready = False
            clock.now += 60
            await cards.loaded([SIGIL])
            await cards.loaded([SIGIL])
            assert fake.asked[-2:] == [SIGIL, SIGIL] and cards.known == {}
        assert await EngineCards(None).loaded([SIGIL]) is None
        async with httpx.AsyncClient(transport=httpx.MockTransport(down)) as http:
            cards = EngineCards(games.EngineClient("http://engine:8090", SERVICE_TOKEN, http))
            assert await cards.loaded([SIGIL]) is None

    asyncio.run(check())


@pytest.mark.skipif(not os.getenv("CD_TEST_POSTGRES_URL"), reason="PostgreSQL URL not supplied")
def test_revision_rows_of_custom_cards_on_postgresql(monkeypatch):
    """Migration 0011 on PostgreSQL: an entry names a catalog card or a custom card, never both
    or neither; revisions stay immutable; the downgrade drops the custom rows."""
    url = os.environ["CD_TEST_POSTGRES_URL"]
    schema = f"test_{uuid4().hex}"
    admin = create_engine(url, connect_args={"connect_timeout": 3})
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    scoped = (
        make_url(url)
        .update_query_dict({"options": f"-csearch_path={schema}"})
        .render_as_string(hide_password=False)
    )
    monkeypatch.setenv("CD_DATABASE_URL", scoped)
    config = Config("alembic.ini")
    engine = create_engine(scoped, connect_args={"connect_timeout": 3})
    try:
        command.upgrade(config, "head")
        user, deck, revision = uuid4(), uuid4(), uuid4()
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO users (id, normalized_handle, handle, display_name, kind, status, "
                    "onboarding, avatar, locale, preferences, privilege_version, created_at) "
                    "VALUES (:id, 'ada', 'ada', 'Ada', 'player', 'active', 'complete', 'sigil', "
                    "'en', '{}', 0, now())"
                ),
                {"id": user},
            )
            connection.execute(
                text(
                    "INSERT INTO decks (id, owner_id, title, format, visibility, notes, draft, "
                    "draft_version, draft_hash, card_count, legal, playable, collection_locked, "
                    "identity, source, created_at, updated_at) VALUES (:id, :owner, 'd', "
                    "'legacy', 'private', '', '{}', 1, '', 0, false, false, false, '', 'empty', "
                    "now(), now())"
                ),
                {"id": deck, "owner": user},
            )
            connection.execute(
                text(
                    "INSERT INTO deck_revisions (id, deck_id, number, format, title, notes, "
                    "content_hash, legal, playable, created_at) VALUES (:id, :deck, 1, 'legacy', "
                    "'d', '', 'x', true, true, now())"
                ),
                {"id": revision, "deck": deck},
            )
        insert = text(
            "INSERT INTO deck_entries (id, revision_id, concept_id, custom_card_id, quantity, "
            "location) VALUES (:id, :revision, NULL, :custom, 4, 'main')"
        )
        with engine.begin() as connection:
            connection.execute(insert, {"id": uuid4(), "revision": revision, "custom": uuid4()})
        with pytest.raises(IntegrityError), engine.begin() as connection:
            connection.execute(insert, {"id": uuid4(), "revision": revision, "custom": None})
        with pytest.raises(DBAPIError), engine.begin() as connection:
            connection.execute(text("UPDATE deck_entries SET quantity = 3"))
        command.downgrade(config, "0008_tokens")
        with engine.connect() as connection:
            assert connection.execute(text("SELECT count(*) FROM deck_entries")).scalar() == 0
        command.upgrade(config, "head")
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()
