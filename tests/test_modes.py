"""Game modes and reward eligibility (v0.9.10, api/modes.py): the policy matrix, and the games that
exist settled exactly as before, mode by mode: what each pays, counts and records, the reason each
reward withheld was, and nothing settled twice.
"""

from typing import Any
from uuid import UUID, uuid4

import pytest
import test_progression
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from test_progression import Account, completed

from api import games, modes
from api.identity import utcnow
from api.models import (
    CampaignGame,
    DailyQuest,
    Game,
    GameSeat,
    PlayerResult,
    ProgressEntry,
    TokenEntry,
)

url = test_progression.url
content = test_progression.content
engine = test_progression.engine
client = test_progression.client

ALL = set(modes.REWARDS)
# Each mode's rewards earned. The first four are the code as it was before v0.9.10, which the
# settlement tests below pin; the rest are proposals for modes no game is made in yet.
EARNS = {
    "practice": ALL - {"competitive"},
    "table": ALL - {"competitive"},
    "campaign": set(),
    "testing": {"wins", "quests", "achievements"},
    "sandbox": set(),
    "borrowed": ALL - {"competitive"},
    "league_practice": {"statistics"},
    "league": {"statistics", "competitive"},
}


@pytest.mark.parametrize("mode", modes.MODES)
def test_the_policy_matrix(mode: str) -> None:
    rules = modes.eligibility(mode)
    assert {reward for reward in modes.REWARDS if rules.earns(reward)} == EARNS[mode]
    # Every reward withheld has a reason, recorded with the game.
    record = rules.record()
    assert set(record["withheld"]) == ALL - EARNS[mode]  # type: ignore[arg-type]
    assert all(record["withheld"].values())  # type: ignore[union-attr]
    # A game that ended with no result earns nothing but its players' "no result".
    ended = modes.eligibility(mode, result=False)
    assert {reward for reward in modes.REWARDS if ended.earns(reward)} <= {"statistics"}


def test_a_game_no_mode_names_earns_nothing() -> None:
    rules = modes.eligibility("chess")
    assert not any(rules.earns(reward) for reward in modes.REWARDS)
    assert set(rules.record()["withheld"].values()) == {"unknown_mode"}  # type: ignore[union-attr]


def test_old_games_are_given_their_mode_from_what_they_are() -> None:
    assert modes.mode_of("practice", False) == "practice"
    assert modes.mode_of("table", False) == "table"
    assert modes.mode_of("practice", True) == "campaign"


def game(client: TestClient, seats: list[UUID | None], kind: str = "practice") -> UUID:
    game_id = uuid4()
    database = client.app.state.database  # type: ignore[attr-defined]
    owner = next(seat for seat in seats if seat is not None)
    with Session(database) as db:
        db.add(
            Game(
                id=game_id,
                kind=kind,
                format="commander",
                status="active",
                created_by=owner,
                created_at=utcnow(),
                bot_skill=4,
                turn_cap=60,
            )
        )
        db.flush()
        for index, user_id in enumerate(seats):
            db.add(
                GameSeat(
                    game_id=game_id,
                    seat=index,
                    player="human" if user_id else "bot",
                    user_id=user_id,
                    deck="x",
                )
            )
        db.commit()
    return game_id


def settled(client: TestClient, user_id: UUID, game_id: UUID) -> dict[str, Any]:
    """What a game left on a player's account."""
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        row = db.get_one(Game, game_id)
        return {
            "mode": row.mode,
            "eligibility": row.eligibility,
            "tokens": list(
                db.scalars(
                    select(TokenEntry.kind).where(
                        TokenEntry.user_id == user_id, TokenEntry.game_id == game_id
                    )
                )
            ),
            "wins": db.scalar(
                select(func.count()).where(
                    ProgressEntry.user_id == user_id, ProgressEntry.game_id == game_id
                )
            ),
            "results": list(
                db.execute(
                    select(PlayerResult.outcome, PlayerResult.mode).where(
                        PlayerResult.user_id == user_id, PlayerResult.game_id == game_id
                    )
                )
            ),
            "quests_drawn": db.scalar(select(func.count()).where(DailyQuest.user_id == user_id)),
        }


