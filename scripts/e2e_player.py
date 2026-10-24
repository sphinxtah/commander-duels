"""A second account for the browser journeys of human tables (v0.4.0), which need two players
and cannot sign in with Google. Creates an active player past onboarding, with the welcome grant
of tokens, and a session; prints the session token, which the journey sets as the
second browser's cookie (CD_E2E_PLAYER_SESSION). The journeys' decks are basic lands; since v0.6.0 a
library holds only the basic lands granted to it, so a new player is granted 100 of each basic land
in its default printing (as an earlier deck's cards were). Refused on a production database.

    python scripts/e2e_player.py rival     # prints the session token
"""

import secrets
import sys
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from api.config import Settings
from api.database import build_engine
from api.economy import welcome
from api.identity import hash_token, utcnow
from api.models import CardConcept, LibraryGrant, User, UserSession

BASICS = 100


def main(argv: list[str]) -> None:
    settings = Settings()
    if settings.environment == "production":
        raise SystemExit("Test players are never made on a production database.")
    handle = argv[0] if argv else "rival"
    engine = build_engine(settings.database_url)
    token = secrets.token_urlsafe(32)
    try:
        with Session(engine) as db, db.begin():
            now = utcnow()
            user = db.scalar(select(User).where(User.normalized_handle == handle.casefold()))
            if user is None:
                user = User(
                    handle=handle,
                    normalized_handle=handle.casefold(),
                    display_name=handle.title(),
                    kind="player",
                    status="active",
                    onboarding="complete",
                    created_at=now,
                )
                db.add(user)
                db.flush()
                welcome(db, user)
                for concept in db.scalars(
                    select(CardConcept).where(CardConcept.type_line.startswith("Basic Land"))
                ):
                    if concept.default_printing_id is None:
                        continue
                    db.add(
                        LibraryGrant(
                            user_id=user.id,
                            concept_id=concept.id,
                            printing_id=concept.default_printing_id,
                            quantity=BASICS,
                            source="grandfathered",
                            grant_key=f"grandfathered:e2e:{handle.casefold()}",
                            created_at=now,
                        )
                    )
            db.add(
                UserSession(
                    token_hash=hash_token(token),
                    user_id=user.id,
                    kind="google",
                    csrf_token=secrets.token_urlsafe(32),
                    privilege_version=user.privilege_version,
                    created_at=now,
                    authenticated_at=now,
                    last_seen_at=now,
                    idle_expires_at=now + timedelta(hours=12),
                    absolute_expires_at=now + timedelta(hours=12),
                )
            )
    finally:
        engine.dispose()
    print(token)


if __name__ == "__main__":
    main(sys.argv[1:])
