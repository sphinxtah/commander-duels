"""Friend deck lending (v1.0.0, api/loans.py): a deck offered to a friend, looked at, accepted
and given back; played only at a private table where its lender sits; and, as a real deck
handed over, lent to one friend at a time and not its owner's to play meanwhile (the owner's
decisions of 2026-11-15). Behind the gate deck_lending."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session
from test_tables import Account, card, client, content, deck, engine, until_finished, url

from api.models import AccessGrant, Game, GameSeat

__all__ = ["client", "content", "engine", "url"]


def staged(client: TestClient, stage: str = "on") -> Account:
    """The workflow at a stage, set by the installation's SysOp."""
    root = Account(client, "root-" + uuid.uuid4().hex[:8], kind="sysop")
    changed = root.send("PUT", "/api/v1/admin/rollout/deck_lending", {"stage": stage})
    assert changed.status_code == 200, changed.text
    return root


def befriend(one: Account, other: Account) -> None:
    assert one.send("PUT", f"/api/v1/friends/{other.id}").status_code == 200
    assert other.send("PUT", f"/api/v1/friends/{one.id}").json()["friendship"] == "friends"


def bolts(account: Account, client: TestClient, title: str = "Bolts") -> str:
    """A deck only an account that builds from the whole catalog can play: its Lightning Bolts
    are in no player's library here."""
    made = account.send(
        "POST",
        "/api/v1/decks",
        {
            "title": title,
            "format": "legacy",
            "entries": [
                {"card_id": card(client, "Lightning Bolt"), "quantity": 4, "location": "main"},
                {"card_id": card(client, "Mountain"), "quantity": 56, "location": "main"},
            ],
        },
    ).json()
    assert made["playable"] is True, made
    return str(made["id"])


def people(client: TestClient) -> tuple[Account, Account, Account]:
    """A lender who holds every card, a friend with a library of their own, and a stranger."""
    tag = uuid.uuid4().hex[:6]
    ada = Account(client, f"ada{tag}", admin=True)
    bob = Account(client, f"bob{tag}")
    eve = Account(client, f"eve{tag}")
    for account, name in ((ada, "ada"), (bob, "bob"), (eve, "eve")):
        account.handle = f"{name}{tag}"
    befriend(ada, bob)
    return ada, bob, eve


def offer(lender: Account, deck_id: str, friend: Account) -> Any:
    return lender.send("POST", f"/api/v1/decks/{deck_id}/loans", {"player_id": str(friend.id)})


def table(host: Account, deck_id: str, **extra: Any) -> Any:
    return host.send("POST", "/api/v1/tables", {"format": "legacy", "deck_id": deck_id} | extra)


def join(player: Account, code: str, deck_id: str) -> Any:
    return player.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": deck_id})


def close(host: Account, code: str) -> None:
    assert host.send("POST", f"/api/v1/tables/{code}/leave").status_code == 200


