"""Two-Headed Giant practice games (v0.5.0, early): the format option, the team deck rules and a
team's result, against the fake engine of test_games.py."""

import copy
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from alembic import command
from alembic.config import Config
from catalog_fixtures import bulk, engine_list, import_bulk
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jsonschema import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from test_contracts import card, snapshot, validator_for
from test_games import SERVICE_TOKEN, Account, FakeEngine, build, connect, until_status

from api import games, teams
from api.config import Settings
from api.identity import ApiError
from api.main import create_app
from api.models import Game, ProgressEntry, TokenEntry


@pytest.fixture
def engine() -> FakeEngine:
    return FakeEngine()


@pytest.fixture
def client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, engine: FakeEngine
) -> Iterator[TestClient]:
    url = f"sqlite:///{tmp_path}/two-headed-giant.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    with connect(build(url, engine)) as client:
        yield client


@pytest.fixture
def app(client: TestClient) -> FastAPI:
    return client.app  # type: ignore[return-value]


def fixture_names(deck: str) -> set[str]:
    """A fixture deck file's card names, without its basic lands."""
    names = set()
    for line in Path(f"engine/decks/{deck}.txt").read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("//"):
            names.add(line.split(" ", 1)[1].strip())
    return names - teams.BASICS


def test_the_fixture_cards_are_the_engines() -> None:
    assert list(teams.FIXTURES) == games.FIXTURE_DECKS["two_headed_giant"]
    for deck, names in teams.FIXTURES.items():
        assert names == fixture_names(deck), deck
    decks = list(teams.FIXTURES.values())
    for first in range(len(decks)):
        for second in range(first + 1, len(decks)):
            assert not decks[first] & decks[second], "fixture decks share no card"


def listing(*names: str, basics: int = 20) -> dict[str, object]:
    """An engine deck list: four of each name and some Mountains."""
    cards = [{"name": name, "count": 4} for name in names]
    return {"deck_list": {"cards": [*cards, {"name": "Mountain", "count": basics}]}}


def seated(player: dict[str, object], *bots: dict[str, object]) -> list[dict[str, object]]:
    return [{"player": "human", **player}, *({"player": "bot", **bot} for bot in bots)]


def test_bots_get_fixture_decks_their_teammates_share_no_card_with() -> None:
    # The player's own deck holds Lightning Bolt: the teammate cannot play the red fixture. The
    # two opponents play a measured pair (v0.5.1): green and blue.
    seats = seated(listing("Lightning Bolt", "Snow-Covered Mountain"), {}, {}, {})
    teams.assign_and_check(seats, banned_allowed=True)
    assert [seat.get("deck") for seat in seats] == [
        None,
        "legacy-mono-white-weenie",
        "legacy-mono-green-creatures",
        "legacy-mono-blue-skies",
    ]
    # A fixture chosen for the player is not dealt again: the opponents play the other pair.
    seats = seated({"deck": "legacy-mono-green-creatures"}, {}, {}, {})
    teams.assign_and_check(seats, banned_allowed=True)
    assert [seat["deck"] for seat in seats] == [
        "legacy-mono-green-creatures",
        "legacy-mono-blue-skies",
        "legacy-mono-red-burn",
        "legacy-mono-white-weenie",
    ]
    # Every seat may leave its deck to the table, the player's too: red and white against green
    # and blue, the engine's own order.
    seats = seated({}, {}, {}, {})
    teams.assign_and_check(seats, banned_allowed=True)
    assert [seat["deck"] for seat in seats] == [deck for pair in teams.PAIRS for deck in pair]
    assert sorted(deck for pair in teams.PAIRS for deck in pair) == sorted(teams.FIXTURES)


def test_a_pair_gives_way_when_it_would_leave_a_bot_no_deck() -> None:
    """Regression (v0.5.1, the audit's review): the bots' pair was dealt first, and could take the
    only decks a player's bot teammate could play."""
    red, white = (teams.FIXTURES[deck] for deck in teams.PAIRS[0])
    green, blue = (teams.FIXTURES[deck] for deck in teams.PAIRS[1])
    # The player shares a card with red and white: the opponents play them, the teammate green.
    seats = seated(listing(min(red), min(white)), {}, {}, {})
    teams.assign_and_check(seats, banned_allowed=True)
    assert [seat.get("deck") for seat in seats] == [
        None,
        "legacy-mono-green-creatures",
        "legacy-mono-red-burn",
        "legacy-mono-white-weenie",
    ]
    # Seat 2's player shares a card with green and blue: team 0's bots play them instead of their
    # own pair, and seat 3 plays red.
    seats = [{"player": "bot"}, {"player": "bot"}, {"player": "human"}, {"player": "bot"}]
    seats[2].update(listing(min(green), min(blue)))
    teams.assign_and_check(seats, banned_allowed=True)
    assert [seat.get("deck") for seat in seats] == [
        "legacy-mono-green-creatures",
        "legacy-mono-blue-skies",
        None,
        "legacy-mono-red-burn",
    ]


