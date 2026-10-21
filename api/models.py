"""Relational model. Later milestones add domain-specific tables."""

from datetime import UTC, date, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    SmallInteger,
    String,
    Text,
    TypeDecorator,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

JsonType = JSON().with_variant(JSONB(), "postgresql")
SYSOP_ONLY = text("kind = 'sysop'")


class UtcDateTime(TypeDecorator[datetime]):
    """A timezone-aware timestamp. SQLite drops the zone, so values read back are marked UTC."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_result_value(self, value: Any, dialect: Any) -> datetime | None:
        if isinstance(value, datetime) and value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value  # type: ignore[no-any-return]


class Base(DeclarativeBase):
    pass


class User(Base):
    """An application account. Google users are players; one row is SysOp, the local root."""

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("kind IN ('player', 'sysop')", name="ck_users_kind"),
        CheckConstraint(
            "status IN ('active', 'pending', 'denied', 'disabled')", name="ck_users_status"
        ),
        CheckConstraint(
            "onboarding IN ('handle', 'starters', 'complete')", name="ck_users_onboarding"
        ),
        CheckConstraint("privilege_version >= 0", name="ck_users_privilege_version"),
        Index(
            "uq_users_one_sysop",
            "kind",
            unique=True,
            postgresql_where=SYSOP_ONLY,
            sqlite_where=SYSOP_ONLY,
        ),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    # Chosen at onboarding (AUTH05); unique case-insensitively through the normalized form.
    normalized_handle: Mapped[str | None] = mapped_column(String(32), unique=True)
    handle: Mapped[str | None] = mapped_column(String(32))
    display_name: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(16), default="player")
    status: Mapped[str] = mapped_column(String(16), default="active")
    onboarding: Mapped[str] = mapped_column(String(16), default="handle")
    avatar: Mapped[str] = mapped_column(String(32), default="sigil")
    locale: Mapped[str] = mapped_column(String(16), default="en")
    preferences: Mapped[dict[str, object]] = mapped_column(JsonType, default=dict)
    # Argon2id, SysOp only. Google players never hold a password here.
    password_hash: Mapped[str | None] = mapped_column(String(255))
    # Raised on every role or status change; sessions issued before it are rotated (AUTH03).
    privilege_version: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime())
    updated_at: Mapped[datetime | None] = mapped_column(UtcDateTime())
    last_seen_at: Mapped[datetime | None] = mapped_column(UtcDateTime())
    # The Planeswalker the account is allied with (content/planeswalkers.json), and since when.
    alliance: Mapped[str | None] = mapped_column(String(48))
    alliance_since: Mapped[datetime | None] = mapped_column(UtcDateTime())
    # The two starter decks chosen at onboarding, by ID; null until chosen.
    starter_decks: Mapped[list[str] | None] = mapped_column(JsonType)


class ExternalIdentity(Base):
    """Google identity, keyed by issuer and subject, never email (AUTH01). Email stays private."""

    __tablename__ = "external_identities"
    __table_args__ = (UniqueConstraint("issuer", "subject"),)
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    issuer: Mapped[str] = mapped_column(String(255))
    subject: Mapped[str] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(320))
    email_verified: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime | None] = mapped_column(UtcDateTime())
    last_login_at: Mapped[datetime | None] = mapped_column(UtcDateTime())


class UserSession(Base):
    """A server-side session. The browser holds only a random token; the row holds its hash."""

    __tablename__ = "sessions"
    __table_args__ = (
        CheckConstraint("kind IN ('google', 'sysop')", name="ck_sessions_kind"),
        CheckConstraint("privilege_version >= 0", name="ck_sessions_privilege_version"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    csrf_token: Mapped[str] = mapped_column(String(64))
    privilege_version: Mapped[int]
    created_at: Mapped[datetime] = mapped_column(UtcDateTime())
    # When the person last proved who they are; a rotated session keeps it.
    authenticated_at: Mapped[datetime] = mapped_column(UtcDateTime())
    last_seen_at: Mapped[datetime] = mapped_column(UtcDateTime())
    idle_expires_at: Mapped[datetime] = mapped_column(UtcDateTime())
    absolute_expires_at: Mapped[datetime] = mapped_column(UtcDateTime())
    revoked_at: Mapped[datetime | None] = mapped_column(UtcDateTime())
    revoked_reason: Mapped[str | None] = mapped_column(String(32))
    source_address: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(256))


class RoleGrant(Base):
    """Granted roles beyond player, which every active account holds (AUTH06)."""

    __tablename__ = "role_grants"
    __table_args__ = (
        UniqueConstraint("user_id", "role"),
        CheckConstraint(
            "role IN ('moderator', 'content_editor', 'administrator')", name="ck_role_grants_role"
        ),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    role: Mapped[str] = mapped_column(String(32))
    granted_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    granted_at: Mapped[datetime] = mapped_column(UtcDateTime())


class AuditEvent(Base):
    """Append-only administrative and security record. PostgreSQL refuses updates and deletes."""

    __tablename__ = "audit_events"
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    occurred_at: Mapped[datetime] = mapped_column(UtcDateTime(), index=True)
    actor_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    target_user_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    source_address: Mapped[str | None] = mapped_column(String(64))
    request_id: Mapped[str | None] = mapped_column(String(64))
    details: Mapped[dict[str, object]] = mapped_column(JsonType, default=dict)


class LoginChallenge(Base):
    """One Google sign-in attempt. Its nonce goes into the ID token; the browser holds the secret
    that hashes to it, and a successful sign-in consumes it, so a token cannot be replayed."""

    __tablename__ = "login_challenges"
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    nonce: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime())
    expires_at: Mapped[datetime] = mapped_column(UtcDateTime(), index=True)
    consumed_at: Mapped[datetime | None] = mapped_column(UtcDateTime())


class Game(Base):
    """A game the API started in the engine. Its id is the engine's game id. The engine holds the
    game itself, in memory; the seat tokens live only in the API process, so a game still active
    when the API restarts is marked interrupted."""

    __tablename__ = "games"
    __table_args__ = (
        CheckConstraint("kind IN ('practice')", name="ck_games_kind"),
        CheckConstraint("format IN ('legacy', 'commander')", name="ck_games_format"),
        CheckConstraint("status IN ('active', 'finished', 'interrupted')", name="ck_games_status"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), default="practice")
    format: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)
    created_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime())
    finished_at: Mapped[datetime | None] = mapped_column(UtcDateTime())
    bot_skill: Mapped[int]
    turn_cap: Mapped[int]
    # The engine's result, when the game finished: kind, winner_seat, draw, turns, conceded_seats.
    result: Mapped[dict[str, object] | None] = mapped_column(JsonType)
    # What the game started under: the catalog revision and the format's version (T17).
    catalog_revision_id: Mapped[int | None] = mapped_column(ForeignKey("catalog_revisions.id"))
    format_version: Mapped[int | None]


class GameSeat(Base):
    """A seat in a game: a human seat's owner, or a bot, and its deck."""

    __tablename__ = "game_seats"
    __table_args__ = (
        UniqueConstraint("game_id", "seat"),
        CheckConstraint("player IN ('human', 'bot')", name="ck_game_seats_player"),
        CheckConstraint("(player = 'human') = (user_id IS NOT NULL)", name="ck_game_seats_owner"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    game_id: Mapped[UUID] = mapped_column(ForeignKey("games.id"), index=True)
    seat: Mapped[int]
    player: Mapped[str] = mapped_column(String(8))
    user_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    # A fixture deck's name, or "custom" for a deck list.
    deck: Mapped[str] = mapped_column(String(64))
    # The deck list's cards and commanders, as sent to the engine; null for fixture decks.
    deck_list: Mapped[dict[str, object] | None] = mapped_column(JsonType)
    # The player's deck revision the seat played, bound for good (DECK01).
    deck_revision_id: Mapped[UUID | None] = mapped_column(ForeignKey("deck_revisions.id"))


class CardImage(Base):
    """What Scryfall answered for a card name: the printing and face whose image is cached on
    disk, or that it knows no such card (tokens, unknown names)."""

    __tablename__ = "card_images"
    __table_args__ = (
        CheckConstraint("status IN ('found', 'missing')", name="ck_card_images_status"),
        CheckConstraint(
            "(status = 'found') = (scryfall_id IS NOT NULL)", name="ck_card_images_found"
        ),
    )
    # The exact name the game asked for; several names may lead to one printing.
    name: Mapped[str] = mapped_column(Text, primary_key=True)
    status: Mapped[str] = mapped_column(String(16))
    scryfall_id: Mapped[UUID | None]
    # Which of the card's faces the image shows; null for the card's own image.
    face: Mapped[int | None] = mapped_column(SmallInteger)
    set_code: Mapped[str | None] = mapped_column(Text)
    collector_number: Mapped[str | None] = mapped_column(Text)
    artist: Mapped[str | None] = mapped_column(Text)
    checked_at: Mapped[datetime] = mapped_column(UtcDateTime())


class RulesBundle(Base):
    __tablename__ = "rules_bundles"
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    engine_commit: Mapped[str] = mapped_column(String(64))
    catalog_revision: Mapped[str] = mapped_column(String(64))
    format_revision: Mapped[str] = mapped_column(String(64))
    scenario_revision: Mapped[str] = mapped_column(String(64))
    protocol_version: Mapped[int]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ScheduledJob(Base):
    __tablename__ = "scheduled_jobs"
    __table_args__ = (
        CheckConstraint("generation >= 0"),
        CheckConstraint("status IN ('pending', 'running', 'completed', 'failed')"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    kind: Mapped[str] = mapped_column(String(64))
    deduplication_key: Mapped[str] = mapped_column(String(128), unique=True)
    payload: Mapped[dict[str, object]] = mapped_column(JsonType, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    generation: Mapped[int] = mapped_column(default=0)
    result_code: Mapped[str | None] = mapped_column(String(64))


# The card catalog (CAT01–CAT10): Scryfall's bulk data, imported by the worker. Concepts, faces and
# printings are never deleted: a record Scryfall drops keeps its row with removed_revision set, so
# no deck loses a card. Rulings, relations, aliases and tags are rebuilt by every import.

CARD_STATUSES = ("catalog_only", "mapped", "implemented", "certified", "suspended", "unsupported")
BigCount = Integer().with_variant(BigInteger(), "postgresql")


class CatalogRevision(Base):
    """One successful import: the catalog as a whole changes only by a new revision."""

    __tablename__ = "catalog_revisions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(UtcDateTime())
    sync_run_id: Mapped[UUID | None] = mapped_column(ForeignKey("catalog_sync_runs.id"))
    # The engine build whose implementations the statuses were decided against.
    engine_build: Mapped[str | None] = mapped_column(Text)
    # Per dataset: source timestamp, SHA-256 and record count.
    datasets: Mapped[dict[str, object]] = mapped_column(JsonType, default=dict)
    counts: Mapped[dict[str, object]] = mapped_column(JsonType, default=dict)
    changes: Mapped[dict[str, object]] = mapped_column(JsonType, default=dict)


class CatalogSyncRun(Base):
    """One run of the catalog job, scheduled or asked for, with what it did or why it failed."""

    __tablename__ = "catalog_sync_runs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('running', 'succeeded', 'unchanged', 'failed', 'fenced')",
            name="ck_catalog_sync_runs_status",
        ),
        CheckConstraint("trigger IN ('schedule', 'manual')", name="ck_catalog_sync_runs_trigger"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    job_id: Mapped[UUID | None] = mapped_column(ForeignKey("scheduled_jobs.id"), index=True)
    generation: Mapped[int] = mapped_column(default=0)
    trigger: Mapped[str] = mapped_column(String(16))
    requested_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    attempt: Mapped[int] = mapped_column(default=1)
    started_at: Mapped[datetime] = mapped_column(UtcDateTime(), index=True)
    finished_at: Mapped[datetime | None] = mapped_column(UtcDateTime())
    status: Mapped[str] = mapped_column(String(16), default="running")
    error_code: Mapped[str | None] = mapped_column(String(64))
    error_message: Mapped[str | None] = mapped_column(Text)
    stats: Mapped[dict[str, object]] = mapped_column(JsonType, default=dict)
    # The revision it made. No foreign key: the revision already points at its run.
    revision_id: Mapped[int | None]
    next_attempt_at: Mapped[datetime | None] = mapped_column(UtcDateTime())


class SourceSnapshot(Base):
    """A downloaded bulk file: what Scryfall advertised, what arrived and what became of it."""

    __tablename__ = "catalog_source_snapshots"
    __table_args__ = (
        CheckConstraint(
            "status IN ('downloaded', 'validated', 'applied', 'failed')",
            name="ck_catalog_source_snapshots_status",
        ),
        Index("ix_catalog_source_snapshots_dataset", "dataset", "status"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    sync_run_id: Mapped[UUID] = mapped_column(ForeignKey("catalog_sync_runs.id"), index=True)
    dataset: Mapped[str] = mapped_column(String(32))
    source_updated_at: Mapped[datetime] = mapped_column(UtcDateTime())
    download_uri: Mapped[str] = mapped_column(Text)
    compressed_bytes: Mapped[int] = mapped_column(BigCount)
    decompressed_bytes: Mapped[int | None] = mapped_column(BigCount)
    # Computed here: it shows the file did not change locally, not who made it.
    sha256: Mapped[str] = mapped_column(String(64))
    etag: Mapped[str | None] = mapped_column(Text)
    last_modified: Mapped[str | None] = mapped_column(Text)
    records: Mapped[int | None]
    status: Mapped[str] = mapped_column(String(16))
    applied_revision: Mapped[int | None] = mapped_column(ForeignKey("catalog_revisions.id"))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime())


class CardConcept(Base):
    """A card as a game piece: one Scryfall Oracle ID, whatever its printings (CAT02). Copy limits
    count construction_key, so another printing of a card is still that card (T03)."""

    __tablename__ = "card_concepts"
    __table_args__ = (
        CheckConstraint(
            "status IN ('catalog_only', 'mapped', 'implemented', 'certified', 'suspended', "
            "'unsupported')",
            name="ck_card_concepts_status",
        ),
        CheckConstraint("review IN ('none', 'pending')", name="ck_card_concepts_review"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    oracle_id: Mapped[UUID] = mapped_column(unique=True)
    name: Mapped[str] = mapped_column(Text)
    normalized_name: Mapped[str] = mapped_column(Text, index=True)
    construction_key: Mapped[str] = mapped_column(Text, index=True)
    layout: Mapped[str] = mapped_column(String(32))
    # Whether a deck may hold it at all: not tokens, emblems, art cards, planes or schemes.
    deck_card: Mapped[bool]
    mana_cost: Mapped[str | None] = mapped_column(Text)
    mana_value: Mapped[float] = mapped_column(Float)
    type_line: Mapped[str] = mapped_column(Text)
    oracle_text: Mapped[str] = mapped_column(Text)
    power: Mapped[str | None] = mapped_column(Text)
    toughness: Mapped[str | None] = mapped_column(Text)
    loyalty: Mapped[str | None] = mapped_column(Text)
    defense: Mapped[str | None] = mapped_column(Text)
    colors: Mapped[list[str]] = mapped_column(JsonType, default=list)
    color_identity: Mapped[list[str]] = mapped_column(JsonType, default=list)
    color_indicator: Mapped[list[str] | None] = mapped_column(JsonType)
    # W=1, U=2, B=4, R=8, G=16: colors and identity as bits, for search.
    colors_mask: Mapped[int] = mapped_column(SmallInteger)
    identity_mask: Mapped[int] = mapped_column(SmallInteger)
    keywords: Mapped[list[str]] = mapped_column(JsonType, default=list)
    produced_mana: Mapped[list[str]] = mapped_column(JsonType, default=list)
    # Scryfall's legality per format; validation reconciles it with our own rules (CAT05).
    legalities: Mapped[dict[str, str]] = mapped_column(JsonType, default=dict)
    reserved: Mapped[bool] = mapped_column(default=False)
    game_changer: Mapped[bool] = mapped_column(default=False)
    # Popularity on EDHREC, which changes daily; it is no change to the card.
    edhrec_rank: Mapped[int | None]
    # The earliest printing; later than today means not yet released.
    first_released_at: Mapped[date | None] = mapped_column(Date)
    # Whether any printing exists on paper (not one printing's games list; CAT05).
    paper: Mapped[bool] = mapped_column(default=True)
    # Deck-building roles, read from the card's types and Oracle text at import (catalog.roles).
    # commander: it may lead a Commander deck. partner: how it pairs with a second commander
    # ("partner", "partner_with:<name>", "partner_group:<group>", "choose_background",
    # "background", "doctors_companion", "time_lord_doctor"). copy_limit: null for the format's
    # limit, 0 for any number (basic lands, "any number of cards named"), else "up to" that many.
    # activated: it has an activated ability (Zirda's companion condition).
    commander: Mapped[bool] = mapped_column(default=False)
    partner: Mapped[str | None] = mapped_column(String(160))
    companion: Mapped[bool] = mapped_column(default=False)
    copy_limit: Mapped[int | None] = mapped_column(SmallInteger)
    activated: Mapped[bool] = mapped_column(default=False)
    # Lower-case, accent-free text of every face, for search.
    name_search: Mapped[str] = mapped_column(Text)
    type_search: Mapped[str] = mapped_column(Text)
    text_search: Mapped[str] = mapped_column(Text)
    # Hashes of the fields that decide play, and of the legalities. A changed gameplay hash is a
    # compatibility review (CAT08).
    gameplay_hash: Mapped[str] = mapped_column(String(64))
    legality_hash: Mapped[str] = mapped_column(String(64))
    # Source fields this version does not map yet, kept as they came (CAT03).
    extra: Mapped[dict[str, object]] = mapped_column(JsonType, default=dict)
    # CAT07: catalog_only until mapped; only certified cards start games.
    status: Mapped[str] = mapped_column(String(16), default="catalog_only", index=True)
    status_reason: Mapped[str | None] = mapped_column(String(32))
    status_detail: Mapped[str | None] = mapped_column(Text)
    # The engine card it maps to, and the build that decided its status.
    engine_name: Mapped[str | None] = mapped_column(Text)
    engine_build: Mapped[str | None] = mapped_column(Text)
    # The gameplay hash when it was certified; another one means the Oracle text moved on.
    certified_hash: Mapped[str | None] = mapped_column(String(64))
    # The engine's wording differs from today's Oracle text (shown with the card; CAT08).
    text_differs: Mapped[bool] = mapped_column(default=False)
    review: Mapped[str] = mapped_column(String(16), default="none")
    # Separate capabilities: multiplayer, AI, campaign and offline (CAT07).
    capabilities: Mapped[dict[str, object]] = mapped_column(JsonType, default=dict)
    # The printing shown when a deck names none.
    default_printing_id: Mapped[UUID | None]
    first_revision: Mapped[int] = mapped_column(ForeignKey("catalog_revisions.id"))
    changed_revision: Mapped[int] = mapped_column(ForeignKey("catalog_revisions.id"))
    removed_revision: Mapped[int | None] = mapped_column(ForeignKey("catalog_revisions.id"))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime())
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime())


class CardFace(Base):
    """A face of a card concept: split halves, both sides of a double-faced card, an adventure."""

    __tablename__ = "card_faces"
    __table_args__ = (UniqueConstraint("concept_id", "position"),)
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    concept_id: Mapped[UUID] = mapped_column(ForeignKey("card_concepts.id"), index=True)
    position: Mapped[int] = mapped_column(SmallInteger)
    name: Mapped[str] = mapped_column(Text)
    normalized_name: Mapped[str] = mapped_column(Text, index=True)
    mana_cost: Mapped[str | None] = mapped_column(Text)
    type_line: Mapped[str | None] = mapped_column(Text)
    oracle_text: Mapped[str | None] = mapped_column(Text)
    colors: Mapped[list[str] | None] = mapped_column(JsonType)
    color_indicator: Mapped[list[str] | None] = mapped_column(JsonType)
    power: Mapped[str | None] = mapped_column(Text)
    toughness: Mapped[str | None] = mapped_column(Text)
    loyalty: Mapped[str | None] = mapped_column(Text)
    defense: Mapped[str | None] = mapped_column(Text)


class CardPrinting(Base):
    """One printing: set, collector number (text), language, finishes, frame and images."""

    __tablename__ = "card_printings"
    __table_args__ = (Index("ix_card_printings_set", "set_code", "collector_number"),)
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    scryfall_id: Mapped[UUID] = mapped_column(unique=True)
    concept_id: Mapped[UUID] = mapped_column(ForeignKey("card_concepts.id"), index=True)
    set_code: Mapped[str] = mapped_column(String(16))
    set_name: Mapped[str] = mapped_column(Text)
    set_type: Mapped[str] = mapped_column(String(32))
    collector_number: Mapped[str] = mapped_column(String(32))
    lang: Mapped[str] = mapped_column(String(8))
    released_at: Mapped[date | None] = mapped_column(Date)
    rarity: Mapped[str] = mapped_column(String(16))
    layout: Mapped[str] = mapped_column(String(32))
    finishes: Mapped[list[str]] = mapped_column(JsonType, default=list)
    frame: Mapped[str | None] = mapped_column(String(16))
    frame_effects: Mapped[list[str]] = mapped_column(JsonType, default=list)
    border_color: Mapped[str | None] = mapped_column(String(16))
    full_art: Mapped[bool] = mapped_column(default=False)
    promo: Mapped[bool] = mapped_column(default=False)
    promo_types: Mapped[list[str]] = mapped_column(JsonType, default=list)
    digital: Mapped[bool] = mapped_column(default=False)
    games: Mapped[list[str]] = mapped_column(JsonType, default=list)
    artist: Mapped[str | None] = mapped_column(Text)
    illustration_id: Mapped[UUID | None]
    image_status: Mapped[str | None] = mapped_column(String(32))
    # Scryfall's image URLs, used as returned (CAT10): the card's own, or one set per face.
    image_uris: Mapped[dict[str, str] | None] = mapped_column(JsonType)
    faces: Mapped[list[dict[str, object]]] = mapped_column(JsonType, default=list)
    flavor_name: Mapped[str | None] = mapped_column(Text)
    printed_name: Mapped[str | None] = mapped_column(Text)
    extra: Mapped[dict[str, object]] = mapped_column(JsonType, default=dict)
    cosmetic_hash: Mapped[str] = mapped_column(String(64))
    first_revision: Mapped[int] = mapped_column(ForeignKey("catalog_revisions.id"))
    changed_revision: Mapped[int] = mapped_column(ForeignKey("catalog_revisions.id"))
    removed_revision: Mapped[int | None] = mapped_column(ForeignKey("catalog_revisions.id"))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime())
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime())


class CardRuling(Base):
    __tablename__ = "card_rulings"
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    concept_id: Mapped[UUID] = mapped_column(ForeignKey("card_concepts.id"), index=True)
    source: Mapped[str] = mapped_column(String(16))
    published_at: Mapped[date] = mapped_column(Date)
    comment: Mapped[str] = mapped_column(Text)


class CardRelation(Base):
    """A related object Scryfall lists with a card: its tokens, meld parts, combo pieces."""

    __tablename__ = "card_relations"
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    concept_id: Mapped[UUID] = mapped_column(ForeignKey("card_concepts.id"), index=True)
    component: Mapped[str] = mapped_column(String(32))
    related_scryfall_id: Mapped[UUID]
    related_name: Mapped[str] = mapped_column(Text)
    related_type_line: Mapped[str | None] = mapped_column(Text)


class CardAlias(Base):
    """Other names a deck list may use for a card: faces, flavor names, plain-letter spellings."""

    __tablename__ = "card_aliases"
    __table_args__ = (UniqueConstraint("alias", "concept_id"),)
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    alias: Mapped[str] = mapped_column(Text, index=True)
    concept_id: Mapped[UUID] = mapped_column(ForeignKey("card_concepts.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))


class CardTag(Base):
    """A Scryfall Tagger oracle tag ("ramp", "spot removal"); tags form a hierarchy."""

    __tablename__ = "card_tags"
    id: Mapped[UUID] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(Text, unique=True)
    label: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    parent_ids: Mapped[list[str]] = mapped_column(JsonType, default=list)
    aliases: Mapped[list[str]] = mapped_column(JsonType, default=list)


class CardTagLink(Base):
    __tablename__ = "card_tag_links"
    concept_id: Mapped[UUID] = mapped_column(ForeignKey("card_concepts.id"), primary_key=True)
    tag_id: Mapped[UUID] = mapped_column(ForeignKey("card_tags.id"), primary_key=True, index=True)
    weight: Mapped[str] = mapped_column(String(16))


class CatalogChange(Base):
    """What one revision changed: a card added, removed, reworded, re-legalled or re-statused."""

    __tablename__ = "catalog_changes"
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    revision_id: Mapped[int] = mapped_column(ForeignKey("catalog_revisions.id"), index=True)
    concept_id: Mapped[UUID | None] = mapped_column(ForeignKey("card_concepts.id"), index=True)
    printing_id: Mapped[UUID | None] = mapped_column(ForeignKey("card_printings.id"))
    kind: Mapped[str] = mapped_column(String(32))
    details: Mapped[dict[str, object]] = mapped_column(JsonType, default=dict)


class EngineCard(Base):
    """A card the engine implements, as one engine build exported it, with its automatic gates
    (CAT09). The catalog's statuses are decided from these rows."""

    __tablename__ = "engine_cards"
    __table_args__ = (UniqueConstraint("engine_build", "name"),)
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    engine_build: Mapped[str] = mapped_column(String(128), index=True)
    name: Mapped[str] = mapped_column(Text)
    normalized_name: Mapped[str] = mapped_column(Text, index=True)
    class_name: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(16))
    # Its characteristics and rules text as the engine prints them.
    data: Mapped[dict[str, object]] = mapped_column(JsonType, default=dict)
    gates: Mapped[dict[str, object]] = mapped_column(JsonType, default=dict)
    passed: Mapped[bool]


class FormatVersion(Base):
    """A dated revision of a format's rules and banned list (CAT05, CAT08). Decks are validated
    against the newest; a game records the one it started under."""

    __tablename__ = "format_versions"
    __table_args__ = (
        UniqueConstraint("format", "version"),
        CheckConstraint("format IN ('legacy', 'commander')", name="ck_format_versions_format"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    format: Mapped[str] = mapped_column(String(16))
    version: Mapped[int]
    effective_at: Mapped[datetime] = mapped_column(UtcDateTime())
    catalog_revision_id: Mapped[int | None] = mapped_column(ForeignKey("catalog_revisions.id"))
    # The construction rules this version applies (deck sizes, copy limits, rules revision).
    rules: Mapped[dict[str, object]] = mapped_column(JsonType, default=dict)
    # Construction keys of the banned cards, and of role-specific bans.
    banned: Mapped[list[str]] = mapped_column(JsonType, default=list)
    banned_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime())


# Decks (DECK01, DECK02): a deck is its owner's. Its draft autosaves, with a version for optimistic
# concurrency; revisions are immutable copies of a draft, and a game binds to one. Decks are never
# deleted outright: "deleted" ones wait in the trash, where they can be restored.

DECK_LOCATIONS = ("main", "sideboard", "commander", "companion", "maybeboard")


class Deck(Base):
    __tablename__ = "decks"
    __table_args__ = (
        CheckConstraint("format IN ('legacy', 'commander')", name="ck_decks_format"),
        CheckConstraint("visibility IN ('private', 'link')", name="ck_decks_visibility"),
        CheckConstraint("draft_version >= 1", name="ck_decks_draft_version"),
        Index("ix_decks_owner", "owner_id", "updated_at"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str] = mapped_column(String(80))
    format: Mapped[str] = mapped_column(String(16))
    # private, or link: anyone signed in who has the link may view it (DECK11).
    visibility: Mapped[str] = mapped_column(String(16), default="private")
    share_code: Mapped[str | None] = mapped_column(String(32), unique=True)
    # The owner's notes; never shared, exported only to the owner.
    notes: Mapped[str] = mapped_column(Text, default="")
    # The draft: {"entries": [{card_id, printing_id, quantity, location}]}.
    draft: Mapped[dict[str, object]] = mapped_column(JsonType, default=dict)
    draft_version: Mapped[int] = mapped_column(default=1)
    draft_hash: Mapped[str] = mapped_column(String(64))
    # The draft's last validation, so a deck list needs no revalidation.
    card_count: Mapped[int] = mapped_column(default=0)
    legal: Mapped[bool] = mapped_column(default=False)
    playable: Mapped[bool] = mapped_column(default=False)
    # Legal, but the owner's library holds too few copies of a card (v0.3.1).
    collection_locked: Mapped[bool] = mapped_column(default=False)
    identity: Mapped[str] = mapped_column(String(8), default="")
    latest_revision: Mapped[int | None]
    # How it began: empty, imported, duplicated, starter or guided.
    source: Mapped[str] = mapped_column(String(16), default="empty")
    archived_at: Mapped[datetime | None] = mapped_column(UtcDateTime())
    deleted_at: Mapped[datetime | None] = mapped_column(UtcDateTime())
    created_at: Mapped[datetime] = mapped_column(UtcDateTime())
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime())


class DeckRevision(Base):
    """An immutable copy of a deck: PostgreSQL refuses updates to it and to its entries."""

    __tablename__ = "deck_revisions"
    __table_args__ = (
        UniqueConstraint("deck_id", "number"),
        CheckConstraint("format IN ('legacy', 'commander')", name="ck_deck_revisions_format"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    deck_id: Mapped[UUID] = mapped_column(ForeignKey("decks.id"), index=True)
    number: Mapped[int]
    format: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(String(80))
    notes: Mapped[str] = mapped_column(Text, default="")
    content_hash: Mapped[str] = mapped_column(String(64))
    catalog_revision_id: Mapped[int | None] = mapped_column(ForeignKey("catalog_revisions.id"))
    format_version: Mapped[int | None]
    legal: Mapped[bool]
    playable: Mapped[bool]
    created_at: Mapped[datetime] = mapped_column(UtcDateTime())


class DeckEntryRow(Base):
    __tablename__ = "deck_entries"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="ck_deck_entries_quantity"),
        CheckConstraint(
            "location IN ('main', 'sideboard', 'commander', 'companion', 'maybeboard')",
            name="ck_deck_entries_location",
        ),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    revision_id: Mapped[UUID] = mapped_column(ForeignKey("deck_revisions.id"), index=True)
    concept_id: Mapped[UUID] = mapped_column(ForeignKey("card_concepts.id"), index=True)
    printing_id: Mapped[UUID | None] = mapped_column(ForeignKey("card_printings.id"))
    quantity: Mapped[int]
    location: Mapped[str] = mapped_column(String(16))


class ProgressEntry(Base):
    """The progression ledger (PROG03-PROG05): wins, each counted once from a committed game
    result, and SysOp's settings of an account's wins, kept apart from them. Append-only:
    PostgreSQL refuses updates and deletes. An account's wins are the sum of its entries."""

    __tablename__ = "progress_ledger"
    __table_args__ = (
        CheckConstraint("kind IN ('game_win', 'wins_set')", name="ck_progress_ledger_kind"),
        CheckConstraint(
            "(kind = 'game_win') = (game_id IS NOT NULL)", name="ck_progress_ledger_game"
        ),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    # A change in wins: 1 for a game won; for a setting, the difference it made.
    wins: Mapped[int] = mapped_column(BigInteger)
    # Unique per fact, so retries and replays write nothing twice: win:<game>:<seat>, set:<id>.
    key: Mapped[str] = mapped_column(String(96), unique=True)
    game_id: Mapped[UUID | None] = mapped_column(ForeignKey("games.id"))
    # The rule an entry was counted under, recorded with it (PROG05).
    policy: Mapped[str] = mapped_column(String(32))
    reason: Mapped[str | None] = mapped_column(Text)
    actor_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime())


class LibraryGrant(Base):
    """Copies of a card granted into an account's library for good: a starter deck's cards, or
    the cards of decks saved before libraries existed. An alliance's cards are not granted: they
    are in the library while the alliance lasts. Append-only, like the ledger."""

    __tablename__ = "library_grants"
    __table_args__ = (
        UniqueConstraint("user_id", "grant_key", "concept_id"),
        CheckConstraint("quantity > 0", name="ck_library_grants_quantity"),
        CheckConstraint("source IN ('starter', 'grandfathered')", name="ck_library_grants_source"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    concept_id: Mapped[UUID] = mapped_column(ForeignKey("card_concepts.id"))
    quantity: Mapped[int]
    source: Mapped[str] = mapped_column(String(16))
    # What granted it, the same for every card of one grant: starter:<deck>, grandfathered:0.3.1.
    grant_key: Mapped[str] = mapped_column(String(96))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime())


class CustomCard(Base):
    """A card of the owner's own making, uploaded by SysOp: never in the catalog's tables, so no
    search, card page, deck or list of others can reach it. Only accounts at the Godlike tier see
    it, and none may play it until the engine implements it."""

    __tablename__ = "custom_cards"
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(String(160), unique=True)
    # The roster's Planeswalker whose alliance brings it.
    planeswalker: Mapped[str] = mapped_column(String(48))
    mana_cost: Mapped[str | None] = mapped_column(String(64))
    type_line: Mapped[str] = mapped_column(String(160))
    oracle_text: Mapped[str] = mapped_column(Text, default="")
    flavor_text: Mapped[str | None] = mapped_column(Text)
    power: Mapped[str | None] = mapped_column(String(8))
    toughness: Mapped[str | None] = mapped_column(String(8))
    loyalty: Mapped[str | None] = mapped_column(String(8))
    rarity: Mapped[str] = mapped_column(String(16))
    set_code: Mapped[str | None] = mapped_column(String(16))
    collector_number: Mapped[str | None] = mapped_column(String(16))
    artist: Mapped[str | None] = mapped_column(String(128))
    image: Mapped[bytes] = mapped_column(LargeBinary, deferred=True)
    image_type: Mapped[str] = mapped_column(String(32))
    image_sha256: Mapped[str] = mapped_column(String(64))
    uploaded_by: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(UtcDateTime())
    updated_at: Mapped[datetime] = mapped_column(UtcDateTime())