def test_a_deck_is_offered_looked_at_accepted_and_given_back(client, engine):
    staged(client)
    ada, bob, eve = people(client)
    lent = bolts(ada, client, "Burn to lend")

    # Lent to a friend, and to nobody else.
    refused = offer(ada, lent, eve)
    assert (refused.status_code, refused.json()["code"]) == (403, "not_a_friend")
    made = offer(ada, lent, bob)
    assert made.status_code == 201, made.text
    loan = made.json()
    assert loan["state"] == "offered" and loan["yours"] is True
    assert loan["deck"] == {
        "id": lent,
        "title": "Burn to lend",
        "format": "legacy",
        "version": 1,
        "card_count": 60,
        "commanders": [],
    }
    assert loan["lender"]["handle"] == ada.handle and loan["borrower"]["handle"] == bob.handle
    week = datetime.now(UTC) + timedelta(days=7)
    until = datetime.fromisoformat(loan["until"])
    assert abs((until.replace(tzinfo=UTC) - week).total_seconds()) < 60

    # One friend at a time: the same deck is not offered twice.
    again = offer(ada, lent, bob)
    assert (again.status_code, again.json()["code"]) == (409, "already_lent")
    assert "already offered to" in again.json()["message"]

    # The friend is told, sees it among the decks offered to them, and nobody else does.
    bell = bob.get("/api/v1/notifications").json()["items"]
    told = next(item for item in bell if item["kind"] == "deck_offered")
    assert told["actor"]["handle"] == ada.handle
    assert [found["id"] for found in bob.get("/api/v1/loans").json()["taken"]] == [loan["id"]]
    assert bob.get("/api/v1/loans").json()["taken"][0]["yours"] is False
    mine = ada.get("/api/v1/loans").json()
    assert [found["id"] for found in mine["given"]] == [loan["id"]] and mine["taken"] == []
    assert (mine["days"], mine["limit"]) == (7, 20)
    assert ada.get(f"/api/v1/decks/{lent}/loans").json()[0]["id"] == loan["id"]
    assert eve.get("/api/v1/loans").json() == {"given": [], "taken": [], "days": 7, "limit": 20}
    assert eve.get(f"/api/v1/loans/{loan['id']}/deck").status_code == 404
    assert eve.send("POST", f"/api/v1/loans/{loan['id']}/accept").status_code == 404

    # The friend looks at the list before answering: the version the loan is of.
    looked = bob.get(f"/api/v1/loans/{loan['id']}/deck")
    assert looked.status_code == 200, looked.text
    bolt = card(client, "Lightning Bolt")
    assert {(e["card_id"], e["quantity"]) for e in looked.json()["entries"]} == {
        (bolt, 4),
        (card(client, "Mountain"), 56),
    }
    assert looked.json()["cards"][bolt]["name"] == "Lightning Bolt"

    # An offer keeps nothing from its owner: the deck is still theirs to play.
    opened = table(ada, lent, visibility="private")
    assert opened.status_code == 201, opened.text
    close(ada, opened.json()["code"])

    # Accepted, it is with the friend for seven days, and not its owner's to play.
    accepted = bob.send("POST", f"/api/v1/loans/{loan['id']}/accept")
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["taken"][0]["state"] == "accepted"
    assert bob.send("POST", f"/api/v1/loans/{loan['id']}/accept").status_code == 409
    kept = table(ada, lent, visibility="private")
    assert (kept.status_code, kept.json()["code"]) == (409, "deck_lent")
    assert f"is lent to {bob.handle} until" in kept.json()["message"]
    practice = ada.send(
        "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": lent, "bots": [{}]}
    )
    assert (practice.status_code, practice.json()["code"]) == (409, "deck_lent")

    # What was lent is one version: the owner's later edits change nothing of the loan.
    draft = ada.get(f"/api/v1/decks/{lent}").json()["draft"]
    changed = ada.send(
        "PUT",
        f"/api/v1/decks/{lent}/draft",
        {
            "version": draft["version"],
            "entries": [{"card_id": card(client, "Mountain"), "quantity": 60, "location": "main"}],
        },
    )
    assert changed.status_code == 200, changed.text
    after = bob.get(f"/api/v1/loans/{loan['id']}/deck").json()
    assert after["loan"]["deck"]["version"] == 1
    assert {e["card_id"] for e in after["entries"]} == {bolt, card(client, "Mountain")}

    # Given back, it is its owner's to play and to lend again.
    back = bob.send("DELETE", f"/api/v1/loans/{loan['id']}")
    assert back.status_code == 200 and back.json()["taken"] == []
    assert ada.get("/api/v1/loans").json()["given"] == []
    reopened = table(ada, lent, visibility="private")
    assert reopened.status_code == 201, reopened.text
    close(ada, reopened.json()["code"])
    assert offer(ada, lent, bob).status_code == 201


