"""Best-of-three Legacy matches (v0.5.0) through the API, against the fake engine of the table
tests: a match's games each their own, every game won counting and paying once, the score, the
end at two game wins, a draw, games without a result, the cap of five games, conceding a game
and conceding the match, a player removed while away, sideboarding against the locked pool and
the library, the loser's choice to play or draw, the sideboarding's clock, the next game waiting
for a slot, and the limit of running games. No answer or frame another player receives may name a
player's arrangement."""

import json
import time
import uuid
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Any

import pytest
import test_progression
import test_tables
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import Session
from test_tables import Account, TableEngine, card, opened, served

from api import accounts, economy, games, matches
from api.identity import utcnow
from api.models import CardConcept, Game, LibraryGrant, Match, MatchPlayer, TokenEntry, User

content = test_progression.content
url = test_tables.url


@contextmanager
def serving(url: str, content: Path, engine: TableEngine, **settings: Any) -> Iterator[TestClient]:
    try:
        with served(url, content, engine, **settings) as client:
            yield client
    finally:
        database = create_engine(url)
        with Session(database) as db:
            for table in ("match_players", "matches"):
                db.execute(text(f"DELETE FROM {table}"))
            db.commit()
        database.dispose()


@pytest.fixture
def engine() -> TableEngine:
    return TableEngine()


@pytest.fixture
def client(url: str, content: Path, engine: TableEngine) -> Iterator[TestClient]:
    with serving(url, content, engine) as client:
        yield client


def legacy_deck(
    account: Account,
    client: TestClient,
    main: dict[str, int],
    sideboard: dict[str, int] | None = None,
    title: str = "Red",
) -> str:
    entries = [
        {"card_id": card(client, name), "quantity": count, "location": "main"}
        for name, count in main.items()
    ] + [
        {"card_id": card(client, name), "quantity": count, "location": "sideboard"}
        for name, count in (sideboard or {}).items()
    ]
    made = account.send(
        "POST", "/api/v1/decks", {"title": title, "format": "legacy", "entries": entries}
    ).json()
    assert made["playable"] is True, made
    return str(made["id"])


def red(account: Account, client: TestClient) -> str:
    """56 Mountains and 4 Lightning Bolts, with 3 Hill Giants in the sideboard."""
    return legacy_deck(
        account, client, {"Mountain": 56, "Lightning Bolt": 4}, {"Hill Giant": 3}, "Red"
    )


def practice_match(account: Account, deck_id: str) -> dict[str, Any]:
    made = account.send(
        "POST",
        "/api/v1/practice-games",
        {"format": "legacy", "deck_id": deck_id, "best_of": 3},
    )
    assert made.status_code == 201, made.text
    return made.json()  # type: ignore[no-any-return]


def end(engine: TableEngine, game_id: str, winner: int | None, kind: str = "completed") -> None:
    """The fake engine ends a game: a winner, a draw (no winner, completed) or another result."""
    fake = engine.games[game_id]
    with engine.lock:
        fake.result = {
            "kind": kind,
            "winner_seat": winner,
            "draw": winner is None and kind == "completed",
            "turns": 5,
            "conceded_seats": [],
            "error": None,
        }
        fake.revision += 1


def match_of(account: Account, match_id: str) -> dict[str, Any]:
    found = account.get(f"/api/v1/matches/{match_id}")
    assert found.status_code == 200, found.text
    return found.json()  # type: ignore[no-any-return]


def until(account: Account, match_id: str, **wanted: Any) -> dict[str, Any]:
    """The match once its fields have the wanted values."""
    for _ in range(300):
        found = match_of(account, match_id)
        if all(found[key] == value for key, value in wanted.items()):
            return found
        time.sleep(0.02)
    raise AssertionError(f"match {match_id} never had {wanted}: {found}")


def wins(found: dict[str, Any]) -> list[int]:
    return [player["game_wins"] for player in found["players"]]


