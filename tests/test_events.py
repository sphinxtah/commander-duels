"""A game's structured events (v0.9.10, api/events.py): one perspective filter for every reader, the
events kept as a game goes on and replaced when the engine took the game up again, read through a
player's eyes or inspection's, and swept after their time.

The engine side (what events a real game makes, and who may see each object) is the engine's
GameEventsTest and ServiceRecoveryHttpTest; here the fake engine of test_games serves them.
"""

import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_games import Account, FakeEngine, build, connect

from api import events, games
from api.events import Perspective, filtered
from api.models import AuditEvent, Game, GameEventRow, GameSeat

# One event of each visibility: a card only seat 0 sees (its draw), one seats 0 and 1 see (a
# draw at a Two-Headed Giant table), one only seat 2 sees (a face-down creature, the cause of a
# damage), and a spell everyone sees.
DRAW = {
    "v": 1, "seq": 1, "epoch": 0, "turn": 1, "step": "draw", "type": "zone_change",
    "from": "library", "to": "hand", "player": 0,
    "object": {"ref": "o1111111111111111", "name": "Lightning Bolt", "owner": 0,
               "seen_by": [0], "was": "o2222222222222222"},
}  # fmt: skip
TEAM_DRAW = {
    "v": 1, "seq": 2, "epoch": 0, "turn": 1, "step": "draw", "type": "zone_change",
    "from": "library", "to": "hand", "player": 1,
    "object": {"ref": "o3333333333333333", "name": "Counterspell", "owner": 1, "seen_by": [0, 1]},
}  # fmt: skip
CAST = {
    "v": 1, "seq": 3, "epoch": 0, "turn": 1, "step": "precombat_main", "type": "cast",
    "player": 0, "object": {"ref": "o4444444444444444", "name": "Lightning Bolt", "owner": 0,
                            "seen_by": "all"},
}  # fmt: skip
DAMAGE = {
    "v": 1, "seq": 4, "epoch": 0, "turn": 2, "step": "combat_damage", "type": "damage",
    "target": {"seat": 0}, "amount": 2, "combat": True,
    "cause": {"ref": "o5555555555555555", "name": "Morph Beast", "owner": 2, "seen_by": [2]},
}  # fmt: skip
EVENTS = [DRAW, TEAM_DRAW, CAST, DAMAGE]