def test_a_borrowed_deck_is_played_only_at_a_private_table_with_its_lender(client, engine):
    staged(client)
    ada, bob, eve = people(client)
    lent = bolts(ada, client, "Burn to lend")
    own = bolts(ada, client, "Ada's own")
    loan = offer(ada, lent, bob).json()

    # Not before it is accepted.
    private = table(ada, own, visibility="private").json()["code"]
    early = join(bob, private, lent)
    assert (early.status_code, early.json()["code"]) == (422, "invalid_deck")
    assert bob.send("POST", f"/api/v1/loans/{loan['id']}/accept").status_code == 200
    close(ada, private)

    # Not to open a table with, not at a public table, not where its lender does not sit.
    alone = table(bob, lent, visibility="private")
    assert (alone.status_code, alone.json()["code"]) == (409, "borrowed_deck")
    public = table(ada, own, visibility="public").json()["code"]
    listed = join(bob, public, lent)
    assert (listed.status_code, listed.json()["code"]) == (409, "borrowed_deck")
    close(ada, public)
    elsewhere = table(eve, deck(eve, client), visibility="private").json()["code"]
    away = join(bob, elsewhere, lent)
    assert (away.status_code, away.json()["code"]) == (409, "borrowed_deck")
    assert "Its lender is not at this table." in away.json()["message"]
    close(eve, elsewhere)

    # At a private table where its lender sits: seated, and said to the table as borrowed.
    code = table(ada, own, visibility="private").json()["code"]
    sat = join(bob, code, lent)
    assert sat.status_code == 200, sat.text
    mine = next(player for player in sat.json()["players"] if player["you"])
    assert (mine["borrowed"], mine["deck"], mine["deck_id"]) == (True, "Burn to lend", lent)
    seen = ada.get(f"/api/v1/tables/{code}").json()["players"]
    theirs = next(player for player in seen if player["handle"] == bob.handle)
    # The lender's own seat is not borrowed; the friend's deck stays private to the table.
    assert (theirs["borrowed"], theirs["deck"], theirs["deck_id"]) == (True, None, None)
    assert next(player for player in seen if player["you"])["borrowed"] is False

    # The game plays the version that was lent, and is of the borrowed mode.
    assert bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True}).status_code == 200
    started = ada.send("POST", f"/api/v1/tables/{code}/start")
    assert started.status_code == 200, started.text
    game_id = started.json()["game_id"]
    with Session(client.app.state.database) as db:
        game = db.get(Game, uuid.UUID(game_id))
        assert game is not None and game.mode == "borrowed"
        seat = db.scalar(
            select(GameSeat).where(GameSeat.game_id == game.id, GameSeat.user_id == bob.id)
        )
        grant = db.get(AccessGrant, uuid.UUID(loan["id"]))
        assert seat is not None and grant is not None
        assert str(seat.deck_revision_id) == grant.scope["revision"]
    sent = engine.created[-1]["seats"][1]["deck_list"]["cards"]
    assert {"name": "Lightning Bolt", "count": 4} in sent

    # Taken back after the start: the loan ends, and the game plays on as it started.
    assert ada.send("DELETE", f"/api/v1/loans/{loan['id']}").status_code == 200
    assert bob.get("/api/v1/loans").json()["taken"] == []
    assert bob.get(f"/api/v1/games/{game_id}").json()["game"]["status"] == "active"


