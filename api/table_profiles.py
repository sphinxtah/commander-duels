"""Rule Zero table profiles (v0.9.12, the specification's section 9; docs/tables.md).

Rule Zero is Commander's custom of agreeing, before a game, what kind of game it will be. A
table's **profile** is the host's side of that, in two parts kept apart:

- **What it describes**: the game the table is for (its intent, from a learning game to a
  competitive one), its pace, how long it is expected to take, and a note in the host's words.
  Nothing checks these: they are what the players agree to by sitting down and getting ready.
- **What it enforces**: restrictions on the decks, checked by the server when a player sits
  down, changes deck, gets ready and when the game starts, as the table's rules already are
  (banned cards, cards not legal, stand-ins): whether a deck may hold the Godlike tier's custom
  cards, whether it may hold Reserved List cards, and how many Game Changers it may hold. Each
  is read from the catalog (a card's own flags), never judged: nothing here rates a deck.

The owner's decision of 2026-11-13 leaves the rest of the specification's list out: a deck
makes **no disclosures**, computed or declared, and is not analysed. What a deck holds stays its
player's: a refusal names the cards to that player alone, and the others learn only that the
deck cannot be played here (api/tables.py), as with the table's rules.

**Versioned.** A profile carries its version (1). One this code does not read (a later version's,
after a rollback) is no profile: it describes nothing and enforces nothing, and the table's own
rules still hold.

**Readiness.** A profile is what the players are ready for. Any change to it makes every player
not ready again, the note included, so getting ready again is the acknowledgement of the change;
a change that leaves it as it was changes nothing.

**Bound to the game.** When the table's game starts, the profile is copied to the game
(`games.table_profile`): what was agreed stays with the game, whatever the table becomes.

**Presets.** The specification's six (learning, preconstructed, upgraded, high power,
competitive, custom) are built in as starting points; a host saves their own, a name each, with
the table's other settings, to open the same table again.

**Pace policies** (the specification's section 14). A profile's pace is a word the players agreed
to; a pace policy says what the word means in numbers: how long a decision may stay open before
the table says who it waits for, and before the others may nudge that player, with twice as long
for a player who asked for more time. They are defined here and enforced nowhere yet. They are
apart from the response timer, which is a player's own device passing for its own player when it
has nothing to answer (docs/game-screen.md): a pace policy never passes, concedes or moves for
anyone.
"""

from typing import Annotated, Literal, get_args
from uuid import UUID

from fastapi import APIRouter
from pydantic import Field, ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.auth import INPUT_ERRORS
from api.decks import revision_entries
from api.economy import lock_account
from api.identity import Active, ApiError, Db, not_found, utcnow
from api.models import CardConcept, CustomCard, DeckRevision, GameTable, TablePreset
from api.schemas import Contract, StoredText, TableRules
from api.validation import DeckEntry

router = APIRouter(prefix="/api/v1", responses=INPUT_ERRORS)

VERSION = 1
PRESET_LIMIT = 20
Intent = Literal["learning", "precon", "upgraded", "high_power", "competitive", "custom"]
Pace = Literal["relaxed", "steady", "brisk"]
Duration = Literal[30, 60, 90, 120, 180]
INTENTS: tuple[str, ...] = get_args(Intent)
INTENT_NAMES: dict[str, str] = {
    "learning": "Learning game",
    "precon": "Preconstructed decks",
    "upgraded": "Upgraded casual",
    "high_power": "High power",
    "competitive": "Competitive",
    "custom": "Custom",
}
PACE_NAMES: dict[str, str] = {
    "relaxed": "Relaxed: time to ask and take back",
    "steady": "Steady",
    "brisk": "Brisk: short turns",
}


class Enforced(Contract):
    """What the server checks every deck against, beside the table's rules. The defaults allow
    everything: a profile enforces only what its host turned on."""

    custom_cards: bool = Field(
        default=True, description="Decks may hold the Godlike tier's custom cards."
    )
    reserved_list: bool = Field(default=True, description="Decks may hold Reserved List cards.")
    game_changers: int | None = Field(
        default=None,
        ge=0,
        le=10,
        description="The most Game Changers a deck may hold (the Commander format's own list, "
        "as the catalog marks it); null: any number.",
    )


