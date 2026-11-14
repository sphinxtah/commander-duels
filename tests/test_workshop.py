"""The deck workshop's foundations (v0.9.12, api/workshop.py): folders and tags, two versions
compared and one restored into the draft without changing it, a deck's results by the version
played with their sample sizes, the wishlist and what a deck's library lacks, substitutions from
owned cards that keep to the format, the colour identity and the engine's cards, and the choice
a copy of Cryptic Spires carries from the draft to the engine."""

from typing import Any
from uuid import UUID, uuid4

import pytest
import test_quests
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select
from test_progression import Account, card_id, completed, entry
from test_quests import database, played

from api import deckio, decklists, decks, matches, validation, workshop
from api.identity import utcnow
from api.models import (
    CardConcept,
    Deck,
    DeckEntryRow,
    DeckRevision,
    LibraryGrant,
    WishlistEntry,
)
from api.validation import DeckEntry

url = test_quests.url
content = test_quests.content
engine = test_quests.engine
client = test_quests.client


def grant(client: TestClient, user_id: UUID, **copies: int) -> None:
    """Grants copies of cards by name (underscores for spaces), each in its default printing."""
    with database(client) as db:
        key = f"grandfathered:test:{uuid4()}"
        for name, quantity in copies.items():
            concept = db.scalar(
                select(CardConcept).where(
                    CardConcept.name == name.replace("_", " "), CardConcept.deck_card
                )
            )
            assert concept is not None and concept.default_printing_id is not None, name
            db.add(
                LibraryGrant(
                    user_id=user_id,
                    concept_id=concept.id,
                    printing_id=concept.default_printing_id,
                    quantity=quantity,
                    source="grandfathered",
                    grant_key=key,
                    created_at=utcnow(),
                )
            )
        db.commit()


def new_deck(who: Account, title: str, entries: list[dict[str, Any]], fmt: str = "legacy") -> dict:
    answer = who.send("POST", "/api/v1/decks", {"title": title, "format": fmt, "entries": entries})
    assert answer.status_code == 201, answer.text
    return answer.json()  # type: ignore[no-any-return]


def revision_id(client: TestClient, deck_id: str, number: int) -> UUID:
    with database(client) as db:
        return db.scalars(
            select(DeckRevision.id).where(
                DeckRevision.deck_id == UUID(deck_id), DeckRevision.number == number
            )
        ).one()


def burn(client: TestClient, bolts: int = 4) -> list[dict[str, Any]]:
    return [entry(client, "Lightning Bolt", bolts), entry(client, "Mountain", 60 - bolts)]


