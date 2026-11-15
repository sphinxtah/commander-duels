"""Replays and review (v1.0.0, api/replays.py; docs/replays.md): a game that is over read through
one seat's eyes, a reader's own bookmarks and notes, a replay shared with a friend and taken back,
what goes when, and the gate.

The events themselves, and the filter every reading goes through, are test_events.py's.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_events import CAST, DAMAGE, DRAW, TEAM_DRAW
from test_games import Account, build, connect

from api import replays
from api.models import (
    AccessGrant,
    AuditEvent,
    Deck,
    DeckRevision,
    Game,
    GameEventRow,
    GameSeat,
    Notification,
    PlayerBlock,
    ReplayMark,
)

NOW = datetime.now(UTC)


@pytest.fixture
def database(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> str:
    url = f"sqlite:///{tmp_path}/replays.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    return url


def delete(account: Account, path: str, **params: str) -> Any:
    return account.http.delete(
        path,
        params=params,
        headers={"cookie": f"__Host-cd_session={account.token}", "x-csrf-token": account.csrf},
    )


def set_stage(root: Account, stage: str) -> None:
    changed = root.put("/api/v1/admin/rollout/replays", {"stage": stage})
    assert changed.status_code == 200, changed.text


def staged(client: TestClient, stage: str = "on") -> Account:
    """The workflow at a stage, set by the installation's SysOp."""
    root = Account(client, "root-" + uuid.uuid4().hex[:8], kind="sysop")
    set_stage(root, stage)
    return root


def befriend(one: Account, other: Account) -> None:
    assert one.put(f"/api/v1/friends/{other.id}").status_code == 200
    assert other.put(f"/api/v1/friends/{one.id}").json()["friendship"] == "friends"


def played(
    client: TestClient,
    *players: Account,
    status: str = "finished",
    ended: datetime | None = None,
    format: str = "legacy",
    deck: bool = False,
) -> str:
    """A game its players have played, with the four events of test_events: seat 0's draw (its
    own to see), seat 1's (seats 0 and 1 see it), a spell everyone saw, and damage by a card only
    seat 2 could see."""
    ended = ended or NOW - timedelta(days=1)
    with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
        game = Game(
            id=uuid.uuid4(), kind="table", format=format, status=status,
            created_by=players[0].id, created_at=ended - timedelta(hours=1),
            finished_at=None if status in ("active", "saved") else ended, bot_skill=1, turn_cap=30,
            result={"kind": "completed", "turns": 2, "winner_seat": 0, "winner_seats": [0],
                    "conceded_seats": [], "draw": False} if status == "finished" else None,
            kings_table={"life": "generals_20_kings_40"} if format == "kings_table" else None,
        )  # fmt: skip
        db.add(game)
        revision = None
        if deck:
            owned = Deck(
                owner_id=players[0].id, title="Burn", format="legacy", draft_hash="h",
                created_at=ended, updated_at=ended,
            )  # fmt: skip
            db.add(owned)
            db.flush()
            revision = DeckRevision(
                deck_id=owned.id, number=3, format="legacy", title="Burn, with Fireblast",
                content_hash="c", legal=True, playable=True, created_at=ended,
            )  # fmt: skip
            db.add(revision)
            db.flush()
        for seat, player in enumerate(players):
            db.add(
                GameSeat(
                    game_id=game.id, seat=seat, player="human", user_id=player.id, deck="custom",
                    deck_revision_id=revision.id if revision is not None and seat == 0 else None,
                )
            )  # fmt: skip
        for seat in range(len(players), 4 if format != "legacy" else 2):
            db.add(GameSeat(game_id=game.id, seat=seat, player="bot", deck="bot-deck"))
        db.flush()
        for event in (DRAW, TEAM_DRAW, CAST, DAMAGE):
            db.add(
                GameEventRow(
                    game_id=game.id, seq=event["seq"], epoch=0, turn=event["turn"],
                    type=event["type"], event=event,
                )
            )  # fmt: skip
        db.commit()
        return str(game.id)


def names(page: dict[str, Any]) -> list[str | None]:
    """What each event's card reads as: its name, or None for one the reader may not see."""
    found = []
    for event in page["events"]:
        thing = event.get("object") or event.get("cause")
        found.append(thing.get("name") if isinstance(thing, dict) else None)
    return found