def ready(account: Account, match_id: str, **body: Any) -> dict[str, Any]:
    answer = account.send("POST", f"/api/v1/matches/{match_id}/ready", {"ready": True} | body)
    assert answer.status_code == 200, answer.text
    return answer.json()  # type: ignore[no-any-return]


def arrange(account: Account, match_id: str, cards: list[dict[str, Any]]) -> Any:
    return account.send("PUT", f"/api/v1/matches/{match_id}/sideboard", {"cards": cards})


def arrangement(found: dict[str, Any], seat: int) -> dict[str, tuple[int, int]]:
    cards = found["players"][seat]["deck_cards"]["cards"]
    return {entry["name"]: (entry["main"], entry["sideboard"]) for entry in cards}


def swap(found: dict[str, Any], seat: int, moves: dict[str, int]) -> list[dict[str, Any]]:
    """The seat's arrangement with each named card moved by a count: into the main deck when
    positive, out to the sideboard when negative."""
    cards = []
    for entry in found["players"][seat]["deck_cards"]["cards"]:
        moved = moves.get(entry["name"], 0)
        cards.append(
            {
                "card_id": entry["card_id"],
                "printing_id": entry["printing_id"],
                "main": entry["main"] + moved,
                "sideboard": entry["sideboard"] - moved,
            }
        )
    return cards


def deck_list(body: dict[str, Any], seat: int) -> dict[str, Any]:
    return body["seats"][seat]["deck_list"]  # type: ignore[no-any-return]


def counted(entries: list[dict[str, Any]]) -> dict[str, int]:
    return {entry["name"]: entry["count"] for entry in entries}


def counted_wins(account: Account) -> int:
    return int(account.get("/api/v1/me/progress").json()["counted_wins"])


def running(client: TestClient, account: Account) -> int:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return games.active_games_of(db, account.id)


