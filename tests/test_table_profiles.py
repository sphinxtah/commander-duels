"""Rule Zero table profiles (v0.9.12, api/table_profiles.py) through the API, at real tables on
the fake engine: a profile made, validated, shown and searched for; its restrictions checked as a
deck sits down, as its player gets ready and at the start, the cards named to the deck's own
player alone; any change to it making every player not ready again; the profile kept with the
game; and the tables a host saves to open again."""

import json
from collections.abc import Iterator
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session
from test_tables import (
    Account,
    banned_deck,
    browse,
    card,
    client,
    codes,
    content,
    deck,
    engine,
    lotus,
    url,
)

from api import table_profiles
from api.models import CardConcept, Game, GameTable, TablePreset

# The table tests' database, engine and client, as fixtures here.
__all__ = ["client", "content", "engine", "url"]

UPGRADED = {
    "intent": "upgraded",
    "pace": "steady",
    "duration": 90,
    "note": "Bring the deck you are still tuning.",
    "enforced": {"custom_cards": False, "reserved_list": False, "game_changers": 1},
}


@pytest.fixture
def changers(client: TestClient) -> Iterator[None]:
    """Lightning Bolt as a Game Changer for the test: the fixture catalog marks none."""
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(
            update(CardConcept)
            .where(CardConcept.name == "Lightning Bolt")
            .values(game_changer=True)
        )
        db.commit()
    try:
        yield
    finally:
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            db.execute(update(CardConcept).values(game_changer=False))
            db.commit()


def bolts(account: Account, client: TestClient, copies: int, title: str = "Bolts") -> str:
    made = account.send(
        "POST",
        "/api/v1/decks",
        {
            "title": title,
            "format": "legacy",
            "entries": [
                {"card_id": card(client, "Lightning Bolt"), "quantity": copies, "location": "main"},
                {"card_id": card(client, "Mountain"), "quantity": 60 - copies, "location": "main"},
            ],
        },
    ).json()
    assert made["playable"] is True, made
    return str(made["id"])


def table(host: Account, deck_id: str, **extra: Any) -> Any:
    return host.send("POST", "/api/v1/tables", {"format": "legacy", "deck_id": deck_id} | extra)


def ready(account: Account, code: str) -> Any:
    return account.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True})


def kept(client: TestClient, code: str) -> GameTable:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        found = db.scalar(select(GameTable).where(GameTable.code == code))
    assert found is not None
    return found


def test_a_profile_is_made_shown_searched_for_and_kept_with_the_game(client, engine):
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    made = table(ada, deck(ada, client), profile=UPGRADED)
    assert made.status_code == 201, made.text
    code = made.json()["code"]
    shown = made.json()["profile"]
    # What it describes, in words, and everything the server checks at this table: the table's
    # own rules (casual here, so none of those) and the profile's restrictions.
    assert shown == UPGRADED | {
        "version": 1,
        "intent_name": "Upgraded casual",
        "pace_name": "Steady",
        "enforced_rules": [
            {"code": "custom_cards", "text": "No custom cards"},
            {"code": "reserved_list", "text": "No Reserved List cards"},
            {"code": "game_changers", "text": "At most 1 Game Changers a deck"},
        ],
    }
    # Another player reads the same in the lobby and at the table.
    assert bob.get(f"/api/v1/tables/{code}").json()["profile"] == shown
    assert [found["profile"] for found in bob.get("/api/v1/tables").json()] == [shown]
    stored = kept(client, code)
    assert (stored.intent, stored.pace, stored.duration) == ("upgraded", "steady", 90)

    # A table with none says so, and enforces only its rules: tournament rules are named.
    plain = table(
        bob, deck(bob, client), rules={"banned": False, "not_legal": False, "stand_in": True}
    )
    assert plain.status_code == 201 and plain.json()["profile"] is None
    other = plain.json()["code"]
    bob.send("PATCH", f"/api/v1/tables/{other}", {"profile": {"intent": "competitive"}})
    assert bob.get(f"/api/v1/tables/{other}").json()["profile"]["enforced_rules"] == [
        {"code": "banned", "text": "No cards banned in the format"},
        {"code": "not_legal", "text": "No cards that are not legal in the format"},
    ]
    bob.send("PATCH", f"/api/v1/tables/{other}", {"profile": None})
    assert bob.get(f"/api/v1/tables/{other}").json()["profile"] is None

    # The lobby searches by what a profile says; a table with none matches none of it.
    assert set(codes(browse(bob))) == {code, other}
    assert codes(browse(bob, intent="upgraded")) == [code]
    assert codes(browse(bob, intent=["learning", "upgraded"])) == [code]
    assert codes(browse(bob, intent="competitive")) == []
    assert codes(browse(bob, pace="steady")) == [code]
    assert codes(browse(bob, pace="brisk")) == []
    assert codes(browse(bob, max_duration=90)) == [code]
    assert codes(browse(bob, max_duration=60)) == []
    assert bob.get("/api/v1/tables/browse", intent="friendly").status_code == 422
    bob.send("POST", f"/api/v1/tables/{other}/leave")

    # The game keeps the profile its players were ready for, whatever the table becomes.
    joined = bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": deck(bob, client)})
    assert joined.status_code == 200, joined.text
    assert ready(bob, code).status_code == 200
    started = ada.send("POST", f"/api/v1/tables/{code}/start")
    assert started.status_code == 200, started.text
    with Session(client.app.state.database) as db:
        game = db.get(Game, UUID(started.json()["game_id"]))
        assert game is not None and game.table_profile == stored.profile
        assert table_profiles.read(game.table_profile) == table_profiles.TableProfile(**UPGRADED)
    # Once started, the table's profile no longer changes.
    late = ada.send("PATCH", f"/api/v1/tables/{code}", {"profile": None})
    assert (late.status_code, late.json()["code"]) == (409, "table_closed")