def refusal(seats: list[dict[str, object]], banned_allowed: bool = True) -> ApiError:
    with pytest.raises(ApiError) as refused:
        teams.assign_and_check(seats, banned_allowed=banned_allowed)
    return refused.value


def test_teammates_decks_share_only_basic_lands() -> None:
    # MTR 8.4 and 9.5: no card in both decks of a team, by name, except basic lands.
    shared = refusal(seated(listing("Lightning Bolt"), {"deck": "legacy-mono-red-burn"}, {}, {}))
    assert shared.code == "team_decks"
    assert shared.message == (
        "Your deck and your teammate's share Lightning Bolt. In Two-Headed Giant teammates' "
        "decks may share only basic lands."
    )
    # Names match without regard to case, as the engine's do.
    assert refusal(seated(listing("lightning bolt"), {"deck": "legacy-mono-red-burn"}, {}, {}))
    opponents = refusal(
        seated({}, {}, {"deck": "legacy-mono-blue-skies"}, {"deck": "legacy-mono-blue-skies"})
    )
    assert opponents.message.startswith("The opponents' decks share Air Servant, Cloud Sprite,")
    # Basic lands, snow-covered ones too, are every deck's.
    seats = seated(
        listing("Goblin Guide", "Snow-Covered Mountain"),
        listing("Llanowar Elves", "Snow-Covered Mountain"),
        {},
        {},
    )
    teams.assign_and_check(seats, banned_allowed=True)
    # A player whose deck shares a card with every fixture chooses the teammate's deck.
    every = listing("Shock", "Grizzly Bears", "Squire", "Vaporkin")
    stuck = refusal(seated(every, {}, {}, {}))
    assert (stuck.code, stuck.message) == (
        "team_decks",
        "Every fixture deck shares a card with your teammate's deck: choose a deck for the bot.",
    )


def one_of(deck: str) -> str:
    """A card of a fixture deck, the first by name."""
    return min(teams.FIXTURES[deck])


def opposite(player: dict[str, object], other: dict[str, object]) -> list[dict[str, object]]:
    """A player and a bot in each team."""
    return [
        {"player": "human", **player},
        {"player": "bot"},
        {"player": "human", **other},
        {"player": "bot"},
    ]


def test_the_bots_decks_are_dealt_so_that_every_bot_has_one() -> None:
    """Regression (v0.5.1): taking the first fixture deck that fits gave the first bot the only
    one the second could play, and refused a game that another dealing allowed."""
    decks = list(teams.FIXTURES)
    # The first player's deck rules out the first fixture; the other's every one but the second.
    seats = opposite(
        listing(one_of(decks[0])),
        listing(*(one_of(deck) for deck in decks if deck != decks[1])),
    )
    teams.assign_and_check(seats, banned_allowed=True)
    assert [seat.get("deck") for seat in seats] == [None, decks[2], None, decks[1]]
    # Two players whose decks leave their bots only the same deck: each team's bot plays it, as
    # only a team's decks must share no card.
    only_first = listing(*(one_of(deck) for deck in decks[1:]))
    seats = opposite(only_first, only_first)
    teams.assign_and_check(seats, banned_allowed=True)
    assert [seat.get("deck") for seat in seats] == [None, decks[0], None, decks[0]]
    # Only a deck sharing a card with every fixture deck leaves its bot none: that seat is named,
    # and nothing is dealt.
    every = listing(*(one_of(deck) for deck in decks))
    seats = opposite(listing(one_of(decks[0])), every)
    assert teams.without_fixture(seats) == [2]
    assert refusal(seats).code == "team_decks"
    assert [seat.get("deck") for seat in seats] == [None, None, None, None]
    assert teams.without_fixture(opposite(every, every)) == [0, 2]
    assert teams.without_fixture(seated(every, {"deck": decks[0]}, {}, {})) == []
    assert not teams.fits_a_fixture({one_of(deck) for deck in decks})
    assert teams.fits_a_fixture({one_of(deck) for deck in decks[1:]} | {"Brainstorm"})


