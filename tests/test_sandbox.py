"""The all-card practice sandbox (v1.0.0, api/sandbox.py): a sandbox deck built from every card
in the game and played only in the sandbox; a sandbox game that earns nothing and is counted
apart, with bots its player switches to passive; a restart; and the deck made a normal one once
its owner holds its cards (the owner's decisions of 2026-11-16). Behind the gate sandbox."""

import uuid
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from test_games import FakeEngine
from test_tables import Account, TableEngine, card, client, content, until_finished, url

from api.models import CardConcept, Game, LibraryGrant, PlayerResult, TokenEntry
from api.modes import REWARDS, SANDBOX

__all__ = ["client", "content", "url"]


class SandboxEngine(TableEngine):
    """The tables' engine, which asks a seat's token of every route of a game it does not name
    a service's: the bots' switch is the service's own."""

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        parts = request.url.path.removeprefix("/v1/service/").split("/")
        if len(parts) == 3 and parts[2] == "bots":
            return await FakeEngine.__call__(self, request)
        return await super().__call__(request)


@pytest.fixture
def engine() -> SandboxEngine:
    return SandboxEngine()


def staged(client: TestClient, stage: str = "on") -> Account:
    """The workflow at a stage, set by the installation's SysOp."""
    root = Account(client, "root-" + uuid.uuid4().hex[:8], kind="sysop")
    changed = root.send("PUT", "/api/v1/admin/rollout/sandbox", {"stage": stage})
    assert changed.status_code == 200, changed.text
    return root


def player(client: TestClient) -> Account:
    return Account(client, "bob" + uuid.uuid4().hex[:6])


def entries(client: TestClient, **cards: int) -> list[dict[str, Any]]:
    names = {"bolt": "Lightning Bolt", "mountain": "Mountain", "giant": "Hill Giant"}
    return [
        {"card_id": card(client, names[key]), "quantity": count, "location": "main"}
        for key, count in cards.items()
    ]


def make(account: Account, client: TestClient, title: str, sandbox: bool, **cards: int) -> Any:
    return account.send(
        "POST",
        "/api/v1/decks",
        {
            "title": title,
            "format": "legacy",
            "entries": entries(client, **cards),
            "sandbox": sandbox,
        },
    )


def grant(client: TestClient, account: Account, name: str, copies: int) -> None:
    """Copies of a card in the account's library, in its default printing."""
    with Session(client.app.state.database) as db:
        concept = db.scalar(select(CardConcept).where(CardConcept.name == name))
        assert concept is not None and concept.default_printing_id is not None
        db.add(
            LibraryGrant(
                user_id=account.id,
                concept_id=concept.id,
                printing_id=concept.default_printing_id,
                quantity=copies,
                source="grandfathered",
                grant_key=f"grandfathered:test:{uuid.uuid4()}",
                created_at=datetime.now(UTC),
            )
        )
        db.commit()


def grants(client: TestClient, account: Account) -> int:
    with Session(client.app.state.database) as db:
        return int(
            db.scalar(
                select(func.coalesce(func.sum(LibraryGrant.quantity), 0)).where(
                    LibraryGrant.user_id == account.id
                )
            )
            or 0
        )


def sandbox_game(account: Account, deck_id: str, **extra: Any) -> Any:
    body = {"format": "legacy", "deck_id": deck_id, "bots": [{}], "sandbox": True} | extra
    return account.send("POST", "/api/v1/practice-games", body)