def test_a_replay_is_read_through_its_readers_own_seat(database: str) -> None:
    with connect(build(database, None)) as client:
        staged(client)
        ada, bea, dee = (Account(client, name) for name in ("ada", "bea", "dee"))
        game = played(client, ada, bea, deck=True)

        mine = ada.get(f"/api/v1/games/{game}/replay")
        assert mine.status_code == 200, mine.text
        replay = mine.json()
        assert replay["through"] == {"seat": 0, "yours": True, "shared_by": None, "grant_id": None}
        assert replay["game"]["id"] == game and replay["game"]["your_seat"] == 0
        assert (replay["events"], replay["turns"]) == (4, 2)
        assert [(start["seat"], start["life"], start["team"]) for start in replay["starting"]] == [
            (0, 20, None),
            (1, 20, None),
        ]
        # The deck as it was played: the saved version's own title and number.
        assert replay["deck"]["title"] == "Burn, with Fireblast" and replay["deck"]["version"] == 3
        assert replay["deck"]["deck_id"] is not None
        kept = datetime.fromisoformat(replay["kept_until"])
        assert timedelta(days=88) < kept - NOW < timedelta(days=90)
        assert replay["marks"] == [] and replay["note"] == "" and replay["shares"] == []

        # Each player reads the same game through their own seat, however it is asked for.
        events = ada.get(f"/api/v1/games/{game}/replay/events").json()
        assert events["perspective"] == "seat" and events["seat"] == 0
        assert names(events) == ["Lightning Bolt", "Counterspell", "Lightning Bolt", None]
        hers = bea.get(f"/api/v1/games/{game}/replay/events").json()
        assert hers["seat"] == 1
        assert names(hers) == [None, "Counterspell", "Lightning Bolt", None]
        assert bea.get(f"/api/v1/games/{game}/replay").json()["deck"] == {
            "title": "custom", "version": None, "deck_id": None,
        }  # fmt: skip
        # Seeking shows no more: from any number, in any size, it is the same filter.
        later = bea.get(f"/api/v1/games/{game}/replay/events", since="0", limit="1").json()
        assert names(later) == [None] and later["more"] is True and later["next"] == 1
        assert names(bea.get(f"/api/v1/games/{game}/replay/events", since="3").json()) == [None]
        assert events["turns"] == {}, "these events hold no step to say whose turn it was"

        # Nobody else is told the game exists, and asking for someone's share that was never
        # given finds nothing either.
        for path in (f"/api/v1/games/{game}/replay", f"/api/v1/games/{game}/replay/events"):
            assert dee.get(path).status_code == 404
            assert dee.get(path, shared_by=str(ada.id)).status_code == 404
            assert bea.get(path, shared_by=str(ada.id)).status_code == 404

        # The list: the games the account played, and nothing of anyone else's.
        listed = ada.get("/api/v1/replays").json()
        assert [entry["game"]["id"] for entry in listed["own"]] == [game]
        assert listed["own"][0]["turns"] == 2 and listed["shared"] == [] and not listed["more"]
        assert dee.get("/api/v1/replays").json() == {"own": [], "shared": [], "more": False}


def test_a_game_that_is_not_over_has_no_replay_and_one_without_events_is_not_listed(
    database: str,
) -> None:
    with connect(build(database, None)) as client:
        staged(client)
        ada, bea = Account(client, "ada"), Account(client, "bea")
        running = played(client, ada, bea, status="active")
        refused = ada.get(f"/api/v1/games/{running}/replay")
        assert refused.status_code == 409 and refused.json()["code"] == "replay_not_ready"
        assert ada.get(f"/api/v1/games/{running}/replay/events").status_code == 409
        over = played(client, ada, bea)
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            db.execute(sa_delete(GameEventRow).where(GameEventRow.game_id == uuid.UUID(over)))
            db.commit()
        assert ada.get("/api/v1/replays").json()["own"] == []
        # Asked for by its address it says how long it is: nothing.
        assert ada.get(f"/api/v1/games/{over}/replay").json()["events"] == 0


def test_the_scoreboard_starts_from_each_formats_life_and_teams(database: str) -> None:
    with connect(build(database, None)) as client:
        staged(client)
        ada = Account(client, "ada")
        starts = {}
        for format in ("commander", "two_headed_giant", "kings_table"):
            game = played(client, ada, format=format)
            replay = ada.get(f"/api/v1/games/{game}/replay").json()
            starts[format] = [
                (start["life"], start["team"], start["shared_life"]) for start in replay["starting"]
            ]
        assert starts["commander"] == [(40, None, False)] * 4
        assert starts["two_headed_giant"] == [
            (30, 0, True),
            (30, 0, True),
            (30, 1, True),
            (30, 1, True),
        ]
        # King's Table as the test's game has it: four seats of its six, the Kings at 40.
        assert starts["kings_table"] == [
            (20, 0, False),
            (40, 0, False),
            (20, 0, False),
            (20, 1, False),
        ]


