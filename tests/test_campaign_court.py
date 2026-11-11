"""Ward 15, The Unbound Court (v0.9.6, api/campaign.py), against the King's Table fake engine:
The Sphinx flees ward 14 at the moment he would lose it, which opens the court and pays nothing yet;
the court is a King's Table game (the player King A, team B The Sphinx with Nicol Bolas and Liliana,
each a named bot with its own deck, The Sphinx's incarnation on the battlefield from the start);
losing it sends the player back to ward 14, and winning it pays both wards (seals, the three decks
with their openings, 8,192,000 and 16,384,000 tokens, both chapters). Friends join as Generals at a
table the campaign opens, are paid 10,000 tokens once ever per player and friend for a win, and the
game counts nothing else for anyone. An account that won ward 14 before the court existed plays it
alone; Apex Unbound is the same dual level."""

import shutil
import uuid
from collections.abc import Iterator
from contextlib import ExitStack
from pathlib import Path
from typing import Any

import httpx
import pytest
import test_progression
from alembic import command
from alembic.config import Config
from catalog_fixtures import bulk, engine_list, import_bulk
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, update
from sqlalchemy.orm import Session
from test_kings_table import KingsEngine, until_left
from test_tables import Account, concede, deck, left_reason, opened, served, until_finished

from api import campaign
from api.models import (
    CampaignGame,
    CampaignProgress,
    CampaignReward,
    Deck,
    Game,
    PlayerResult,
    ProgressEntry,
    TokenEntry,
    WardenOpening,
)

content = test_progression.content
FINALE_KEY = "/v1/service/content/campaign-finale"


class CourtEngine(KingsEngine):
    """The King's Table fake engine, with the owner's finale content when asked to serve it."""

    def __init__(self) -> None:
        super().__init__()
        self.finale: dict[str, Any] | None = None

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == FINALE_KEY:
            if self.finale is None:
                return httpx.Response(404, json={"code": "not_found"})
            return httpx.Response(200, json=self.finale)
        return await super().__call__(request)

    def finish(self, game_id: str, result: dict[str, Any]) -> None:
        with self.lock:
            game = self.games[game_id]
            game.result = result
            game.revision += 1


@pytest.fixture
def url(tmp_path: Path) -> str:
    url = f"sqlite:///{tmp_path}/court.db"
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv("CD_DATABASE_URL", url)
        command.upgrade(Config("alembic.ini"), "head")
    engine = create_engine(url)
    import_bulk(engine, tmp_path / "files", bulk(), engine_list())
    engine.dispose()
    return url


@pytest.fixture
def court_content(content: Path) -> Path:
    shutil.copy(Path("content") / "campaign.json", content / "campaign.json")
    return content


@pytest.fixture
def engine() -> CourtEngine:
    return CourtEngine()


@pytest.fixture
def client(url: str, court_content: Path, engine: CourtEngine) -> Iterator[TestClient]:
    with served(url, court_content, engine, games_per_account=4) as client:
        yield client


def won(seat: int = 0) -> dict[str, Any]:
    return {
        "kind": "completed",
        "winner_seat": seat,
        "winner_seats": [seat],
        "draw": False,
        "turns": 7,
        "conceded_seats": [],
        "error": None,
    }


def state(account: Account) -> dict[str, Any]:
    answer = account.get("/api/v1/campaign")
    assert answer.status_code == 200, answer.text
    return answer.json()  # type: ignore[no-any-return]


def start(account: Account, number: int, **body: Any) -> httpx.Response:
    return account.send(
        "POST", f"/api/v1/campaign/encounters/{number}/start", body or {"loaner": True}
    )


def unlock(client: TestClient, account: Account, number: int, **values: Any) -> None:
    state(account)
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(
            update(CampaignProgress)
            .where(CampaignProgress.user_id == account.id)
            .values(highest_unlocked=number, **values)
        )
        db.commit()


def flee(client: TestClient, engine: CourtEngine, account: Account, **body: Any) -> None:
    """Ward 14 won: The Sphinx flees it."""
    started = start(account, 14, **body)
    assert started.status_code == 201, started.text
    engine.finish(started.json()["id"], won(0))
    until_finished(account, started.json()["id"])


def court(account: Account, **body: Any) -> dict[str, Any]:
    started = start(account, 15, **body)
    assert started.status_code == 201, started.text
    return started.json()  # type: ignore[no-any-return]


def rewards(client: TestClient, account: Account) -> list[str]:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return sorted(
            db.scalars(select(CampaignReward.reward).where(CampaignReward.user_id == account.id))
        )


