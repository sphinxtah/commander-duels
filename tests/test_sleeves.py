"""v0.8.9: card sleeves (api/sleeves.py), and administrators seeing the app as SysOp does
(api/identity.py, api/games.py concealed_for)."""

import base64
import io
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_games import Account, FakeEngine, build, connect

from api.games import concealed_for
from api.identity import Principal, utcnow
from api.models import AuditEvent, CardSleeve, DeckRevision, GameSeat, RoleGrant, User
from api.sleeves import MAX_SLEEVES, seat_sleeves


@pytest.fixture
def database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    url = f"sqlite:///{tmp_path}/sleeves.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    return url


@pytest.fixture
def client(database: str) -> Iterator[TestClient]:
    with connect(build(database, FakeEngine())) as client:
        yield client


@pytest.fixture
def app(client: TestClient) -> FastAPI:
    return client.app  # type: ignore[return-value]


def picture(fmt: str = "PNG", size: tuple[int, int] = (300, 200)) -> str:
    out = io.BytesIO()
    Image.new("RGB", size, (200, 40, 40)).save(out, fmt)
    return base64.b64encode(out.getvalue()).decode()


def delete(account: Account, path: str) -> Any:
    headers = {"cookie": f"__Host-cd_session={account.token}", "x-csrf-token": account.csrf}
    return account.http.delete(path, headers=headers)


def administrator(app: FastAPI, client: TestClient, handle: str) -> Account:
    found = Account(client, handle)
    with Session(app.state.database) as db:
        db.add(RoleGrant(user_id=found.id, role="administrator", granted_at=utcnow()))
        db.commit()
    return found


def deck_of(account: Account) -> str:
    made = account.post("/api/v1/decks", {"title": "Sleeved", "format": "legacy"})
    assert made.status_code == 201, made.text
    return cast(str, made.json()["id"])


def test_uploading_choosing_and_deleting_sleeves(client: TestClient, app: FastAPI) -> None:
    ada, bob = Account(client, "ada"), Account(client, "bob")
    empty = ada.get("/api/v1/me/sleeves").json()
    assert empty["sleeves"] == [] and empty["limit"] == MAX_SLEEVES
    assert [found["id"] for found in empty["defaults"]] == [
        "duels-varragoth",
        "duels-crest",
        "the-sphinx",
    ]
    for found in empty["defaults"]:
        assert (Path("web/public") / found["url"].lstrip("/")).is_file(), found["url"]

    sent = ada.post("/api/v1/me/sleeves", {"name": "Red", "image": picture()})
    assert sent.status_code == 201, sent.text
    sleeve = sent.json()
    image = bob.get(sleeve["url"])
    assert image.status_code == 200 and image.headers["content-type"] == "image/webp"
    with Image.open(io.BytesIO(image.content)) as shown:
        assert (shown.format, shown.size) == ("WEBP", (504, 704))
    # BMP and JPEG too; anything else is refused, never a 500.
    for fmt in ("BMP", "JPEG"):
        assert (
            ada.post("/api/v1/me/sleeves", {"name": fmt, "image": picture(fmt)}).status_code == 201
        )
    gif = ada.post("/api/v1/me/sleeves", {"name": "Gif", "image": picture("GIF")})
    assert (gif.status_code, gif.json()["code"]) == (422, "invalid_image")
    junk = base64.b64encode(b"not a picture").decode()
    assert ada.post("/api/v1/me/sleeves", {"name": "X", "image": junk}).status_code == 422

    # Each deck wears one: the player's own, a default one, an earned campaign back, or none.
    deck = deck_of(ada)
    path = f"/api/v1/decks/{deck}/sleeve"
    assert ada.put(path, {"sleeve": f"sleeve:{sleeve['id']}"}).json()["sleeve"] == (
        f"sleeve:{sleeve['id']}"
    )
    assert ada.get(f"/api/v1/decks/{deck}").json()["sleeve"] == f"sleeve:{sleeve['id']}"
    assert ada.put(path, {"sleeve": "default:the-sphinx"}).status_code == 200
    assert ada.put(path, {"sleeve": "default:nothing"}).status_code == 422
    assert ada.put(path, {"sleeve": "back:broken-writ"}).json()["code"] == "not_earned"
    bobs = bob.post("/api/v1/me/sleeves", {"name": "Bob's", "image": picture()}).json()
    assert ada.put(path, {"sleeve": f"sleeve:{bobs['id']}"}).status_code == 422
    assert bob.put(path, {"sleeve": None}).status_code == 404

    # Deleting one takes it off the decks wearing it.
    assert ada.put(path, {"sleeve": f"sleeve:{sleeve['id']}"}).status_code == 200
    assert delete(ada, f"/api/v1/me/sleeves/{sleeve['id']}").status_code == 204
    assert bob.get(sleeve["url"]).status_code == 404
    assert ada.get(f"/api/v1/decks/{deck}").json()["sleeve"] is None
    assert len(ada.get("/api/v1/me/sleeves").json()["sleeves"]) == 2


def test_at_most_twenty_sleeves(client: TestClient) -> None:
    ada = Account(client, "ada")
    small = picture(size=(40, 40))
    for number in range(MAX_SLEEVES):
        assert (
            ada.post("/api/v1/me/sleeves", {"name": f"#{number}", "image": small}).status_code
            == 201
        )
    more = ada.post("/api/v1/me/sleeves", {"name": "One more", "image": small})
    assert (more.status_code, more.json()["code"]) == (409, "too_many_sleeves")