def test_a_practice_match_won_two_games_to_none(client, engine):
    ada = Account(client, "ada", admin=True)
    started = practice_match(ada, red(ada, client))
    first = started["id"]
    assert started["match"]["game"] == 1 and started["match"]["status"] == "playing"
    assert started["match"]["wins"] == [0, 0] and started["match"]["best_of"] == 3
    match_id = started["match"]["id"]
    # The first game: the player's main deck, with its sideboard outside the game for wishes, and
    # the engine drawing who chooses to start.
    body = engine.created[-1]
    assert "starting_seat" not in body
    assert counted(deck_list(body, 0)["cards"]) == {"Mountain": 56, "Lightning Bolt": 4}
    assert counted(deck_list(body, 0)["sideboard"]) == {"Hill Giant": 3}
    listed = ada.get("/api/v1/matches").json()
    assert [found["id"] for found in listed] == [match_id]
    assert all(player["deck_cards"] is None for player in listed[0]["players"])

    # She wins the first game: it counts and pays as a single game does.
    end(engine, first, 0)
    found = until(ada, match_id, status="sideboarding")
    assert wins(found) == [1, 0] and found["game_number"] == 2
    # The bot lost, so it chooses: bots play first. The bot is ready; she is not.
    assert (found["chooser_seat"], found["starting_seat"]) == (1, 1)
    assert [player["ready"] for player in found["players"]] == [False, True]
    assert found["games"][0]["tokens"] == economy.BOT_TOKENS[4]
    assert counted_wins(ada) == 1
    assert arrangement(found, 0) == {
        "Hill Giant": (0, 3),
        "Lightning Bolt": (4, 0),
        "Mountain": (56, 0),
    }
    assert found["players"][1]["deck_cards"] is None
    summary = ada.get(f"/api/v1/games/{first}").json()["game"]
    assert summary["match"] | {"id": None} == {
        "id": None,
        "best_of": 3,
        "game": 1,
        "status": "sideboarding",
        "wins": [1, 0],
        "winner_seat": None,
        "draw": False,
    }
    # A match counts as one running game, between its games too.
    assert running(client, ada) == 1

    # She sideboards two Giants in for two Bolts, and is ready: the next game starts at once.
    saved = arrange(ada, match_id, swap(found, 0, {"Hill Giant": 2, "Lightning Bolt": -2}))
    assert saved.status_code == 200, saved.text
    assert arrangement(saved.json(), 0)["Hill Giant"] == (2, 1)
    second = ready(ada, match_id)
    assert second["status"] == "playing" and second["game_id"] not in (None, first)
    body = engine.created[-1]
    assert body["starting_seat"] == 1
    assert counted(deck_list(body, 0)["cards"]) == {
        "Mountain": 56,
        "Lightning Bolt": 2,
        "Hill Giant": 2,
    }
    assert counted(deck_list(body, 0)["sideboard"]) == {"Lightning Bolt": 2, "Hill Giant": 1}
    # The bot keeps the deck it played first.
    assert body["seats"][1] == {"player": "bot", "deck": engine.games[first].decks[1]}
    state = ada.get(f"/api/v1/games/{second['game_id']}").json()
    assert state["game"]["match"]["game"] == 2 and state["game"]["match"]["wins"] == [1, 0]

    # She wins again: two game wins take the match.
    end(engine, second["game_id"], 0)
    done = until(ada, match_id, status="finished")
    assert (done["winner_seat"], done["end_reason"], wins(done)) == (0, "games", [2, 0])
    assert [game["game"] for game in done["games"]] == [1, 2]
    assert counted_wins(ada) == 2
    assert running(client, ada) == 0
    with Session(client.app.state.database) as db:
        paid = db.scalars(select(TokenEntry).where(TokenEntry.user_id == ada.id)).all()
        assert sorted(entry.kind for entry in paid if entry.game_id) == ["bot_win", "bot_win"]
        # A replayed end pays and counts nothing more.
        games.record_end(
            client.app.state.database, uuid.UUID(second["game_id"]), "finished", {"winner_seat": 0}
        )
        assert db.scalar(
            select(func.count()).select_from(TokenEntry).where(TokenEntry.user_id == ada.id)
        ) == len(paid)
    assert counted_wins(ada) == 2
    assert wins(match_of(ada, match_id)) == [2, 0]
    # The profile's record counts the match once, beside its two games.
    stats = ada.get("/api/v1/me/stats").json()
    assert stats["matches"] == {"games": 1, "wins": 1, "losses": 0, "draws": 0, "no_result": 0}
    assert (stats["totals"]["games"], stats["totals"]["wins"]) == (2, 2)


