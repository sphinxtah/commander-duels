"""Relational model. Later milestones add domain-specific tables."""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
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
        CheckConstraint("onboarding IN ('handle', 'complete')", name="ck_users_onboarding"),
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
