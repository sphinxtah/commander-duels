"""Save and resume (v1.0.0, api/saves.py): a game against the bots closed into its recording and
played on later.

Against the fake engine of test_games, which keeps recordings and saved games. Covered: the gate;
saving (the tab is told, the game is nobody's running game, the engine holds it); resuming (new
tokens, followed again, played on, counted again); who may save what; the limit of five; the
thirty days; an upgrade that ends a save, found at the restart and at a resume; restarts of the
API and of the engine under a save; a save the engine refuses; discarding; an account deleted.
"""

import time
import uuid
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketDisconnect
from test_games import Account, FakeEngine, Tab, build, connect

from api import games, metrics, saves
from api.identity import utcnow
from api.models import Game, GameSave, User

SAVES = "/api/v1/saves"


@pytest.fixture
def database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    url = f"sqlite:///{tmp_path}/saves.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    return url


@pytest.fixture
def engine() -> FakeEngine:
    engine = FakeEngine()
    engine.recordings = True
    return engine


def hub_of(client: TestClient) -> games.GameHub:
    return client.app.state.games  # type: ignore[attr-defined, no-any-return]


def staged(client: TestClient, stage: str = "on") -> Account:
    """The workflow at a stage, set by the installation's SysOp."""
    root = Account(client, "root-" + uuid.uuid4().hex[:8], kind="sysop")
    changed = root.put("/api/v1/admin/rollout/save_resume", {"stage": stage})
    assert changed.status_code == 200, changed.text
    return root


def delete(account: Account, path: str) -> Any:
    return account.http.delete(
        path,
        headers={"cookie": f"__Host-cd_session={account.token}", "x-csrf-token": account.csrf},
    )


def game_of(client: TestClient, game_id: str) -> Game:
    with Session(client.app.state.database, expire_on_commit=False) as db:  # type: ignore[attr-defined]
        game = db.get(Game, uuid.UUID(game_id))
        assert game is not None
        return game


def saves_of(client: TestClient, game_id: str) -> list[GameSave]:
    with Session(client.app.state.database, expire_on_commit=False) as db:  # type: ignore[attr-defined]
        return list(
            db.scalars(
                select(GameSave)
                .where(GameSave.game_id == uuid.UUID(game_id))
                .order_by(GameSave.saved_at)
            )
        )


def started(account: Account) -> str:
    made = account.post("/api/v1/practice-games", {})
    assert made.status_code == 201, made.text
    return str(made.json()["id"])


def saved(account: Account, game_id: str) -> dict[str, Any]:
    answer = account.post(f"/api/v1/games/{game_id}/save")
    assert answer.status_code == 201, answer.text
    return answer.json()  # type: ignore[no-any-return]


def test_a_workflow_that_is_off_is_not_there(database: str, engine: FakeEngine) -> None:
    """Until SysOp stages it nothing of save and resume exists; at staff it is SysOp's and the
    administrators' alone. A game is played and closed as ever."""
    with connect(build(database, engine)) as client:
        ada = Account(client, "ada")
        game_id = started(ada)
        assert ada.get(SAVES).status_code == 404
        assert ada.post(f"/api/v1/games/{game_id}/save").status_code == 404
        assert ada.post(f"{SAVES}/{uuid.uuid4()}/resume").status_code == 404
        assert delete(ada, f"{SAVES}/{uuid.uuid4()}").status_code == 404
        assert engine.saves == []

        root = staged(client, "staff")
        assert ada.get(SAVES).status_code == 404
        assert ada.post(f"/api/v1/games/{game_id}/save").status_code == 404
        assert root.get(SAVES).json()["saves"] == [], root.get(SAVES).text
        assert game_of(client, game_id).status == "active"
        assert ada.post(f"/api/v1/games/{game_id}/close").json()["status"] == "finished"