def campaign_tokens(client: TestClient, account: Account) -> list[int]:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        return sorted(
            db.scalars(
                select(TokenEntry.amount).where(
                    TokenEntry.user_id == account.id, TokenEntry.kind == "campaign"
                )
            )
        )


# What winning ward 14 gave while it was the finale: its seal, its spoils and its chapter.
THRONE = ("seal:14", "spoils:14", "title:concordance-breaker", "card_back:fractured-throne")


def befriend(one: Account, other: Account) -> None:
    assert one.send("PUT", f"/api/v1/friends/{other.id}").status_code == 200
    assert other.send("PUT", f"/api/v1/friends/{one.id}").status_code == 200


def test_the_sphinx_flees_and_the_court_pays_both_wards(
    client: TestClient, engine: CourtEngine
) -> None:
    ada = Account(client, "ada", admin=True)
    unlock(client, ada, 14)
    assert start(ada, 15).json()["code"] == "encounter_locked"

    # Ward 14 won: The Sphinx flees. The court opens; nothing is paid yet.
    flee(client, engine, ada)
    after = state(ada)
    statuses = {e["number"]: e["status"] for e in after["encounters"]}
    assert (statuses[14], statuses[15]) == ("fled", "open")
    assert after["progress"]["completed"] == []
    assert after["progress"]["highest_unlocked"] == 15
    assert rewards(client, ada) == []
    assert campaign_tokens(client, ada) == []

    # The court: a King's Table game, the player King A, team B the court's named bots.
    summary = court(ada)
    body = engine.created[-1]
    assert body["format"] == "kings_table" and body["skill"] == 6
    # The owner's rule for the court (v0.9.7): a King attacks any General, and the other King once
    # one of that King's Generals is defeated; and 40 turns for each of the six players.
    assert body["kings_table"] == {
        "deck_format": "commander",
        "life": "all_40",
        "king_attacks_anyone": True,
        "guarded_kings": True,
    }
    assert body["turn_cap"] == 240 and summary["turn_cap"] == 240
    assert summary["kings_table"] == body["kings_table"]
    assert [seat["player"] for seat in body["seats"]] == [
        "bot",
        "human",
        "bot",
        "bot",
        "bot",
        "bot",
    ]
    assert "deck_list" not in body["seats"][0] and "deck_list" not in body["seats"][2]
    assert body["seats"][3]["deck_list"]["commanders"] == ["Nicol Bolas, the Ravager"]
    assert body["seats"][5]["deck_list"]["commanders"] == ["Liliana, Heretical Healer"]
    # Without the owner's content the public stand-in leads The Sphinx's deck, with no reserve.
    sphinx = body["seats"][4]["deck_list"]
    assert sphinx["commanders"] == ["Morophon, the Boundless"] and "reserve" not in sphinx
    for seat in (3, 4, 5):
        assert sum(card["count"] for card in body["seats"][seat]["deck_list"]["cards"]) == 99
    named = {seat["seat"]: (seat["handle"], seat["portrait"]) for seat in summary["seats"]}
    assert named[3] == ("Nicol Bolas", "nicol-bolas")
    assert named[4] == ("The Sphinx", "the-sphinx")
    assert named[5] == ("Liliana", "liliana")
    assert named[0] == (None, None) and named[2] == (None, None)
    assert summary["your_seat"] == 1
    assert summary["campaign"]["encounter"] == 15 and summary["campaign"]["seat"] == 1

    # Lost: the run ends, back to ward 14.
    engine.win(summary["id"], 1)
    assert until_finished(ada, summary["id"])["campaign"]["outcome"] == "lost"
    lost = state(ada)
    statuses = {e["number"]: e["status"] for e in lost["encounters"]}
    assert (statuses[14], statuses[15]) == ("open", "locked")
    assert start(ada, 15).json()["code"] == "encounter_locked"

    # Fled again, then the court won: both wards, all three decks and both chapters.
    flee(client, engine, ada)
    summary = court(ada)
    engine.win(summary["id"], 0)
    assert until_finished(ada, summary["id"])["campaign"]["outcome"] == "won"
    after = state(ada)
    assert after["progress"]["completed"] == [14, 15]
    statuses = {e["number"]: e["status"] for e in after["encounters"]}
    assert (statuses[14], statuses[15]) == ("won", "won")
    assert rewards(client, ada) == sorted(
        [
            "seal:14",
            "spoils:14",
            "title:concordance-breaker",
            "card_back:fractured-throne",
            "seal:15",
            "spoils:15",
            "title:courtbreaker",
            "card_back:unbound-court",
        ]
    )
    assert campaign_tokens(client, ada) == [8192000, 16384000]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        titles = sorted(db.scalars(select(Deck.title).where(Deck.owner_id == ada.id)))
        assert titles == ["Liliana's Gift", "Nicol Bolas's Gift", "The Sphinx's Deck"]
        openings = sorted(
            db.scalars(select(WardenOpening.deck_title).where(WardenOpening.user_id == ada.id))
        )
        assert openings == titles
        # The court counts no win, as a campaign duel counts none.
        game_id = uuid.UUID(summary["id"])
        assert db.scalar(select(ProgressEntry).where(ProgressEntry.game_id == game_id)) is None
        assert db.scalar(select(PlayerResult).where(PlayerResult.game_id == game_id)) is None
    cosmetics = ada.get("/api/v1/me/cosmetics").json()
    assert {back["id"] for back in cosmetics["card_backs"] if back["earned"]} == {
        "fractured-throne",
        "unbound-court",
    }

    # The court won again: nothing twice.
    again = court(ada)
    engine.win(again["id"], 0)
    until_finished(ada, again["id"])
    assert campaign_tokens(client, ada) == [8192000, 16384000]
    assert state(ada)["challenge"]["open"] is True