def test_decks_are_kept_in_folders_and_under_tags(client):
    ada, bea = Account(client, "ada"), Account(client, "bea")
    grant(client, ada.id, Lightning_Bolt=4, Mountain=60)
    one, two, three = (new_deck(ada, title, burn(client)) for title in ("One", "Two", "Three"))
    assert (one["folder"], one["tags"]) == (None, [])
    filed = ada.send(
        "PATCH", f"/api/v1/decks/{one['id']}", {"folder": "Tournament", "tags": ["Aggro", "aggro"]}
    ).json()
    # A tag once, case aside, as it was first written.
    assert (filed["folder"], filed["tags"]) == ("Tournament", ["Aggro"])
    # Several at once: all of them, or none.
    moved = ada.send(
        "POST",
        "/api/v1/decks/organize",
        {"deck_ids": [two["id"], three["id"]], "folder": "Brews", "add_tags": ["red", "Aggro"]},
    )
    assert moved.status_code == 200, moved.text
    assert [(d["title"], d["folder"], d["tags"]) for d in moved.json()] == [
        ("Two", "Brews", ["red", "Aggro"]),
        ("Three", "Brews", ["red", "Aggro"]),
    ]
    theirs = new_deck(bea, "Hers", [])
    refused = ada.send(
        "POST",
        "/api/v1/decks/organize",
        {"deck_ids": [one["id"], theirs["id"]], "folder": "Stolen"},
    )
    assert refused.status_code == 404
    assert ada.get(f"/api/v1/decks/{one['id']}").json()["folder"] == "Tournament"
    shelves = ada.get("/api/v1/decks/shelves").json()
    assert shelves == {
        "folders": [{"name": "Brews", "decks": 2}, {"name": "Tournament", "decks": 1}],
        "tags": [{"name": "Aggro", "decks": 3}, {"name": "red", "decks": 2}],
        "unfiled": 0,
    }
    # The list filters by either; an empty folder name is the decks in none.
    assert {d["title"] for d in ada.get("/api/v1/decks", folder="Brews").json()} == {"Two", "Three"}
    assert {d["title"] for d in ada.get("/api/v1/decks", tag="RED").json()} == {"Two", "Three"}
    out = ada.send(
        "POST",
        "/api/v1/decks/organize",
        {"deck_ids": [two["id"]], "unfile": True, "remove_tags": ["aggro"]},
    ).json()
    assert (out[0]["folder"], out[0]["tags"]) == (None, ["red"])
    assert [d["title"] for d in ada.get("/api/v1/decks", folder="").json()] == ["Two"]
    # A folder set to nothing takes the deck out of it; left out, it stays.
    kept = ada.send("PATCH", f"/api/v1/decks/{one['id']}", {"title": "First"}).json()
    assert (kept["title"], kept["folder"], kept["tags"]) == ("First", "Tournament", ["Aggro"])
    cleared = ada.send("PATCH", f"/api/v1/decks/{one['id']}", {"folder": None, "tags": []}).json()
    assert (cleared["folder"], cleared["tags"]) == (None, [])
    both = {"deck_ids": [one["id"]], "folder": "A", "unfile": True}
    assert ada.send("POST", "/api/v1/decks/organize", both).status_code == 422
    many = [f"tag{n}" for n in range(12)]
    ada.send("POST", "/api/v1/decks/organize", {"deck_ids": [one["id"]], "add_tags": many})
    over = ada.send("POST", "/api/v1/decks/organize", {"deck_ids": [one["id"]], "add_tags": ["x"]})
    assert (over.status_code, over.json()["code"]) == (422, "too_many_tags")


def test_two_versions_are_compared_and_one_restored_without_changing_it(client):
    ada = Account(client, "ada")
    grant(client, ada.id, Lightning_Bolt=4, Mountain=60, Hill_Giant=4)
    deck = new_deck(ada, "Burn", burn(client, 4))
    path = f"/api/v1/decks/{deck['id']}"
    assert ada.send("POST", f"{path}/revisions").json()["number"] == 1
    later = [
        entry(client, "Lightning Bolt", 2),
        entry(client, "Hill Giant", 3),
        entry(client, "Mountain", 55),
    ]
    saved = ada.send("PUT", f"{path}/draft", {"version": 1, "entries": later})
    assert saved.status_code == 200, saved.text
    assert ada.send("POST", f"{path}/revisions").json()["number"] == 2
    diff = ada.get(f"{path}/diff", before="1", after="2").json()
    assert (diff["added"], diff["removed"], diff["same"]) == (3, 3, False)
    assert [
        (line["name"], line["location"], line["before"], line["after"]) for line in diff["lines"]
    ] == [
        ("Hill Giant", "main", 0, 3),
        ("Lightning Bolt", "main", 4, 2),
        ("Mountain", "main", 56, 55),
    ]
    # A version against the draft, by default; the same cards are no difference.
    assert ada.get(f"{path}/diff", before="2").json()["same"] is True
    assert ada.get(f"{path}/diff", before="9").status_code == 404
    assert ada.get(f"{path}/diff", before="first").status_code == 422
    with database(client) as db:
        first = revision_id(client, deck["id"], 1)
        before = [
            (row.concept_id, row.quantity, row.location)
            for row in db.scalars(select(DeckEntryRow).where(DeckEntryRow.revision_id == first))
        ]
    # A game played the first version; restoring it makes a new draft, and changes no version.
    game = played(
        client, [(ada.id, "Burn"), None], completed(0), fmt="legacy", revisions={0: first}
    )
    stale = ada.send("POST", f"{path}/revisions/1/restore", {"version": 1})
    assert (stale.status_code, stale.json()["code"]) == (409, "draft_conflict")
    restored = ada.send("POST", f"{path}/revisions/1/restore", {"version": 2})
    assert restored.status_code == 200, restored.text
    assert restored.json()["version"] == 3 and restored.json()["validation"]["playable"] is True
    assert ada.get(f"{path}/diff", before="1").json()["same"] is True
    with database(client) as db:
        after = [
            (row.concept_id, row.quantity, row.location)
            for row in db.scalars(select(DeckEntryRow).where(DeckEntryRow.revision_id == first))
        ]
        numbers = sorted(
            db.scalars(select(DeckRevision.number).where(DeckRevision.deck_id == UUID(deck["id"])))
        )
    assert sorted(after, key=str) == sorted(before, key=str) and numbers == [1, 2]
    assert ada.get(f"{path}/revisions/2").json()["number"] == 2
    # The game still names the version it played.
    assert ada.get(f"{path}/performance").json()["versions"][0]["number"] == 1
    assert game is not None
    assert ada.send("POST", f"{path}/revisions/7/restore", {"version": 3}).status_code == 404


