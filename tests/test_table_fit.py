"""How a table fit what it described (v1.0.0, api/table_fit.py): asked of a finished table
game's own players where the table kept a Rule Zero profile, answered once and changeable,
counted in the site's numbers and shown to nobody else (the owner's decision 25)."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_games import Account, build, connect

from api import table_fit
from api.models import Game, GameSeat, TableFit

NOW = datetime.now(UTC)
PROFILE = {"version": 1, "intent": "upgraded", "pace": "steady", "duration": 90, "note": ""}


@pytest.fixture
def database(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> str:
    url = f"sqlite:///{tmp_path}/fit.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    return url


def game_of(
    client: TestClient,
    *players: Account,
    kind: str = "table",
    status: str = "finished",
    profile: dict[str, Any] | None = PROFILE,
) -> str:
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        game = Game(
            id=uuid.uuid4(), kind=kind, format="commander", status=status,
            created_by=players[0].id, created_at=NOW - timedelta(hours=1),
            finished_at=None if status == "active" else NOW, bot_skill=1, turn_cap=30,
            table_profile=profile,
        )  # fmt: skip
        db.add(game)
        for seat, player in enumerate(players):
            db.add(
                GameSeat(game_id=game.id, seat=seat, player="human", user_id=player.id, deck="d")
            )
        db.commit()
        return str(game.id)


def test_a_player_says_how_the_table_fit_and_only_the_sites_numbers_know(database: str) -> None:
    with connect(build(database, None)) as client:
        ada, bob, eve = (Account(client, name) for name in ("ada", "bob", "eve"))
        root = Account(client, "sysop", kind="sysop")
        game = game_of(client, ada, bob)
        path = f"/api/v1/games/{game}/table-fit"

        asked = ada.get(path).json()
        assert asked == {"asked": True, "intent_name": "Upgraded casual", "fit": None}
        answered = ada.put(path, {"fit": "stronger"})
        assert answered.status_code == 200, answered.text
        assert answered.json()["fit"] == "stronger"
        # Answering again changes the answer; it is still one.
        assert ada.put(path, {"fit": "as_described"}).json()["fit"] == "as_described"
        assert ada.put(path, {"fit": "splendid"}).status_code == 422
        assert bob.put(path, {"fit": "weaker"}).status_code == 200

        # Each reads back their own and nothing of the other's; nobody else is told of the game.
        assert ada.get(path).json()["fit"] == "as_described"
        assert bob.get(path).json()["fit"] == "weaker"
        assert eve.get(path).status_code == 404
        assert eve.put(path, {"fit": "weaker"}).status_code == 404
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            rows = list(db.scalars(select(TableFit).order_by(TableFit.fit)))
            assert [(row.fit, row.intent) for row in rows] == [
                ("as_described", "upgraded"),
                ("weaker", "upgraded"),
            ]
            assert [count.model_dump() for count in table_fit.tally(db)] == [
                {"intent": "upgraded", "as_described": 1, "stronger": 0, "weaker": 1}
            ]

        # The site's numbers have the tally, for SysOp; a player is refused them.
        numbers = root.get("/api/v1/admin/operations")
        assert numbers.status_code == 200, numbers.text
        assert numbers.json()["table_fit"] == [
            {"intent": "upgraded", "as_described": 1, "stronger": 0, "weaker": 1}
        ]
        assert ada.get("/api/v1/admin/operations").status_code == 403


@pytest.mark.parametrize(
    "game",
    [
        {"profile": None},
        {"profile": {"version": 99, "intent": "upgraded"}},
        {"kind": "practice"},
        {"status": "active"},
        {"status": "interrupted"},
    ],
)
def test_only_a_finished_game_of_a_table_that_described_itself_asks(
    database: str, game: dict[str, Any]
) -> None:
    with connect(build(database, None)) as client:
        ada = Account(client, "ada")
        path = f"/api/v1/games/{game_of(client, ada, **game)}/table-fit"
        assert ada.get(path).json() == {"asked": False, "intent_name": None, "fit": None}
        refused = ada.put(path, {"fit": "weaker"})
        assert (refused.status_code, refused.json()["code"]) == (409, "no_table_fit")