def test_a_table_match_won_two_to_one_with_the_losers_choice(client, engine, monkeypatch):
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    ada_deck = red(ada, client)
    bob_deck = legacy_deck(
        bob, client, {"Mountain": 60}, {"Swords to Plowshares": 2}, title="Secret plan"
    )
    made = ada.send(
        "POST", "/api/v1/tables", {"format": "legacy", "best_of": 3, "deck_id": ada_deck}
    )
    assert made.status_code == 201 and made.json()["best_of"] == 3, made.text
    code = made.json()["code"]
    bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": bob_deck})
    bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True})
    first = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
    summary = bob.get(f"/api/v1/games/{first}").json()["game"]
    match_id = summary["match"]["id"]
    assert engine.created[-1]["idle_timeout_seconds"] == games.TABLE_IDLE_SECONDS

    # Ada wins the first game; Bob lost, so he chooses: he draws, and Ada plays first.
    end(engine, first, 0)
    found = until(bob, match_id, status="sideboarding")
    assert found["chooser_seat"] == 1 and found["starting_seat"] is None
    refused = ada.send("POST", f"/api/v1/matches/{match_id}/ready", {"play_first": True})
    assert (refused.status_code, refused.json()["code"]) == (409, "not_chooser")
    assert ready(bob, match_id, play_first=False)["starting_seat"] == 0
    second = ready(ada, match_id)
    assert engine.created[-1]["starting_seat"] == 0
    assert engine.created[-1]["idle_timeout_seconds"] == games.TABLE_IDLE_SECONDS

    # Nothing Ada is sent names Bob's sideboard: not the match, not the game, not its frames.
    secret = card(client, "Swords to Plowshares")
    seen: list[str] = []
    with ExitStack() as stack:
        ada_tab = opened(ada, second["game_id"], seen, stack)
        ada_tab.snapshot(1)
        seen.append(json.dumps(ada.get(f"/api/v1/matches/{match_id}").json()))
        seen.append(json.dumps(ada.get("/api/v1/matches").json()))
        seen.append(json.dumps(ada.get(f"/api/v1/games/{second['game_id']}").json()))
        seen.append(json.dumps(ada.get(f"/api/v1/tables/{code}").json()))
        # Bob wins the second game: one each, and Ada chooses for the third.
        end(engine, second["game_id"], 1)
        found = until(ada, match_id, status="sideboarding")
        seen.append(json.dumps(found))
    everything = "\n".join(seen)
    assert secret not in everything and "Swords to Plowshares" not in everything
    assert "Secret plan" not in everything
    assert wins(found) == [1, 1] and found["chooser_seat"] == 0
    assert found["players"][1]["deck_cards"] is None
    # SysOp sees every arrangement.
    root = Account(client, "sysop", kind="sysop")
    watched = match_of(root, match_id)
    assert arrangement(watched, 1)["Swords to Plowshares"] == (0, 2)
    assert Account(client, "cara").get(f"/api/v1/matches/{match_id}").status_code == 404

    # Nobody readies: when sideboarding's time is up the third game starts anyway, with the
    # chooser playing first.
    with Session(client.app.state.database) as db:
        db.get(Match, uuid.UUID(match_id)).sideboard_until = utcnow()  # type: ignore[union-attr]
        db.commit()
    third = until(ada, match_id, status="playing", game_number=3)
    assert engine.created[-1]["starting_seat"] == 0
    end(engine, third["game_id"], 0)
    done = until(bob, match_id, status="finished")
    assert (done["winner_seat"], done["end_reason"], wins(done)) == (0, "games", [2, 1])
    # Every game won counted, and paid as one game does.
    assert (counted_wins(ada), counted_wins(bob)) == (2, 1)
    with Session(client.app.state.database) as db:
        kinds = {
            user: sorted(
                db.scalars(
                    select(TokenEntry.kind).where(
                        TokenEntry.user_id == user, TokenEntry.game_id.is_not(None)
                    )
                )
            )
            for user in (ada.id, bob.id)
        }
    assert kinds == {ada.id: ["human_win", "human_win"], bob.id: ["human_win"]}
    # The loser's record: one match lost, with a game won and two lost.
    stats = bob.get("/api/v1/me/stats").json()
    assert stats["matches"] == {"games": 1, "wins": 0, "losses": 1, "draws": 0, "no_result": 0}
    assert (stats["totals"]["wins"], stats["totals"]["losses"]) == (1, 2)


def test_draws_and_games_without_a_result_add_games_up_to_five(client, engine):
    ada = Account(client, "ada", admin=True)
    started = practice_match(ada, red(ada, client))
    match_id = started["match"]["id"]
    game_id = started["id"]
    # A draw, the turn limit, a win each and an engine error: the fifth game ends the match.
    for number, (winner, kind) in enumerate(
        [(None, "completed"), (0, "completed"), (None, "turn_limit"), (1, "completed")], start=1
    ):
        end(engine, game_id, winner, kind)
        found = until(ada, match_id, status="sideboarding", game_number=number + 1)
        if number == 1:
            # The first game had no loser: a player is drawn to choose.
            assert found["chooser_seat"] in (0, 1)
        game_id = ready(
            ada, match_id, **({"play_first": True} if found["chooser_seat"] == 0 else {})
        )["game_id"]
    assert wins(found) == [1, 1] and found["chooser_seat"] == 0
    end(engine, game_id, None, "error")
    done = until(ada, match_id, status="finished")
    assert (done["draw"], done["winner_seat"], done["end_reason"]) == (True, None, "games")
    assert len(done["games"]) == matches.MAX_GAMES