def test_a_decks_results_are_counted_by_the_version_played(client):
    ada, bea = Account(client, "ada"), Account(client, "bea")
    grant(client, ada.id, Lightning_Bolt=4, Mountain=60)
    deck = new_deck(ada, "Burn", burn(client, 4))
    path = f"/api/v1/decks/{deck['id']}"
    ada.send("POST", f"{path}/revisions")
    ada.send("PUT", f"{path}/draft", {"version": 1, "entries": burn(client, 2)})
    ada.send("POST", f"{path}/revisions")
    one, two = revision_id(client, deck["id"], 1), revision_id(client, deck["id"], 2)
    empty = ada.get(f"{path}/performance").json()
    assert empty["record"] == {
        "games": 0,
        "wins": 0,
        "losses": 0,
        "draws": 0,
        "win_rate": None,
        "small_sample": True,
    }
    assert empty["versions"] == [] and empty["splits"] == []

    def play(revision: UUID, result: dict[str, Any], **options: Any) -> None:
        seats = options.pop("seats", [(ada.id, "Burn"), None])
        played(client, seats, result, fmt="legacy", revisions={0: revision}, **options)

    # Version 1: two wins and a loss against bots of skill 4, a win at a table against a player.
    play(one, completed(0), skill=4)
    play(one, completed(0), skill=4)
    play(one, completed(1), skill=4)
    play(one, completed(0), seats=[(ada.id, "Burn"), (bea.id, "x")], kind="table")
    # Version 2: a loss against bots of skill 6, a draw, and a game with no result.
    play(two, completed(1), skill=6)
    play(two, completed(None) | {"draw": True}, skill=6)
    play(two, {"kind": "interrupted", "winner_seat": None, "draw": False, "turns": 3})
    # Another deck's game, and a game of no deck, are not this deck's.
    played(client, [(ada.id, "x"), None], completed(0), fmt="legacy")
    found = ada.get(f"{path}/performance").json()
    assert found["record"] == {
        "games": 6,
        "wins": 3,
        "losses": 2,
        "draws": 1,
        "win_rate": 0.5,
        "small_sample": True,
    }
    assert [
        (v["number"], v["record"]["games"], v["record"]["wins"]) for v in found["versions"]
    ] == [
        (2, 2, 0),
        (1, 4, 3),
    ]
    splits = {
        (s["mode"], s["opposition"], s["bot_skill"]): (s["games"], s["wins"], s["win_rate"])
        for s in found["splits"]
    }
    assert splits == {
        ("practice", "bots", 4): (3, 2, 0.6667),
        ("practice", "bots", 6): (2, 0, 0.0),
        ("table", "players", None): (1, 1, 1.0),
    }
    assert all(s["format"] == "legacy" and s["small_sample"] for s in found["splits"])
    # It matches the results the games recorded, one by one.
    with database(client) as db:
        assert workshop.performance(db, db.get_one(Deck, UUID(deck["id"]))).record.games == 6
    assert bea.get(f"{path}/performance").status_code == 404


