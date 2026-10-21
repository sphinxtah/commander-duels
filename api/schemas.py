from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from api.version import APP_VERSION


def without_nul(value: str) -> str:
    """PostgreSQL text holds no NUL character, nor jsonb a \\u0000: such input is refused here
    (422), not by the database (500)."""
    if "\x00" in value:
        raise ValueError("Text may not contain NUL characters.")
    return value


# Text the API stores or searches for in the database.
StoredText = Annotated[str, AfterValidator(without_nul)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Error(Contract):
    code: str
    message: str
    request_id: str
    names: list[str] | None = Field(
        default=None, description="For unknown_cards: the names the engine does not know."
    )


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
    # Since v0.3.1 players build from their own library; administrators and SysOp from every card.
    collection_policy: Literal["open_collection", "earned_collection"] = "earned_collection"
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


class ImplementationList(Contract):
    """The engine's list of the cards it implements: its build ID and counts."""

    build: str
    cards: int
    passed: int


class EngineStatus(Contract):
    """Engine /health, passed through. "unavailable" means the engine is unreachable or invalid."""

    status: Literal["unavailable", "loading", "ready", "failed"]
    protocol_version: Literal[1] = 1
    # True once the engine serves games to players (its service routes).
    gameplay_available: bool = False
    xmage: XmageBuild | None = None
    cards: CardCounts | None = None
    bot_match_enabled: bool = False
    service_games_enabled: bool = False
    implementations: ImplementationList | None = None


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
    "decks.edit",
    "catalog.manage",
    "library.unlimited",
    "progress.manage",
    "custom_cards.manage",
    "economy.manage",
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
    onboarding: Literal["handle", "starters", "complete"] = Field(
        description="handle, then starters (choose two starter decks), then complete."
    )
    alliance: str | None = Field(
        default=None, description="The allied Planeswalker's ID; its portrait is the account's."
    )
    email: str | None
    roles: list[Role]
    permissions: list[Permission]
    preferences: Preferences
    session: SessionInfo
    csrf_token: str = Field(description="Send as X-CSRF-Token on every state-changing request.")


class ProfileUpdate(Contract):
    handle: str | None = Field(default=None, min_length=3, max_length=20)
    display_name: Annotated[StoredText, Field(min_length=1, max_length=64)] | None = None
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
    wins: int = 0
    tier: Literal["bronze", "silver", "gold", "platinum", "mythic", "godlike"] = "bronze"
    alliance: str | None = None
    tokens: int = Field(default=0, description="The account's token balance (v0.4.0).")


class UserPage(Contract):
    items: list[AdminUser]
    next_cursor: str | None


class StatusChange(Contract):
    status: Literal["active", "denied", "disabled"]
    reason: Annotated[StoredText, Field(max_length=200)] | None = None


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


GameFormatId = Literal["legacy", "commander"]
FixtureDeck = Literal[
    "legacy-mono-red-burn",
    "legacy-mono-green-creatures",
    "commander-mono-white-soldiers",
    "commander-mono-blue-flyers",
    "commander-mono-red-raiders",
    "commander-mono-green-stompers",
]
DECK_LIST = Field(
    default=None,
    min_length=1,
    max_length=60_000,
    description="SysOp only (cards.any): one card per line, any card the engine implements.",
)


class SeatChoice(Contract):
    """A bot seat's deck: a fixture deck of the game's format, one of your own decks, or a deck
    list (SysOp)."""

    deck: FixtureDeck | None = None
    deck_id: UUID | None = None
    deck_list: str | None = DECK_LIST


class PracticeGameRequest(Contract):
    """A practice game: your seat first, then the bots in turn order."""

    format: GameFormatId = "legacy"
    deck: FixtureDeck | None = None
    deck_id: UUID | None = Field(
        default=None, description="One of your own decks: the game binds to a revision of it."
    )
    deck_list: str | None = DECK_LIST
    bots: list[SeatChoice] | None = Field(
        default=None,
        min_length=1,
        max_length=3,
        description="One bot in Legacy; one to three in Commander (default three).",
    )
    bot_skill: int = Field(default=4, ge=1, le=6)
    turn_cap: int = Field(default=60, ge=1, le=200)


class PracticeFormat(Contract):
    id: GameFormatId
    name: str
    bots: list[int]
    default_bots: int
    decks: list[FixtureDeck]


class PracticeOptions(Contract):
    formats: list[PracticeFormat]
    deck_lists: bool = Field(description="Whether this account may seat deck lists (cards.any).")
    own_decks: bool = Field(
        default=False, description="Whether this account may play its own decks (decks.edit)."
    )


class GameSeat(Contract):
    seat: int
    player: Literal["human", "bot"]
    handle: str | None
    portrait: str | None = Field(
        default=None, description="A player's allied Planeswalker, whose portrait stands for them."
    )
    deck: str | None = Field(
        description="Your own seat's deck (\"custom\" for a deck list); other seats' decks are "
        "private, except to SysOp."
    )


class GameResult(Contract):
    kind: str = Field(
        description="completed, turn_limit, closed, idle_timeout, humans_eliminated or error"
    )
    winner_seat: int | None
    draw: bool
    turns: int
    conceded_seats: list[int]


class GameSummary(Contract):
    id: UUID
    format: GameFormatId
    status: Literal["active", "finished", "interrupted"]
    seats: list[GameSeat]
    your_seat: int | None
    bot_skill: int
    turn_cap: int
    created_at: datetime
    finished_at: datetime | None
    result: GameResult | None
    tokens: int | None = Field(
        default=None,
        description="Tokens the game paid you (v0.4.0); null while it runs or without a seat.",
    )


class GameState(Contract):
    game: GameSummary
    snapshot: dict[str, Any] | None = Field(
        description="The seat's engine snapshot, unchanged "
        "(contracts/engine-seat-view.schema.json); null once the engine no longer holds the game."
    )


class CardNames(Contract):
    names: list[str]