def test_a_game_is_saved_and_played_on(database: str, engine: FakeEngine) -> None:
    """Its player saves a game against the bots: the tab is told and let go, the engine holds
    the game, and it is nobody's running game. Resumed, it is followed again with the engine's
    new token, played on where it stood, and counts as its player's game again."""
    with connect(build(database, engine)) as client:
        staged(client)
        ada = Account(client, "ada")
        game_id = started(ada)
        old_token = engine.game(game_id).token
        seen: list[str] = []
        with ada.socket(game_id) as socket:
            socket.send_json(ada.hello(control=True))
            tab = Tab(socket, seen)
            tab.command(tab.snapshot(1))
            assert tab.until("command_result")["status"] == 200
            before = tab.snapshot(2)

            save = saved(ada, game_id)
            told = tab.until("saved")
            assert told == {"type": "saved", "game_id": game_id, "save_id": save["id"]}
            with pytest.raises(WebSocketDisconnect):
                while True:
                    tab.receive()

        # What the save says, and the rules it stands under.
        assert save["game"]["id"] == game_id and save["game"]["status"] == "saved"
        assert save["turn"] == 1 and save["ended_at"] is None and save["ended_reason"] is None
        row = saves_of(client, game_id)[0]
        assert row.expires_at - row.saved_at == timedelta(days=30)
        assert row.engine_build == "build-1"
        listed = ada.get(SAVES).json()
        assert [found["id"] for found in listed["saves"]] == [save["id"]]
        assert (listed["limit"], listed["days"], listed["ends_at_upgrade"]) == (5, 30, True)
        assert listed["ended"] == []

        # The engine holds it until the save runs out, and the API follows nothing.
        assert game_id in engine.saved and game_id not in engine.games
        assert engine.saves == [(game_id, int(row.expires_at.timestamp() * 1000))]
        assert uuid.UUID(game_id) not in hub_of(client).games
        assert hub_of(client).running() == 0
        stored = game_of(client, game_id)
        assert (stored.status, stored.result, stored.finished_at) == ("saved", None, None)
        assert engine.attaches == [], "nothing asked for the game again"
        assert game_id not in engine.closed

        # It is not over: no rematch, no socket, and it shows as saved among the games.
        assert ada.get(f"/api/v1/games/{game_id}").json()["game"]["status"] == "saved"
        assert ada.get("/api/v1/games").json()[0]["status"] == "saved"
        assert ada.post(f"/api/v1/games/{game_id}/rematch").status_code == 409
        with ada.socket(game_id) as socket:
            assert socket.receive_json()["code"] == "game_not_live"
        # Saved twice it is not.
        assert ada.post(f"/api/v1/games/{game_id}/save").json()["code"] == "game_not_running"

        # Its player may play another game meanwhile, and that one comes first.
        other = started(ada)
        blocked = ada.post(f"{SAVES}/{save['id']}/resume")
        assert blocked.status_code == 409 and blocked.json()["code"] == "game_limit"
        assert game_id in engine.saved
        assert ada.post(f"/api/v1/games/{other}/close").json()["status"] == "finished"

        resumed = ada.post(f"{SAVES}/{save['id']}/resume")
        assert resumed.status_code == 200, resumed.text
        assert resumed.json()["id"] == game_id and resumed.json()["status"] == "active"
        assert engine.attaches == [game_id]
        assert engine.game(game_id).token != old_token
        assert game_of(client, game_id).status == "active"
        assert saves_of(client, game_id)[0].ended_reason == "resumed"
        assert ada.get(SAVES).json()["saves"] == []
        # Its player's one game again.
        assert ada.post("/api/v1/practice-games", {}).json()["code"] == "game_limit"
        with ada.socket(game_id) as socket:
            socket.send_json(ada.hello(control=True))
            tab = Tab(socket, seen)
            again = tab.snapshot(1_000_000)
            assert again["log_count"] == before["log_count"]
            tab.command(again)
            assert tab.until("command_result")["status"] == 200
            tab.snapshot(again["revision"] + 1)
        # No seat token ever reached a tab.
        for token in (old_token, engine.game(game_id).token):
            assert all(token not in message for message in seen)

        # A save that was resumed is no save, and the game ends as any game.
        assert ada.post(f"{SAVES}/{save['id']}/resume").status_code == 404
        assert delete(ada, f"{SAVES}/{save['id']}").status_code == 404
        closed = ada.post(f"/api/v1/games/{game_id}/close")
        assert closed.status_code == 200 and closed.json()["status"] == "finished"
        assert metrics.COUNTERS.read("saves.saved") >= 1


def test_only_its_own_player_saves_a_game_against_the_bots(
    database: str, engine: FakeEngine
) -> None:
    with connect(build(database, engine)) as client:
        staged(client)
        ada, bob = Account(client, "ada"), Account(client, "bob")
        game_id = started(ada)
        # Another's game looks like none, and another's save too.
        assert bob.post(f"/api/v1/games/{game_id}/save").status_code == 404
        assert game_of(client, game_id).status == "active"
        save = saved(ada, game_id)
        assert bob.post(f"{SAVES}/{save['id']}/resume").status_code == 404
        assert delete(bob, f"{SAVES}/{save['id']}").status_code == 404
        assert bob.get(SAVES).json()["saves"] == []
        assert game_id in engine.saved

        # A game that is over has nothing to save.
        over = started(ada)
        assert ada.post(f"/api/v1/games/{over}/close").json()["status"] == "finished"
        refused = ada.post(f"/api/v1/games/{over}/save")
        assert refused.status_code == 409 and refused.json()["code"] == "game_not_running"

        # A match's game is not saved: the match would stand between its games.
        match = ada.post("/api/v1/practice-games", {"format": "legacy", "best_of": 3})
        assert match.status_code == 201, match.text
        refused = ada.post(f"/api/v1/games/{match.json()['id']}/save")
        assert refused.status_code == 409 and refused.json()["code"] == "match_game"
        assert game_of(client, match.json()["id"]).status == "active"
        assert len(engine.saves) == 1