def test_a_practice_game_pays_counts_and_records_as_before(client: TestClient) -> None:
    ada = Account(client, "ada")
    game_id = game(client, [ada.id, None])
    games.record_end(client.app.state.database, game_id, "finished", completed(0))  # type: ignore[attr-defined]
    seen = settled(client, ada.id, game_id)
    assert seen["mode"] == "practice"
    assert seen["tokens"] == ["bot_win"] and seen["wins"] == 1
    assert [tuple(row) for row in seen["results"]] == [("win", "practice")]
    assert seen["eligibility"] == {
        "mode": "practice",
        "earns": ["tokens", "wins", "quests", "achievements", "statistics"],
        "withheld": {"competitive": modes.NOT_COMPETITIVE},
    }
    # Settled again, nothing is settled twice: the game's end is recorded once, and every grant
    # is keyed by the game and its seats.
    games.record_end(client.app.state.database, game_id, "finished", completed(0))  # type: ignore[attr-defined]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        replayed = db.get_one(Game, game_id)
        from api.awards import settle
        from api.economy import pay_game
        from api.progression import count_win

        count_win(db, replayed)
        pay_game(db, replayed)
        settle(db, replayed)
        db.commit()
    assert settled(client, ada.id, game_id) == seen


def test_a_table_game_pays_its_winner_for_the_player_beaten(client: TestClient) -> None:
    ada, bea = Account(client, "ada"), Account(client, "bea")
    game_id = game(client, [ada.id, bea.id], kind="table")
    games.record_end(client.app.state.database, game_id, "finished", completed(1))  # type: ignore[attr-defined]
    winner, loser = settled(client, bea.id, game_id), settled(client, ada.id, game_id)
    assert winner["mode"] == "table"
    assert winner["tokens"] == ["human_win"] and winner["wins"] == 1
    assert [tuple(row) for row in winner["results"]] == [("win", "table")]
    assert loser["tokens"] == [] and loser["wins"] == 0
    assert [tuple(row) for row in loser["results"]] == [("loss", "table")]


def test_an_interrupted_game_earns_nothing_but_a_no_result(client: TestClient) -> None:
    ada = Account(client, "ada")
    game_id = game(client, [ada.id, None])
    games.record_end(client.app.state.database, game_id, "interrupted", None)  # type: ignore[attr-defined]
    seen = settled(client, ada.id, game_id)
    assert seen["tokens"] == [] and seen["wins"] == 0
    assert [tuple(row) for row in seen["results"]] == [("no_result", "practice")]
    assert seen["eligibility"]["withheld"]["tokens"] == modes.NO_RESULT  # type: ignore[index]
    assert seen["quests_drawn"] == 0


def test_a_campaign_duel_is_the_campaigns_to_settle(client: TestClient) -> None:
    ada = Account(client, "ada")
    game_id = game(client, [ada.id, None])
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        db.add(
            CampaignGame(
                game_id=game_id,
                user_id=ada.id,
                campaign_id="campaign-v1",
                encounter=1,
                opponent="daretti",
                opponent_name="Daretti",
                title="The Scrap Savant",
                deck="own",
                created_at=utcnow(),
            )
        )
        db.commit()
    games.record_end(client.app.state.database, game_id, "finished", completed(0))  # type: ignore[attr-defined]
    seen = settled(client, ada.id, game_id)
    # A campaign duel is the campaign's, whatever it was made as.
    assert seen["mode"] == "campaign"
    # No win counted, no win's tokens, no result, no quest: the campaign's own rewards are its own.
    assert seen["tokens"] == [] and seen["wins"] == 0 and seen["results"] == []
    assert seen["eligibility"]["withheld"]["tokens"] == modes.CAMPAIGN_PAYS_ITS_OWN  # type: ignore[index]
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        assert db.get_one(CampaignGame, game_id).outcome == "won"