@pytest.fixture
def database(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> str:
    url = f"sqlite:///{tmp_path}/events.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    return url


def secrets_of(event: dict[str, Any]) -> list[str]:
    """Every identity in the event's objects: what a perspective that may not see it must not
    get."""
    found = []
    for key in events.OBJECT_FIELDS:
        value = event.get(key)
        if isinstance(value, dict) and "ref" in value:
            found += [value["ref"], value["name"]] + ([value["was"]] if "was" in value else [])
    return found


@pytest.mark.parametrize(
    ("perspective", "visible"),
    [
        (Perspective.of_seat(0), {1, 2, 3}),
        (Perspective.of_seat(1), {2, 3}),  # the teammate sees its partner's draw
        (Perspective.of_seat(2), {3, 4}),
        (Perspective.of_seat(3), {3}),
        (Perspective.spectator(), {3}),
        (Perspective.inspection(), {1, 2, 3, 4}),
    ],
)
def test_each_perspective_sees_only_what_it_may(
    perspective: Perspective, visible: set[int]
) -> None:
    for event in EVENTS:
        shown = filtered(event, perspective)
        text = json.dumps(shown)
        # The event itself is everyone's: its kind, seats, zones, amounts and turn.
        for key in ("seq", "type", "turn", "player", "from", "to", "amount", "target"):
            if key in event and key != "target":
                assert shown[key] == event[key]
        if event["seq"] in visible:
            for secret in secrets_of(event):
                assert secret in text
            if perspective.kind != "inspection":
                assert "seen_by" not in text, "who else may see it is not told"
        else:
            for secret in secrets_of(event):
                assert secret not in text, f"{secret} leaked to {perspective}: {text}"
            hidden = shown.get("object") or shown.get("cause")
            assert hidden == {
                "hidden": True,
                "owner": (event.get("object") or event["cause"])["owner"],
            }
    assert filtered(DAMAGE, Perspective.of_seat(0))["target"] == {"seat": 0}


def test_an_object_the_filter_cannot_read_is_hidden() -> None:
    odd = dict(CAST, object={"ref": "o6666666666666666", "name": "Shock", "seen_by": "nobody"})
    assert filtered(odd, Perspective.of_seat(0))["object"] == {"hidden": True}
    assert filtered(odd, Perspective.spectator())["object"] == {"hidden": True}


# The events' version 2 (v1.0.0): a cast says what it cost, and what changed its cost names its
# sources; here one every seat sees and one only seat 2 does (a face-down permanent).
TAXED_CAST = {
    "v": 2, "seq": 5, "epoch": 0, "turn": 2, "step": "precombat_main", "type": "cast",
    "player": 1,
    "object": {"ref": "o7777777777777777", "name": "Grizzly Bears", "owner": 1,
               "mana_cost": "{1}{G}", "seen_by": "all"},
    "cost": {"paid": "{4}{G}", "changes": [
        {"how": "more", "tax": True, "amount": 2},
        {"how": "more", "by": {"ref": "o8888888888888888", "name": "Sphere of Resistance",
                               "owner": 0, "seen_by": "all"}},
        {"how": "less", "by": {"ref": "o9999999999999999", "name": "Secret Familiar",
                               "owner": 2, "seen_by": [2]}},
    ]},
}  # fmt: skip
FACE_DOWN_CAST = {
    "v": 2, "seq": 6, "epoch": 0, "turn": 2, "step": "precombat_main", "type": "cast",
    "player": 2,
    "object": {"ref": "oaaaaaaaaaaaaaaaa", "name": "Morph Beast", "owner": 2,
               "mana_cost": "{4}{G}{G}", "seen_by": [2]},
    "cost": {"paid": "{3}"},
}  # fmt: skip


def test_what_changed_a_cost_is_shown_as_any_other_object() -> None:
    seat0 = filtered(TAXED_CAST, Perspective.of_seat(0))
    assert seat0["object"]["mana_cost"] == "{1}{G}" and seat0["cost"]["paid"] == "{4}{G}"
    assert seat0["cost"]["changes"] == [
        {"how": "more", "tax": True, "amount": 2},
        {"how": "more", "by": {"ref": "o8888888888888888", "name": "Sphere of Resistance",
                               "owner": 0}},
        {"how": "less", "by": {"hidden": True, "owner": 2}},
    ]  # fmt: skip
    assert "Secret Familiar" not in json.dumps(seat0) and "seen_by" not in json.dumps(seat0)
    assert "Secret Familiar" in json.dumps(filtered(TAXED_CAST, Perspective.of_seat(2)))
    assert "Secret Familiar" not in json.dumps(filtered(TAXED_CAST, Perspective.spectator()))
    assert filtered(TAXED_CAST, Perspective.inspection()) == TAXED_CAST
    # A spell cast face down: what was paid is everyone's, its printed cost goes with its name.
    for perspective in (Perspective.of_seat(0), Perspective.spectator()):
        hidden = filtered(FACE_DOWN_CAST, perspective)
        assert hidden["object"] == {"hidden": True, "owner": 2}
        assert hidden["cost"] == {"paid": "{3}"}
        assert "{4}{G}{G}" not in json.dumps(hidden)
    assert filtered(FACE_DOWN_CAST, Perspective.of_seat(2))["object"]["mana_cost"] == "{4}{G}{G}"


def until(check: Any, timeout: float = 10.0) -> Any:
    deadline = time.monotonic() + timeout
    while True:
        value = check()
        if value:
            return value
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.05)