def test_a_loan_taken_back_or_run_out_seats_nothing_and_frees_its_owner(client, engine):
    staged(client)
    ada, bob, _ = people(client)
    lent = bolts(ada, client, "Burn to lend")
    own = bolts(ada, client, "Ada's own")
    loan = offer(ada, lent, bob).json()
    assert bob.send("POST", f"/api/v1/loans/{loan['id']}/accept").status_code == 200
    code = table(ada, own, visibility="private").json()["code"]
    assert join(bob, code, lent).status_code == 200
    assert bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True}).status_code == 200

    # The lender takes it back before the start: the host cannot start with it.
    assert ada.send("DELETE", f"/api/v1/loans/{loan['id']}").status_code == 200
    refused = ada.send("POST", f"/api/v1/tables/{code}/start")
    assert (refused.status_code, refused.json()["code"]) == (409, "deck_not_playable")
    assert bob.handle in refused.json()["message"]
    again = bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True})
    assert (again.status_code, again.json()["code"]) == (422, "invalid_deck")
    close(ada, code)

    # A loan runs out by itself after its seven days.
    second = offer(ada, lent, bob).json()
    assert bob.send("POST", f"/api/v1/loans/{second['id']}/accept").status_code == 200
    assert table(ada, lent, visibility="private").json()["code"] == "deck_lent"
    with Session(client.app.state.database) as db:
        db.execute(
            update(AccessGrant)
            .where(AccessGrant.id == uuid.UUID(second["id"]))
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        db.commit()
    assert bob.get("/api/v1/loans").json()["taken"] == []
    assert ada.get("/api/v1/loans").json()["given"] == []
    freed = table(ada, lent, visibility="private")
    assert freed.status_code == 201, freed.text
    late = join(bob, freed.json()["code"], lent)
    assert (late.status_code, late.json()["code"]) == (422, "invalid_deck")
    close(ada, freed.json()["code"])


def test_only_a_playable_deck_is_lent_and_only_through_the_open_gate(client, engine):
    root = staged(client)
    ada, bob, _ = people(client)
    # A deck its owner cannot play is not lent: bob's library holds no Lightning Bolt.
    befriend(bob, root)
    unplayable = bob.send(
        "POST",
        "/api/v1/decks",
        {
            "title": "Not mine to lend",
            "format": "legacy",
            "entries": [
                {"card_id": card(client, "Lightning Bolt"), "quantity": 4, "location": "main"},
                {"card_id": card(client, "Mountain"), "quantity": 56, "location": "main"},
            ],
        },
    ).json()
    refused = offer(bob, unplayable["id"], ada)
    assert (refused.status_code, refused.json()["code"]) == (422, "deck_not_playable")
    # Nor another player's deck.
    lent = bolts(ada, client)
    assert offer(bob, lent, ada).status_code == 404

    # A loan made while the gate was open gives nothing once it is closed, and keeps nothing
    # from its owner; the routes answer as paths that do not exist.
    loan = offer(ada, lent, bob).json()
    assert bob.send("POST", f"/api/v1/loans/{loan['id']}/accept").status_code == 200
    assert (
        root.send("PUT", "/api/v1/admin/rollout/deck_lending", {"stage": "off"}).status_code == 200
    )
    assert bob.get("/api/v1/loans").status_code == 404
    assert offer(ada, lent, bob).status_code == 404
    opened = table(ada, lent, visibility="private")
    assert opened.status_code == 201, opened.text
    late = join(bob, opened.json()["code"], lent)
    assert (late.status_code, late.json()["code"]) == (422, "invalid_deck")
    close(ada, opened.json()["code"])
    # At staff, only SysOp and administrators reach it: a player's loan still seats nothing.
    assert (
        root.send("PUT", "/api/v1/admin/rollout/deck_lending", {"stage": "staff"}).status_code
        == 200
    )
    assert bob.get("/api/v1/loans").status_code == 404
    assert ada.get("/api/v1/loans").status_code == 200
    assert (
        root.send("PUT", "/api/v1/admin/rollout/deck_lending", {"stage": "on"}).status_code == 200
    )


def test_a_rematch_plays_the_borrowed_deck_again_while_the_loan_stands(client, engine):
    staged(client)
    ada, bob, _ = people(client)
    lent = bolts(ada, client, "Burn to lend")
    own = bolts(ada, client, "Ada's own")
    loan = offer(ada, lent, bob).json()
    assert bob.send("POST", f"/api/v1/loans/{loan['id']}/accept").status_code == 200
    code = table(ada, own, visibility="private").json()["code"]
    assert join(bob, code, lent).status_code == 200
    assert bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True}).status_code == 200
    game_id = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
    with engine.lock:
        engine.games[game_id].concede(1)
    until_finished(ada, game_id)

    # Everyone accepts: the same decks again, the borrowed one as the loan has it.
    assert ada.send("POST", f"/api/v1/games/{game_id}/rematch").status_code == 200
    again = bob.send("POST", f"/api/v1/games/{game_id}/rematch")
    assert again.status_code == 200, again.text
    second = again.json()["game_id"]
    assert again.json()["status"] == "started" and second not in (None, game_id)
    with Session(client.app.state.database) as db:
        game = db.get(Game, uuid.UUID(second))
        assert game is not None and game.mode == "borrowed"
        seat = db.scalar(
            select(GameSeat).where(GameSeat.game_id == game.id, GameSeat.user_id == bob.id)
        )
        grant = db.get(AccessGrant, uuid.UUID(loan["id"]))
        assert seat is not None and grant is not None
        assert str(seat.deck_revision_id) == grant.scope["revision"]
    sent = engine.created[-1]["seats"][1]["deck_list"]["cards"]
    assert {"name": "Lightning Bolt", "count": 4} in sent
    borrowed = next(
        player
        for player in ada.get(f"/api/v1/tables/{table_code(client, second)}").json()["players"]
        if player["handle"] == bob.handle
    )
    assert borrowed["borrowed"] is True

    # Once the loan has ended, the next rematch does not start: the deck is its owner's again.
    with engine.lock:
        engine.games[second].concede(1)
    until_finished(ada, second)
    assert bob.send("DELETE", f"/api/v1/loans/{loan['id']}").status_code == 200
    assert ada.send("POST", f"/api/v1/games/{second}/rematch").status_code == 200
    refused = bob.send("POST", f"/api/v1/games/{second}/rematch")
    assert (refused.status_code, refused.json()["code"]) == (422, "invalid_deck")
    failed = ada.get(f"/api/v1/games/{second}/rematch").json()
    assert failed["status"] == "failed" and bob.handle in failed["message"]