def test_bookmarks_and_notes_are_their_readers_own(database: str) -> None:
    with connect(build(database, None)) as client:
        staged(client)
        ada, bea = Account(client, "ada"), Account(client, "bea")
        game = played(client, ada, bea)
        marks = f"/api/v1/games/{game}/replay/marks"

        marked = ada.put(f"{marks}/3", {"label": "  The Bolt  ", "note": "Should have held it."})
        assert marked.status_code == 200, marked.text
        assert [(m["seq"], m["turn"], m["label"], m["note"]) for m in marked.json()["marks"]] == [
            (3, 1, "The Bolt", "Should have held it.")
        ]
        # Marking the same event again changes the mark; an event the game never had is refused.
        again = ada.put(f"{marks}/3", {"label": "Bolt", "note": ""}).json()
        assert [(m["seq"], m["label"], m["note"]) for m in again["marks"]] == [(3, "Bolt", "")]
        missing = ada.put(f"{marks}/99", {"label": "x"})
        assert missing.status_code == 404 and missing.json()["code"] == "no_such_event"
        assert ada.put(f"{marks}/3", {"label": "x" * 81}).status_code == 422
        assert ada.put(f"{marks}/3", {"note": "x" * 2001}).status_code == 422

        # The note on the game as a whole is the mark at 0; an empty one removes it.
        noted = ada.put(f"{marks}/0", {"note": "Mulligan next time."}).json()
        assert noted["note"] == "Mulligan next time." and len(noted["marks"]) == 1
        listed = ada.get("/api/v1/replays").json()["own"][0]
        assert (listed["marks"], listed["noted"]) == (1, True)
        assert ada.put(f"{marks}/0", {"note": "  "}).json()["note"] == ""

        # They are ada's alone: bea, who played the same game, has none of them, and her own
        # are hers.
        hers = bea.get(f"/api/v1/games/{game}/replay").json()
        assert hers["marks"] == [] and hers["note"] == ""
        bea.put(f"{marks}/4", {"label": "Ouch"})
        assert [m["seq"] for m in ada.get(f"/api/v1/games/{game}/replay").json()["marks"]] == [3]

        removed = delete(ada, f"{marks}/3")
        assert removed.status_code == 200 and removed.json()["marks"] == []
        assert delete(ada, f"{marks}/3").status_code == 200, "removing what is gone changes nothing"
        assert [m["seq"] for m in bea.get(f"/api/v1/games/{game}/replay").json()["marks"]] == [4]


