"""Server console commands. SysOp's password is set here, never through the interface.

    python -m api.cli sysop-password                 # asks twice, without echo
    python -m api.cli sysop-password --password-file /run/secrets/sysop_password
    printf '%s\\n' "$PASSWORD" | python -m api.cli sysop-password --stdin

Setting the password creates SysOp on first use and signs out every SysOp session. It also lifts
the sign-in lockout on every address: the API counts failures only after the latest console set.
"""

import argparse
import getpass
import sys
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from api.config import Settings
from api.database import build_engine
from api.economy import welcome
from api.identity import revoke_sessions, utcnow
from api.models import AuditEvent, User
from api.passwords import MIN_LENGTH, hash_password
from api.progression import sysop_start


def read_password(args: argparse.Namespace) -> str:
    if args.password_file:
        return Path(args.password_file).read_text(encoding="utf-8").splitlines()[0]
    if args.stdin:
        return sys.stdin.readline().rstrip("\r\n")
    first = getpass.getpass("New SysOp password: ")
    if first != getpass.getpass("Type it again: "):
        raise SystemExit("The passwords do not match.")
    return first


def set_sysop_password(database_url: str, password: str) -> bool:
    """Returns True when SysOp was created."""
    password_hash = hash_password(password)
    engine = build_engine(database_url)
    try:
        with Session(engine) as db, db.begin():
            now = utcnow()
            sysop = db.scalar(select(User).where(User.kind == "sysop"))
            created = sysop is None
            if sysop is None:
                sysop = User(
                    kind="sysop",
                    handle="sysop",
                    normalized_handle="sysop",
                    display_name="SysOp",
                    status="active",
                    onboarding="complete",
                    tutorial="done",
                    created_at=now,
                )
                db.add(sysop)
            sysop.password_hash = password_hash
            sysop.updated_at = now
            db.flush()
            # SysOp starts at 100,000 wins (v0.3.1), so every tier is open to it, and with the
            # welcome grant of tokens every account gets (v0.4.0).
            sysop_start(db, sysop)
            welcome(db, sysop)
            revoke_sessions(db, sysop.id, "password_set")
            db.add(
                AuditEvent(
                    occurred_at=now,
                    action="account.sysop_password_set",
                    target_user_id=sysop.id,
                    details={"source": "console", "created": created},
                )
            )
        return created
    finally:
        engine.dispose()


def print_timeline(args: argparse.Namespace) -> None:
    """A developer's timeline of a game's events (v0.9.10, api/events.py): one line an event,
    through the same filter the API's readers have. Run where the API's settings are."""
    from uuid import UUID

    from api.database import build_engine
    from api.events import Perspective, timeline

    if args.inspection:
        perspective = Perspective.inspection()
    elif args.spectator:
        perspective = Perspective.spectator()
    else:
        perspective = Perspective.of_seat(args.seat if args.seat is not None else 0)
    engine = build_engine(Settings().database_url)
    try:
        lines = timeline(engine, UUID(args.game_id), perspective)
    finally:
        engine.dispose()
    print("\n".join(lines) if lines else "No events kept for this game.")


def write_fixtures(args: argparse.Namespace) -> None:
    """The development fixtures (v0.9.13, api/fixtures.py), in a database that is not the live
    site's: the accounts, the finished game with its events, and the access given on it."""
    from sqlalchemy.orm import Session

    from api import fixtures
    from api.database import build_engine
    from api.identity import utcnow

    settings = Settings()
    fixtures.refuse_production(settings.environment)
    engine = build_engine(settings.database_url)
    try:
        with Session(engine) as db, db.begin():
            written = fixtures.write(db, utcnow(), sessions=args.sessions, stage=args.rollout)
    finally:
        engine.dispose()
    print(f"Fixture game: {written.game}")
    for handle, account in written.accounts.items():
        print(f"{handle}: {account}")
    for handle, cookie in written.sessions.items():
        print(f"{handle} is signed in for a day with the cookie {cookie}")
    if args.rollout is None:
        print("The access given on the game works once its workflows are staged (rollout).")