def test_erayo_is_banned_where_the_table_refuses_banned_cards() -> None:
    erayo = seated(listing("Erayo, Soratami Ascendant"), {}, {}, {})
    refused = refusal(erayo, banned_allowed=False)
    assert refused.code == "deck_not_allowed"
    assert "Erayo, Soratami Ascendant is banned in Two-Headed Giant" in refused.message
    teams.assign_and_check(seated(listing("Erayo, Soratami Ascendant"), {}, {}, {}), True)


def test_the_format_is_listed_as_early_and_offered_for_practice(
    client: TestClient,
) -> None:
    ada = Account(client, "ada")
    formats = {entry["id"]: entry for entry in client.get("/api/v1/formats").json()}
    assert formats["two_headed_giant"]["available"] is True
    assert formats["two_headed_giant"]["early"] is True
    assert formats["two_headed_giant"]["seats"] == [4]
    assert formats["legacy"]["early"] is False
    options = {f["id"]: f for f in ada.get("/api/v1/practice-games/options").json()["formats"]}
    assert options["two_headed_giant"]["name"] == "Two-Headed Giant"
    assert options["two_headed_giant"]["bots"] == [3]
    assert options["two_headed_giant"]["default_bots"] == 3
    assert options["two_headed_giant"]["decks"] == [], "fixture decks are SysOp's to choose"


def test_a_practice_game_seats_a_teammate_and_two_opponents(
    client: TestClient, app: FastAPI, engine: FakeEngine
) -> None:
    ada = Account(client, "ada")
    few = ada.post("/api/v1/practice-games", {"format": "two_headed_giant", "bots": [{}]})
    assert (few.status_code, few.json()["code"]) == (422, "invalid_table")
    commander = ada.post(
        "/api/v1/practice-games",
        {"format": "two_headed_giant", "bots": [{"deck": "commander-mono-blue-flyers"}, {}, {}]},
    )
    assert (commander.status_code, commander.json()["code"]) == (422, "invalid_deck")
    clash = ada.post(
        "/api/v1/practice-games",
        {
            "format": "two_headed_giant",
            "deck": "legacy-mono-red-burn",
            "bots": [{"deck": "legacy-mono-red-burn"}, {}, {}],
        },
    )
    assert (clash.status_code, clash.json()["code"]) == (422, "team_decks")

    started = ada.post(
        "/api/v1/practice-games", {"format": "two_headed_giant", "deck": "legacy-mono-blue-skies"}
    )
    assert started.status_code == 201, started.text
    summary = started.json()
    assert summary["format"] == "two_headed_giant"
    assert [seat["player"] for seat in summary["seats"]] == ["human", "bot", "bot", "bot"]
    sent = engine.created[-1]
    assert sent["format"] == "two_headed_giant"
    assert [seat.get("deck") for seat in sent["seats"]] == [
        "legacy-mono-blue-skies",
        "legacy-mono-green-creatures",
        "legacy-mono-red-burn",
        "legacy-mono-white-weenie",
    ]
    with Session(app.state.database) as db:
        game = db.get(Game, uuid.UUID(summary["id"]))
        assert game is not None
        assert game.format == "two_headed_giant"

    # The team wins together: the player's win counts once, and the tokens pay for the two
    # opponents, never for the teammate.
    fake = engine.game(summary["id"])
    result: dict[str, Any] = {
        "kind": "completed",
        "winner_seat": 0,
        "winner_seats": [0, 1],
        "draw": False,
        "turns": 11,
        "conceded_seats": [],
        "error": None,
    }
    with engine.lock:
        fake.result = result
        fake.revision += 1
    finished = until_status(ada, summary["id"], "finished")["game"]
    assert finished["result"]["winner_seats"] == [0, 1]
    assert finished["result"]["winner_seat"] == 0
    for _ in range(100):
        with Session(app.state.database) as db:
            paid = list(db.scalars(select(TokenEntry).where(TokenEntry.game_id == game.id)))
            wins = list(db.scalars(select(ProgressEntry).where(ProgressEntry.game_id == game.id)))
        if paid:
            break
        time.sleep(0.02)
    assert sorted(entry.opponent_seat for entry in paid) == [2, 3]
    assert all(entry.kind == "bot_win" and entry.user_id == ada.id for entry in paid)
    assert [(entry.user_id, entry.wins) for entry in wins] == [(ada.id, 1)]
    assert finished["tokens"] == sum(entry.amount for entry in paid)