def test_an_account_holds_five_saves(database: str, engine: FakeEngine) -> None:
    """A sixth waits for one to be resumed or discarded, and its game plays on meanwhile."""
    with connect(build(database, engine)) as client:
        staged(client)
        ada = Account(client, "ada")
        held = [saved(ada, started(ada))["id"] for _ in range(5)]
        assert [found["id"] for found in ada.get(SAVES).json()["saves"]] == held[::-1]

        sixth = started(ada)
        with ada.socket(sixth) as socket:
            socket.send_json(ada.hello(control=True))
            tab = Tab(socket, [])
            first = tab.snapshot(1)
            refused = ada.post(f"/api/v1/games/{sixth}/save")
            assert refused.status_code == 409 and refused.json()["code"] == "save_limit"
            # Untouched: still followed, still played.
            tab.command(first)
            assert tab.until("command_result")["status"] == 200
            tab.snapshot(2)
        assert sixth in engine.games and len(engine.saved) == 5

        assert delete(ada, f"{SAVES}/{held[0]}").status_code == 204
        assert saved(ada, sixth)["game"]["id"] == sixth
        assert len(ada.get(SAVES).json()["saves"]) == 5


def test_a_save_runs_out_after_its_days(database: str, engine: FakeEngine) -> None:
    """Past its time a save has ended wherever it is next looked at: the game is interrupted,
    with no result, and its player reads why for a while."""
    with connect(build(database, engine)) as client:
        staged(client)
        ada = Account(client, "ada")
        first, second = started(ada), None
        one = saved(ada, first)
        second = started(ada)
        two = saved(ada, second)
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            for save in db.scalars(select(GameSave)):
                save.expires_at = utcnow() - timedelta(minutes=1)
            db.commit()

        # Found by the resume itself.
        gone = ada.post(f"{SAVES}/{one['id']}/resume")
        assert gone.status_code == 410 and gone.json()["code"] == "save_ended"
        assert "30 days" in gone.json()["message"]
        assert game_of(client, first).status == "interrupted"
        assert game_of(client, first).result is None
        assert engine.attaches == [], "the engine is not asked for a save that ran out"

        # And by the worker's daily job.
        assert saves.expire_saves(client.app.state.database, utcnow()) == 1  # type: ignore[attr-defined]
        assert game_of(client, second).status == "interrupted"
        listed = ada.get(SAVES).json()
        assert listed["saves"] == []
        assert {found["id"] for found in listed["ended"]} == {one["id"], two["id"]}
        assert {found["ended_reason"] for found in listed["ended"]} == {"expired"}
        assert {found["game"]["status"] for found in listed["ended"]} == {"interrupted"}
        assert delete(ada, f"{SAVES}/{two['id']}").status_code == 410
        # An interrupted game is over: its player starts another.
        assert ada.post("/api/v1/practice-games", {}).status_code == 201


def test_a_save_ends_at_the_upgrade(database: str, engine: FakeEngine) -> None:
    """The owner's decision: a recording is played on only by the engine build that made it, and
    no second engine is kept. The API that starts with the upgraded engine ends the saves the
    old build holds, so their players read it in the list."""
    with connect(build(database, engine)) as first:
        staged(first)
        ada = Account(first, "ada")
        game_id = started(ada)
        save = saved(ada, game_id)

    engine.build = "build-2"
    with connect(build(database, engine)) as upgraded:
        ada.http = upgraded
        deadline = time.monotonic() + 5
        while game_of(upgraded, game_id).status == "saved":
            assert time.monotonic() < deadline, "the save of the old build was not ended"
            time.sleep(0.02)
        assert game_of(upgraded, game_id).status == "interrupted"
        assert game_of(upgraded, game_id).result is None
        listed = ada.get(SAVES).json()
        assert listed["saves"] == []
        assert [found["ended_reason"] for found in listed["ended"]] == ["upgrade"]
        gone = ada.post(f"{SAVES}/{save['id']}/resume")
        assert gone.status_code == 410 and "upgraded" in gone.json()["message"]
        assert engine.attaches == []


