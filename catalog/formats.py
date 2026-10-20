"""Format versions: each format's construction rules and banned list, dated (CAT05, CAT08).

Scryfall's legalities are the source for bans; an import whose bans differ from the newest
version's records a new version, effective at once. Decks are validated against the newest
version, and a game records the version it started under, so a ban never changes a game in
progress (T17). Role-specific bans, which Scryfall's single legality per format cannot express,
are listed here with their source.
"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from api.models import CardConcept, FormatVersion
from catalog.records import digest

# The application's deck limits are technical, not Magic rules, and the deck builder says so.
TECHNICAL_MAX_MAIN = 250
RULES: dict[str, dict[str, object]] = {
    "legacy": {
        "rules_revision": "2026-10-20",
        "min_main": 60,
        "max_main": TECHNICAL_MAX_MAIN,
        "max_sideboard": 15,
        "copy_limit": 4,
        # A companion is a card in the sideboard (rule 702.139a).
        "companion": "sideboard",
    },
    "commander": {
        "rules_revision": "2026-10-20",
        "deck_size": 100,
        "copy_limit": 1,
        "max_commanders": 2,
        # A companion starts outside the 100 cards (Commander rules).
        "companion": "outside",
    },
}
# "role:key" entries: a card banned only in one role. Lutri, the Spellchaser is legal in
# Commander decks but banned as a companion (Commander Rules Committee, 2020-04-17).
ROLE_BANS: dict[str, list[str]] = {
    "legacy": [],
    "commander": ["companion:lutri, the spellchaser"],
}


def banned(session: Session, fmt: str) -> list[str]:
    keys = session.scalars(
        select(CardConcept.construction_key)
        .where(CardConcept.removed_revision.is_(None))
        .where(CardConcept.legalities[fmt].as_string() == "banned")
        .distinct()
    ).all()
    return sorted(set(keys)) + ROLE_BANS[fmt]


def latest(session: Session, fmt: str) -> FormatVersion | None:
    return session.scalar(
        select(FormatVersion)
        .where(FormatVersion.format == fmt)
        .order_by(FormatVersion.version.desc())
        .limit(1)
    )


def record_versions(session: Session, revision_id: int, now: datetime) -> dict[str, int]:
    """Adds a version for each format whose bans or rules changed; returns the current ones."""
    current: dict[str, int] = {}
    for fmt, rules in RULES.items():
        keys = banned(session, fmt)
        hashed = digest(keys)
        newest = latest(session, fmt)
        if newest is not None and newest.banned_hash == hashed and newest.rules == rules:
            current[fmt] = newest.version
            continue
        version = FormatVersion(
            format=fmt,
            version=(newest.version + 1) if newest else 1,
            effective_at=now,
            catalog_revision_id=revision_id,
            rules=rules,
            banned=keys,
            banned_hash=hashed,
            created_at=now,
        )
        session.add(version)
        session.flush()
        current[fmt] = version.version
    return current