def test_a_closed_game_closes_its_match(client, engine):
    ada = Account(client, "ada", admin=True)
    started = practice_match(ada, red(ada, client))
    closed = ada.send("POST", f"/api/v1/games/{started['id']}/close")
    assert closed.json()["match"]["status"] == "closed"
    found = match_of(ada, started["match"]["id"])
    assert (found["status"], found["end_reason"], found["winner_seat"]) == (
        "closed",
        "closed",
        None,
    )
    assert running(client, ada) == 0


def test_conceding_a_game_and_conceding_the_match(client, engine):
    ada = Account(client, "ada", admin=True)
    deck_id = red(ada, client)
    started = practice_match(ada, deck_id)
    match_id = started["match"]["id"]
    # Conceding the game: the bot wins it, and the match goes on.
    with ExitStack() as stack:
        tab = opened(ada, started["id"], [], stack)
        tab.snapshot(1)
        assert test_tables.concede(tab, started["id"])["status"] == 200
    found = until(ada, match_id, status="sideboarding")
    assert wins(found) == [0, 1] and found["chooser_seat"] == 0
    # The loser chooses to play first.
    second = ready(ada, match_id, play_first=True)
    assert engine.created[-1]["starting_seat"] == 0
    # Conceding the match concedes the game in play, and the match is the bot's.
    conceded = ada.send("POST", f"/api/v1/matches/{match_id}/concede")
    assert conceded.status_code == 200, conceded.text
    done = until(ada, match_id, status="finished")
    assert (done["winner_seat"], done["end_reason"]) == (1, "conceded")
    assert done["players"][0]["left"] == "conceded" and wins(done) == [0, 2]
    assert engine.games[second["game_id"]].out == [0]
    again = ada.send("POST", f"/api/v1/matches/{match_id}/concede")
    assert (again.status_code, again.json()["code"]) == (409, "match_over")

    # Between games, conceding ends the match at once.
    other = practice_match(ada, deck_id)
    end(engine, other["id"], 0)
    until(ada, other["match"]["id"], status="sideboarding")
    left = ada.send("POST", f"/api/v1/matches/{other['match']['id']}/concede").json()
    assert (left["status"], left["winner_seat"], left["end_reason"]) == ("finished", 1, "conceded")
    assert wins(left) == [1, 0]
    assert running(client, ada) == 0


def test_a_player_removed_while_away_loses_the_match(client, engine, monkeypatch):
    monkeypatch.setattr(games, "AWAY_SECONDS", 0.2)
    ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
    made = ada.send(
        "POST", "/api/v1/tables", {"format": "legacy", "best_of": 3, "deck_id": red(ada, client)}
    ).json()
    code = made["code"]
    bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": red(bob, client)})
    bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True})
    game_id = ada.send("POST", f"/api/v1/tables/{code}/start").json()["game_id"]
    match_id = ada.get(f"/api/v1/games/{game_id}").json()["game"]["match"]["id"]
    with ExitStack() as stack:
        tab = opened(ada, game_id, [], stack)
        # Bob never came: Ada alone votes him out, and the game is hers.
        test_tables.presence(tab, **{"1": {"removable": True}})
        tab.socket.send_json({"type": "vote", "seat": 1, "remove": True})
        tab.snapshot(2)
    done = until(ada, match_id, status="finished")
    assert (done["winner_seat"], done["end_reason"], wins(done)) == (0, "removed", [1, 0])
    assert done["players"][1]["left"] == "removed"
    assert running(client, bob) == 0 and running(client, ada) == 0