@pytest.mark.parametrize(
    "profile",
    [
        {"intent": "friendly"},
        {"intent": "custom", "version": 2},
        {"intent": "custom", "pace": "glacial"},
        {"intent": "custom", "duration": 45},
        {"intent": "custom", "note": "x" * 281},
        {"intent": "custom", "enforced": {"game_changers": 11}},
        {"intent": "custom", "enforced": {"game_changers": -1}},
        {"intent": "custom", "enforced": {"fast_mana": False}},
        {"pace": "steady"},
    ],
)
def test_a_profile_is_validated(client, profile):
    ada = Account(client, "ada", admin=True)
    refused = table(ada, deck(ada, client), profile=profile)
    assert refused.status_code == 422, refused.text
    assert ada.get("/api/v1/tables").json() == []


def test_restrictions_are_checked_sitting_down_getting_ready_and_at_the_start(
    client, engine, changers
):
    """The restrictions are the server's: a deck is checked as it sits down, as its deck changes,
    as its player gets ready and at the start. The cards are named to the deck's own player;
    the host learns only whose deck it is, and nobody's view of the table names a card."""
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    root = Account(client, "sysop", kind="sysop")
    no_lotus = "This table allows no Reserved List cards: Black Lotus."

    # The host's own deck is checked as the table opens.
    refused = table(ada, banned_deck(ada, client), profile=UPGRADED)
    assert (refused.status_code, refused.json()["code"]) == (422, "deck_not_allowed")
    assert refused.json()["message"] == (
        f"{no_lotus} Choose another deck, or a table that allows them."
    )
    ada_deck = deck(ada, client)
    code = table(ada, ada_deck, profile=UPGRADED).json()["code"]

    # Sitting down, and changing deck: Reserved List cards, and Game Changers by the copy.
    bobs_lotus = banned_deck(bob, client)
    joined = bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": bobs_lotus})
    assert (joined.status_code, joined.json()["code"]) == (422, "deck_not_allowed")
    assert no_lotus in joined.json()["message"]
    one_bolt = bolts(bob, client, 1, "One bolt")
    assert bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": one_bolt}).status_code == 200
    two = bob.send(
        "PATCH", f"/api/v1/tables/{code}/seat", {"deck_id": bolts(bob, client, 2, "Two bolts")}
    )
    assert (two.status_code, two.json()["code"]) == (422, "deck_not_allowed")
    assert two.json()["message"] == (
        "This table allows at most 1 Game Changers; this deck holds 2: Lightning Bolt. "
        "Choose another deck, or a table that allows them."
    )
    # A card on the maybeboard is not played, and not counted.
    aside = [
        {"card_id": card(client, "Mountain"), "quantity": 60, "location": "main"},
        {"card_id": card(client, "Black Lotus"), "quantity": 1, "location": "maybeboard"},
    ]
    maybe = bob.send(
        "POST", "/api/v1/decks", {"title": "Maybe", "format": "legacy", "entries": aside}
    ).json()["id"]
    assert bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"deck_id": maybe}).status_code == 200

    # Getting ready checks the deck as it stands now.
    bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"deck_id": one_bolt})
    edited = bob.send(
        "PUT", f"/api/v1/decks/{one_bolt}/draft", {"version": 1, "entries": lotus(client)}
    )
    assert edited.status_code == 200, edited.text
    unready = ready(bob, code)
    assert (unready.status_code, unready.json()["code"]) == (422, "deck_not_allowed")
    assert no_lotus in unready.json()["message"]
    assert ada.get(f"/api/v1/tables/{code}").json()["players"][1]["ready"] is False

    # And the start checks it again: the host learns whose deck, never which cards.
    clean = deck(bob, client, title="Clean")
    bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"deck_id": clean})
    assert ready(bob, code).status_code == 200
    bob.send("PUT", f"/api/v1/decks/{clean}/draft", {"version": 1, "entries": lotus(client)})
    stopped = ada.send("POST", f"/api/v1/tables/{code}/start")
    assert (stopped.status_code, stopped.json()["code"]) == (409, "deck_not_playable")
    assert stopped.json()["message"] == (
        "bob's deck cannot be played now; they need to choose another."
    )
    seen = ada.get(f"/api/v1/tables/{code}").json()
    assert seen["players"][1]["ready"] is False
    assert "Lotus" not in json.dumps(seen) and "Bolt" not in json.dumps(seen)
    assert engine.created == []
    # The host's own, edited, is named to the host.
    bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"deck_id": deck(bob, client, title="New")})
    assert ready(bob, code).status_code == 200
    ada.send("PUT", f"/api/v1/decks/{ada_deck}/draft", {"version": 1, "entries": lotus(client)})
    own = ada.send("POST", f"/api/v1/tables/{code}/start")
    assert own.json()["code"] == "deck_not_allowed" and no_lotus in own.json()["message"]
    assert engine.created == []
    ada.send("POST", f"/api/v1/tables/{code}/leave")
    bob.send("POST", f"/api/v1/tables/{code}/leave")

    # SysOp's decks pass a table's rules, never a profile's restrictions: those are what the
    # table promised its players.
    sysops = table(root, banned_deck(root, client), profile=UPGRADED)
    assert (sysops.status_code, sysops.json()["code"]) == (422, "deck_not_allowed")
    # A profile that restricts nothing takes any deck its table's rules take.
    free = table(bob, bobs_lotus, profile={"intent": "high_power"})
    assert free.status_code == 201 and free.json()["profile"]["enforced_rules"] == []