def test_the_wishlist_and_what_a_decks_library_lacks(client):
    ada, bea = Account(client, "ada"), Account(client, "bea")
    grant(client, ada.id, Lightning_Bolt=1, Mountain=56)
    deck = new_deck(ada, "Burn", burn(client, 4))
    assert deck["collection_locked"] is True
    path = f"/api/v1/decks/{deck['id']}"
    bolt, giant = card_id(client, "Lightning Bolt"), card_id(client, "Hill Giant")
    assert ada.get("/api/v1/me/wishlist").json() == {"wishes": []}
    wished = ada.send("PUT", f"/api/v1/me/wishlist/{bolt}", {"quantity": 3, "deck_id": deck["id"]})
    assert wished.status_code == 200, wished.text
    (wish,) = wished.json()["wishes"]
    assert (wish["card"]["name"], wish["quantity"], wish["deck_id"], wish["owned"]) == (
        "Lightning Bolt",
        3,
        deck["id"],
        1,
    )
    # One wish a card: wishing again changes it.
    ada.send("PUT", f"/api/v1/me/wishlist/{bolt}", {"quantity": 2})
    ada.send("PUT", f"/api/v1/me/wishlist/{giant}", {})
    assert [
        (w["card"]["name"], w["quantity"], w["deck_id"])
        for w in ada.get("/api/v1/me/wishlist").json()["wishes"]
    ] == [
        ("Lightning Bolt", 2, None),
        ("Hill Giant", 1, None),
    ]
    assert ada.send("PUT", f"/api/v1/me/wishlist/{uuid4()}", {}).status_code == 404
    hers = new_deck(bea, "Hers", [])
    other = ada.send("PUT", f"/api/v1/me/wishlist/{giant}", {"deck_id": hers["id"]})
    assert other.status_code == 404
    missing = ada.get(f"{path}/missing").json()
    assert (missing["missing"], missing["complete"]) == (3, False)
    (card,) = missing["cards"]
    assert (card["card"]["name"], card["needed"], card["owned"], card["missing"]) == (
        "Lightning Bolt",
        4,
        1,
        3,
    )
    assert (card["wished"], card["auctions"], card["packs"]) == (2, 0, [])
    # A wish for a deck outlives the deck, for no deck; the account's deletion takes its wishes.
    ada.send("PUT", f"/api/v1/me/wishlist/{bolt}", {"quantity": 3, "deck_id": deck["id"]})
    ada.send("DELETE", path)
    assert ada.send("DELETE", f"{path}/forever").status_code == 204
    with database(client) as db:
        rows = db.scalars(select(WishlistEntry).where(WishlistEntry.user_id == ada.id)).all()
        assert {row.deck_id for row in rows} == {None} and len(rows) == 2
    gone = ada.send("DELETE", f"/api/v1/me/wishlist/{giant}").json()
    assert [w["card"]["name"] for w in gone["wishes"]] == ["Lightning Bolt"]
    # A library that holds everything lacks nothing.
    full = new_deck(ada, "Lands", [entry(client, "Mountain", 56)])
    assert ada.get(f"/api/v1/decks/{full['id']}/missing").json()["complete"] is True