def test_an_upgrade_is_found_when_a_save_is_resumed(database: str, engine: FakeEngine) -> None:
    """An engine upgraded under a running API (or one that did not name its build in time): the
    resume is refused by the engine, and the save ends then."""
    with connect(build(database, engine)) as client:
        staged(client)
        ada = Account(client, "ada")
        game_id = started(ada)
        save = saved(ada, game_id)
        engine.build = "build-2"
        gone = ada.post(f"{SAVES}/{save['id']}/resume")
        assert gone.status_code == 410 and gone.json()["code"] == "save_ended"
        assert "upgraded" in gone.json()["message"]
        assert saves_of(client, game_id)[0].ended_reason == "upgrade"
        assert game_of(client, game_id).status == "interrupted"
        assert hub_of(client).running() == 0 and hub_of(client).starting == 0


def test_a_save_outlives_restarts_of_the_api_and_the_engine(
    database: str, engine: FakeEngine
) -> None:
    """A saved game is not a running game: the API's restart asks the engine for nothing, and
    the engine that follows a dead one gives the game back when its player asks."""
    with connect(build(database, engine)) as first:
        staged(first)
        ada = Account(first, "ada")
        game_id = started(ada)
        save = saved(ada, game_id)

    engine.restart()
    with connect(build(database, engine)) as restarted:
        ada.http = restarted
        deadline = time.monotonic() + 5
        while engine.builds_asked == 0:
            assert time.monotonic() < deadline, "the engine's build was not asked for"
            time.sleep(0.02)
        assert engine.attaches == []
        assert game_of(restarted, game_id).status == "saved"
        assert [found["id"] for found in ada.get(SAVES).json()["saves"]] == [save["id"]]

        resumed = ada.post(f"{SAVES}/{save['id']}/resume")
        assert resumed.status_code == 200 and resumed.json()["status"] == "active"
        with ada.socket(game_id) as socket:
            socket.send_json(ada.hello(control=True))
            tab = Tab(socket, [])
            tab.command(tab.snapshot(1_000_000))
            assert tab.until("command_result")["status"] == 200


def test_a_recording_that_is_gone_ends_the_save(database: str, engine: FakeEngine) -> None:
    with connect(build(database, engine)) as client:
        staged(client)
        ada = Account(client, "ada")
        game_id = started(ada)
        save = saved(ada, game_id)
        engine.saved.clear()
        gone = ada.post(f"{SAVES}/{save['id']}/resume")
        assert gone.status_code == 410 and gone.json()["code"] == "save_ended"
        assert saves_of(client, game_id)[0].ended_reason == "unrecoverable"
        assert game_of(client, game_id).status == "interrupted"
        assert [found["ended_reason"] for found in ada.get(SAVES).json()["ended"]] == [
            "unrecoverable"
        ]


def test_a_full_engine_keeps_the_save_waiting(database: str) -> None:
    engine = FakeEngine(cap=1)
    engine.recordings = True
    with connect(build(database, engine)) as client:
        staged(client)
        ada, bob = Account(client, "ada"), Account(client, "bob")
        save = saved(ada, started(ada))
        started(bob)
        full = ada.post(f"{SAVES}/{save['id']}/resume")
        assert full.status_code == 429 and full.json()["code"] == "games_busy"
        assert [found["id"] for found in ada.get(SAVES).json()["saves"]] == [save["id"]]
        assert hub_of(client).starting == 0


@pytest.mark.parametrize(
    ("answer", "status", "code"),
    [
        ((409, {"code": "not_recorded"}), 409, "save_unavailable"),
        ((409, {"code": "game_over"}), 409, "game_not_running"),
        ((503, {"code": "save_not_ready"}), 503, "save_not_ready"),
    ],
)
def test_a_save_the_engine_refuses_leaves_the_game_running(
    database: str, engine: FakeEngine, answer: tuple[int, dict[str, Any]], status: int, code: str
) -> None:
    with connect(build(database, engine)) as client:
        staged(client)
        ada = Account(client, "ada")
        game_id = started(ada)
        with ada.socket(game_id) as socket:
            socket.send_json(ada.hello(control=True))
            tab = Tab(socket, [])
            first = tab.snapshot(1)
            engine.save_refusal = answer
            refused = ada.post(f"/api/v1/games/{game_id}/save")
            assert (refused.status_code, refused.json()["code"]) == (status, code)
            # Followed again, and played on by the same tab.
            tab.command(first)
            assert tab.until("command_result")["status"] == 200
            tab.snapshot(2)
        assert game_of(client, game_id).status == "active"
        assert saves_of(client, game_id) == []
        assert ada.get(SAVES).json()["saves"] == []
        # And saved when the engine can.
        assert saved(ada, game_id)["game"]["status"] == "saved"


