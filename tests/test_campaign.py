"""The campaign (v0.8.0, api/campaign.py) against the fake engine of tests/test_games.py: the
encounters open one by one, a won duel records its encounter, seal and chapter once and in the
transaction that records the game, a lost or unfinished one changes nothing, campaign duels count
no win and pay no win's tokens, a warden's first defeat gives their deck and their tokens (1,000
doubling), and the finale takes the owner's private content from the engine when it serves it,
else the public stand-in. Also the content itself: fourteen encounters of 100 cards each."""

import dataclasses
import json
import time
import uuid
from collections import Counter
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
from sqlalchemy import create_engine, func, select, update
from sqlalchemy.orm import Session
from test_games import SERVICE_TOKEN, Account, FakeEngine, build, connect, until_status

from api import campaign
from api.models import (
    CampaignProgress,
    CampaignReward,
    CardConcept,
    CustomCard,
    CustomCardGrant,
    Deck,
    Game,
    LibraryGrant,
    ProgressEntry,
    TokenEntry,
)

CONTENT = Path("content") / "campaign.json"
BASICS = {"Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes"}


@pytest.fixture
def database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    url = f"sqlite:///{tmp_path}/campaign.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    return url


@pytest.fixture
def engine() -> FakeEngine:
    return FakeEngine()


@pytest.fixture
def client(database: str, engine: FakeEngine) -> Iterator[TestClient]:
    with connect(build(database, engine)) as client:
        yield client


@pytest.fixture
def app(client: TestClient) -> FastAPI:
    return client.app  # type: ignore[return-value]


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


def end(engine: FakeEngine, game_id: str, result: dict[str, Any]) -> None:
    fake = engine.game(game_id)
    with engine.lock:
        fake.result = result
        fake.revision += 1


def start(account: Account, number: int, **body: Any) -> httpx.Response:
    return account.post(f"/api/v1/campaign/encounters/{number}/start", body or {"loaner": True})


def play(account: Account, engine: FakeEngine, number: int, result: dict[str, Any]) -> str:
    started = start(account, number)
    assert started.status_code == 201, started.text
    game_id = str(started.json()["id"])
    end(engine, game_id, result)
    until_status(account, game_id, "finished")
    return game_id


def state(account: Account) -> dict[str, Any]:
    answer = account.get("/api/v1/campaign")
    assert answer.status_code == 200, answer.text
    return answer.json()  # type: ignore[no-any-return]


def put(account: Account, path: str, body: object) -> httpx.Response:
    headers = {"cookie": f"__Host-cd_session={account.token}", "x-csrf-token": account.csrf}
    return account.http.put(path, json=body, headers=headers)


def without_court(monkeypatch: pytest.MonkeyPatch) -> None:
    """The campaign as it was before v0.9.6, its duel the last: for the finale's own rules, which
    the court (tests/test_campaign_court.py) leaves as they were."""
    real = campaign.campaign_in("content")
    assert real is not None
    duel = dataclasses.replace(
        real,
        encounters=tuple(e for e in real.encounters if e.court is None),
        chapters=tuple(c for c in real.chapters if 15 not in c.encounters),
    )
    monkeypatch.setattr(campaign, "campaign_in", lambda folder: duel)


def unlock(app: FastAPI, account: Account, number: int) -> None:
    with Session(app.state.database) as db:
        db.execute(
            update(CampaignProgress)
            .where(CampaignProgress.user_id == account.id)
            .values(highest_unlocked=number)
        )
        db.commit()


def test_the_campaign_opens_at_its_first_encounter(client: TestClient) -> None:
    ada = Account(client, "ada")
    opened = state(ada)
    assert opened["id"] == "final_concordance_v1"
    assert [e["number"] for e in opened["encounters"]] == list(range(1, 16))
    assert [e["status"] for e in opened["encounters"]][:3] == ["open", "locked", "locked"]
    assert opened["encounters"][0]["opponent"] == "tibalt"
    assert opened["encounters"][13]["opponent"] == "the-sphinx"
    # The finale's commander is the owner's own and is never named here.
    assert opened["encounters"][13]["commander"] is None
    tiers = [chapter["tier"] for chapter in opened["chapters"]]
    assert tiers == ["bronze", "silver", "gold", "platinum", "mythic", "godlike", "godlike"]
    assert [len(chapter["encounters"]) for chapter in opened["chapters"]] == [4, 4, 2, 2, 1, 1, 1]
    # Ward 15 (v0.9.6): the court, a King's Table game against The Sphinx and his two Generals.
    court = opened["encounters"][14]
    assert (court["title"], court["opponent"], court["status"]) == (
        "The Unbound Court",
        "the-sphinx",
        "locked",
    )
    assert court["court"]["player_seat"] == 1 and court["court"]["ally_seats"] == [0, 2]
    # The court's rules as its game plays them (v0.9.7): the house rule with its guard, and 40
    # turns for each of the six players.
    assert court["court"]["kings_table"] == {
        "deck_format": "commander",
        "life": "all_40",
        "king_attacks_anyone": True,
        "guarded_kings": True,
    }
    assert court["court"]["turn_cap"] == 240
    assert [(seat["seat"], seat["name"], seat["role"]) for seat in court["court"]["opponents"]] == [
        (3, "Nicol Bolas", "general"),
        (4, "The Sphinx", "king"),
        (5, "Liliana", "general"),
    ]
    assert [deck["title"] for deck in court["spoils"]["decks"]] == [
        "Nicol Bolas's Gift",
        "Liliana's Gift",
    ]
    assert opened["progress"]["highest_unlocked"] == 1
    assert opened["progress"]["tutorial"] == {
        "complete": False,
        "hints": True,
        "skipped": False,
        "lessons": [],
    }
    assert opened["running"] is None
    assert start(ada, 2).json()["code"] == "encounter_locked"