def stage_rollout(args: argparse.Namespace) -> None:
    """The unfinished workflows' stages (v0.9.13, api/rollout.py), read or set at the console:
    the operator's way, where SysOp's is PUT /api/v1/admin/rollout/{workflow}. Audited."""
    from sqlalchemy.orm import Session

    from api import rollout
    from api.database import build_engine
    from api.identity import utcnow
    from api.models import AuditEvent, SiteSetting

    engine = build_engine(Settings().database_url)
    try:
        with Session(engine) as db, db.begin():
            if args.workflow is not None:
                if args.workflow not in rollout.WORKFLOWS:
                    raise SystemExit(f"No such workflow. One of: {', '.join(rollout.WORKFLOWS)}")
                if args.stage is None:
                    raise SystemExit("Name the stage: off, staff or on.")
                before = rollout.stage_of(db, args.workflow)
                if args.stage != before:
                    key = rollout.PREFIX + args.workflow
                    setting = db.get(SiteSetting, key) or SiteSetting(key=key)
                    setting.value, setting.updated_at = args.stage, utcnow()
                    db.add(setting)
                    db.add(
                        AuditEvent(
                            occurred_at=utcnow(),
                            action="rollout.stage_changed",
                            details={
                                "workflow": args.workflow,
                                "from": before,
                                "to": args.stage,
                                "by": "console",
                            },
                        )
                    )
                    db.flush()
            for workflow in rollout.WORKFLOWS.values():
                print(f"{workflow.id}: {rollout.stage_of(db, workflow.id)} ({workflow.name})")
    finally:
        engine.dispose()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m api.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    password = commands.add_parser(
        "sysop-password", help="Create SysOp or set its password; signs out every SysOp session."
    )
    source = password.add_mutually_exclusive_group()
    source.add_argument("--stdin", action="store_true", help="Read the password from stdin.")
    source.add_argument("--password-file", help="Read the password from a file's first line.")
    timeline = commands.add_parser(
        "timeline",
        help="Print a game's events, one a line, as a seat, a spectator or inspection sees them.",
    )
    timeline.add_argument("game_id", help="The game's id.")
    eyes = timeline.add_mutually_exclusive_group()
    eyes.add_argument("--seat", type=int, help="As this seat sees them (the default: seat 0).")
    eyes.add_argument("--spectator", action="store_true", help="As a spectator sees them.")
    eyes.add_argument(
        "--inspection", action="store_true", help="Everything, with who may see what."
    )
    made = commands.add_parser(
        "fixtures",
        help="Write the development fixtures: accounts, a finished game with events, access. "
        "Never on the live site.",
    )
    made.add_argument(
        "--sessions", action="store_true", help="Sign each fixture account in; print its cookie."
    )
    made.add_argument(
        "--rollout", choices=["off", "staff", "on"], help="Stage every unfinished workflow."
    )
    staged = commands.add_parser(
        "rollout", help="Print the unfinished workflows' stages, or set one: rollout sandbox staff."
    )
    staged.add_argument("workflow", nargs="?", help="The workflow to stage.")
    staged.add_argument("stage", nargs="?", choices=["off", "staff", "on"], help="Its stage.")
    args = parser.parse_args(argv)
    if args.command == "timeline":
        print_timeline(args)
        return
    if args.command == "fixtures":
        write_fixtures(args)
        return
    if args.command == "rollout":
        stage_rollout(args)
        return
    secret = read_password(args)
    if len(secret) < MIN_LENGTH:
        raise SystemExit(f"The password must be at least {MIN_LENGTH} characters.")
    created = set_sysop_password(Settings().database_url, secret)
    print("SysOp created." if created else "SysOp password changed; SysOp sessions ended.")


if __name__ == "__main__":
    main()