def test_sideboarding_keeps_to_the_locked_pool_and_the_rules(client, engine):
    ada = Account(client, "ada", admin=True)
    deck_id = legacy_deck(
        ada,
        client,
        {"Mountain": 57, "Lightning Bolt": 4},
        {"Hill Giant": 3, "Grizzly Bears": 4, "Counterspell": 4, "Swords to Plowshares": 4},
    )
    started = practice_match(ada, deck_id)
    match_id = started["match"]["id"]
    # Not while a game is in play.
    found = match_of(ada, match_id)
    playing = arrange(ada, match_id, swap(found, 0, {"Hill Giant": 1}))
    assert (playing.status_code, playing.json()["code"]) == (409, "not_sideboarding")
    end(engine, started["id"], 0)
    found = until(ada, match_id, status="sideboarding")
    for cards in (
        # A card from outside the deck the match started with.
        swap(found, 0, {}) + [{"card_id": card(client, "Brainstorm"), "main": 1, "sideboard": 0}],
        # More copies than it holds.
        [entry | {"main": entry["main"] + 1} for entry in swap(found, 0, {})],
        # A card left out.
        swap(found, 0, {})[1:],
    ):
        refused = arrange(ada, match_id, cards)
        assert (refused.status_code, refused.json()["code"]) == (422, "invalid_sideboard")
    # Validated as a deck: 60 cards in the main deck at least, 15 in the sideboard at most.
    small = arrange(ada, match_id, swap(found, 0, {"Lightning Bolt": -2}))
    assert (small.status_code, small.json()["code"]) == (422, "sideboard_not_legal")
    assert "Legacy needs at least 60" in small.json()["message"]
    large = arrange(ada, match_id, swap(found, 0, {"Lightning Bolt": -1}))
    assert (large.status_code, large.json()["code"]) == (422, "sideboard_not_legal")
    assert "Legacy allows 15" in large.json()["message"]
    # Nothing refused was kept, and a fair swap is.
    assert arrangement(match_of(ada, match_id), 0)["Lightning Bolt"] == (4, 0)
    fair = arrange(ada, match_id, swap(found, 0, {"Lightning Bolt": -1, "Hill Giant": 1}))
    assert fair.status_code == 200, fair.text
    assert arrangement(fair.json(), 0)["Hill Giant"] == (1, 2)


def test_the_library_holds_every_card_of_the_arrangement(client, engine):
    """A player builds from their library: an arrangement is checked against it as it is now."""
    cara = Account(client, "cara")
    with Session(client.app.state.database) as db:
        for name, quantity in (("Lightning Bolt", 4), ("Hill Giant", 2)):
            concept = db.get_one(CardConcept, uuid.UUID(card(client, name)))
            db.add(
                LibraryGrant(
                    user_id=cara.id,
                    concept_id=concept.id,
                    printing_id=concept.default_printing_id,
                    quantity=quantity,
                    source="pack",
                    grant_key="pack:test",
                    created_at=utcnow(),
                )
            )
        db.commit()
    deck_id = legacy_deck(cara, client, {"Mountain": 56, "Lightning Bolt": 4}, {"Hill Giant": 2})
    started = practice_match(cara, deck_id)
    match_id = started["match"]["id"]
    end(engine, started["id"], 1)
    found = until(cara, match_id, status="sideboarding")
    fine = arrange(cara, match_id, swap(found, 0, {"Hill Giant": 2, "Lightning Bolt": -2}))
    assert fine.status_code == 200, fine.text
    # The library no longer holds the cards (a reset counts only what came after it).
    with Session(client.app.state.database) as db:
        db.get(User, cara.id).reset_at = utcnow()  # type: ignore[union-attr]
        db.commit()
    refused = arrange(cara, match_id, swap(found, 0, {}))
    assert (refused.status_code, refused.json()["code"]) == (422, "sideboard_not_legal")
    assert "your library has none" in refused.json()["message"]