def two_headed_giant_view() -> dict[str, Any]:
    """Seat 0's snapshot at a Two-Headed Giant table: seat 1 is its teammate."""
    view = snapshot()
    view["settings"].update(format="two_headed_giant", rules_profile="two_headed_giant_legacy")
    for state in [view["view"]["you"], *view["view"]["opponents"]]:
        state.update(
            team=state["seat"] // 2, life=30, color_identity=None, command_zone=[], commanders=[]
        )
        state["hand"] = None
    view["view"]["opponents"][0]["hand"] = [card("o1111111111111111", "Giant Growth")]
    view["result"] = {
        "kind": "completed",
        "winner_seat": 0,
        "winner_seats": [0, 1],
        "draw": False,
        "conceded_seats": [],
        "turns": 9,
        "error": None,
    }
    return view


def test_the_seat_view_contract_shows_only_a_teammates_hand() -> None:
    validator = validator_for("contracts/engine-seat-view.schema.json")
    validator.validate(two_headed_giant_view())
    secret = card("o2222222222222222", "Lightning Bolt")
    leaks: list[tuple[str, Any]] = [
        ("two hands", lambda view: view["view"]["opponents"][1].update(hand=[secret])),
        ("your own entry's hand", lambda view: view["view"]["you"].update(hand=[secret])),
        ("a hand outside the format", lambda view: view["settings"].update(format="legacy")),
        ("a third team", lambda view: view["view"]["opponents"][2].update(team=2)),
        ("a hand to a spectator", lambda view: view.update(seat=None)),
    ]
    for description, mutate in leaks:
        leaked = copy.deepcopy(two_headed_giant_view())
        mutate(leaked)
        with pytest.raises(ValidationError):
            validator.validate(leaked)
            pytest.fail(f"schema accepted {description}")


def test_a_players_own_legacy_deck_plays_without_its_sideboard(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """MTR 9.5: no sideboards in Two-Headed Giant. A Legacy game takes the deck's (v0.5.0)."""
    from test_decks_api import Account as DeckAccount
    from test_decks_api import entry

    url = f"sqlite:///{tmp_path}/two-headed-giant-decks.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    catalog = create_engine(url)
    import_bulk(catalog, tmp_path / "files", bulk(), engine_list())
    catalog.dispose()
    fake = FakeEngine()
    app = create_app(
        Settings(database_url=url, engine_service_token=SERVICE_TOKEN, games_per_account=4)
    )
    app.state.engine_transport = httpx.MockTransport(fake)
    with TestClient(app, base_url="https://testserver") as client:
        ada = DeckAccount(client, "ada", admin=True)
        entries = [
            entry(client, "Lightning Bolt", 4),
            entry(client, "Mountain", 56),
            entry(client, "Brainstorm", 2, "sideboard"),
        ]
        deck = ada.send(
            "POST", "/api/v1/decks", {"title": "Burn", "format": "legacy", "entries": entries}
        ).json()
        giant = ada.send(
            "POST", "/api/v1/practice-games", {"format": "two_headed_giant", "deck_id": deck["id"]}
        )
        assert giant.status_code == 201, giant.json()
        seats = fake.created[-1]["seats"]
        assert "sideboard" not in seats[0]["deck_list"]
        # Lightning Bolt is in the red fixture: the teammate plays the white one, and the opponents
        # green and blue.
        assert [seat.get("deck") for seat in seats[1:]] == [
            "legacy-mono-white-weenie",
            "legacy-mono-green-creatures",
            "legacy-mono-blue-skies",
        ]
        ada.send("POST", f"/api/v1/games/{giant.json()['id']}/close", {})
        legacy = ada.send(
            "POST", "/api/v1/practice-games", {"format": "legacy", "deck_id": deck["id"]}
        )
        assert legacy.status_code == 201, legacy.json()
        assert fake.created[-1]["seats"][0]["deck_list"]["sideboard"] == [
            {"name": "Brainstorm", "count": 2}
        ]


def test_a_team_wins_together_in_the_records() -> None:
    from api.models import GameSeat
    from api.stats import outcome_of

    result = {"kind": "completed", "winner_seat": 0, "winner_seats": [0, 1], "draw": False}
    assert [outcome_of(result, GameSeat(seat=seat)) for seat in range(4)] == [
        "win",
        "win",
        "loss",
        "loss",
    ]
    alone = {"kind": "completed", "winner_seat": 1, "draw": False}
    assert [outcome_of(alone, GameSeat(seat=seat)) for seat in range(2)] == ["loss", "win"]


def test_an_engine_without_teams_names_its_winner_alone() -> None:
    kept = games.recorded(
        {"kind": "completed", "winner_seat": 1, "draw": False, "turns": 3, "conceded_seats": []}
    )
    assert kept["winner_seats"] == [1]
    assert games.recorded({"kind": "closed", "winner_seat": None})["winner_seats"] == []