def test_the_incarnation_takes_the_court_with_the_owners_content(
    client: TestClient, engine: CourtEngine
) -> None:
    engine.finale = {
        "commander": "Test Priest Commander",
        "reserve": {"card": "Test Incarnation Walker", "threshold": 15},
    }
    ada = Account(client, "ada", admin=True)
    unlock(client, ada, 15, fled_at=None)
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(
            update(CampaignProgress)
            .where(CampaignProgress.user_id == ada.id)
            .values(fled_at=func.now())
        )
        db.commit()
    summary = court(ada)
    sphinx = engine.created[-1]["seats"][4]["deck_list"]
    assert sphinx["commanders"] == ["Test Priest Commander"]
    # The court's rule: on the battlefield from the start, back at each of his upkeeps.
    assert sphinx["reserve"] == [{"name": "Test Incarnation Walker", "mode": "court"}]
    assert summary["campaign"]["finale"] == "private"


def test_a_player_who_won_ward_14_before_plays_the_court_alone(
    client: TestClient, engine: CourtEngine, court_content: Path
) -> None:
    ada = Account(client, "ada", admin=True)
    unlock(client, ada, 14, completed=[*range(1, 15)])
    # Ward 14 was won when it was the finale: its seal, its spoils and the Throne's chapter are
    # theirs already.
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        progress = db.scalars(
            select(CampaignProgress).where(CampaignProgress.user_id == ada.id)
        ).one()
        installed = campaign.campaign_in(str(court_content))
        assert installed is not None
        for name in THRONE:
            assert campaign.reward(db, ada.id, installed, progress, name, None)
        db.commit()
    after = state(ada)
    statuses = {e["number"]: e["status"] for e in after["encounters"]}
    assert (statuses[14], statuses[15]) == ("won", "open")
    # Losing never sends them back: ward 14 is theirs already.
    summary = court(ada)
    engine.win(summary["id"], 1)
    until_finished(ada, summary["id"])
    assert {e["number"]: e["status"] for e in state(ada)["encounters"]}[15] == "open"
    summary = court(ada)
    engine.win(summary["id"], 0)
    until_finished(ada, summary["id"])
    # The court's own rewards; nothing of ward 14's is given twice.
    assert rewards(client, ada) == sorted(
        [*THRONE, "seal:15", "spoils:15", "title:courtbreaker", "card_back:unbound-court"]
    )
    assert campaign_tokens(client, ada) == [16384000]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        titles = sorted(db.scalars(select(Deck.title).where(Deck.owner_id == ada.id)))
        assert titles == ["Liliana's Gift", "Nicol Bolas's Gift"]