def test_any_change_to_the_profile_makes_every_player_not_ready(client, engine):
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    code = table(ada, deck(ada, client), profile=UPGRADED).json()["code"]
    bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": deck(bob, client)})

    def bob_ready() -> bool:
        return bool(ada.get(f"/api/v1/tables/{code}").json()["players"][1]["ready"])

    def change(profile: dict[str, Any] | None) -> Any:
        return ada.send("PATCH", f"/api/v1/tables/{code}", {"profile": profile})

    assert ready(bob, code).status_code == 200 and bob_ready()
    # Only the host changes it.
    mine = bob.send("PATCH", f"/api/v1/tables/{code}", {"profile": {"intent": "learning"}})
    assert (mine.status_code, mine.json()["code"]) == (403, "not_host")
    # The same profile again changes nothing; a request without one is no change to a table that
    # has no other settings.
    assert change(UPGRADED).status_code == 200 and bob_ready()
    assert ada.send("PATCH", f"/api/v1/tables/{code}", {}).status_code == 422 and bob_ready()
    # Its note alone is a change: getting ready again is how a player accepts it.
    assert change(UPGRADED | {"note": "No infinite combos, please."}).status_code == 200
    assert not bob_ready()
    assert ada.get(f"/api/v1/tables/{code}").json()["can_start"] is False
    assert ready(bob, code).status_code == 200 and bob_ready()
    # So is a restriction, which the players' decks are then checked by, and its removal.
    assert change(UPGRADED | {"enforced": {"game_changers": 0}}).status_code == 200
    assert not bob_ready()
    stored = kept(client, code)
    assert stored.profile is not None and stored.profile["enforced"] == {
        "custom_cards": True,
        "reserved_list": True,
        "game_changers": 0,
    }
    assert ready(bob, code).status_code == 200
    assert change(None).status_code == 200 and not bob_ready()
    stored = kept(client, code)
    assert (stored.profile, stored.intent, stored.pace, stored.duration) == (None,) * 4
    # A Legacy table still has no other settings to change.
    seats = ada.send("PATCH", f"/api/v1/tables/{code}", {"profile": UPGRADED, "bot_seats": [1]})
    assert (seats.status_code, seats.json()["code"]) == (422, "invalid_table")


