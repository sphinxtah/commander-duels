"""The library by edition (v0.5.0, docs/progression.md "The library by edition").

- library_grants.printing_id: every grant names the edition (printing) it gives, and the
  uniqueness of a grant is its account, its key and that edition (uq_library_grants_edition), so
  one grant may give several editions of a card, a row each. Existing grants are given theirs:
  - a pack's (key pack:<opening>) the printings the opening pulled (pack_cards);
  - a starter deck's (key starter:<deck>, or starter:<deck>:<time> after a reset) the printings of
    content/starter-decks.json, as the API reads it (CD_CONTENT_DIR);
  - a grandfathered one (v0.3.1) the printings of the player's deck that held the most copies of
    the card, among its drafts and the versions saved before the grant;
  - and wherever none is found, the card's default printing (else its newest).
  A grant whose copies came in several editions becomes a row per edition, with the same key,
  source and time; the copies add up to what was granted. library_grants is append-only on
  PostgreSQL (0007): its trigger is set aside while the rows are written.
- decks.switched_editions: the note of copies switched to an edition the owner's library holds,
  which the worker writes once, when it starts on v0.5.0 (api/decks.py switch_editions); the
  marker that it did is the site setting decks.editions_switched.

Not expand only: the previous version writes grants without an edition, which this one refuses.
Downgrade adds each grant's editions back into one row per card, as before, drops the column and
the note, and forgets the marker, so upgrading again switches the decks again.
"""

import json
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0025_library_editions"
down_revision = "0024_two_headed_giant"
branch_labels = None
depends_on = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
TIMESTAMP = sa.DateTime(timezone=True)
OLD_UNIQUE = ("user_id", "grant_key", "concept_id")
# The name PostgreSQL gave 0007's unnamed constraint, which the downgrade gives it back.
OLD_NAME = "library_grants_user_id_grant_key_concept_id_key"
NEW_UNIQUE = "uq_library_grants_edition"
FOREIGN_KEY = "fk_library_grants_printing_id"
MARKER = "decks.editions_switched"

grants = sa.table(
    "library_grants",
    sa.column("id", sa.Uuid()),
    sa.column("user_id", sa.Uuid()),
    sa.column("concept_id", sa.Uuid()),
    sa.column("printing_id", sa.Uuid()),
    sa.column("quantity", sa.Integer()),
    sa.column("source", sa.String()),
    sa.column("grant_key", sa.String()),
    sa.column("created_at", TIMESTAMP),
)


def loaded(value: object) -> object:
    """A JSON column as read by plain SQL: parsed already on PostgreSQL, text on SQLite."""
    return json.loads(value) if isinstance(value, str) else value


def utc(value: datetime) -> datetime:
    """A time as read by plain SQL, in UTC: SQLite's come back without their zone."""
    return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)


def postgres() -> bool:
    return bool(op.get_bind().dialect.name == "postgresql")


def guarded(enabled: bool) -> None:
    """Sets the append-only trigger aside, or back (PostgreSQL only)."""
    if postgres():
        state = "ENABLE" if enabled else "DISABLE"
        op.execute(f"ALTER TABLE library_grants {state} TRIGGER library_grants_append_only")


def upgrade() -> None:
    with op.batch_alter_table("decks") as decks:
        decks.add_column(
            sa.Column("switched_editions", JSON, nullable=False, server_default=sa.text("'[]'"))
        )
    old = next(
        (
            found["name"]
            for found in sa.inspect(op.get_bind()).get_unique_constraints("library_grants")
            if tuple(found["column_names"]) == OLD_UNIQUE
        ),
        None,
    )
    # The old uniqueness goes first, so a card's grant can become a row per edition. SQLite
    # reflects 0007's constraint without a name: a naming convention gives it one to drop.
    convention = {"uq": "uq_%(table_name)s_%(column_0_N_name)s"}
    with op.batch_alter_table("library_grants", naming_convention=convention) as table:
        table.add_column(sa.Column("printing_id", sa.Uuid()))
        table.drop_constraint(old or "uq_library_grants_user_id_grant_key_concept_id", "unique")
    guarded(False)
    give_editions()
    guarded(True)
    with op.batch_alter_table("library_grants") as table:
        table.alter_column("printing_id", existing_type=sa.Uuid(), nullable=False)
        table.create_unique_constraint(NEW_UNIQUE, ["user_id", "grant_key", "printing_id"])
        table.create_foreign_key(FOREIGN_KEY, "card_printings", ["printing_id"], ["id"])