def test_a_won_duel_opens_the_next_encounter_once(
    client: TestClient, app: FastAPI, engine: FakeEngine
) -> None:
    ada = Account(client, "ada")
    started = start(ada, 1)
    assert started.status_code == 201, started.text
    summary = started.json()
    assert summary["campaign"] == {
        "encounter": 1,
        "opponent": "tibalt",
        "name": "Tibalt",
        "title": "The Laughing Gate",
        "hints": True,
        "deck": "loaner",
        "finale": None,
        "outcome": None,
        "challenge": False,
        "seat": 0,
    }
    # The bot is the encounter's opponent, by name and portrait, playing its own deck.
    bot = summary["seats"][1]
    assert (bot["player"], bot["handle"], bot["portrait"]) == ("bot", "Tibalt", "tibalt")
    body = engine.created[-1]
    assert body["format"] == "commander" and body["skill"] == 1 and "seed" not in body
    # 40 turns for each of the duel's two players (v0.9.7; 60 for the whole game before).
    assert body["turn_cap"] == 80 and summary["turn_cap"] == 80
    assert body["seats"][1]["deck_list"]["commanders"] == ["Judith, the Scourge Diva"]
    assert sum(card["count"] for card in body["seats"][1]["deck_list"]["cards"]) == 99
    assert body["seats"][0]["deck_list"]["commanders"] == ["Adeline, Resplendent Cathar"]
    assert state(ada)["running"] == summary["id"]

    end(engine, summary["id"], won())
    finished = until_status(ada, summary["id"], "finished")["game"]
    assert finished["campaign"]["outcome"] == "won"
    after = state(ada)
    assert after["progress"]["completed"] == [1]
    assert after["progress"]["highest_unlocked"] == 2
    assert after["progress"]["tutorial"]["complete"] is True
    assert [e["status"] for e in after["encounters"]][:3] == ["won", "open", "locked"]
    # No win counted and no win's tokens paid: the campaign is apart from the competitive
    # record. Its own spoils are the warden's deck and tokens (below).
    with Session(app.state.database) as db:
        game_id = uuid.UUID(summary["id"])
        assert db.scalar(select(ProgressEntry).where(ProgressEntry.game_id == game_id)) is None
        assert db.scalar(select(TokenEntry).where(TokenEntry.game_id == game_id)) is None

    # Played again and won again: no second seal.
    again = play(ada, engine, 1, won())
    assert again != summary["id"]
    with Session(app.state.database) as db:
        rewards = list(
            db.scalars(select(CampaignReward.reward).where(CampaignReward.user_id == ada.id))
        )
    assert sorted(rewards) == ["seal:01", "spoils:01"]
    assert state(ada)["progress"]["highest_unlocked"] == 2


