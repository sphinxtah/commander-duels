from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from api.version import APP_VERSION


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Error(Contract):
    code: str
    message: str
    request_id: str


class Health(Contract):
    status: Literal["ok"] = "ok"
    version: str = APP_VERSION


class Readiness(Contract):
    status: Literal["ready", "not_ready"]
    database: Literal["ready", "unavailable", "migration_required"]


class Capability(Contract):
    id: str
    name: str
    available: bool = False
    milestone: str
    reason: str


class AuthConfig(Contract):
    """What the browser needs to offer sign-in. The Google client ID is public by design."""

    google_client_id: str | None
    signup_policy: Literal["open", "approval"]


class Bootstrap(Contract):
    name: Literal["Commander Duels"] = "Commander Duels"
    version: str = APP_VERSION
    protocol_version: Literal[1] = 1
    collection_policy: Literal["open_collection"] = "open_collection"
    capabilities: list[Capability]
    auth: AuthConfig


class Format(Contract):
    id: Literal["commander", "legacy", "two_headed_giant"]
    name: str
    seats: list[int]
    default_seats: int
    description: str
    available: bool = False


class XmageBuild(Contract):
    version: str
    tag: str
    commit: str
    commit_date: str


class CardCounts(Contract):
    printings: int
    distinct_names: int


class EngineStatus(Contract):
    """Engine /health, passed through. "unavailable" means the engine is unreachable or invalid."""

    status: Literal["unavailable", "loading", "ready", "failed"]
    protocol_version: Literal[1] = 1
    gameplay_available: Literal[False] = False
    xmage: XmageBuild | None = None
    cards: CardCounts | None = None
    bot_match_enabled: bool = False


Role = Literal["player", "moderator", "content_editor", "administrator", "sysop"]
GrantableRole = Literal["moderator", "content_editor", "administrator"]
Permission = Literal[
    "profile.edit",
    "games.play",
    "moderation.read",
    "content.edit",
    "admin.users.read",
    "admin.users.manage",
    "admin.roles.manage",
    "admin.roles.administrator",
    "admin.audit.read",
    "games.view_concealed",
    "cards.any",
]
Avatar = Literal["sigil", "sun", "moon", "flame", "wave", "leaf", "crown", "tower"]
AccountStatus = Literal["active", "pending", "denied", "disabled"]


class Preferences(Contract):
    large_text: bool = False
    reduced_motion: bool = False


class SessionInfo(Contract):
    id: UUID
    kind: Literal["google", "sysop"]
    authenticated_at: datetime
    idle_expires_at: datetime
    absolute_expires_at: datetime


class Me(Contract):
    """The signed-in account, for its owner only. Email is private; the Google subject is never
    returned."""

    id: UUID
    kind: Literal["player", "sysop"]
    status: Literal["active", "pending", "denied"]
    handle: str | None
    display_name: str
    avatar: Avatar
    locale: str
    onboarding: Literal["handle", "complete"]
    email: str | None
    roles: list[Role]
    permissions: list[Permission]
    preferences: Preferences
    session: SessionInfo
    csrf_token: str = Field(description="Send as X-CSRF-Token on every state-changing request.")


class ProfileUpdate(Contract):
    handle: str | None = Field(default=None, min_length=3, max_length=20)
    display_name: str | None = Field(default=None, min_length=1, max_length=64)
    avatar: Avatar | None = None
    locale: str | None = Field(default=None, pattern=r"^[a-z]{2}(-[A-Z]{2})?$")
    preferences: Preferences | None = None


class GoogleChallenge(Contract):
    nonce: str
    client_id: str


class GoogleCredential(Contract):
    credential: str = Field(min_length=1, max_length=8192)


class SysopLogin(Contract):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=1024)


class SysopPasswordChange(Contract):
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=12, max_length=1024)


class SessionSummary(Contract):
    id: UUID
    kind: Literal["google", "sysop"]
    current: bool
    created_at: datetime
    last_seen_at: datetime
    idle_expires_at: datetime
    absolute_expires_at: datetime
    source_address: str | None
    user_agent: str | None


class AdminUser(Contract):
    id: UUID
    handle: str | None
    display_name: str
    email: str | None
    status: AccountStatus
    roles: list[Role]
    created_at: datetime
    last_seen_at: datetime | None


class UserPage(Contract):
    items: list[AdminUser]
    next_cursor: str | None


class StatusChange(Contract):
    status: Literal["active", "denied", "disabled"]
    reason: str | None = Field(default=None, max_length=200)


class AuditActor(Contract):
    id: UUID | None
    label: str


class AuditEntry(Contract):
    id: UUID
    occurred_at: datetime
    action: str
    actor: AuditActor | None
    target: AuditActor | None
    source_address: str | None
    details: dict[str, str | int | bool | None | list[str]]


class AuditPage(Contract):
    items: list[AuditEntry]
    next_cursor: str | None