def spread(quantity: int, wanted: Counter[UUID], fallback: UUID) -> dict[UUID, int]:
    """quantity copies over the editions wanted, the most wanted first; what they do not cover
    goes to the fallback edition."""
    found: dict[UUID, int] = defaultdict(int)
    left = quantity
    for printing, count in sorted(wanted.items(), key=lambda item: (-item[1], str(item[0]))):
        taken = min(count, left)
        if taken > 0:
            found[printing] += taken
            left -= taken
    if left > 0:
        found[fallback] += left
    return dict(found)


def defaults(bind: sa.Connection) -> dict[UUID, UUID]:
    """Each card's default printing, else its newest."""
    concepts = sa.table(
        "card_concepts", sa.column("id", sa.Uuid()), sa.column("default_printing_id", sa.Uuid())
    )
    printings = sa.table(
        "card_printings",
        sa.column("id", sa.Uuid()),
        sa.column("concept_id", sa.Uuid()),
        sa.column("released_at", sa.Date()),
        sa.column("set_code", sa.String()),
        sa.column("collector_number", sa.String()),
    )
    found: dict[UUID, UUID] = {
        row.id: row.default_printing_id
        for row in bind.execute(
            sa.select(concepts.c.id, concepts.c.default_printing_id).where(
                concepts.c.default_printing_id.is_not(None),
                concepts.c.id.in_(sa.select(grants.c.concept_id)),
            )
        )
    }
    for row in bind.execute(
        sa.select(printings.c.concept_id, printings.c.id)
        .where(printings.c.concept_id.in_(sa.select(grants.c.concept_id)))
        .order_by(
            printings.c.released_at.desc().nulls_last(),
            printings.c.set_code,
            printings.c.collector_number,
        )
    ):
        found.setdefault(row.concept_id, row.id)
    return found


def pulled(bind: sa.Connection) -> dict[tuple[str, UUID], Counter[UUID]]:
    """The printings each opening pulled, by its grant key and the card."""
    cards = sa.table(
        "pack_cards",
        sa.column("opening_id", sa.Uuid()),
        sa.column("printing_id", sa.Uuid()),
        sa.column("concept_id", sa.Uuid()),
    )
    found: dict[tuple[str, UUID], Counter[UUID]] = defaultdict(Counter)
    for row in bind.execute(sa.select(cards.c.opening_id, cards.c.printing_id, cards.c.concept_id)):
        found[(f"pack:{row.opening_id}", row.concept_id)][row.printing_id] += 1
    return found


def starter_printings(bind: sa.Connection) -> dict[tuple[str, UUID], Counter[UUID]]:
    """The printings of each starter deck's cards (content/starter-decks.json), by the deck and
    the card. A card whose set and number the catalog lacks has none here."""
    from api.config import Settings

    path = Path(Settings().content_dir) / "starter-decks.json"
    if not path.is_file():
        return {}
    decks = json.loads(path.read_text(encoding="utf-8")).get("decks", [])
    wanted: dict[tuple[str, str], list[tuple[str, int]]] = defaultdict(list)
    for deck in decks:
        for card in deck.get("cards", []):
            place = (str(card.get("set", "")), str(card.get("collector_number", "")))
            wanted[place].append((str(deck["id"]), int(card.get("quantity", 1))))
    printings = sa.table(
        "card_printings",
        sa.column("id", sa.Uuid()),
        sa.column("concept_id", sa.Uuid()),
        sa.column("set_code", sa.String()),
        sa.column("collector_number", sa.String()),
    )
    found: dict[tuple[str, UUID], Counter[UUID]] = defaultdict(Counter)
    codes = {code for code, _ in wanted}
    for row in bind.execute(
        sa.select(
            printings.c.id,
            printings.c.concept_id,
            printings.c.set_code,
            printings.c.collector_number,
        ).where(printings.c.set_code.in_(codes))
    ):
        for deck, quantity in wanted.get((row.set_code, row.collector_number), []):
            found[(deck, row.concept_id)][row.id] += quantity
    return found