def test_a_sandbox_deck_holds_any_card_and_is_played_nowhere_else(client, engine):
    staged(client)
    bob = player(client)
    grant(client, bob, "Mountain", 60)

    # A normal deck is the library's: four Lightning Bolts nobody gave bob cannot be played.
    normal = make(bob, client, "Burn", False, bolt=4, mountain=56).json()
    assert (normal["sandbox"], normal["playable"], normal["collection_locked"]) == (
        False,
        False,
        True,
    )
    # A sandbox deck is every card's in the game: the same list is ready for the sandbox.
    made = make(bob, client, "Burn to try", True, bolt=4, mountain=56)
    assert made.status_code == 201, made.text
    deck = made.json()
    assert (deck["sandbox"], deck["playable"], deck["collection_locked"]) == (True, True, False)
    assert deck["validation"]["errors"] == [] and deck["convertible"] is False
    # What bob holds of each card is still said: none of the bolts, all of the lands.
    bolt, mountain = card(client, "Lightning Bolt"), card(client, "Mountain")
    assert (deck["cards"][bolt]["owned"], deck["cards"][mountain]["owned"]) == (0, 60)
    listed = {found["title"]: found for found in bob.get("/api/v1/decks").json()}
    assert (listed["Burn to try"]["sandbox"], listed["Burn"]["sandbox"]) == (True, False)

    # Saved again, it is still checked against every card; the deck's own rules still hold.
    draft = bob.send(
        "PUT",
        f"/api/v1/decks/{deck['id']}/draft",
        {"version": deck["draft"]["version"], "entries": entries(client, bolt=4, giant=4)},
    )
    assert draft.status_code == 200, draft.text
    assert draft.json()["validation"]["playable"] is False
    assert all(p["kind"] != "collection_locked" for p in draft.json()["validation"]["errors"])
    again = bob.send(
        "PUT",
        f"/api/v1/decks/{deck['id']}/draft",
        {
            "version": draft.json()["version"],
            "entries": entries(client, bolt=4, giant=4, mountain=52),
        },
    )
    assert again.json()["validation"]["playable"] is True

    # Its duplicate is a sandbox deck too, whatever the request says.
    copy = bob.send(
        "POST",
        "/api/v1/decks",
        {
            "title": "A copy",
            "format": "legacy",
            "source": {"kind": "duplicate", "deck_id": deck["id"]},
        },
    )
    assert copy.status_code == 201 and copy.json()["sandbox"] is True

    # A normal deck that needs cards its owner lacks is copied as a sandbox deck, to try it.
    tried = bob.send(
        "POST",
        "/api/v1/decks",
        {
            "title": "Burn (sandbox)",
            "format": "legacy",
            "source": {"kind": "duplicate", "deck_id": normal["id"]},
            "sandbox": True,
        },
    )
    assert tried.status_code == 201, tried.text
    assert (tried.json()["sandbox"], tried.json()["playable"]) == (True, True)

    # It is played only in the sandbox: not as a practice game that counts, not at a table.
    counted = bob.send(
        "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck["id"], "bots": [{}]}
    )
    assert (counted.status_code, counted.json()["code"]) == (422, "sandbox_deck")
    table = bob.send("POST", "/api/v1/tables", {"format": "legacy", "deck_id": deck["id"]})
    assert (table.status_code, table.json()["code"]) == (422, "sandbox_deck")
    # Nothing was given to bob's library by any of it.
    assert grants(client, bob) == 60


def test_a_sandbox_game_earns_nothing_and_is_counted_apart(client, engine):
    staged(client)
    bob = player(client)
    grant(client, bob, "Mountain", 60)
    deck = make(bob, client, "Burn to try", True, bolt=4, mountain=56).json()["id"]
    own = make(bob, client, "Mountains", False, mountain=60).json()["id"]

    # The player's own seat takes a sandbox deck; a bot's takes a sandbox deck or a normal one.
    refused = sandbox_game(bob, own)
    assert (refused.status_code, refused.json()["code"]) == (422, "not_a_sandbox_deck")
    for body in (
        {"best_of": 3},
        {"format": "two_headed_giant", "bots": [{}, {}, {}]},
        {"starter": True},
    ):
        wrong = sandbox_game(bob, deck, **body)
        assert (wrong.status_code, wrong.json()["code"]) == (422, "invalid_table"), wrong.text
    outside = bob.send(
        "POST",
        "/api/v1/practice-games",
        {"format": "legacy", "deck_id": own, "bots": [{}], "passive": True},
    )
    assert (outside.status_code, outside.json()["code"]) == (422, "invalid_table")

    started = sandbox_game(bob, deck, bots=[{"deck_id": own}], passive=True)
    assert started.status_code == 201, started.text
    game_id = started.json()["id"]
    sent = engine.created[-1]["seats"]
    assert {"name": "Lightning Bolt", "count": 4} in sent[0]["deck_list"]["cards"]
    assert sent[1]["deck_list"]["cards"] == [{"name": "Mountain", "count": 60}]
    # Its bots are passive from the start, and the switch is its player's: any player's here.
    assert engine.passive[game_id] is True and started.json()["passive_bots"] is True
    back = bob.send("PUT", f"/api/v1/games/{game_id}/bots", {"passive": False})
    assert back.status_code == 200 and back.json()["passive_bots"] is False

    # Restarted: the game is closed and played again as it was asked for, in the sandbox.
    assert bob.send("POST", f"/api/v1/games/{game_id}/close").status_code == 200
    again = bob.send("POST", f"/api/v1/games/{game_id}/rematch")
    assert again.status_code == 200, again.text
    second = again.json()["game_id"]
    assert second not in (None, game_id) and engine.passive[second] is True

    # Won: nothing is earned, each reward withheld by name.
    before = balance(client, bob)
    with engine.lock:
        engine.games[second].result = {
            "kind": "completed",
            "winner_seat": 0,
            "draw": False,
            "turns": 6,
            "conceded_seats": [],
            "error": None,
        }
        engine.games[second].revision += 1
    until_finished(bob, second)
    with Session(client.app.state.database) as db:
        game = db.get(Game, uuid.UUID(second))
        assert game is not None and game.mode == "sandbox"
        assert game.eligibility == {
            "mode": "sandbox",
            "earns": [],
            "withheld": {reward: SANDBOX for reward in REWARDS},
        }
        # The record is among what is withheld (the owner's policy of 2026-11-13): a sandbox
        # game leaves no result, so no record of the account's or of the deck's counts it.
        assert list(db.scalars(select(PlayerResult).where(PlayerResult.user_id == bob.id))) == []
    assert balance(client, bob) == before
    assert grants(client, bob) == 60

    # Outside the sandbox the switch stays SysOp's and the administrators'.
    counted = bob.send(
        "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": own, "bots": [{}]}
    )
    assert counted.status_code == 201, counted.text
    assert counted.json()["passive_bots"] is None
    switch = bob.send("PUT", f"/api/v1/games/{counted.json()['id']}/bots", {"passive": True})
    assert switch.status_code == 403


