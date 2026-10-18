"""Initial relational foundation; later milestones add domain-specific tables."""

from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import JSON, CheckConstraint, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

JsonType = JSON().with_variant(JSONB(), "postgresql")


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    normalized_handle: Mapped[str] = mapped_column(String(32), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ExternalIdentity(Base):
    __tablename__ = "external_identities"
    __table_args__ = (UniqueConstraint("issuer", "subject"),)
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    issuer: Mapped[str] = mapped_column(String(255))
    subject: Mapped[str] = mapped_column(String(255))


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