Holding = tuple[datetime | None, Counter[UUID | None]]


def held(bind: sa.Connection) -> dict[tuple[UUID, UUID], list[Holding]]:
    """Each grandfathered player's holdings of each card, outside the maybeboard, by the player
    and the card: a draft's (no time) or a version's (its time), with the printing of each copy
    (None: no printing named)."""
    decks = sa.table(
        "decks", sa.column("id", sa.Uuid()), sa.column("owner_id", sa.Uuid()), sa.column("draft")
    )
    revisions = sa.table(
        "deck_revisions",
        sa.column("id", sa.Uuid()),
        sa.column("deck_id", sa.Uuid()),
        sa.column("created_at", TIMESTAMP),
    )
    entries = sa.table(
        "deck_entries",
        sa.column("revision_id", sa.Uuid()),
        sa.column("concept_id", sa.Uuid()),
        sa.column("printing_id", sa.Uuid()),
        sa.column("quantity", sa.Integer()),
        sa.column("location", sa.String()),
    )
    players: set[UUID] = set(
        bind.scalars(sa.select(grants.c.user_id).where(grants.c.source == "grandfathered"))
    )
    found: dict[tuple[UUID, UUID], list[Holding]] = defaultdict(list)
    if not players:
        return found
    for row in bind.execute(
        sa.select(decks.c.owner_id, decks.c.draft).where(decks.c.owner_id.in_(players))
    ):
        owner: UUID = row.owner_id
        content = loaded(row.draft)
        counted: dict[UUID, Counter[UUID | None]] = defaultdict(Counter)
        for entry in content.get("entries", []) if isinstance(content, dict) else []:
            if not isinstance(entry, dict) or entry.get("location") == "maybeboard":
                continue
            try:
                concept = UUID(str(entry["card_id"]))
                printing = UUID(str(entry["printing_id"])) if entry.get("printing_id") else None
                counted[concept][printing] += int(entry["quantity"])
            except (KeyError, ValueError, TypeError):
                continue
        for concept, printings in counted.items():
            found[(owner, concept)].append((None, printings))
    versions: dict[tuple[UUID, UUID, UUID], Counter[UUID | None]] = defaultdict(Counter)
    times: dict[UUID, datetime] = {}
    for row in bind.execute(
        sa.select(
            decks.c.owner_id,
            revisions.c.id,
            revisions.c.created_at,
            entries.c.concept_id,
            entries.c.printing_id,
            entries.c.quantity,
        )
        .join(revisions, revisions.c.deck_id == decks.c.id)
        .join(entries, entries.c.revision_id == revisions.c.id)
        .where(
            decks.c.owner_id.in_(players),
            entries.c.concept_id.is_not(None),
            entries.c.location != "maybeboard",
        )
    ):
        versions[(row.owner_id, row.id, row.concept_id)][row.printing_id] += row.quantity
        times[row.id] = row.created_at
    for (owner, revision_id, concept), printings in versions.items():
        found[(owner, concept)].append((times[revision_id], printings))
    return found


def grandfathered(
    holdings: list[Holding],
    granted: datetime,
    quantity: int,
    fallback: UUID,
    own: set[UUID],
) -> Counter[UUID]:
    """The printings of the deck that granted the copies: of the holdings from before the grant
    (every draft, and the versions saved by then), the one holding exactly as many copies, else
    the most; a copy that named no printing, or another card's, takes the fallback."""
    before = [
        printings for when, printings in holdings if when is None or utc(when) <= utc(granted)
    ]
    if not before:
        return Counter()
    best = max(
        before,
        key=lambda printings: (sum(printings.values()) == quantity, sum(printings.values())),
    )
    chosen: Counter[UUID] = Counter()
    for printing, count in best.items():
        chosen[printing if printing in own else fallback] += count
    return chosen