def test_friends_help_at_the_court_and_are_paid_once(
    client: TestClient, engine: CourtEngine
) -> None:
    ada, bob, cid = (Account(client, name, admin=True) for name in ("ada", "bob", "cid"))
    befriend(ada, bob)
    unlock(client, ada, 15, completed=[*range(1, 15)])
    mine = deck(ada, client, "commander", "Ada's Commander")
    his = deck(bob, client, "commander", "Bob's Commander")
    # Only friends; never a stranger.
    refused = ada.send(
        "POST", "/api/v1/campaign/encounters/15/court", {"deck_id": mine, "friends": [str(cid.id)]}
    )
    assert (refused.status_code, refused.json()["code"]) == (422, "not_friend")
    opened = ada.send(
        "POST", "/api/v1/campaign/encounters/15/court", {"deck_id": mine, "friends": [str(bob.id)]}
    )
    assert opened.status_code == 201, opened.text
    table = opened.json()
    assert (table["format"], table["visibility"], table["campaign"]) == (
        "kings_table",
        "private",
        "The Unbound Court",
    )
    seats = {p["seat"]: p for p in table["players"]}
    assert seats[1]["you"] and seats[1]["host"]
    # One friend: one General's seat waits for him, the other is a bot's.
    assert seats[0]["player"] == "human" and not seats[0]["taken"]
    assert seats[2]["player"] == "bot" and seats[2]["handle"] is None
    assert [seats[s]["handle"] for s in (3, 4, 5)] == ["Nicol Bolas", "The Sphinx", "Liliana"]
    code = table["code"]
    # The court's rule and its turn limit are the solo court's (v0.9.7).
    assert table["kings_table"] == {
        "deck_format": "commander",
        "life": "all_40",
        "king_attacks_anyone": True,
        "guarded_kings": True,
    }
    assert table["turn_cap"] == 240
    # The court's settings and seats are the campaign's.
    changed = ada.send("PATCH", f"/api/v1/tables/{code}", {"kings_table": {"life": "all_20"}})
    assert (changed.status_code, changed.json()["code"]) == (409, "campaign_table")
    freed = ada.send("PATCH", f"/api/v1/tables/{code}", {"bot_seats": [2]})
    assert (freed.status_code, freed.json()["code"]) == (409, "campaign_table")
    # Bob was invited: the bell, and the table among his.
    joined = bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": his, "seat": 0})
    assert joined.status_code == 200, joined.text
    assert bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True}).status_code == 200
    started = ada.send("POST", f"/api/v1/tables/{code}/start", {})
    assert started.status_code == 200, started.text
    game_id = started.json()["game_id"]
    body = engine.created[-1]
    assert [seat["player"] for seat in body["seats"]] == [
        "human",
        "human",
        "bot",
        "bot",
        "bot",
        "bot",
    ]
    assert body["seats"][4]["deck_list"]["commanders"] == ["Morophon, the Boundless"]
    # Bob sees a table's game; the campaign's reference is Ada's.
    assert bob.get(f"/api/v1/games/{game_id}").json()["game"]["campaign"] is None
    assert ada.get(f"/api/v1/games/{game_id}").json()["game"]["campaign"]["encounter"] == 15
    engine.win(game_id, 0)
    until_finished(ada, game_id)
    assert campaign_tokens(client, bob) == [10000]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        link = db.get(CampaignGame, uuid.UUID(game_id))
        assert link is not None and link.outcome == "won" and link.seat == 1
        # Nobody's win counts: not Ada's, not Bob's.
        assert db.scalar(select(ProgressEntry).where(ProgressEntry.user_id == bob.id)) is None
        assert db.scalar(select(func.count()).select_from(Deck).where(Deck.owner_id == bob.id)) == 1

    # A second court with Bob, won: Bob is not paid again.
    opened = ada.send(
        "POST", "/api/v1/campaign/encounters/15/court", {"deck_id": mine, "friends": [str(bob.id)]}
    )
    code = opened.json()["code"]
    bob.send("POST", f"/api/v1/tables/{code}/join", {"deck_id": his, "seat": 0})
    bob.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True})
    game_id = ada.send("POST", f"/api/v1/tables/{code}/start", {}).json()["game_id"]
    engine.win(game_id, 0)
    until_finished(ada, game_id)
    assert campaign_tokens(client, bob) == [10000]


def test_spoils_a_court_win_did_not_pay_come_with_the_next_one(
    client: TestClient, engine: CourtEngine
) -> None:
    """v0.9.7: a court first won with passive bots moves the campaign on and pays nothing; the
    next court won without them pays both wards. Until v0.9.7 ward 14's spoils were then lost for
    good: the run paid ward 14 only while ward 14 was not yet among the wards won."""
    ada = Account(client, "ada", admin=True)
    unlock(client, ada, 14)
    flee(client, engine, ada)
    summary = court(ada)
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.execute(
            update(Game).where(Game.id == uuid.UUID(summary["id"])).values(passive_bots_used=True)
        )
        db.commit()
    engine.win(summary["id"], 0)
    assert until_finished(ada, summary["id"])["uncounted"] is True
    assert state(ada)["progress"]["completed"] == [14, 15]
    assert rewards(client, ada) == ["seal:14", "seal:15"]
    assert campaign_tokens(client, ada) == []
    spoils = {e["number"]: e["spoils"]["earned"] for e in state(ada)["encounters"]}
    assert (spoils[14], spoils[15]) == (False, False)

    # Ward 14 again changes nothing: its spoils are the court's to give.
    replay = start(ada, 14)
    engine.finish(replay.json()["id"], won(0))
    until_finished(ada, replay.json()["id"])
    assert campaign_tokens(client, ada) == []

    again = court(ada)
    engine.win(again["id"], 0)
    until_finished(ada, again["id"])
    assert campaign_tokens(client, ada) == [8192000, 16384000]
    assert rewards(client, ada) == sorted(
        [
            "seal:14",
            "spoils:14",
            "title:concordance-breaker",
            "card_back:fractured-throne",
            "seal:15",
            "spoils:15",
            "title:courtbreaker",
            "card_back:unbound-court",
        ]
    )
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        titles = sorted(db.scalars(select(Deck.title).where(Deck.owner_id == ada.id)))
        assert titles == ["Liliana's Gift", "Nicol Bolas's Gift", "The Sphinx's Deck"]
    # And once more: nothing twice.
    third = court(ada)
    engine.win(third["id"], 0)
    until_finished(ada, third["id"])
    assert campaign_tokens(client, ada) == [8192000, 16384000]