@pytest.mark.real_roles
def test_a_reported_sleeve_is_removed_from_every_table(client: TestClient, app: FastAPI) -> None:
    ada, bob = Account(client, "ada"), Account(client, "bob")
    admin = administrator(app, client, "admin")
    sleeve = ada.post("/api/v1/me/sleeves", {"name": "Rude", "image": picture()}).json()
    deck = deck_of(ada)
    assert (
        ada.put(f"/api/v1/decks/{deck}/sleeve", {"sleeve": f"sleeve:{sleeve['id']}"}).status_code
        == 200
    )
    context = {
        "page": "#play",
        "app_version": "0.8.9",
        "viewport_width": 1200,
        "viewport_height": 800,
        "pixel_ratio": 1,
    }
    report = {
        "summary": "Card sleeve reported: ada",
        "description": "Not for a table.",
        "context": context,
        "sleeve": sleeve["id"],
    }
    own = ada.post("/api/v1/reports", report)
    assert (own.status_code, own.json()["code"]) == (409, "own_sleeve")
    sent = bob.post("/api/v1/reports", report)
    assert sent.status_code == 201, sent.text
    detail = admin.get(f"/api/v1/admin/reports/{sent.json()['id']}").json()
    assert detail["sleeve"]["id"] == sleeve["id"] and detail["sleeve"]["removed"] is False
    assert detail["reported_user"]["handle"] == "ada"
    listed = admin.get("/api/v1/admin/reports").json()["items"][0]
    assert listed["sleeve"]["name"] == "Rude"

    path = f"/api/v1/admin/sleeves/{sleeve['id']}/remove"
    assert bob.post(path, {"reason": "Not allowed"}).status_code == 403
    removed = admin.post(path, {"reason": "Not allowed"})
    assert removed.status_code == 200, removed.text
    # Gone from every table and deck; staff still see it for the report; a removed sleeve is
    # reported no more.
    assert bob.get(sleeve["url"]).status_code == 404
    assert ada.get(sleeve["url"]).status_code == 404
    assert admin.get(sleeve["url"]).status_code == 200
    assert ada.get(f"/api/v1/decks/{deck}").json()["sleeve"] is None
    assert ada.get("/api/v1/me/sleeves").json()["sleeves"][0]["removed"] is True
    assert bob.post("/api/v1/reports", report).status_code == 404
    with Session(app.state.database) as db:
        actions = list(db.scalars(select(AuditEvent.action)))
        assert "sleeves.removed" in actions


def test_each_seat_shows_its_decks_sleeve(client: TestClient, app: FastAPI) -> None:
    ada, bob = Account(client, "ada"), Account(client, "bob")
    sleeve = ada.post("/api/v1/me/sleeves", {"name": "Mine", "image": picture()}).json()
    deck = deck_of(ada)
    chosen = {"sleeve": f"sleeve:{sleeve['id']}"}
    assert ada.put(f"/api/v1/decks/{deck}/sleeve", chosen).status_code == 200
    assert ada.post(f"/api/v1/decks/{deck}/revisions").status_code == 201
    with Session(app.state.database) as db:
        revision = db.scalars(select(DeckRevision.id)).one()
        shown = seat_sleeves(db, [(0, ada.id, revision), (1, bob.id, None), (2, None, None)])
        assert shown == {0: sleeve["url"]}
        # The account's campaign back stands in for a deck without a sleeve.
        db.get_one(User, bob.id).card_back = "broken-writ"
        db.commit()
        assert seat_sleeves(db, [(1, bob.id, None)]) == {1: "/brand/backs/broken-writ.svg"}
        # A removed sleeve shows the default.
        db.get_one(CardSleeve, UUID(sleeve["id"])).removed_at = utcnow()
        db.commit()
        assert seat_sleeves(db, [(0, ada.id, revision)]) == {}


def principal(user_id: Any, kind: str, *permissions: str) -> Principal:
    return cast(
        Principal,
        SimpleNamespace(
            user=SimpleNamespace(id=user_id, kind=kind),
            can=lambda permission: permission in permissions,
        ),
    )


def test_an_administrator_sees_concealed_information_only_where_it_cannot_cheat() -> None:
    me, other = uuid4(), uuid4()

    def seat(user_id: Any) -> GameSeat:
        return GameSeat(seat=0, player="human" if user_id else "bot", user_id=user_id, deck="x")

    alone = [seat(me), seat(None), seat(None)]
    with_people = [seat(me), seat(other)]
    others = [seat(other), seat(uuid4())]
    admin = principal(me, "player", "games.view_concealed")
    assert concealed_for(admin, alone) is True
    assert concealed_for(admin, others) is True  # observing, not playing
    assert concealed_for(admin, with_people) is False
    root = principal(me, "sysop", "games.view_concealed")
    assert concealed_for(root, with_people) is True
    player = principal(me, "player")
    assert concealed_for(player, alone) is False


@pytest.mark.real_roles
def test_an_administrators_own_game_against_bots_is_inspectable(
    client: TestClient, app: FastAPI
) -> None:
    admin = administrator(app, client, "admin")
    made = admin.post("/api/v1/practice-games", {})
    assert made.status_code == 201, made.text
    assert made.json()["inspectable"] is True
    ada = Account(client, "ada")
    theirs = ada.post("/api/v1/practice-games", {}).json()
    assert theirs["inspectable"] is False
    # Every game to list and observe, as SysOp.
    assert admin.get("/api/v1/games", scope="all").status_code == 200
    assert admin.get(f"/api/v1/games/{theirs['id']}").json()["game"]["inspectable"] is True