def give_editions() -> None:
    bind = op.get_bind()
    rows = list(
        bind.execute(
            sa.select(
                grants.c.id,
                grants.c.user_id,
                grants.c.concept_id,
                grants.c.quantity,
                grants.c.source,
                grants.c.grant_key,
                grants.c.created_at,
            )
        )
    )
    if not rows:
        return
    fallback = defaults(bind)
    packs = pulled(bind)
    starters = starter_printings(bind)
    holdings = held(bind)
    printings_of: dict[UUID, set[UUID]] = defaultdict(set)
    printings = sa.table(
        "card_printings", sa.column("id", sa.Uuid()), sa.column("concept_id", sa.Uuid())
    )
    for found in bind.execute(
        sa.select(printings.c.id, printings.c.concept_id).where(
            printings.c.concept_id.in_(sa.select(grants.c.concept_id))
        )
    ):
        printings_of[found.concept_id].add(found.id)
    updates: list[dict[str, object]] = []
    inserts: list[dict[str, object]] = []
    for row in rows:
        # The catalog never deletes a printing, and every card came with one.
        default = fallback[row.concept_id]
        own = printings_of[row.concept_id]
        if row.source == "pack":
            wanted = packs.get((row.grant_key, row.concept_id), Counter())
        elif row.source == "starter":
            # starter:<deck>, or starter:<deck>:<time> after a reset.
            wanted = starters.get((row.grant_key.split(":")[1], row.concept_id), Counter())
        else:
            wanted = grandfathered(
                holdings.get((row.user_id, row.concept_id), []),
                row.created_at,
                row.quantity,
                default,
                own,
            )
        given = spread(
            row.quantity,
            Counter({printing: n for printing, n in wanted.items() if printing in own}),
            default,
        )
        first, *rest = sorted(given.items(), key=lambda item: (-item[1], str(item[0])))
        updates.append({"grant": row.id, "printing": first[0], "copies": first[1]})
        for printing, copies in rest:
            inserts.append(
                {
                    "id": uuid4(),
                    "user_id": row.user_id,
                    "concept_id": row.concept_id,
                    "printing_id": printing,
                    "quantity": copies,
                    "source": row.source,
                    "grant_key": row.grant_key,
                    "created_at": row.created_at,
                }
            )
    statement = (
        grants.update()
        .where(grants.c.id == sa.bindparam("grant"))
        .values(printing_id=sa.bindparam("printing"), quantity=sa.bindparam("copies"))
    )
    for start in range(0, len(updates), 1000):
        bind.execute(statement, updates[start : start + 1000])
    for start in range(0, len(inserts), 1000):
        bind.execute(grants.insert(), inserts[start : start + 1000])


def downgrade() -> None:
    bind = op.get_bind()
    guarded(False)
    # One row per card again: the first edition's row takes every copy, the others go.
    kept: dict[tuple[UUID, str, UUID], UUID] = {}
    copies: dict[UUID, int] = defaultdict(int)
    merged: set[UUID] = set()
    gone: list[UUID] = []
    for row in bind.execute(
        sa.select(
            grants.c.id,
            grants.c.user_id,
            grants.c.grant_key,
            grants.c.concept_id,
            grants.c.quantity,
        ).order_by(grants.c.created_at, grants.c.id)
    ):
        first = kept.setdefault((row.user_id, row.grant_key, row.concept_id), row.id)
        copies[first] += row.quantity
        if first != row.id:
            merged.add(first)
            gone.append(row.id)
    statement = (
        grants.update()
        .where(grants.c.id == sa.bindparam("grant"))
        .values(quantity=sa.bindparam("copies"))
    )
    rows = [{"grant": grant, "copies": copies[grant]} for grant in merged]
    for start in range(0, len(rows), 1000):
        bind.execute(statement, rows[start : start + 1000])
    for start in range(0, len(gone), 1000):
        bind.execute(grants.delete().where(grants.c.id.in_(gone[start : start + 1000])))
    guarded(True)
    settings = sa.table("site_settings", sa.column("key", sa.String()))
    bind.execute(settings.delete().where(settings.c.key == MARKER))
    with op.batch_alter_table("library_grants") as table:
        table.drop_constraint(FOREIGN_KEY, "foreignkey")
        table.drop_constraint(NEW_UNIQUE, "unique")
        table.drop_column("printing_id")
        table.create_unique_constraint(OLD_NAME, list(OLD_UNIQUE))
    with op.batch_alter_table("decks") as decks:
        decks.drop_column("switched_editions")