def test_a_loan_between_two_who_block_each_other_gives_nothing_and_is_shown_to_nobody(
    client, engine
):
    staged(client)
    ada, bob, eve = people(client)
    befriend(ada, eve)
    lent = bolts(ada, client, "Burn to lend")
    loan = offer(ada, lent, bob).json()
    assert bob.send("POST", f"/api/v1/loans/{loan['id']}/accept").status_code == 200
    assert table(ada, lent, visibility="private").json()["code"] == "deck_lent"

    assert ada.send("PUT", f"/api/v1/blocks/{bob.id}").status_code == 200
    assert ada.get("/api/v1/loans").json()["given"] == []
    assert bob.get("/api/v1/loans").json()["taken"] == []
    # Its owner plays it again, and lends it to another friend: the dead loan ends there.
    opened = table(ada, lent, visibility="private")
    assert opened.status_code == 201, opened.text
    close(ada, opened.json()["code"])
    assert offer(ada, lent, eve).status_code == 201
    with Session(client.app.state.database) as db:
        dead = db.get(AccessGrant, uuid.UUID(loan["id"]))
        assert dead is not None and dead.revoked_at is not None


def table_code(client: TestClient, game_id: str) -> str:
    from api.models import GameTable

    with Session(client.app.state.database) as db:
        found = db.scalar(select(GameTable.code).where(GameTable.game_id == uuid.UUID(game_id)))
    assert found is not None
    return str(found)


def test_a_best_of_three_match_keeps_a_borrowed_deck_and_its_mode_to_its_end(client, engine):
    from test_matches import arrange, arrangement, end, legacy_deck, ready, swap, until

    staged(client)
    ada, bob, _ = people(client)
    lent = legacy_deck(
        ada, client, {"Mountain": 56, "Lightning Bolt": 4}, {"Hill Giant": 3}, "Burn to lend"
    )
    own = bolts(ada, client, "Ada's own")
    loan = offer(ada, lent, bob).json()
    assert bob.send("POST", f"/api/v1/loans/{loan['id']}/accept").status_code == 200
    code = table(ada, own, visibility="private", best_of=3).json()["code"]
    assert join(bob, code, lent).status_code == 200
    assert bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True}).status_code == 200
    first = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
    match_id = bob.get(f"/api/v1/games/{first}").json()["game"]["match"]["id"]

    # Between games the friend sideboards the borrowed deck, whose cards they do not own: it
    # is checked against its lender's library, as it was when the match started.
    end(engine, first, 0)
    found = until(bob, match_id, status="sideboarding")
    swapped = arrange(bob, match_id, swap(found, 1, {"Lightning Bolt": -1, "Hill Giant": 1}))
    assert swapped.status_code == 200, swapped.text
    assert arrangement(swapped.json(), 1)["Hill Giant"] == (1, 2)

    # The loan ends between games: the match's decks are bound, and it plays on as borrowed.
    assert ada.send("DELETE", f"/api/v1/loans/{loan['id']}").status_code == 200
    ready(bob, match_id, play_first=True)
    second = ready(ada, match_id)["game_id"]
    assert second not in (None, first)
    sent = {
        line["name"]: line["count"] for line in engine.created[-1]["seats"][1]["deck_list"]["cards"]
    }
    assert (sent["Lightning Bolt"], sent["Hill Giant"]) == (3, 1)
    with Session(client.app.state.database) as db:
        modes = [
            game.mode
            for game in (db.get(Game, uuid.UUID(found)) for found in (first, second))
            if game is not None
        ]
    assert modes == ["borrowed", "borrowed"]
