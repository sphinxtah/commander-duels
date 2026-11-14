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


def print_economy_report(args: argparse.Namespace) -> None:
    """The economy's report and simulation (v0.9.12, api/economy_report.py): what the ledger and
    the campaign hold, and what the proposed quest and staple policies would pay. Reads only. Run
    where the API's settings are."""
    import json

    from api import policies
    from api.database import build_engine
    from api.economy_report import as_text, report

    settings = Settings()
    engine = build_engine(settings.database_url)
    try:
        with Session(engine) as db:
            found = report(
                db,
                settings.content_dir,
                streaks=policies.QuestStreaks(
                    mode="forgiving", grace=args.grace, penalty=args.penalty
                ),
                catch_up=policies.QuestCatchUp(
                    enabled=True, tokens=args.catch_up_tokens, days=args.catch_up_days
                ),
                staples=policies.StarterStaples(
                    enabled=True,
                    initial=args.initial_picks,
                    per_ward=args.picks_per_ward,
                    per_weekly_board=args.picks_per_week,
                ),
                weeks=args.weeks,
            )
    finally:
        engine.dispose()
    print(json.dumps(found, indent=2) if args.json else as_text(found), end="")


def economy_policy(args: argparse.Namespace) -> None:
    """The economy's policies (v0.9.12, api/policies.py): lists them, or sets one from JSON. A
    change here is the console's, and audited as one. Run where the API's settings are."""
    import json

    from api import policies
    from api.database import build_engine
    from api.identity import ApiError

    engine = build_engine(Settings().database_url)
    try:
        with Session(engine) as db:
            if args.name is not None and args.value is not None:
                try:
                    value, differs = policies.changed(db, args.name, json.loads(args.value))
                except ApiError as error:
                    sys.exit(f"Not set: {error.message}")
                if differs:
                    before = policies.apply(db, args.name, value, None)
                    db.add(
                        AuditEvent(
                            occurred_at=utcnow(),
                            action="economy.policy_changed",
                            details={
                                "policy": args.name,
                                "from": before,
                                "to": value.model_dump(mode="json"),
                                "source": "console",
                            },
                        )
                    )
                    db.commit()
            for each in policies.view(db).policies:
                if args.name in (None, each.name):
                    state = "changed" if each.changed else "default"
                    print(f"{each.name:<20} {state:<8} {json.dumps(each.value)}")
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
    economy = commands.add_parser(
        "economy-report",
        help="Print the economy's report and what the proposed policies would pay; reads only.",
    )
    economy.add_argument("--json", action="store_true", help="As JSON.")
    economy.add_argument("--weeks", type=int, default=8, help="Weeks to simulate (8).")
    economy.add_argument("--grace", type=int, default=2, help="Missed periods a streak keeps (2).")
    economy.add_argument("--penalty", type=int, default=0, help="Steps a missed period costs (0).")
    economy.add_argument(
        "--catch-up-tokens", type=int, default=400, help="Tokens for a missed daily board (400)."
    )
    economy.add_argument(
        "--catch-up-days", type=int, default=3, help="Missed days caught up in a week (3)."
    )
    economy.add_argument(
        "--initial-picks", type=int, default=10, help="Staple picks to start (10)."
    )
    economy.add_argument("--picks-per-ward", type=int, default=2, help="Picks a ward won (2).")
    economy.add_argument(
        "--picks-per-week", type=int, default=0, help="Picks a weekly board finished (0)."
    )
    policy = commands.add_parser(
        "economy-policy",
        help="List the economy's policies, or set one from JSON; a change is audited.",
    )
    policy.add_argument("name", nargs="?", help="The policy, e.g. functional_basics.")
    policy.add_argument(
        "value", nargs="?", help="Its new value as JSON, e.g. '{\"enabled\": true}'."
    )
    args = parser.parse_args(argv)
    if args.command == "economy-report":
        print_economy_report(args)
        return
    if args.command == "economy-policy":
        economy_policy(args)
        return
    if args.command == "timeline":
        print_timeline(args)
        return
    secret = read_password(args)
    if len(secret) < MIN_LENGTH:
        raise SystemExit(f"The password must be at least {MIN_LENGTH} characters.")
    created = set_sysop_password(Settings().database_url, secret)
    print("SysOp created." if created else "SysOp password changed; SysOp sessions ended.")


if __name__ == "__main__":
    main()