def balance(client: TestClient, account: Account) -> int:
    with Session(client.app.state.database) as db:
        return int(
            db.scalar(
                select(func.coalesce(func.sum(TokenEntry.amount), 0)).where(
                    TokenEntry.user_id == account.id
                )
            )
            or 0
        )


def test_a_sandbox_deck_becomes_a_normal_one_once_its_cards_are_owned(client, engine):
    staged(client)
    bob = player(client)
    grant(client, bob, "Mountain", 60)
    deck = make(bob, client, "Burn to try", True, bolt=4, mountain=56).json()
    path = f"/api/v1/sandbox/decks/{deck['id']}/convert"

    early = bob.send("POST", path)
    assert (early.status_code, early.json()["code"]) == (409, "cards_missing")
    grant(client, bob, "Lightning Bolt", 4)
    assert bob.get(f"/api/v1/decks/{deck['id']}").json()["convertible"] is True
    assert bob.get("/api/v1/decks").json()[0]["convertible"] is True

    converted = bob.send("POST", path)
    assert converted.status_code == 200, converted.text
    after = converted.json()
    assert (after["sandbox"], after["convertible"], after["playable"]) == (False, False, True)
    assert (again := bob.send("POST", path)).status_code == 409
    assert again.json()["code"] == "not_a_sandbox_deck"
    # A normal deck now: its games count, and it is no longer the sandbox's.
    played = bob.send(
        "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck["id"], "bots": [{}]}
    )
    assert played.status_code == 201, played.text
    assert bob.send("POST", f"/api/v1/games/{played.json()['id']}/close").status_code == 200
    sandboxed = sandbox_game(bob, deck["id"])
    assert (sandboxed.status_code, sandboxed.json()["code"]) == (422, "not_a_sandbox_deck")


def test_the_sandbox_is_nothing_while_its_gate_is_closed(client, engine):
    root = staged(client)
    bob = player(client)
    grant(client, bob, "Mountain", 60)
    deck = make(bob, client, "Burn to try", True, bolt=4, mountain=56).json()["id"]
    assert root.send("PUT", "/api/v1/admin/rollout/sandbox", {"stage": "off"}).status_code == 200

    assert make(bob, client, "Another", True, mountain=60).status_code == 404
    assert sandbox_game(bob, deck).status_code == 404
    assert bob.send("POST", f"/api/v1/sandbox/decks/{deck}/convert").status_code == 404
    # A normal deck is made as ever, and a sandbox deck made before is still its owner's to read.
    assert make(bob, client, "Mountains", False, mountain=60).status_code == 201
    assert bob.get(f"/api/v1/decks/{deck}").json()["sandbox"] is True
    # At staff, the staff alone.
    assert root.send("PUT", "/api/v1/admin/rollout/sandbox", {"stage": "staff"}).status_code == 200
    assert sandbox_game(bob, deck).status_code == 404
    assert root.send("PUT", "/api/v1/admin/rollout/sandbox", {"stage": "on"}).status_code == 200
