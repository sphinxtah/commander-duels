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
        default=None,
        description="For unknown_cards: the names the engine does not know; for "
        "cards_not_playable (v0.4.5): the names of no card in the game.",
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
    "shop.manage",
    "reports.manage",
    "players.presence",
    "chat.read_all",
    "admin.users.reset",
    "players.history",
]
Avatar = Literal["sigil", "sun", "moon", "flame", "wave", "leaf", "crown", "tower"]
AccountStatus = Literal["active", "pending", "denied", "disabled", "deleted"]


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
    deleted_at: datetime | None = Field(
        default=None, description="When the account was deleted (v0.4.1); null otherwise."
    )


class UserPage(Contract):
    items: list[AdminUser]
    next_cursor: str | None


class StatusChange(Contract):
    status: Literal["active", "denied", "disabled"]
    reason: Annotated[StoredText, Field(max_length=200)] | None = None


class AccountDeletion(Contract):
    """Why the account is deleted (v0.4.1), kept in the audit log, which outlives the account:
    describe the request, not the person."""

    reason: Annotated[StoredText, Field(min_length=3, max_length=200)]


class AccountReset(Contract):
    """What SysOp's reset of an account cleared (v0.4.5), and the account as Administration now
    lists it: no handle, 0 wins, 1,000 tokens and no alliance."""

    account: AdminUser
    decks: int = Field(description="Decks moved to the trash.")
    cards: int = Field(description="Copies of cards the library held for good, now cleared.")
    packs: int = Field(description="Unopened packs, now cleared.")
    wins: int = Field(description="The wins it had, now 0.")
    tokens: int = Field(description="The tokens it had, now the welcome's 1,000.")


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
    description="SysOp only (cards.any): one card per line, any card in the game.",
)
# The table options a deck may need by its cards' legality in the format (v0.4.5).
TableOption = Literal["banned", "not_legal"]


class TableRules(Contract):
    """Which cards a table's decks may hold by their legality in its format (v0.4.5); the format's
    deck rules apply whatever these say. Casual rules allow both; tournament rules neither."""

    banned: bool = Field(description="Cards banned in the format.")
    not_legal: bool = Field(
        description="Cards not legal in the format: Un-cards, playtest and digital-only cards."
    )


def casual() -> TableRules:
    """A new table's rules, and a new practice game's: every card, whatever its legality."""
    return TableRules(banned=True, not_legal=True)


# One game, or (v0.5.0, Legacy only) a best-of-three match with sideboards (api/matches.py).
BestOf = Literal[1, 3]
BEST_OF_TEXT = (
    "Since v0.5.0, Legacy only: 3 plays a best-of-three match, with sideboarding between its "
    "games (docs/matches.md)."
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
    rules: TableRules = Field(
        default_factory=casual,
        description="Which cards the game's own decks may hold by their legality; casual unless "
        "told otherwise.",
    )
    best_of: BestOf = Field(default=1, description=BEST_OF_TEXT)


class PracticeFormat(Contract):
    id: GameFormatId
    name: str
    bots: list[int]
    default_bots: int
    decks: list[FixtureDeck]
    best_of: list[int] = Field(
        default_factory=lambda: [1],
        description="Since v0.5.0: 1, and 3 in Legacy for a best-of-three match.",
    )


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
    left: Literal["conceded", "removed", "eliminated"] | None = Field(
        default=None,
        description="A player's seat out of a table's game that went on without it (v0.4.0): it "
        "conceded, the others removed it while it was away, or it lost.",
    )


class GameResult(Contract):
    kind: str = Field(
        description="completed, turn_limit, closed, idle_timeout, humans_eliminated or error"
    )
    winner_seat: int | None
    draw: bool
    turns: int
    conceded_seats: list[int]


MatchStatus = Literal["playing", "sideboarding", "finished", "closed"]


class GameMatch(Contract):
    """The best-of-three match a game is part of (v0.5.0), as it stands now."""

    id: UUID
    best_of: int
    game: int = Field(description="This game's number in the match, from 1.")
    status: MatchStatus
    wins: list[int] = Field(description="Each seat's game wins so far, by seat.")
    winner_seat: int | None
    draw: bool


class GameSummary(Contract):
    id: UUID
    kind: Literal["practice", "table"] = Field(
        default="practice",
        description="A practice game against bots, or a human table's game (v0.4.0).",
    )
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
    match: GameMatch | None = Field(
        default=None, description="Its best-of-three match (v0.5.0); null for a single game."
    )


class GameState(Contract):
    game: GameSummary
    snapshot: dict[str, Any] | None = Field(
        description="The seat's engine snapshot, unchanged "
        "(contracts/engine-seat-view.schema.json); null once the engine no longer holds the game."
    )


class CardNames(Contract):
    names: list[str]


# Chat (v0.4.4, api/chat.py and api/table_chat.py): what a problem report keeps of a message it
# reports. Here, beside the other shared contracts, since both the chat and the reports need them.

ChatKind = Literal["direct", "table"]


class ReportedMessageRef(Contract):
    """The message a report is about: a friend's (direct) or a table chat's."""

    kind: ChatKind
    id: UUID


class ChatPerson(Contract):
    id: UUID | None
    handle: str | None


class ChatLine(Contract):
    """One message of a reported chat, as the reporter saw it."""

    id: UUID
    sender: ChatPerson | None = Field(description="Null for an alliance's event.")
    channel: Literal["direct", "table", "allies"]
    kind: Literal["text", "emote", "event"]
    body: str = Field(description="The text; an emote's or an event's name.")
    seats: list[int] = Field(
        default_factory=list,
        description="At a table: the sender's seat first, then the seats an allies-only message "
        "went to, or an event's two allies.",
    )
    created_at: datetime
    reported: bool = False


class ReportedChat(Contract):
    """A copy of a reported message and the messages before it that the reporter saw."""

    kind: ChatKind
    game_id: UUID | None = None
    reported_user: ChatPerson
    lines: list[ChatLine]