def test_a_replay_holds_so_many_bookmarks(database: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(replays, "MARK_LIMIT", 2)
    with connect(build(database, None)) as client:
        staged(client)
        ada = Account(client, "ada")
        game = played(client, ada)
        marks = f"/api/v1/games/{game}/replay/marks"
        assert ada.put(f"{marks}/1", {"label": "a"}).status_code == 200
        assert ada.put(f"{marks}/2", {"label": "b"}).status_code == 200
        full = ada.put(f"{marks}/3", {"label": "c"})
        assert full.status_code == 409 and full.json()["code"] == "mark_limit"
        # One already kept is still changed, and the game's note is no bookmark.
        assert ada.put(f"{marks}/2", {"label": "b2"}).status_code == 200
        assert ada.put(f"{marks}/0", {"note": "n"}).status_code == 200


def test_a_replay_is_shared_with_a_friend_and_taken_back(database: str) -> None:
    with connect(build(database, None)) as client:
        staged(client)
        ada, bea, cy, dee = (Account(client, name) for name in ("ada", "bea", "cy", "dee"))
        befriend(ada, cy)
        game = played(client, ada, bea)
        shares = f"/api/v1/games/{game}/replay/shares"
        ada.put(f"/api/v1/games/{game}/replay/marks/3", {"label": "Mine", "note": "private"})

        # Friends only, and only one's own replay.
        stranger = ada.post(shares, {"player_id": str(dee.id)})
        assert stranger.status_code == 403 and stranger.json()["code"] == "not_a_friend"
        assert ada.post(shares, {"player_id": str(uuid.uuid4())}).status_code == 403
        assert ada.post(shares, {"player_id": str(ada.id)}).status_code == 403
        assert dee.post(shares, {"player_id": str(cy.id)}).status_code == 404

        shared = ada.post(shares, {"player_id": str(cy.id)})
        assert shared.status_code == 200, shared.text
        assert [share["player"]["handle"] for share in shared.json()["shares"]] == ["cy"]
        grant = shared.json()["shares"][0]["id"]
        # Sharing twice shares once, and tells the friend once.
        assert len(ada.post(shares, {"player_id": str(cy.id)}).json()["shares"]) == 1
        assert ada.get("/api/v1/replays").json()["own"][0]["shares"] == 1
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            told = list(db.scalars(select(Notification).where(Notification.user_id == cy.id)))
            assert [
                (note.kind, note.actor_id, str(note.game_id))
                for note in told
                if note.kind == "replay_shared"
            ] == [("replay_shared", ada.id, game)]
            stored = db.get_one(AccessGrant, uuid.UUID(grant))
            assert stored.scope == {"seat": 0} and stored.consent == "given"
            # It ends by itself when the events go.
            assert stored.expires_at is not None
            assert (
                timedelta(days=88)
                < stored.expires_at.replace(tzinfo=UTC) - NOW
                < timedelta(days=90)
            )
            assert "access.given" in set(db.scalars(select(AuditEvent.action)))
        bell = cy.get("/api/v1/notifications").json()
        item = next(item for item in bell["items"] if item["kind"] == "replay_shared")
        assert item["game_id"] == game and item["actor"]["handle"] == "ada"

        # The friend reads the game through ada's seat: her hand as she saw it, nothing more,
        # and none of her bookmarks.
        listed = cy.get("/api/v1/replays").json()
        assert listed["own"] == [] and [e["game"]["id"] for e in listed["shared"]] == [game]
        assert listed["shared"][0]["through"]["shared_by"]["handle"] == "ada"
        theirs = cy.get(f"/api/v1/games/{game}/replay").json()
        assert theirs["through"]["seat"] == 0 and theirs["through"]["yours"] is False
        assert theirs["through"]["grant_id"] == grant
        assert theirs["marks"] == [] and theirs["note"] == "" and theirs["shares"] == []
        assert theirs["game"]["your_seat"] is None
        assert theirs["deck"]["deck_id"] is None
        page = cy.get(f"/api/v1/games/{game}/replay/events", shared_by=str(ada.id)).json()
        assert page["seat"] == 0
        assert names(page) == ["Lightning Bolt", "Counterspell", "Lightning Bolt", None]
        # The friend keeps bookmarks of their own on it, and cannot pass it on.
        assert cy.put(f"/api/v1/games/{game}/replay/marks/3", {"label": "cy's"}).status_code == 200
        assert cy.post(shares, {"player_id": str(ada.id)}).status_code == 404
        # It is not bea's share: she asks for it and finds nothing.
        assert bea.get(f"/api/v1/games/{game}/replay", shared_by=str(ada.id)).status_code == 404

        # Taken back, it is gone from then on; taking it back twice changes nothing.
        assert delete(dee, f"{shares}/{grant}").status_code == 404
        assert delete(ada, f"{shares}/{grant}").status_code == 204
        assert delete(ada, f"{shares}/{grant}").status_code == 204
        assert cy.get(f"/api/v1/games/{game}/replay").status_code == 404
        assert cy.get(f"/api/v1/games/{game}/replay/events").status_code == 404
        assert cy.get("/api/v1/replays").json()["shared"] == []
        assert ada.get(f"/api/v1/games/{game}/replay").json()["shares"] == []


def test_a_player_of_the_game_may_be_shown_another_seats_replay_and_give_it_up(
    database: str,
) -> None:
    with connect(build(database, None)) as client:
        staged(client)
        ada, bea = Account(client, "ada"), Account(client, "bea")
        befriend(ada, bea)
        game = played(client, ada, bea)
        shares = f"/api/v1/games/{game}/replay/shares"
        grant = ada.post(shares, {"player_id": str(bea.id)}).json()["shares"][0]["id"]

        # Her own seat's stays the one she gets unless she asks for ada's.
        assert bea.get(f"/api/v1/games/{game}/replay").json()["through"]["seat"] == 1
        through = bea.get(f"/api/v1/games/{game}/replay", shared_by=str(ada.id)).json()["through"]
        assert through["seat"] == 0 and through["shared_by"]["handle"] == "ada"
        page = bea.get(f"/api/v1/games/{game}/replay/events", shared_by=str(ada.id)).json()
        assert names(page)[0] == "Lightning Bolt", "ada's own draw, which bea's seat never saw"
        both = bea.get("/api/v1/replays").json()
        assert len(both["own"]) == 1 and len(both["shared"]) == 1

        # The friend gives it up; a block would end it as well (api/access.py).
        assert delete(bea, f"{shares}/{grant}").status_code == 204
        assert bea.get(f"/api/v1/games/{game}/replay", shared_by=str(ada.id)).status_code == 404
        again = ada.post(shares, {"player_id": str(bea.id)}).json()["shares"]
        assert len(again) == 1 and again[0]["id"] != grant
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            db.add(PlayerBlock(blocker_id=bea.id, blocked_id=ada.id, created_at=NOW))
            db.commit()
        assert bea.get(f"/api/v1/games/{game}/replay", shared_by=str(ada.id)).status_code == 404
        assert bea.get("/api/v1/replays").json()["shared"] == []


def test_a_replay_is_shared_with_so_many_friends(
    database: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(replays, "SHARE_LIMIT", 1)
    with connect(build(database, None)) as client:
        staged(client)
        ada, cy, eve = Account(client, "ada"), Account(client, "cy"), Account(client, "eve")
        befriend(ada, cy)
        befriend(ada, eve)
        game = played(client, ada)
        shares = f"/api/v1/games/{game}/replay/shares"
        assert ada.post(shares, {"player_id": str(cy.id)}).status_code == 200
        full = ada.post(shares, {"player_id": str(eve.id)})
        assert full.status_code == 409 and full.json()["code"] == "share_limit"


def test_marks_go_with_the_events_and_a_share_ends_with_them(database: str) -> None:
    with connect(build(database, None)) as client:
        staged(client)
        ada, cy = Account(client, "ada"), Account(client, "cy")
        befriend(ada, cy)
        recent = played(client, ada, ended=NOW - timedelta(days=89, hours=12))
        old = played(client, ada, ended=NOW - timedelta(days=91))
        for game in (recent, old):
            assert (
                ada.put(f"/api/v1/games/{game}/replay/marks/3", {"label": "kept"}).status_code
                == 200
            )
        # A replay past its time is no longer shared: its events are about to go.
        gone = ada.post(f"/api/v1/games/{old}/replay/shares", {"player_id": str(cy.id)})
        assert gone.status_code == 409 and gone.json()["code"] == "replay_gone"
        assert (
            ada.post(f"/api/v1/games/{recent}/replay/shares", {"player_id": str(cy.id)}).status_code
            == 200
        )
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            assert replays.sweep(db, NOW) == 1
            db.commit()
            assert [str(mark.game_id) for mark in db.scalars(select(ReplayMark))] == [recent]
            assert replays.sweep(db, NOW) == 0
            # Half a day on, the share has run out with the events, with nothing swept for it.
            later = NOW + timedelta(days=1)
            assert replays.shared_with(db, cy.id) != []
            from api import access

            assert access.active(db, cy.id, "replay", uuid.UUID(recent), later) == []


def test_replays_are_behind_their_gate(database: str) -> None:
    with connect(build(database, None)) as client:
        ada, cy = Account(client, "ada"), Account(client, "cy")
        befriend(ada, cy)
        game = played(client, ada)
        paths = [
            ("GET", "/api/v1/replays"),
            ("GET", f"/api/v1/games/{game}/replay"),
            ("GET", f"/api/v1/games/{game}/replay/events"),
            ("PUT", f"/api/v1/games/{game}/replay/marks/3"),
            ("POST", f"/api/v1/games/{game}/replay/shares"),
        ]

        def reach(account: Account) -> list[int]:
            found = []
            for method, path in paths:
                if method == "GET":
                    found.append(account.get(path).status_code)
                elif method == "PUT":
                    found.append(account.put(path, {"label": "x"}).status_code)
                else:
                    found.append(account.post(path, {"player_id": str(cy.id)}).status_code)
            return found

        assert reach(ada) == [404] * 5, "off: the paths look like nothing"
        root = staged(client, "staff")
        assert reach(ada) == [404] * 5, "at staff a player still finds nothing"
        assert root.get("/api/v1/replays").status_code == 200
        set_stage(root, "on")
        assert reach(ada) == [200] * 5
        # Switched off again, what was shared gives nothing; on again, it is back untouched.
        set_stage(root, "off")
        assert cy.get(f"/api/v1/games/{game}/replay").status_code == 404
        set_stage(root, "on")
        assert cy.get(f"/api/v1/games/{game}/replay").json()["through"]["seat"] == 0
        # The timeline itself has no gate, and reads a shared replay through the same grant.
        assert ada.get(f"/api/v1/games/{game}/timeline").status_code == 200
