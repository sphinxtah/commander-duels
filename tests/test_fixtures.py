"""Development fixtures and the console's rollout (v0.9.13, api/fixtures.py, api/cli.py; the
specification's section 15: "development fixtures and reproducible scenarios").

The fixtures are what v1.0.0's workflows read and no route makes yet: the same accounts, the same
finished game with its events and the same access given on it, however often they are written,
and never on the live site. Read through the API, the game shows each reader what their seat or
their access lets them see, once the workflow that access belongs to is staged.
"""

from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from test_games import build, connect

from api import cli, fixtures
from api.identity import utcnow
from api.models import AccessGrant, AuditEvent, Game, GameEventRow, User, UserSession


@pytest.fixture
def database(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> str:
    url = f"sqlite:///{tmp_path}/fixtures.db"
    monkeypatch.setenv("CD_DATABASE_URL", url)
    command.upgrade(Config("alembic.ini"), "head")
    return url


def names(client: TestClient, cookie: str, view: str = "seat") -> list[str | None] | int:
    """What a reader is shown of the fixture game: each event's card by name, or the refusal."""
    found = client.get(
        f"/api/v1/games/{fixtures.fixture_id(fixtures.GAME)}/timeline",
        params={"view": view},
        headers={"cookie": cookie},
    )
    if found.status_code != 200:
        return found.status_code
    return [(event.get("object") or {}).get("name") for event in found.json()["events"]]


def test_the_fixtures_are_the_same_however_often_they_are_written(
    database: str, capsys: pytest.CaptureFixture[str]
) -> None:
    cli.main(["fixtures", "--sessions"])
    first = capsys.readouterr().out
    cli.main(["fixtures"])
    second = capsys.readouterr().out
    assert f"Fixture game: {fixtures.fixture_id(fixtures.GAME)}" in first
    assert first.count("is signed in for a day with the cookie __Host-cd_session=") == 4
    assert "works once its workflows are staged" in second
    with connect(build(database, None)) as client:
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            count = lambda model: db.scalar(select(func.count()).select_from(model))  # noqa: E731
            assert count(User) == 4 and count(Game) == 1 and count(AccessGrant) == 3
            assert count(GameEventRow) == len(fixtures.EVENTS)
            assert count(UserSession) == 4, "the second writing signed nobody in"
            handles = set(db.scalars(select(User.handle)))
            assert handles == set(fixtures.ACCOUNTS)

        cookies = {
            line.split(" ")[0]: line.rsplit(" ", 1)[1]
            for line in first.splitlines()
            if "is signed in" in line
        }
        ada, bea, cal, eve = (cookies[handle] for handle in fixtures.ACCOUNTS)
        # Its players read it through their own seats: each sees their own draw and not the
        # other's, and the spells both saw.
        assert names(client, ada) == [
            "Lightning Bolt", "Goblin Guide", None, "Grizzly Bears", "Lightning Bolt", None,
            "Grizzly Bears", None, None,
        ]  # fmt: skip
        assert names(client, bea)[2] == "Counterspell"  # type: ignore[index]
        assert names(client, bea)[0] is None  # type: ignore[index]
        # The access given on it gives nothing while its workflows are off: a missing game.
        assert names(client, cal) == 404
        assert names(client, eve) == 404

        # Staged for staff at the console, the administrator's coaching works and the player's
        # watching does not; staged for everyone, both do.
        capsys.readouterr()
        cli.main(["rollout", "coaching", "staff"])
        cli.main(["rollout", "spectators", "staff"])
        assert "coaching: staff (Coaching)" in capsys.readouterr().out
        assert names(client, eve) == names(client, ada), "a coach sees as the seat does"
        assert names(client, cal) == 404
        cli.main(["rollout", "spectators", "on"])
        watched = names(client, cal)
        assert isinstance(watched, list) and watched[0] is None and watched[2] is None
        assert watched[1] == "Goblin Guide"
        # The console's changes are in the audit record, as SysOp's are.
        with Session(client.app.state.database) as db:  # type: ignore[attr-defined]
            changes = [
                event.details
                for event in db.scalars(
                    select(AuditEvent)
                    .where(AuditEvent.action == "rollout.stage_changed")
                    .order_by(AuditEvent.occurred_at)
                )
            ]
        assert changes[-1] == {
            "workflow": "spectators", "from": "staff", "to": "on", "by": "console",
        }  # fmt: skip
        assert len(changes) == 3


def test_the_fixtures_stage_every_workflow_when_asked_and_never_on_the_live_site(
    database: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    engine = create_engine(database)
    with Session(engine) as db, db.begin():
        written = fixtures.write(db, utcnow(), stage="on")
        assert not written.sessions
    engine.dispose()
    cli.main(["rollout"])
    stages = capsys.readouterr().out.splitlines()
    assert len(stages) == 6 and all(": on (" in line for line in stages)
    with pytest.raises(SystemExit, match="No such workflow"):
        cli.main(["rollout", "leagues", "on"])
    with pytest.raises(SystemExit, match="Name the stage"):
        cli.main(["rollout", "sandbox"])
    with pytest.raises(SystemExit, match="production"):
        fixtures.refuse_production("production")
    fixtures.refuse_production("development")