def test_a_match_holds_its_players_running_game_between_games(client, engine):
    ada = Account(client, "ada", admin=True)
    deck_id = red(ada, client)
    started = practice_match(ada, deck_id)
    end(engine, started["id"], 0)
    until(ada, started["match"]["id"], status="sideboarding")
    refused = ada.send("POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck_id})
    assert (refused.status_code, refused.json()["code"]) == (409, "game_limit")
    table = ada.send("POST", "/api/v1/tables", {"format": "legacy", "deck_id": deck_id})
    assert (table.status_code, table.json()["code"]) == (409, "game_limit")
    with Session(client.app.state.database) as db:
        assert accounts.running_games(db, ada.id) == 1
    # Best of three is Legacy's alone.
    for path, body in (
        ("/api/v1/practice-games", {"format": "commander", "best_of": 3}),
        ("/api/v1/tables", {"format": "commander", "best_of": 3, "deck_id": deck_id}),
    ):
        wrong = ada.send("POST", path, body)
        assert (wrong.status_code, wrong.json()["code"]) == (422, "invalid_table"), wrong.text


def test_the_next_game_waits_for_a_free_slot(url, content, engine, monkeypatch):
    monkeypatch.setattr(matches, "RETRY_SECONDS", 0.2)
    monkeypatch.setattr(matches, "BUSY_RETRY_SECONDS", 0.2)
    with serving(url, content, engine, games_max=1) as client:
        ada, bob = Account(client, "ada", admin=True), Account(client, "bob", admin=True)
        started = practice_match(ada, red(ada, client))
        match_id = started["match"]["id"]
        end(engine, started["id"], 0)
        until(ada, match_id, status="sideboarding")
        # Bob's practice game takes the only slot meanwhile.
        other = bob.send(
            "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": red(bob, client)}
        ).json()
        waiting = ready(ada, match_id)
        assert waiting["status"] == "sideboarding" and "in use" in waiting["waiting"]
        end(engine, other["id"], 0)
        found = until(ada, match_id, status="playing")
        assert found["game_number"] == 2 and found["waiting"] is None


def test_a_restart_counts_a_match_game_without_a_result(client, engine):
    ada = Account(client, "ada", admin=True)
    started = practice_match(ada, red(ada, client))
    match_id = started["match"]["id"]
    # What the restart's sweep does to a game an earlier process ran.
    games.interrupt_active(client.app.state.database)
    found = until(ada, match_id, status="sideboarding")
    assert found["game_number"] == 2 and wins(found) == [0, 0]
    assert found["games"][0]["status"] == "interrupted"


def test_the_migration_keeps_every_game_when_it_goes_back(tmp_path, monkeypatch):
    database = f"sqlite:///{tmp_path}/matches.db"
    monkeypatch.setenv("CD_DATABASE_URL", database)
    config = Config("alembic.ini")
    command.upgrade(config, "head")
    engine = create_engine(database)
    now = utcnow()
    with Session(engine) as db:
        user = User(display_name="Ada", created_at=now)
        db.add(user)
        db.flush()
        match = Match(
            kind="practice",
            format="legacy",
            best_of=3,
            status="finished",
            created_by=user.id,
            bot_skill=4,
            turn_cap=60,
            game_number=2,
            draw=False,
            created_at=now,
        )
        db.add(match)
        db.flush()
        db.add(MatchPlayer(match_id=match.id, seat=0, player="human", user_id=user.id))
        for number in (1, 2):
            db.add(
                Game(
                    id=uuid.uuid4(),
                    kind="practice",
                    format="legacy",
                    status="finished",
                    created_by=user.id,
                    created_at=now,
                    bot_skill=4,
                    turn_cap=60,
                    match_id=match.id,
                    match_game=number,
                )
            )
        db.commit()
    command.downgrade(config, "0020_account_reset")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM games")).scalar() == 2
        tables = {row[0] for row in connection.execute(text("SELECT name FROM sqlite_master"))}
        assert "matches" not in tables and "match_players" not in tables
    command.upgrade(config, "head")
    engine.dispose()