class TableProfile(Contract):
    """A table's Rule Zero profile, as its host writes it."""

    version: Literal[1] = 1
    intent: Intent = Field(description="What kind of game the table is for. Described only.")
    pace: Pace | None = Field(default=None, description="How fast it is played. Described only.")
    duration: Duration | None = Field(
        default=None, description="The minutes it is expected to take. Described only."
    )
    note: Annotated[StoredText, Field(max_length=280)] = Field(
        default="", description="The host's own words. Described only."
    )
    enforced: Enforced = Field(default_factory=Enforced)


class PacePolicy(Contract):
    """What a pace means in numbers. Described only in v0.9.12: nothing measures or enforces it."""

    pace: Pace
    name: str
    notice_seconds: int | None = Field(
        description="How long a decision stays open before the table says who it waits for; "
        "null: it never does."
    )
    nudge_seconds: int | None = Field(
        description="How long before the other players may nudge the player it waits for; "
        "null: never."
    )
    extended_factor: int = Field(
        description="What a player who asked for more time gets: each of the two, this many "
        "times over."
    )
    enforced: bool = Field(
        default=False, description="Whether the game holds players to it. Not in v0.9.12."
    )

    def thresholds(self, extended: bool = False) -> tuple[int | None, int | None]:
        """The notice and the nudge, in seconds, for a player; with more time when they asked."""
        times = self.extended_factor if extended else 1
        return (
            self.notice_seconds * times if self.notice_seconds is not None else None,
            self.nudge_seconds * times if self.nudge_seconds is not None else None,
        )


PACE_POLICIES: dict[str, PacePolicy] = {
    "relaxed": PacePolicy(
        pace="relaxed",
        name=PACE_NAMES["relaxed"],
        notice_seconds=None,
        nudge_seconds=None,
        extended_factor=2,
    ),
    "steady": PacePolicy(
        pace="steady",
        name=PACE_NAMES["steady"],
        notice_seconds=60,
        nudge_seconds=120,
        extended_factor=2,
    ),
    "brisk": PacePolicy(
        pace="brisk",
        name=PACE_NAMES["brisk"],
        notice_seconds=30,
        nudge_seconds=60,
        extended_factor=2,
    ),
}


class Rule(Contract):
    code: str
    text: str


class ProfileView(TableProfile):
    """A profile as a table shows it: what it describes in words, and every rule the server
    enforces at the table, the table's own rules among them."""

    intent_name: str
    pace_name: str | None
    enforced_rules: list[Rule] = Field(
        description="Everything checked on a deck at this table, in words: the table's rules "
        "(banned cards, cards not legal, stand-ins) and the profile's restrictions. Empty: any "
        "deck its format takes."
    )


# The specification's presets, as starting points: a host changes any of it. Their limits on
# Game Changers follow the Commander format's brackets (none in the first two, up to three in
# the third, any number above).
BUILT_IN: dict[str, TableProfile] = {
    "learning": TableProfile(
        intent="learning",
        pace="relaxed",
        duration=120,
        note="A learning game: questions are welcome, and a mistake may be taken back.",
        enforced=Enforced(game_changers=0),
    ),
    "precon": TableProfile(
        intent="precon", pace="steady", duration=90, enforced=Enforced(game_changers=0)
    ),
    "upgraded": TableProfile(
        intent="upgraded", pace="steady", duration=90, enforced=Enforced(game_changers=3)
    ),
    "high_power": TableProfile(intent="high_power", pace="steady", duration=60),
    "competitive": TableProfile(intent="competitive", pace="brisk", duration=60),
    "custom": TableProfile(intent="custom"),
}


def stored(profile: TableProfile | None) -> dict[str, object] | None:
    return profile.model_dump(mode="json") if profile is not None else None


def read(kept: object) -> TableProfile | None:
    """A kept profile, or none: when there is none, or it is of a version this code does not
    read, which describes and enforces nothing here."""
    if not isinstance(kept, dict) or kept.get("version") != VERSION:
        return None
    try:
        return TableProfile.model_validate(kept)
    except ValidationError:
        return None


def profile_of(table: GameTable) -> TableProfile | None:
    return read(table.profile)