def test_a_wardens_first_defeat_gives_their_deck_and_tokens(
    client: TestClient,
    app: FastAPI,
    engine: FakeEngine,
    database: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The fixture catalog, and a first warden whose deck is made of its cards.
    import_bulk(create_engine(database), tmp_path / "files", bulk(), engine_list())
    real = campaign.campaign_in("content")
    assert real is not None
    first = dataclasses.replace(
        real.encounter(1),
        commander="Karlach, Fury of Avernus",
        cards=(("Sol Ring", 1), ("Lightning Bolt", 1), ("Mountain", 97)),
    )
    patched = dataclasses.replace(real, encounters=(first, *real.encounters[1:]))
    monkeypatch.setattr(campaign, "campaign_in", lambda folder: patched)
    ada = Account(client, "ada")
    spoils = state(ada)["encounters"][0]["spoils"]
    assert spoils == {
        "tokens": 1000,
        "deck": "Tibalt's Deck",
        "commander": "Karlach, Fury of Avernus",
        "decks": [
            {
                "title": "Tibalt's Deck",
                "commander": "Karlach, Fury of Avernus",
                "opponent": "tibalt",
            }
        ],
        "earned": False,
    }
    # 1,000 tokens for the first warden, doubling with each: 8,192,000 for The Sphinx, whose deck
    # comes with the commander he plays, and since v0.9.6 16,384,000 for his court.
    amounts = [encounter["spoils"]["tokens"] for encounter in state(ada)["encounters"]]
    assert amounts == [1000 * 2**index for index in range(15)]
    # Before the engine is asked, the finale's commander by the story's word.
    assert state(ada)["encounters"][13]["spoils"]["commander"] == "The High Priest"

    play(ada, engine, 1, won())
    assert state(ada)["encounters"][0]["spoils"]["earned"] is True
    with Session(app.state.database) as db:
        paid = list(
            db.scalars(
                select(TokenEntry).where(
                    TokenEntry.user_id == ada.id, TokenEntry.kind == "campaign"
                )
            )
        )
        assert [(entry.amount, entry.reason, entry.game_id) for entry in paid] == [
            (1000, "Tibalt, The Laughing Gate", None)
        ]
        deck = db.scalars(select(Deck).where(Deck.owner_id == ada.id)).one()
        assert (deck.title, deck.format, deck.source, deck.card_count) == (
            "Tibalt's Deck",
            "commander",
            "campaign",
            100,
        )
        assert deck.legal and not deck.collection_locked
        granted = dict(
            db.execute(
                select(CardConcept.name, func.sum(LibraryGrant.quantity))
                .join(CardConcept, CardConcept.id == LibraryGrant.concept_id)
                .where(LibraryGrant.user_id == ada.id, LibraryGrant.source == "campaign")
                .group_by(CardConcept.name)
            ).all()
        )
    assert granted == {
        "Karlach, Fury of Avernus": 1,
        "Sol Ring": 1,
        "Lightning Bolt": 1,
        "Mountain": 97,
    }
    # The deck waits to be opened as a pack (v0.9.5): its 100 cards, commons first, the
    # commander last; the bell says so. Opening it gives nothing more and may be watched again.
    (waiting,) = ada.get("/api/v1/campaign/openings").json()
    assert (waiting["deck_title"], waiting["cards"], waiting["opened_at"]) == (
        "Tibalt's Deck",
        100,
        None,
    )
    bell = ada.get("/api/v1/notifications", limit="50").json()["items"]
    assert [item["kind"] for item in bell].count("warden_deck") == 1
    shown = ada.get(f"/api/v1/campaign/openings/{waiting['id']}").json()
    names = [card["name"] for card in shown["pulled"]]
    assert len(names) == 100 and names[-1] == "Karlach, Fury of Avernus"
    assert shown["pulled"][-1]["commander"] is True
    rarities = [card["rarity"] for card in shown["pulled"][:-1]]
    order = ["common", "uncommon", "rare", "mythic", "special", "bonus"]
    assert rarities == sorted(rarities, key=order.index)
    opened = ada.post(f"/api/v1/campaign/openings/{waiting['id']}/open", {})
    assert opened.status_code == 200 and opened.json()["opened_at"] is not None
    again = ada.post(f"/api/v1/campaign/openings/{waiting['id']}/open", {}).json()
    assert again["opened_at"] == opened.json()["opened_at"]
    bob = Account(client, "bob")
    assert bob.get(f"/api/v1/campaign/openings/{waiting['id']}").status_code == 404

    # The deck is the player's, in their deck list, and their balance shows the tokens.
    decks = ada.get("/api/v1/decks").json()
    assert [summary["title"] for summary in decks] == ["Tibalt's Deck"]
    tokens = ada.get("/api/v1/me/tokens").json()
    assert tokens["entries"][0]["kind"] == "campaign"

    # Won again: no second deck and no second payment. The next warden pays double.
    play(ada, engine, 1, won())
    play(ada, engine, 2, won())
    with Session(app.state.database) as db:
        amounts = list(
            db.scalars(
                select(TokenEntry.amount)
                .where(TokenEntry.user_id == ada.id, TokenEntry.kind == "campaign")
                .order_by(TokenEntry.amount)
            )
        )
        titles = sorted(db.scalars(select(Deck.title).where(Deck.owner_id == ada.id)))
    assert amounts == [1000, 2000]
    assert titles == ["Daretti's Deck", "Tibalt's Deck"]


def test_a_lost_or_unfinished_duel_changes_nothing(client: TestClient, engine: FakeEngine) -> None:
    ada = Account(client, "ada")
    lost = play(ada, engine, 1, won(seat=1))
    assert ada.get(f"/api/v1/games/{lost}").json()["game"]["campaign"]["outcome"] == "lost"
    started = start(ada, 1).json()
    closed = ada.post(f"/api/v1/games/{started['id']}/close")
    assert closed.status_code == 200
    assert until_status(ada, started["id"], "finished")["game"]["campaign"]["outcome"] == (
        "unfinished"
    )
    after = state(ada)
    assert after["progress"]["completed"] == []
    assert after["progress"]["highest_unlocked"] == 1
    # A campaign duel is played again from the campaign, never by a rematch.
    assert ada.post(f"/api/v1/games/{lost}/rematch").json()["code"] == "campaign_game"


def test_a_chapter_completes_with_its_rewards(
    client: TestClient, app: FastAPI, engine: FakeEngine
) -> None:
    ada = Account(client, "ada")
    for number in (1, 2, 3, 4):
        play(ada, engine, number, won())
    after = state(ada)
    bronze = after["chapters"][0]
    assert bronze["complete"] is True
    assert bronze["rewards"] == [
        {"id": "card_back:broken-writ", "name": "Broken Writ card back", "earned": True}
    ]
    assert after["chapters"][1]["complete"] is False
    assert after["progress"]["highest_unlocked"] == 5
    # Bronze's bots are its weakest (skill 3 at most), Tibalt's the weakest of all; within a tier
    # the skills follow the measured difficulty (v0.9.3, docs/campaign.md), not the order.
    skills = [body["skill"] for body in engine.created]
    assert skills[0] == 1 and max(skills) <= 3, skills


def test_learn_commander_uses_the_training_seed(client: TestClient, engine: FakeEngine) -> None:
    ada = Account(client, "ada")
    started = start(ada, 1, learn=True)
    assert started.status_code == 201, started.text
    assert started.json()["campaign"]["deck"] == "learn"
    assert started.json()["campaign"]["hints"] is True
    assert engine.created[-1]["seed"] == 20261031
    # The training seven, stacked by the engine on top of the loaner's library (v0.9.1).
    learner = engine.created[-1]["seats"][0]["deck_list"]
    assert learner["opening"] == [
        "Plains",
        "Plains",
        "Plains",
        "Sol Ring",
        "Arcane Signet",
        "Raise the Alarm",
        "Pacifism",
    ]
    refused = ada.post("/api/v1/campaign/encounters/1/start", {})
    assert refused.status_code == 422
    # The loaner without Learn Commander keeps its shuffled hand.
    bob = Account(client, "bob")
    assert start(bob, 1, loaner=True).status_code == 201
    assert "opening" not in engine.created[-1]["seats"][0]["deck_list"]
    assert "seed" not in engine.created[-1]


def test_the_training_hand_comes_from_the_loaner() -> None:
    """Every card of the training seven is in the loaner as often as it is named (v0.9.1): the
    engine refuses an opening its deck can't hold."""
    content = campaign.campaign_in(str(Path(__file__).resolve().parents[1] / "content"))
    assert content is not None
    held = dict(content.loaner_cards)
    assert len(content.training_hand) == 7
    for name, count in Counter(content.training_hand).items():
        assert held.get(name, 0) >= count, name


def test_learn_commander_is_refused_after_the_first_ward(
    client: TestClient, engine: FakeEngine
) -> None:
    """v0.8.3: the disclosed seed fixes the shuffles, so on a later ward, the finale above all, it
    would show both decks' order to a player who lost once."""
    ada = Account(client, "ada")
    play(ada, engine, 1, won())
    created = len(engine.created)
    for number in (2, 14):
        refused = start(ada, number, learn=True)
        assert (refused.status_code, refused.json()["code"]) == (422, "invalid_seat")
    assert len(engine.created) == created
    assert start(ada, 2, loaner=True).status_code == 201


def test_a_choice_of_two_decks_is_refused(client: TestClient) -> None:
    ada = Account(client, "ada")
    both = start(ada, 1, loaner=True, deck_id=str(uuid.uuid4()))
    assert (both.status_code, both.json()["code"]) == (422, "invalid_seat")
    foreign = start(ada, 1, deck_id=str(uuid.uuid4()))
    assert (foreign.status_code, foreign.json()["code"]) == (422, "invalid_deck")


def test_the_finale_without_the_owners_content_plays_the_stand_in(
    client: TestClient, app: FastAPI, engine: FakeEngine
) -> None:
    ada = Account(client, "ada")
    state(ada)
    unlock(app, ada, 14)
    started = start(ada, 14)
    assert started.status_code == 201, started.text
    assert started.json()["campaign"]["finale"] == "public"
    bot = engine.created[-1]["seats"][1]["deck_list"]
    assert bot["commanders"] == ["Morophon, the Boundless"]
    assert "reserve" not in bot
    assert engine.created[-1]["skill"] == 6
    # Without the owner's content, the deck the win gives comes with the stand-in.
    assert state(ada)["encounters"][13]["spoils"]["commander"] == "Morophon, the Boundless"


class FinaleEngine(FakeEngine):
    """An engine whose plugin serves the owner's finale (made-up names here, as every test uses)."""

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/service/content/campaign-finale":
            if request.headers.get("x-service-token") != SERVICE_TOKEN:
                return httpx.Response(401, json={"code": "service_unauthorized"})
            return httpx.Response(
                200,
                json={
                    "commander": "Test Priest Commander",
                    "reserve": {"card": "Test Incarnation Walker", "threshold": 15},
                },
            )
        return await super().__call__(request)


def test_the_finale_takes_the_owners_content_from_the_engine(
    database: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from api.identity import utcnow

    without_court(monkeypatch)
    engine = FinaleEngine()
    with connect(build(database, engine)) as client:
        app: FastAPI = client.app  # type: ignore[assignment]
        ada = Account(client, "ada")
        # The owner's commander, as SysOp uploaded it (a made-up stand-in here).
        with Session(app.state.database) as db:
            priest = CustomCard(
                name="Test Priest Commander",
                planeswalker="the-sphinx",
                mana_cost="{W}{U}{B}{R}{G}",
                type_line="Legendary Creature — Human Cleric",
                oracle_text="",
                power="5",
                toughness="5",
                rarity="mythic",
                image=b"\x89PNG",
                image_type="image/png",
                image_sha256="0" * 64,
                uploaded_by=ada.id,
                created_at=utcnow(),
                updated_at=utcnow(),
            )
            db.add(priest)
            db.commit()
            priest_id = priest.id
        state(ada)
        unlock(app, ada, 14)
        started = start(ada, 14)
        assert started.status_code == 201, started.text
        assert started.json()["campaign"]["finale"] == "private"
        bot = engine.created[-1]["seats"][1]["deck_list"]
        assert bot["commanders"] == ["Test Priest Commander"]
        assert bot["reserve"] == [{"name": "Test Incarnation Walker", "threshold": 15}]
        assert sum(card["count"] for card in bot["cards"]) == 99
        # Winning the finale completes the campaign; its scene records the ending seen.
        end(engine, started.json()["id"], won())
        until_status(ada, started.json()["id"], "finished")
        after = state(ada)
        assert after["chapters"][5]["complete"] is True
        # The spoils: The Sphinx's deck, led by the commander he played (the owner's word), which
        # the winner now holds for good and sees by name, below the Godlike tier.
        assert after["encounters"][13]["spoils"] == {
            "tokens": 8192000,
            "deck": "The Sphinx's Deck",
            "commander": "The High Priest",
            "decks": [
                {
                    "title": "The Sphinx's Deck",
                    "commander": "The High Priest",
                    "opponent": "the-sphinx",
                }
            ],
            "earned": True,
        }
        with Session(app.state.database) as db:
            grants = list(
                db.scalars(select(CustomCardGrant).where(CustomCardGrant.user_id == ada.id))
            )
            assert [(grant.custom_card_id, grant.quantity) for grant in grants] == [(priest_id, 1)]
            deck = db.scalars(select(Deck).where(Deck.owner_id == ada.id)).one()
            leaders = [entry for entry in deck.draft["entries"] if entry["location"] == "commander"]
            assert leaders == [
                {
                    "card_id": str(priest_id),
                    "printing_id": None,
                    "quantity": 1,
                    "location": "commander",
                }
            ]
            assert not deck.collection_locked
        decks = ada.get("/api/v1/decks").json()
        assert [(d["title"], d["commanders"]) for d in decks] == [
            ("The Sphinx's Deck", ["Test Priest Commander"])
        ]
        detail = ada.get(f"/api/v1/decks/{decks[0]['id']}").json()
        named = {card["name"] for card in detail["cards"].values()}
        assert "Test Priest Commander" in named and "Godlike card" not in named
        assert ada.get(f"/api/v1/custom-cards/{priest_id}/image").status_code == 200
        seen = ada.post("/api/v1/campaign/scenes", {"scene": "FC.END.WIN"}).json()
        assert seen["progress"]["ending"] == "standard"


class FinaleListEngine(FakeEngine):
    """An engine whose plugin serves the owner's finale with a deck list of its own."""

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/service/content/campaign-finale":
            return httpx.Response(
                200,
                json={
                    "commander": "Test Priest Commander",
                    "cards": [
                        {"name": "Sol Ring", "count": 1},
                        {"name": "Lightning Bolt", "count": 1},
                        {"name": "Mountain", "count": 97},
                    ],
                },
            )
        return await super().__call__(request)


def test_the_finales_spoils_wait_for_its_commander_and_give_the_deck_served(
    database: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from api.identity import utcnow

    without_court(monkeypatch)
    import_bulk(create_engine(database), tmp_path / "files", bulk(), engine_list())
    engine = FinaleListEngine()
    with connect(build(database, engine)) as client:
        app: FastAPI = client.app  # type: ignore[assignment]
        ada = Account(client, "ada")
        state(ada)
        unlock(app, ada, 14)
        # No custom card carries the commander's name yet: the win counts, the spoils wait.
        play(ada, engine, 14, won())
        after = state(ada)
        assert after["encounters"][13]["status"] == "won"
        assert after["encounters"][13]["spoils"]["earned"] is False
        with Session(app.state.database) as db:
            assert db.scalar(select(func.count()).select_from(Deck)) == 0
            assert db.scalar(select(func.count()).select_from(CustomCardGrant)) == 0
            priest = CustomCard(
                name="Test Priest Commander",
                planeswalker="the-sphinx",
                mana_cost="{W}{U}{B}{R}{G}",
                type_line="Legendary Creature — Human Cleric",
                oracle_text="",
                power="5",
                toughness="5",
                rarity="mythic",
                image=b"\x89PNG",
                image_type="image/png",
                image_sha256="0" * 64,
                uploaded_by=ada.id,
                created_at=utcnow(),
                updated_at=utcnow(),
            )
            db.add(priest)
            db.commit()
            priest_id = priest.id
        # Won again once the card is there: the spoils, with the commander and the list served.
        play(ada, engine, 14, won())
        assert state(ada)["encounters"][13]["spoils"]["earned"] is True
        with Session(app.state.database) as db:
            grants = list(db.scalars(select(CustomCardGrant.custom_card_id)))
            assert grants == [priest_id]
            granted = dict(
                db.execute(
                    select(CardConcept.name, func.sum(LibraryGrant.quantity))
                    .join(CardConcept, CardConcept.id == LibraryGrant.concept_id)
                    .where(LibraryGrant.user_id == ada.id, LibraryGrant.source == "campaign")
                    .group_by(CardConcept.name)
                ).all()
            )
        assert granted == {"Sol Ring": 1, "Lightning Bolt": 1, "Mountain": 97}
        # The opening ends on the High Priest, the custom card, after the 99.
        (waiting,) = ada.get("/api/v1/campaign/openings").json()
        pulled = ada.get(f"/api/v1/campaign/openings/{waiting['id']}").json()["pulled"]
        assert len(pulled) == 100
        assert (pulled[-1]["name"], pulled[-1]["custom"], pulled[-1]["commander"]) == (
            "Test Priest Commander",
            True,
            True,
        )


def test_scenes_and_the_tutorial_are_remembered(client: TestClient) -> None:
    ada = Account(client, "ada")
    seen = ada.post("/api/v1/campaign/scenes", {"scene": "FC.OPEN"})
    assert seen.status_code == 200, seen.text
    assert seen.json()["progress"]["scenes_seen"] == ["FC.OPEN"]
    ada.post("/api/v1/campaign/scenes", {"scene": "FC.OPEN"})
    assert state(ada)["progress"]["scenes_seen"] == ["FC.OPEN"]
    assert ada.post("/api/v1/campaign/scenes", {"scene": "<script>"}).status_code == 422
    # The ending is only recorded once the finale is won.
    ending = ada.post("/api/v1/campaign/scenes", {"scene": "FC.END.WIN"}).json()
    assert ending["progress"]["ending"] is None
    changed = put(ada, "/api/v1/campaign/tutorial", {"hints": False, "lessons": ["T03", "T01"]})
    assert changed.status_code == 200, changed.text
    tutorial = changed.json()["progress"]["tutorial"]
    assert tutorial == {
        "complete": False,
        "hints": False,
        "skipped": False,
        "lessons": ["T01", "T03"],
    }
    skipped = put(ada, "/api/v1/campaign/tutorial", {"skip": True}).json()["progress"]
    # Skipping the teaching completes the tutorial and never wins the duel.
    assert skipped["tutorial"]["complete"] is True
    assert skipped["completed"] == []
    assert put(ada, "/api/v1/campaign/tutorial", {"lessons": ["T13"]}).status_code == 422


def test_the_content_holds_fifteen_wards_of_complete_decks() -> None:
    text = CONTENT.read_text(encoding="utf-8")
    content = json.loads(text)
    # The finale names no commander of its own here: the owner's engine serves it, else the
    # public stand-in plays.
    finale = content["encounters"][13]
    assert finale["commander"] is None and finale["private"] == "campaign-finale"
    assert finale["fallback_commander"] == "Morophon, the Boundless"
    loaded = campaign.campaign_in("content")
    assert loaded is not None and len(loaded.encounters) == 15
    # The court (v0.9.6): The Sphinx keeps his deck, and gifts two more, one per General.
    court = loaded.encounter(15)
    assert court.court is not None and court.cards == loaded.encounter(14).cards
    assert (court.private, court.commander, court.tokens) == ("campaign-finale", None, 16384000)
    assert (loaded.court, loaded.flight, loaded.last) == (15, 14, 15)
    # The content names no turn limit of its own since v0.9.7: the campaign's games take the
    # game-wide one, 40 turns for each player.
    assert "turn_cap" not in content
    assert (campaign.DUEL_TURN_CAP, campaign.COURT_TURN_CAP) == (80, 240)
    decks = [(e["name"], e["commander"], e["cards"]) for e in content["encounters"][:14]] + [
        (g["name"], g["commander"], g["cards"])
        for g in content["encounters"][14]["court"]["generals"]
    ]
    for name, commander, cards in decks:
        assert sum(card["count"] for card in cards) == 99, name
        names = [card["name"] for card in cards]
        assert len(names) == len(set(names)), name
        assert all(card["count"] == 1 for card in cards if card["name"] not in BASICS)
        assert commander not in names
    assert [e["commander"] is None for e in content["encounters"]].count(True) == 2
    assert sum(card["count"] for card in content["loaner"]["cards"]) == 99
    numbers = [n for chapter in content["chapters"] for n in chapter["encounters"]]
    assert numbers == list(range(1, 16))


def test_a_reset_starts_the_campaign_again(
    client: TestClient, app: FastAPI, engine: FakeEngine
) -> None:
    from api.identity import utcnow
    from api.models import User

    ada = Account(client, "ada")
    play(ada, engine, 1, won())
    time.sleep(0.01)
    with Session(app.state.database) as db:
        db.execute(update(User).where(User.id == ada.id).values(reset_at=utcnow()))
        db.commit()
    after = state(ada)
    assert after["progress"]["completed"] == []
    assert after["progress"]["highest_unlocked"] == 1
    assert after["chapters"][0]["rewards"][0]["earned"] is False


def test_a_duel_won_with_passive_bots_counts_as_any_other(
    client: TestClient, app: FastAPI, engine: FakeEngine
) -> None:
    """Passive bots in the campaign (v0.9.7, the owner: "I need to be able to complete the entire
    campaign, as if I were a regular player"): a duel whose bots were passive gives what any win
    gives, its seal, the warden's deck and tokens, the next ward and its chapter's rewards. From
    v0.8.6 until then it opened the next ward and recorded the seal, and gave nothing else."""
    ada = Account(client, "ada")
    started = start(ada, 1)
    assert started.status_code == 201, started.text
    game_id = started.json()["id"]
    with Session(app.state.database) as db:
        db.execute(update(Game).where(Game.id == uuid.UUID(game_id)).values(passive_bots_used=True))
        db.commit()
    end(engine, game_id, won())
    finished = until_status(ada, game_id, "finished")["game"]
    assert finished["campaign"]["outcome"] == "won" and "uncounted" not in finished
    after = state(ada)
    assert after["progress"]["completed"] == [1]
    assert after["progress"]["highest_unlocked"] == 2
    assert after["encounters"][0]["spoils"]["earned"] is True
    with Session(app.state.database) as db:
        rewards = sorted(
            db.scalars(select(CampaignReward.reward).where(CampaignReward.user_id == ada.id))
        )
        assert rewards == ["seal:01", "spoils:01"]
        paid = list(
            db.scalars(
                select(TokenEntry.amount).where(
                    TokenEntry.user_id == ada.id, TokenEntry.kind == "campaign"
                )
            )
        )
        assert paid == [1000]
    # Once: the ward won again, with the switch or without, gives nothing twice.
    play(ada, engine, 1, won())
    with Session(app.state.database) as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(TokenEntry)
                .where(TokenEntry.user_id == ada.id, TokenEntry.kind == "campaign")
            )
            == 1
        )


def test_apex_unbound_is_the_finale_again_for_its_badge_alone(
    client: TestClient, app: FastAPI, engine: FakeEngine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The handoff's post-campaign challenge (v0.9.3): once the finale is won, it may be played
    again as Apex Unbound, without hints, for a badge of its own, once; its win gives no seal,
    spoils, tokens or chapter rewards a second time, and the badge shows on the profile. (Since
    v0.9.6 it is wards 14 and 15 as one run: tests/test_campaign_court.py.)"""
    without_court(monkeypatch)
    ada = Account(client, "ada")
    eve = Account(client, "eve")
    assert state(ada)["challenge"] == {
        "name": "Apex Unbound",
        "open": False,
        "earned": False,
        "at": 14,
    }
    unlock(app, ada, 14)
    locked = start(ada, 14, loaner=True, challenge=True)
    assert (locked.status_code, locked.json()["code"]) == (409, "challenge_locked")
    elsewhere = start(ada, 13, loaner=True, challenge=True)
    assert (elsewhere.status_code, elsewhere.json()["code"]) == (422, "invalid_seat")
    play(ada, engine, 14, won())
    opened = state(ada)
    assert opened["challenge"] == {"name": "Apex Unbound", "open": True, "earned": False, "at": 14}
    with Session(app.state.database) as db:
        before = sorted(
            db.scalars(select(CampaignReward.reward).where(CampaignReward.user_id == ada.id))
        )
        tokens = db.scalar(
            select(func.coalesce(func.sum(TokenEntry.amount), 0)).where(
                TokenEntry.user_id == ada.id
            )
        )

    # A loss gives nothing; a win gives the badge, and nothing else.
    lost = start(ada, 14, loaner=True, challenge=True)
    assert lost.status_code == 201, lost.text
    duel = until_status(ada, lost.json()["id"], "active")["game"]["campaign"]
    assert (duel["challenge"], duel["hints"], duel["encounter"]) == (True, False, 14)
    end(engine, lost.json()["id"], won(seat=1))
    until_status(ada, lost.json()["id"], "finished")
    assert state(ada)["challenge"]["earned"] is False
    for _ in range(2):
        game_id = start(ada, 14, loaner=True, challenge=True).json()["id"]
        end(engine, game_id, won())
        until_status(ada, game_id, "finished")
    assert state(ada)["challenge"]["earned"] is True
    with Session(app.state.database) as db:
        after = sorted(
            db.scalars(select(CampaignReward.reward).where(CampaignReward.user_id == ada.id))
        )
        assert after == sorted([*before, "badge:apex-unbound"])
        assert (
            db.scalar(
                select(func.coalesce(func.sum(TokenEntry.amount), 0)).where(
                    TokenEntry.user_id == ada.id
                )
            )
            == tokens
        )
    profile = eve.get(f"/api/v1/players/{ada.id}")
    if profile.status_code == 200:
        assert profile.json()["badges"] == ["Apex Unbound"]
    assert ada.get(f"/api/v1/players/{ada.id}").json()["badges"] == ["Apex Unbound"]


def test_no_opponent_plays_a_power_nine_or_reserved_list_card() -> None:
    """The owner, 2026-11-13 (v0.9.12): a warden's deck is won whole and for good, so no deck a
    campaign opponent plays holds one of the Power Nine or a card of the Reserved List
    (content/reserved-list.json, scripts/reserved_list.py). That is every ward's deck, with the
    commanders it may be led by, and the two decks the court's Generals play and give."""
    listed = json.loads((CONTENT.parent / "reserved-list.json").read_text(encoding="utf-8"))
    power_nine, reserved = set(listed["power_nine"]), set(listed["cards"])
    assert len(power_nine) == 9 and power_nine <= reserved
    assert {"Underground Sea", "Tundra", "Bayou", "Grim Monolith", "Gaea's Cradle"} <= reserved
    # What the rule leaves: strong cards that are not reserved (the owner: "I still want the
    # higher level wards to produce some awesome rares").
    assert not {"Mana Crypt", "Mana Drain", "Force of Will", "Demonic Tutor"} & reserved
    content = json.loads(CONTENT.read_text(encoding="utf-8"))
    decks: list[tuple[str, dict[str, Any]]] = []
    for encounter in content["encounters"]:
        decks.append((f"ward {encounter['number']}", encounter))
        for general in (encounter.get("court") or {}).get("generals", []):
            decks.append((general["deck_title"], general))
    assert len(decks) == 17
    held = {}
    for label, deck in decks:
        names = {card["name"] for card in deck.get("cards", [])}
        names |= {deck[key] for key in ("commander", "fallback_commander") if deck.get(key)}
        held[label] = sorted(names & reserved)
    assert not any(held.values()), {label: names for label, names in held.items() if names}