def test_discarding_a_save_ends_the_game_with_no_result(database: str, engine: FakeEngine) -> None:
    with connect(build(database, engine)) as client:
        staged(client)
        ada = Account(client, "ada")
        game_id = started(ada)
        save = saved(ada, game_id)
        assert delete(ada, f"{SAVES}/{save['id']}").status_code == 204
        assert engine.discarded == [game_id] and engine.saved == {}
        stored = game_of(client, game_id)
        assert (stored.status, stored.result) == ("interrupted", None)
        assert stored.finished_at is not None
        assert saves_of(client, game_id)[0].ended_reason == "discarded"
        # Gone from the list for good, and not told as something that happened to its player.
        listed = ada.get(SAVES).json()
        assert listed["saves"] == [] and listed["ended"] == []
        assert ada.post(f"{SAVES}/{save['id']}/resume").status_code == 404
        assert delete(ada, f"{SAVES}/{save['id']}").status_code == 404
        assert ada.get("/api/v1/games").json()[0]["status"] == "interrupted"


def test_a_deleted_accounts_saves_end(database: str, engine: FakeEngine) -> None:
    from api.accounts import delete_account

    with connect(build(database, engine)) as client:
        staged(client)
        ada = Account(client, "ada")
        game_id = started(ada)
        saved(ada, game_id)
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            user = db.get(User, ada.id)
            assert user is not None
            delete_account(db, user, utcnow())
            db.commit()
        assert saves_of(client, game_id)[0].ended_reason == "account"
        assert game_of(client, game_id).status == "interrupted"


def test_a_saved_campaign_duel_is_on_the_campaigns_map(database: str, engine: FakeEngine) -> None:
    """The campaign names its player's duels that wait saved, so that its map can say so and
    offer them: the ward, the turn and the save. Nobody else's map names it, a duel played on is
    the running one again, and with the workflow closed the map offers nothing."""
    with connect(build(database, engine)) as client:
        root = staged(client)
        ada, bob = Account(client, "ada"), Account(client, "bob")
        begun = ada.post("/api/v1/campaign/encounters/1/start", {"loaner": True})
        assert begun.status_code == 201, begun.text
        game_id = str(begun.json()["id"])
        state = ada.get("/api/v1/campaign").json()
        assert (state["running"], state["saved"]) == (game_id, [])

        save = saved(ada, game_id)
        assert save["game"]["campaign"]["encounter"] == 1
        state = ada.get("/api/v1/campaign").json()
        assert state["running"] is None
        assert state["saved"] == [
            {
                "save": save["id"],
                "game": game_id,
                "encounter": 1,
                "challenge": False,
                "turn": save["turn"],
                "saved_at": save["saved_at"],
                "expires_at": save["expires_at"],
                "table": None,
            }
        ]
        assert bob.get("/api/v1/campaign").json()["saved"] == []
        # A second duel of the ward may be begun beside the saved one: both are the campaign's.
        again = ada.post("/api/v1/campaign/encounters/1/start", {"loaner": True})
        assert again.status_code == 201, again.text
        state = ada.get("/api/v1/campaign").json()
        assert state["running"] == again.json()["id"]
        assert [duel["game"] for duel in state["saved"]] == [game_id]
        assert ada.post(f"/api/v1/games/{again.json()['id']}/close").status_code == 200

        # Closed, a save cannot be played on: the map does not offer it.
        assert root.put("/api/v1/admin/rollout/save_resume", {"stage": "off"}).status_code == 200
        assert ada.get("/api/v1/campaign").json()["saved"] == []
        assert root.put("/api/v1/admin/rollout/save_resume", {"stage": "on"}).status_code == 200

        resumed = ada.post(f"{SAVES}/{save['id']}/resume")
        assert resumed.status_code == 200, resumed.text
        state = ada.get("/api/v1/campaign").json()
        assert (state["running"], state["saved"]) == (game_id, [])

        # A save past its days is not offered, even before the daily job ends it.
        save = saved(ada, game_id)
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            row = db.get(GameSave, uuid.UUID(save["id"]))
            assert row is not None
            row.expires_at = utcnow() - timedelta(minutes=1)
            db.commit()
        assert ada.get("/api/v1/campaign").json()["saved"] == []