def keep(table: GameTable, profile: TableProfile | None) -> bool:
    """Sets the table's profile, with what the lobby searches by beside it; says whether it
    changed."""
    after = stored(profile)
    if after == table.profile:
        return False
    table.profile = after
    table.intent = profile.intent if profile else None
    table.pace = profile.pace if profile else None
    table.duration = profile.duration if profile else None
    return True


def enforced_rules(profile: TableProfile | None, rules: TableRules) -> list[Rule]:
    """Everything checked on a deck at the table, in words."""
    found = []
    if not rules.banned:
        found.append(Rule(code="banned", text="No cards banned in the format"))
    if not rules.not_legal:
        found.append(Rule(code="not_legal", text="No cards that are not legal in the format"))
    if not rules.stand_in:
        found.append(Rule(code="stand_in", text="No cards the game plays as stand-ins"))
    if profile is None:
        return found
    if not profile.enforced.custom_cards:
        found.append(Rule(code="custom_cards", text="No custom cards"))
    if not profile.enforced.reserved_list:
        found.append(Rule(code="reserved_list", text="No Reserved List cards"))
    most = profile.enforced.game_changers
    if most is not None:
        text = "No Game Changers" if most == 0 else f"At most {most} Game Changers a deck"
        found.append(Rule(code="game_changers", text=text))
    return found


def view(profile: TableProfile | None, rules: TableRules) -> ProfileView | None:
    if profile is None:
        return None
    return ProfileView(
        **profile.model_dump(),
        intent_name=INTENT_NAMES[profile.intent],
        pace_name=PACE_NAMES[profile.pace] if profile.pace else None,
        enforced_rules=enforced_rules(profile, rules),
    )


def named(names: list[str]) -> str:
    shown = sorted(names)[:5]
    return ", ".join(shown) + (f" and {len(names) - 5} more" if len(names) > 5 else "")


def refuse(db: Session, profile: TableProfile | None, entries: list[DeckEntry]) -> None:
    """Refuses a deck the profile's restrictions do not allow (422 deck_not_allowed), naming the
    cards: said to the deck's own player, never to the table. The maybeboard is not played, and
    not checked."""
    if profile is None:
        return
    enforced = profile.enforced
    playing = [entry for entry in entries if entry.location != "maybeboard"]
    ids = {entry.card_id for entry in playing}
    if not ids:
        return
    problems: list[str] = []
    if not enforced.custom_cards:
        custom = list(db.scalars(select(CustomCard.name).where(CustomCard.id.in_(ids))))
        if custom:
            problems.append(f"This table plays no custom cards: {named(custom)}.")
    if not enforced.reserved_list:
        reserved = list(
            db.scalars(
                select(CardConcept.name).where(CardConcept.id.in_(ids), CardConcept.reserved)
            )
        )
        if reserved:
            problems.append(f"This table allows no Reserved List cards: {named(reserved)}.")
    if enforced.game_changers is not None:
        changers = dict(
            db.execute(
                select(CardConcept.id, CardConcept.name).where(
                    CardConcept.id.in_(ids), CardConcept.game_changer
                )
            ).all()
        )
        held = sum(entry.quantity for entry in playing if entry.card_id in changers)
        if held > enforced.game_changers:
            allowed = (
                "no Game Changers"
                if enforced.game_changers == 0
                else f"at most {enforced.game_changers} Game Changers"
            )
            problems.append(
                f"This table allows {allowed}; this deck holds {held}: "
                f"{named(list(changers.values()))}."
            )
    if problems:
        raise ApiError(
            422,
            "deck_not_allowed",
            " ".join(problems) + " Choose another deck, or a table that allows them.",
        )


def refuse_revision(db: Session, profile: TableProfile | None, revision_id: UUID | None) -> None:
    """refuse(), for a deck as a seat is bound to it."""
    if profile is None or revision_id is None:
        return
    revision = db.get(DeckRevision, revision_id)
    if revision is not None:
        refuse(db, profile, revision_entries(db, revision))


# Presets: the built-in ones, and a host's own.