@pytest.fixture
def quick(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(games, "EVENTS_EVERY", 0.0)


def test_a_games_events_are_kept_as_it_goes_and_read_through_each_readers_eyes(
    database: str, quick: None
) -> None:
    engine = FakeEngine()
    engine.recordings = True
    with connect(build(database, engine)) as client:
        ada, bea = Account(client, "ada"), Account(client, "bea")
        root = Account(client, "sysop", kind="sysop")
        created = ada.post("/api/v1/practice-games", {})
        assert created.status_code == 201, created.text
        game_id = created.json()["id"]
        engine.game(game_id).events = [dict(DRAW), dict(TEAM_DRAW), dict(CAST)]

        page = until(
            lambda: (reply := ada.get(f"/api/v1/games/{game_id}/timeline")).json()["events"]
            and reply.json()
        )
        assert page["perspective"] == "seat" and page["seat"] == 0
        assert [event["seq"] for event in page["events"]] == [1, 2, 3]
        assert page["events"][0]["object"]["name"] == "Lightning Bolt"
        # Seat 0 and seat 1 see each other's draws here (a team's, as the engine marked it).
        assert page["events"][1]["object"]["name"] == "Counterspell"
        assert page["next"] == 3
        assert ada.get(f"/api/v1/games/{game_id}/timeline", since="2").json()["events"] == [
            filtered(CAST, Perspective.of_seat(0))
        ]

        # More as the game goes on: kept once each.
        engine.game(game_id).events.append(dict(DAMAGE))
        until(lambda: len(ada.get(f"/api/v1/games/{game_id}/timeline").json()["events"]) == 4)
        last = ada.get(f"/api/v1/games/{game_id}/timeline", since="3").json()["events"][0]
        assert last["cause"] == {"hidden": True, "owner": 2}, "a face-down cause is not seat 0's"
        # By turn and by kind.
        by_turn = ada.get(f"/api/v1/games/{game_id}/timeline", turn="2").json()["events"]
        assert [event["seq"] for event in by_turn] == [4]
        casts = ada.get(f"/api/v1/games/{game_id}/timeline", type="cast").json()["events"]
        assert [event["seq"] for event in casts] == [3]

        # Someone not at the table is told of no such game; nor is a player asking to inspect it.
        assert bea.get(f"/api/v1/games/{game_id}/timeline").status_code == 404
        assert ada.get(f"/api/v1/games/{game_id}/timeline", view="inspection").status_code == 404
        # SysOp inspects it whole, and the reading is audited.
        inspected = root.get(f"/api/v1/games/{game_id}/timeline", view="inspection").json()
        assert inspected["perspective"] == "inspection"
        assert inspected["events"][3]["cause"]["seen_by"] == [2]
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            audits = list(
                db.scalars(select(AuditEvent).where(AuditEvent.action == "games.events_inspected"))
            )
            assert [audit.details["game"] for audit in audits] == [game_id]


def test_the_timeline_is_read_backwards_narrowed_and_fresh(
    database: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The timeline's screen (v1.0.0): the last events before a number, of several kinds, of one
    seat, or naming a card the reader may see; and a running game's newest events without the
    hub's five seconds."""
    monkeypatch.setattr(games, "EVENTS_FRESH", 0.0)
    engine = FakeEngine()
    engine.recordings = True
    with connect(build(database, engine)) as client:
        ada = Account(client, "ada")
        root = Account(client, "sysop", kind="sysop")
        game_id = ada.post("/api/v1/practice-games", {}).json()["id"]
        path = f"/api/v1/games/{game_id}/timeline"
        steps = [
            {"v": 2, "seq": 7, "epoch": 0, "turn": 1, "step": "upkeep", "type": "step",
             "active": 0},
            {"v": 2, "seq": 8, "epoch": 0, "turn": 2, "step": "upkeep", "type": "step",
             "active": 1},
        ]  # fmt: skip
        engine.game(game_id).events = [dict(event) for event in EVENTS]
        until(lambda: len(ada.get(path).json()["events"]) == 4)

        # What has just happened is there at once: the hub next reads in five seconds.
        engine.game(game_id).events += [dict(TAXED_CAST), dict(FACE_DOWN_CAST), *steps]
        whole = ada.get(path).json()
        assert [event["seq"] for event in whole["events"]] == [1, 2, 3, 4, 5, 6, 7, 8]
        assert (whole["next"], whole["first"], whole["more"]) == (8, 1, False)

        # The last two, then the two before them.
        tail = ada.get(path, before="7", limit="2").json()
        assert [event["seq"] for event in tail["events"]] == [5, 6]
        assert (tail["first"], tail["more"]) == (5, True)
        earlier = ada.get(path, before=str(tail["first"]), limit="2").json()
        assert [event["seq"] for event in earlier["events"]] == [3, 4]
        assert ada.get(path, before="3", limit="5").json()["more"] is False
        # A page that is full says that more follows, and where to go on.
        page = ada.get(path, limit="4").json()
        assert (page["next"], page["more"]) == (4, True)
        assert [e["seq"] for e in ada.get(path, since="4", limit="2").json()["events"]] == [5, 6]

        # Several kinds at once; one seat's: what it did, what was done to it, its cards.
        kinds = ada.get(path, type="cast,damage").json()
        assert [event["seq"] for event in kinds["events"]] == [3, 4, 5, 6]
        mine = ada.get(path, seat="1").json()
        assert [event["seq"] for event in mine["events"]] == [2, 5]
        # A narrowed page still says whose turn each of its turns was.
        assert mine["turns"] == {"1": 0, "2": 1}
        assert whole["turns"] == {"1": 0, "2": 1}
        assert [e["seq"] for e in ada.get(path, seat="2").json()["events"]] == [4, 6]

        # A name finds what the reader sees named, whatever the case, also a cost's raiser.
        assert [e["seq"] for e in ada.get(path, q="lightning").json()["events"]] == [1, 3]
        assert [e["seq"] for e in ada.get(path, q="sphere of").json()["events"]] == [5]
        # A card hidden from the reader is found by no name: not the face-down creature that
        # dealt the damage and was cast, not the hidden source of a cost's change.
        for hidden in ("morph", "Morph Beast", "familiar"):
            found = ada.get(path, q=hidden).json()
            assert found["events"] == [] and found["more"] is False, hidden
            assert found["next"] == 8, "a reader that found nothing does not look again"
        inspected = root.get(path, view="inspection", q="morph").json()
        assert [event["seq"] for event in inspected["events"]] == [4, 6]


def test_a_game_taken_up_again_keeps_the_engines_new_log(database: str, quick: None) -> None:
    engine = FakeEngine()
    engine.recordings = True
    with connect(build(database, engine)) as client:
        ada = Account(client, "ada")
        game_id = ada.post("/api/v1/practice-games", {}).json()["id"]
        engine.game(game_id).events = [dict(DRAW), dict(TEAM_DRAW), dict(CAST), dict(DAMAGE)]
        until(lambda: len(ada.get(f"/api/v1/games/{game_id}/timeline").json()["events"]) == 4)

        # The engine dies; taken up from its checkpoint, the game made its later events anew.
        engine.restart()
        game = engine.lost[game_id]
        game.epoch = 1
        remade = dict(CAST, epoch=1, object=dict(CAST["object"], name="Shock"))
        game.events = [dict(DRAW), dict(TEAM_DRAW), remade]

        def names() -> list[str]:
            page = ada.get(f"/api/v1/games/{game_id}/timeline").json()["events"]
            return [event.get("object", {}).get("name", "-") for event in page]

        until(lambda: names() == ["Lightning Bolt", "Counterspell", "Shock"] or None)
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            rows = list(
                db.scalars(select(GameEventRow).where(GameEventRow.game_id == uuid.UUID(game_id)))
            )
            assert [(row.seq, row.epoch) for row in rows] == [(1, 0), (2, 0), (3, 1)]


def test_events_past_their_time_are_swept(database: str) -> None:
    with connect(build(database, None)) as client:
        ada = Account(client, "ada")
        now = datetime.now(UTC)
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            ids = []
            for ended in (now - timedelta(days=91), now - timedelta(days=89), None):
                game = Game(
                    id=uuid.uuid4(), kind="practice", format="legacy",
                    status="finished" if ended else "active", created_by=ada.id,
                    created_at=now - timedelta(days=100), finished_at=ended, bot_skill=1,
                    turn_cap=30,
                )  # fmt: skip
                db.add(game)
                db.add(GameSeat(game_id=game.id, seat=0, player="human", user_id=ada.id, deck="d"))
                db.flush()
                db.add(
                    GameEventRow(game_id=game.id, seq=1, epoch=0, turn=1, type="cast", event=CAST)
                )
                ids.append(game.id)
            db.commit()
            assert events.sweep(db, now) == 1
            db.commit()
            kept = set(db.scalars(select(GameEventRow.game_id)))
            assert kept == {ids[1], ids[2]}, "a running game's events and recent ones stay"
            assert events.sweep(db, now) == 0
