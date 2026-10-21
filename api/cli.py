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
                    created_at=now,
                )
                db.add(sysop)
            sysop.password_hash = password_hash
            sysop.updated_at = now
            db.flush()
            # SysOp starts at 100,000 wins (v0.3.1), so every tier is open to it.
            sysop_start(db, sysop)
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


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m api.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    password = commands.add_parser(
        "sysop-password", help="Create SysOp or set its password; signs out every SysOp session."
    )
    source = password.add_mutually_exclusive_group()
    source.add_argument("--stdin", action="store_true", help="Read the password from stdin.")
    source.add_argument("--password-file", help="Read the password from a file's first line.")
    args = parser.parse_args(argv)
    secret = read_password(args)
    if len(secret) < MIN_LENGTH:
        raise SystemExit(f"The password must be at least {MIN_LENGTH} characters.")
    created = set_sysop_password(Settings().database_url, secret)
    print("SysOp created." if created else "SysOp password changed; SysOp sessions ended.")


if __name__ == "__main__":
    main()
