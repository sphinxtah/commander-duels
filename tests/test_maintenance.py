"""Maintenance is safe to run again (v0.9.13; the specification's section 15: "maintenance jobs
are safe to retry"; docs/operations.md).

The worker's daily job is one run over three removals: accounts never approved, chat past its
time and the events of games long over. A run that is repeated, or taken over by another worker
after a lease ran out (tests/test_jobs.py), must find nothing left to do and leave what is not yet
due alone. The parts have their own tests; this is the job as a whole, twice.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from sqlalchemy import func, select
from sqlalchemy.orm import Session
from test_accounts import account, job_database

from api import accounts
from api.events import EVENT_RETENTION_DAYS
from api.models import AuditEvent, Game, GameEventRow, User


def test_the_daily_job_run_twice_does_its_work_once(tmp_path: Path) -> None:
    engine = job_database(tmp_path)
    now = datetime(2026, 11, 30, 4, 0, tzinfo=UTC)
    long_ago = now - timedelta(days=EVENT_RETENTION_DAYS + 1)
    with Session(engine) as db:
        waiting = account(db, "pending", now - timedelta(days=31))
        player = account(db, "active", long_ago)
        games = {}
        for name, ended in (("old", long_ago), ("recent", now - timedelta(days=1))):
            game = Game(
                id=uuid4(), kind="practice", format="legacy", status="finished",
                created_by=player, created_at=ended, finished_at=ended, bot_skill=1, turn_cap=30,
            )  # fmt: skip
            db.add(game)
            db.flush()
            games[name] = game.id
            for seq in (1, 2):
                db.add(
                    GameEventRow(
                        game_id=game.id, seq=seq, epoch=0, turn=1, type="cast", event={"seq": seq}
                    )
                )
        db.commit()

    def kept() -> tuple[dict[object, int], str, int]:
        with Session(engine) as db:
            events = dict(
                db.execute(
                    select(GameEventRow.game_id, func.count()).group_by(GameEventRow.game_id)
                ).all()
            )
            status = db.scalar(select(User.status).where(User.id == waiting))
            audited = db.scalar(select(func.count()).select_from(AuditEvent))
            return events, str(status), int(audited or 0)

    first = accounts.handle(engine, now)
    assert (first.status, first.code) == ("completed", "deleted")
    after = kept()
    assert after == ({games["recent"]: 2}, "deleted", 1)

    # Again at once, as a retry or a second worker would: nothing is due, and nothing changes.
    again = accounts.handle(engine, now)
    assert (again.status, again.code) == ("completed", "nothing_due")
    assert kept() == after
    # And again the next day: the recent game's events are still not due.
    later = accounts.handle(engine, now + timedelta(days=1))
    assert (later.status, later.code) == ("completed", "nothing_due")
    assert kept() == after
    engine.dispose()