def test_a_friend_eliminated_at_a_won_court_is_paid_and_one_who_left_is_not(
    client: TestClient, engine: CourtEngine
) -> None:
    """v0.9.7: at King's Table a team wins together, a General out before the end too, so a
    friend the court's bots eliminated helped win it and is paid; one who conceded left."""
    ada, bob, cid = (Account(client, name, admin=True) for name in ("ada", "bob", "cid"))
    befriend(ada, bob)
    befriend(ada, cid)
    unlock(client, ada, 15, completed=[*range(1, 15)])
    mine = deck(ada, client, "commander", "Ada's Commander")
    decks = {
        bob: deck(bob, client, "commander", "Bob's Commander"),
        cid: deck(cid, client, "commander", "Cid's Commander"),
    }
    table = ada.send(
        "POST",
        "/api/v1/campaign/encounters/15/court",
        {"deck_id": mine, "friends": [str(bob.id), str(cid.id)]},
    )
    assert table.status_code == 201, table.text
    code = table.json()["code"]
    for friend, seat in ((bob, 0), (cid, 2)):
        joined = friend.send(
            "POST", f"/api/v1/tables/{code}/join", {"deck_id": decks[friend], "seat": seat}
        )
        assert joined.status_code == 200, joined.text
        friend.send("PATCH", f"/api/v1/tables/{code}/seat", {"ready": True})
    game_id = ada.send("POST", f"/api/v1/tables/{code}/start", {}).json()["game_id"]
    # Bob is eliminated in play; Cid concedes. Then King A's team wins.
    engine.eliminate(game_id, 0)
    until_left(client, bob)
    with ExitStack() as stack:
        assert concede(opened(cid, game_id, [], stack), game_id)["status"] == 200
    assert left_reason(client, cid) == "conceded"
    engine.win(game_id, 0)
    until_finished(ada, game_id)
    assert campaign_tokens(client, bob) == [10000]
    assert campaign_tokens(client, cid) == []
    # The court is the campaign's to play again: no rematch is offered, to its player or a friend.
    for account in (ada, bob):
        offer = account.get(f"/api/v1/games/{game_id}/rematch").json()
        assert offer["can_offer"] is False, offer


def test_apex_unbound_is_wards_14_and_15_as_one_run(
    client: TestClient, engine: CourtEngine
) -> None:
    ada = Account(client, "ada", admin=True)
    unlock(client, ada, 15, completed=[*range(1, 16)])
    assert state(ada)["challenge"] == {
        "name": "Apex Unbound",
        "open": True,
        "earned": False,
        "at": 14,
    }
    assert start(ada, 15, loaner=True, challenge=True).json()["code"] == "challenge_locked"
    flee(client, engine, ada, loaner=True, challenge=True)
    assert state(ada)["challenge"]["at"] == 15
    assert start(ada, 14, loaner=True, challenge=True).json()["code"] == "challenge_locked"
    # Lost at the court: back to ward 14.
    summary = court(ada, loaner=True, challenge=True)
    engine.win(summary["id"], 1)
    until_finished(ada, summary["id"])
    assert state(ada)["challenge"]["at"] == 14
    flee(client, engine, ada, loaner=True, challenge=True)
    summary = court(ada, loaner=True, challenge=True)
    engine.win(summary["id"], 0)
    until_finished(ada, summary["id"])
    after = state(ada)["challenge"]
    assert (after["earned"], after["at"]) == (True, 14)
    assert rewards(client, ada) == ["badge:apex-unbound"]
    assert campaign.CHALLENGE_REWARD == "badge:apex-unbound"