def test_a_profile_of_a_version_this_code_does_not_read_is_no_profile(client, engine):
    """After a rollback a table may hold a later version's profile: it describes and enforces
    nothing, and the table is the table it was."""
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    code = table(ada, deck(ada, client), profile=UPGRADED).json()["code"]
    later = {"version": 2, "intent": "cutthroat", "enforced": {"reserved_list": False}}
    with Session(client.app.state.database) as db:
        db.execute(
            text("UPDATE game_tables SET profile = :p WHERE code = :c"),
            {"p": json.dumps(later), "c": code},
        )
        db.commit()
    assert ada.get(f"/api/v1/tables/{code}").json()["profile"] is None
    joined = bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": banned_deck(bob, client)})
    assert joined.status_code == 200, joined.text


def test_a_host_saves_tables_to_open_again(client):
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    found = ada.get("/api/v1/me/table-presets").json()
    assert found["saved"] == [] and found["limit"] == 20
    # The six built in, each a starting point: the first three limit Game Changers.
    assert [preset["name"] for preset in found["built_in"]] == [
        "Learning game",
        "Preconstructed decks",
        "Upgraded casual",
        "High power",
        "Competitive",
        "Custom",
    ]
    assert [preset["profile"]["enforced"]["game_changers"] for preset in found["built_in"]] == [
        0,
        0,
        3,
        None,
        None,
        None,
    ]
    assert all(preset["built_in"] and preset["id"] is None for preset in found["built_in"])
    assert found["built_in"][0]["profile"]["enforced_rules"] == [
        {"code": "game_changers", "text": "No Game Changers"}
    ]
    # A built-in profile opens a table as it is.
    learning = found["built_in"][0]["profile"]
    opened = table(
        ada,
        deck(ada, client),
        profile={key: learning[key] for key in ("intent", "pace", "duration", "note", "enforced")},
    )
    assert opened.status_code == 201 and opened.json()["profile"]["intent_name"] == "Learning game"
    ada.send("POST", f"/api/v1/tables/{opened.json()['code']}/leave")

    settings = {
        "format": "commander",
        "seats": 4,
        "bots": 1,
        "visibility": "private",
        "rules": {"banned": False, "not_legal": True, "stand_in": True},
    }
    saved = ada.send(
        "PUT",
        "/api/v1/me/table-presets",
        {"name": "Friday night", "profile": UPGRADED, "settings": settings},
    )
    assert saved.status_code == 200, saved.text
    [friday] = saved.json()["saved"]
    assert (friday["name"], friday["built_in"], friday["settings"]) == (
        "Friday night",
        False,
        settings | {"bot_skill": None, "best_of": None},
    )
    # Its enforced rules are read with the table's rules it was saved with.
    assert friday["profile"]["enforced_rules"][0] == {
        "code": "banned",
        "text": "No cards banned in the format",
    }
    # The same name, whatever its case, is the same saved table.
    again = ada.send(
        "PUT",
        "/api/v1/me/table-presets",
        {"name": "friday NIGHT", "profile": UPGRADED | {"intent": "high_power"}},
    ).json()["saved"]
    assert [(preset["id"], preset["name"]) for preset in again] == [(friday["id"], "friday NIGHT")]
    assert again[0]["profile"]["intent"] == "high_power" and again[0]["settings"]["seats"] is None
    # It is the account's own: nobody else reads or removes it.
    assert bob.get("/api/v1/me/table-presets").json()["saved"] == []
    theirs = bob.send("DELETE", f"/api/v1/me/table-presets/{friday['id']}")
    assert theirs.status_code == 404
    # At most twenty.
    for number in range(19):
        ada.send(
            "PUT", "/api/v1/me/table-presets", {"name": f"Table {number}", "profile": UPGRADED}
        )
    full = ada.send("PUT", "/api/v1/me/table-presets", {"name": "One more", "profile": UPGRADED})
    assert (full.status_code, full.json()["code"]) == (409, "preset_limit")
    replaced = ada.send("PUT", "/api/v1/me/table-presets", {"name": "Table 3", "profile": UPGRADED})
    assert replaced.status_code == 200 and len(replaced.json()["saved"]) == 20
    removed = ada.send("DELETE", f"/api/v1/me/table-presets/{friday['id']}")
    assert removed.status_code == 200 and len(removed.json()["saved"]) == 19
    with Session(client.app.state.database) as db:
        assert db.scalar(select(TablePreset).where(TablePreset.id == UUID(friday["id"]))) is None