def test_substitutions_keep_to_what_is_owned_legal_and_in_the_colours(client):
    ada = Account(client, "ada")
    # Owned: a burn spell of two colours, a white removal spell, a creature, a land, and a card
    # the deck already holds every copy of. Not owned: Lightning Bolt, the card wanted.
    grant(
        client,
        ada.id,
        Mountain=60,
        Hill_Giant=4,
        Swords_to_Plowshares=1,
        Grizzly_Bears=2,
        Counterspell=1,
    )
    with database(client) as db:
        fire = db.scalar(select(CardConcept).where(CardConcept.name.like("Fire //%")))
        assert fire is not None and fire.default_printing_id is not None
        db.add(
            LibraryGrant(
                user_id=ada.id,
                concept_id=fire.id,
                printing_id=fire.default_printing_id,
                quantity=1,
                source="grandfathered",
                grant_key=f"grandfathered:test:{uuid4()}",
                created_at=utcnow(),
            )
        )
        db.commit()
    bolt = card_id(client, "Lightning Bolt")
    legacy = new_deck(
        ada, "Burn", [entry(client, "Counterspell", 1), entry(client, "Mountain", 59)]
    )
    found = ada.get(f"/api/v1/decks/{legacy['id']}/substitutions", card_id=bolt).json()
    names = [s["card"]["name"] for s in found["substitutes"]]
    # Ranked by what they share with the card: its tags (60), its type (25), its mana value (15).
    # Fire // Ice shares all three of the tags that say what Lightning Bolt does, and costs three
    # more; Swords to Plowshares shares two and costs the same. Grizzly Bears shares only a tag
    # about the cards' fame, and Hill Giant nothing: neither is offered.
    assert names == ["Fire // Ice", "Swords to Plowshares"]
    # A land is no substitute for a spell; the Counterspell the deck already holds every owned
    # copy of is not offered either.
    assert "Mountain" not in names and "Counterspell" not in names
    best, second = found["substitutes"][:2]
    assert (best["spare"], best["score"], second["score"]) == (1, 85, 80)
    assert best["reasons"] == [
        "Both: burn any, single target instant/sorcery, spot removal",
        "Also instant",
        "Mana value 4 against 1",
    ]
    assert second["reasons"] == [
        "Both: single target instant/sorcery, spot removal",
        "Also instant",
        "The same mana value, 1",
    ]
    scores = [s["score"] for s in found["substitutes"]]
    assert scores == sorted(scores, reverse=True) and all(0 < score <= 100 for score in scores)
    # In Commander only the commanders' colours: a red commander leaves out the white spell and
    # the red-blue one, and nothing else it owns is close; a five-colour commander has both.
    grant(client, ada.id, **{"Karlach, Fury of Avernus": 1, "Kenrith, the Returned King": 1})
    red = new_deck(
        ada,
        "Karlach",
        [entry(client, "Karlach, Fury of Avernus", 1, "commander"), entry(client, "Mountain", 60)],
        fmt="commander",
    )
    none = ada.get(f"/api/v1/decks/{red['id']}/substitutions", card_id=bolt).json()
    assert none["substitutes"] == [] and none["note"] == "Nothing you own is close enough to offer."
    five = new_deck(
        ada,
        "Kenrith",
        [
            entry(client, "Kenrith, the Returned King", 1, "commander"),
            entry(client, "Mountain", 60),
        ],
        fmt="commander",
    )
    all_colours = ada.get(f"/api/v1/decks/{five['id']}/substitutions", card_id=bolt).json()
    assert [s["card"]["name"] for s in all_colours["substitutes"]] == [
        "Fire // Ice",
        "Swords to Plowshares",
        "Counterspell",
    ]
    # A land for a land.
    lands = ada.get(
        f"/api/v1/decks/{legacy['id']}/substitutions", card_id=card_id(client, "Forest")
    ).json()
    assert all("Land" in s["card"]["type_line"] for s in lands["substitutes"])
    # SysOp has every card: nothing to substitute.
    root = Account(client, "sysop", kind="sysop")
    theirs = new_deck(root, "Any", burn(client))
    none = root.get(f"/api/v1/decks/{theirs['id']}/substitutions", card_id=bolt).json()
    assert none["substitutes"] == [] and "whole catalog" in none["note"]
    unknown = ada.get(f"/api/v1/decks/{legacy['id']}/substitutions", card_id=str(uuid4()))
    assert unknown.status_code == 404