class PresetSettings(Contract):
    """The table's other settings a host saves with a profile; each is the table request's own
    field, and one left out takes the request's default when the table is opened."""

    format: Literal["legacy", "commander", "two_headed_giant", "kings_table"] | None = None
    seats: int | None = Field(default=None, ge=2, le=6)
    bots: int | None = Field(default=None, ge=0, le=5)
    bot_skill: int | None = Field(default=None, ge=1, le=6)
    visibility: Literal["public", "private"] | None = None
    rules: TableRules | None = None
    best_of: Literal[1, 3] | None = None


class PresetSave(Contract):
    name: Annotated[StoredText, Field(min_length=1, max_length=48)]
    profile: TableProfile
    settings: PresetSettings = Field(default_factory=PresetSettings)


class Preset(Contract):
    id: UUID | None = Field(description="A saved preset's id; null for a built-in one.")
    name: str
    built_in: bool
    profile: ProfileView
    settings: PresetSettings


class Presets(Contract):
    built_in: list[Preset]
    saved: list[Preset]
    limit: int = Field(description="The most presets an account saves.")
    paces: list[PacePolicy] = Field(
        description="What each pace a profile may name means in numbers (pace policies)."
    )


def casual() -> TableRules:
    return TableRules(banned=True, not_legal=True, stand_in=True)


def preset_view(row: TablePreset) -> Preset | None:
    kept = row.preset if isinstance(row.preset, dict) else {}
    profile = read(kept.get("profile"))
    if profile is None:
        return None
    try:
        settings = PresetSettings.model_validate(kept.get("settings") or {})
    except ValidationError:
        settings = PresetSettings()
    shown = view(profile, settings.rules or casual())
    assert shown is not None
    return Preset(id=row.id, name=row.name, built_in=False, profile=shown, settings=settings)


def presets_of(db: Session, user_id: UUID) -> Presets:
    rows = db.scalars(
        select(TablePreset).where(TablePreset.user_id == user_id).order_by(TablePreset.name)
    )
    saved = [found for row in rows if (found := preset_view(row)) is not None]
    built_in = []
    for key, profile in BUILT_IN.items():
        shown = view(profile, casual())
        assert shown is not None
        built_in.append(
            Preset(
                id=None,
                name=INTENT_NAMES[key],
                built_in=True,
                profile=shown,
                settings=PresetSettings(),
            )
        )
    return Presets(
        built_in=built_in, saved=saved, limit=PRESET_LIMIT, paces=list(PACE_POLICIES.values())
    )


@router.get("/me/table-presets", response_model=Presets)
def my_presets(principal: Active, db: Db) -> Presets:
    """The built-in profiles to start a table from, and the tables the account saved."""
    return presets_of(db, principal.user.id)


@router.put("/me/table-presets", response_model=Presets)
def save_preset(body: PresetSave, principal: Active, db: Db) -> Presets:
    """Saves a table to open again, under a name of the account's own: a name it already has is
    replaced (case aside)."""
    stamp = utcnow()
    # Locked, so two saves at once count the account's presets, and find a name, once.
    lock_account(db, principal.user.id)
    row = db.scalar(
        select(TablePreset).where(
            TablePreset.user_id == principal.user.id,
            func.lower(TablePreset.name) == body.name.lower(),
        )
    )
    if row is None:
        held = db.scalar(
            select(func.count())
            .select_from(TablePreset)
            .where(TablePreset.user_id == principal.user.id)
        )
        if int(held or 0) >= PRESET_LIMIT:
            raise ApiError(
                409,
                "preset_limit",
                f"An account saves at most {PRESET_LIMIT} tables: remove one to save another.",
            )
        row = TablePreset(user_id=principal.user.id, name=body.name, created_at=stamp)
        db.add(row)
    row.name = body.name
    row.preset = {
        "profile": stored(body.profile),
        "settings": body.settings.model_dump(mode="json", exclude_none=True),
    }
    row.updated_at = stamp
    db.commit()
    return presets_of(db, principal.user.id)


@router.delete("/me/table-presets/{preset_id}", response_model=Presets)
def remove_preset(preset_id: UUID, principal: Active, db: Db) -> Presets:
    row = db.get(TablePreset, preset_id)
    if row is None or row.user_id != principal.user.id:
        raise not_found()
    db.delete(row)
    db.commit()
    return presets_of(db, principal.user.id)