def test_a_choice_goes_with_its_copy_from_the_draft_to_the_engine(client, monkeypatch):
    # The test catalog has no Cryptic Spires: Hill Giant stands for it.
    monkeypatch.setattr(validation, "CHOICE_CARDS", frozenset({"hill giant"}))
    monkeypatch.setattr(decks, "CHOICE_CARDS", frozenset({"hill giant"}))
    monkeypatch.setattr(deckio, "CHOICE_CARDS", frozenset({"hill giant"}))
    ada = Account(client, "ada")
    grant(client, ada.id, Mountain=60, Hill_Giant=4, Lightning_Bolt=4)
    temple, bolt = card_id(client, "Hill Giant"), card_id(client, "Lightning Bolt")
    # Two different colours, written one way; anything else is refused.
    assert DeckEntry(card_id=UUID(temple), quantity=1, choice="uw").choice == "WU"
    for wrong in ("W", "WW", "WUB", "WX"):
        with pytest.raises(ValidationError):
            DeckEntry(card_id=UUID(temple), quantity=1, choice=wrong)
    plain = DeckEntry(card_id=UUID(bolt), quantity=4)
    # A deck with no choice is written, and so hashed, as before v0.9.12.
    assert "choice" not in plain.kept() and plain.kept()["quantity"] == 4
    entries = [
        {"card_id": temple, "quantity": 2, "location": "main", "choice": "BW"},
        {"card_id": temple, "quantity": 1, "location": "main", "choice": "RG"},
        {"card_id": temple, "quantity": 1, "location": "main"},
        # A choice on a card that takes none is dropped.
        {"card_id": bolt, "quantity": 4, "location": "main", "choice": "WU"},
        entry(client, "Mountain", 52),
    ]
    deck = new_deck(ada, "Spires", entries)
    path = f"/api/v1/decks/{deck['id']}"
    kept = {
        (e["card_id"], e["choice"]): e["quantity"]
        for e in deck["draft"]["entries"]
        if e["card_id"] in (temple, bolt)
    }
    assert kept == {(temple, "WB"): 2, (temple, "RG"): 1, (temple, None): 1, (bolt, None): 4}
    # A copy with no choice keeps the deck from playing, and says why.
    assert deck["validation"]["legal"] is False
    (problem,) = [p for p in deck["validation"]["errors"] if p["code"] == "choice.missing"]
    assert "two colours" in problem["message"] and problem["card_ids"] == [temple]
    fixed = [e for e in entries if e.get("choice") or e["card_id"] != temple]
    fixed.append({"card_id": temple, "quantity": 1, "location": "main", "choice": "RG"})
    saved = ada.send("PUT", f"{path}/draft", {"version": 1, "entries": fixed}).json()
    assert saved["validation"]["playable"] is True
    # The version keeps it, and so does the engine's deck list.
    assert ada.send("POST", f"{path}/revisions").json()["number"] == 1
    with database(client) as db:
        rows = db.scalars(
            select(DeckEntryRow).where(
                DeckEntryRow.revision_id == revision_id(client, deck["id"], 1)
            )
        ).all()
        assert sorted(
            (row.choice or "", row.quantity) for row in rows if str(row.concept_id) == temple
        ) == [
            ("RG", 2),
            ("WB", 2),
        ]
        revision = db.get_one(DeckRevision, revision_id(client, deck["id"], 1))
        held = decks.revision_entries(db, revision)
        assert {e.choice for e in held if str(e.card_id) == temple} == {"WB", "RG"}
    started = ada.send(
        "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck["id"]}
    )
    assert started.status_code == 201, started.text
    with database(client) as db:
        from api.models import GameSeat

        seat = db.scalars(
            select(GameSeat).where(
                GameSeat.game_id == UUID(started.json()["id"]), GameSeat.seat == 0
            )
        ).one()
        cards = {
            (card["name"], card.get("choice")): card["count"]
            for card in seat.deck_list["cards"]  # type: ignore[index, union-attr]
        }
    assert cards[("Hill Giant", "WB")] == 2 and cards[("Hill Giant", "RG")] == 2
    assert cards[("Lightning Bolt", None)] == 4
    ada.send("POST", f"/api/v1/games/{started.json()['id']}/close", {})
    # Exported and imported again, as text and as a file.
    text = ada.get(f"{path}/export", kind="text").text
    assert "2 Hill Giant" in text and "<WB>" in text and "<RG>" in text
    preview = ada.send(
        "POST", "/api/v1/decks/import/preview", {"format": "legacy", "text": text}
    ).json()
    chosen = {(line["name"], line["choice"]): line["quantity"] for line in preview["lines"]}
    assert chosen[("Hill Giant", "WB")] == 2 and chosen[("Lightning Bolt", None)] == 4
    exported = ada.get(f"{path}/export", kind="json").json()
    assert {e.get("choice") for e in exported["entries"] if e["name"] == "Hill Giant"} == {
        "WB",
        "RG",
    }
    # A typed deck list names it the same way; a sideboard plan keeps each copy's.
    typed = decklists.parse_deck_list("2 Hill Giant <bw>\n58 Mountain\n", "legacy")
    assert {"name": "Hill Giant", "count": 2, "choice": "WB"} in typed["cards"]  # type: ignore[operator]
    with pytest.raises(Exception, match="two different colours"):
        decklists.parse_deck_list("1 Hill Giant <WW>\n", "legacy")
    source = [
        DeckEntry(card_id=UUID(temple), quantity=2, choice="WB"),
        DeckEntry(card_id=UUID(temple), quantity=1, location="sideboard", choice="RG"),
    ]
    plan = [
        DeckEntry(card_id=UUID(temple), quantity=1),
        DeckEntry(card_id=UUID(temple), quantity=2, location="sideboard"),
    ]
    arranged = matches.with_choices(plan, source)
    assert sorted((e.location, e.choice, e.quantity) for e in arranged) == [
        ("main", "WB", 1),
        ("sideboard", "RG", 1),
        ("sideboard", "WB", 1),
    ]
    assert matches.arranged(matches.arrangement_of(arranged)) == [
        e for e in arranged if e.location == "main"
    ] + [e for e in arranged if e.location == "sideboard"]
