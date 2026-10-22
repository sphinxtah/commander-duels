"""Card statuses: whether the engine can play a catalog card, and why not (CAT06, CAT07, CAT09).

A status is decided from the card and the engine build's own export of what it implements. The
export comes with the automatic gates the engine image ran on every implementation when it was
built: the card resolves by name, its class creates a card, its rules text and characteristics
can be read, its other faces load, and a copy of it can be made, as games copy cards. Here two
more gates compare the implementation with Scryfall's card: the same mana cost and card types,
and on creatures the same power and toughness. A card that passes everything is certified, and
only certified cards start games. Downloading Oracle text never makes a card playable.

When the Oracle text of a certified card changes, the card keeps playing as the engine has it,
shows that the engine's wording may differ, and waits in the review list (CAT08). A card the gates
held back (implemented) also waits there, and an administrator who accepts it certifies it for
good: the acceptance is kept across syncs (v0.4.5).

Since v0.4.5 only playable cards are in the game at all: search, card pages, decks, libraries and
packs show nothing else (playable()). The catalog keeps every card, so one comes back when the
engine learns it.
"""

import html
import re
from dataclasses import dataclass
from typing import Any

from sqlalchemy import ColumnElement, and_, func, select
from sqlalchemy.orm import Session

from api.models import CardConcept, EngineCard
from catalog.records import SPELL_FACE_LAYOUTS, Concept
from catalog.text import normalize, type_parts

NOT_A_DECK_CARD = {
    "token": "Tokens are made by other cards; no deck holds them.",
    "double_faced_token": "Tokens are made by other cards; no deck holds them.",
    "emblem": "Emblems are made by other cards; no deck holds them.",
    "art_series": "An art card, not a game piece.",
    "planar": "A plane or phenomenon, for Planechase, which is not played here.",
    "scheme": "A scheme, for Archenemy, which is not played here.",
    "vanguard": "A Vanguard card, which is not played here.",
}
# Layouts whose cost and types a single comparison can check against the engine's card.
SINGLE_FACED = frozenset(
    {"normal", "leveler", "class", "case", "saga", "mutate", "prototype", "augment", "host"}
)
SUSPENDED_BY_STAFF = "suspended_by_staff"
SUSPENDED_DETAIL = "Suspended by the site's staff."
# The staff's decisions a card's capabilities carry across syncs (api/cards.py).
STAFF_KEYS = ("suspended_from", "accepted")
SYMBOL = re.compile(r"\{[^}]+\}")
# Mana, tap and other game symbols; not XMage's {this}, which stands for the card's name.
GAME_SYMBOL = re.compile(r"\{(?:[0-9]+|[WUBRGCXYZTQSEPH½∞]|[WUBRGC2]/[WUBRGP](?:/P)?)\}", re.I)
NUMBER = re.compile(r"(?<![\w{])[+-]?\d+(?:/[+-]?\d+)?(?![\w}])")
REMINDER = re.compile(r"\([^()]*\)")
MARKUP = re.compile(r"<[^>]+>")
MANA_REMINDER = re.compile(r"^\((\{T\}: Add [^()]*)\)$", re.M)
# Values a printed power or toughness shows that XMage keeps as a number with an ability.
VARIABLE = re.compile(r"[*X?+\-]")


@dataclass(frozen=True)
class Implementation:
    name: str
    class_name: str
    kind: str
    passed: bool
    gates: dict[str, Any]
    data: dict[str, Any]


@dataclass
class EngineCards:
    build: str
    by_name: dict[str, Implementation]

    @classmethod
    def load(cls, session: Session, build: str) -> "EngineCards | None":
        rows = session.scalars(select(EngineCard).where(EngineCard.engine_build == build)).all()
        if not rows:
            return None
        return cls(
            build,
            {
                row.normalized_name: Implementation(
                    row.name, row.class_name, row.kind, row.passed, row.gates, row.data
                )
                for row in rows
            },
        )


@dataclass
class Decision:
    status: str
    reason: str | None
    detail: str | None
    engine_name: str | None
    engine_build: str | None
    certified_hash: str | None
    text_differs: bool
    review: str
    capabilities: dict[str, object]

    def values(self) -> dict[str, object]:
        return {
            "status": self.status,
            "status_reason": self.reason,
            "status_detail": self.detail,
            "engine_name": self.engine_name,
            "engine_build": self.engine_build,
            "certified_hash": self.certified_hash,
            "text_differs": self.text_differs,
            "review": self.review,
            "capabilities": self.capabilities,
        }


def capabilities(status: str) -> dict[str, object]:
    """What a status allows, per mode. Bots play every certified card through the engine's AI,
    untested card by card; campaigns and offline play do not exist yet."""
    playable = status == "certified"
    return {
        "multiplayer": playable,
        "ai": "untested" if playable else False,
        "campaign": False,
        "offline": False,
    }


def blocked(status: str, reason: str, detail: str, build: str | None = None) -> Decision:
    return Decision(status, reason, detail, None, build, None, False, "none", capabilities(status))


def kept(current: Any, status: str) -> dict[str, object]:
    """A status's capabilities, with the staff's decisions carried over from the card's: the
    status a suspension set aside, and since v0.4.5 an acceptance (STAFF_KEYS)."""
    found = current.capabilities or {}
    return {**capabilities(status), **{key: found[key] for key in STAFF_KEYS if key in found}}


def decide(card: Concept, current: Any, engine: EngineCards | None) -> Decision:
    """current is the concept's row as it stands (status, certified_hash, review, ...)."""
    if current.status == "suspended" and current.status_reason == SUSPENDED_BY_STAFF:
        return Decision(
            "suspended",
            SUSPENDED_BY_STAFF,
            current.status_detail,
            current.engine_name,
            current.engine_build,
            current.certified_hash,
            current.text_differs,
            current.review,
            kept(current, "suspended"),
        )
    if card.meld_result:
        return blocked(
            "unsupported",
            "not_a_deck_card",
            "The melded back face of two cards; decks hold the two halves.",
        )
    if not card.deck_card:
        detail = NOT_A_DECK_CARD.get(card.layout, "Not a card a deck holds.")
        return blocked("unsupported", "not_a_deck_card", detail)
    if not card.known_layout:
        return blocked(
            "unsupported",
            "unknown_layout",
            f"Scryfall's {card.layout} layout is new to this version. The card is kept as "
            "imported, and waits for a version that knows the layout.",
        )
    if engine is None:
        if current.engine_build:
            # Decided before; the engine's list is unavailable now, so the decision stands.
            return Decision(
                current.status,
                current.status_reason,
                current.status_detail,
                current.engine_name,
                current.engine_build,
                current.certified_hash,
                current.text_differs,
                current.review,
                current.capabilities,
            )
        return blocked(
            "catalog_only", "engine_unchecked", "Not yet checked against the game engine."
        )
    found = engine.by_name.get(normalize(card.game_name)) or engine.by_name.get(
        normalize(card.name)
    )
    if found is None:
        return blocked(
            "unsupported",
            "not_implemented",
            "The game engine has no implementation of this card yet.",
            engine.build,
        )
    held: tuple[str, str] | None = None
    if not found.passed:
        failed = [gate for gate, result in found.gates.items() if result is not True]
        message = found.gates.get("error") or ", ".join(failed)
        if found.gates.get("creates") is not True:
            return Decision(
                "mapped",
                "engine_load_failed",
                f"The engine's card did not load: {message}",
                found.name,
                engine.build,
                None,
                False,
                "none",
                capabilities("mapped"),
            )
        held = ("engine_gate_failed", f"The engine's card failed an automatic check: {message}")
    else:
        mismatch = characteristics_differ(card, found)
        if mismatch:
            held = (
                "characteristics_differ",
                f"The engine's card differs from the Oracle card: {mismatch}.",
            )
    # An administrator's acceptance of a held-back card stands across syncs (api/cards.py).
    if held is not None and not (current.capabilities or {}).get("accepted"):
        return Decision(
            "implemented",
            held[0],
            held[1],
            found.name,
            engine.build,
            None,
            False,
            "none",
            capabilities("implemented"),
        )
    certified_hash = current.certified_hash if current.status == "certified" else None
    certified_hash = certified_hash or card.gameplay_hash
    review = "pending" if certified_hash != card.gameplay_hash else "none"
    return Decision(
        "certified",
        None,
        None,
        found.name,
        engine.build,
        certified_hash,
        wording_differs(card, found),
        review,
        kept(current, "certified"),
    )


def symbols(cost: str | None) -> list[str]:
    return sorted(symbol.upper() for symbol in SYMBOL.findall(cost or ""))


def characteristics_differ(card: Concept, found: Implementation) -> str | None:
    """Cost, card types and power/toughness, where one comparison is meaningful."""
    if card.layout not in SINGLE_FACED:
        return None
    data = found.data
    engine_cost = data.get("mana_cost")
    if isinstance(engine_cost, str) and symbols(engine_cost) != symbols(card.mana_cost):
        return f"mana cost {engine_cost or 'none'} against {card.mana_cost or 'none'}"
    engine_types = data.get("types")
    if isinstance(engine_types, list):
        _, oracle_types, _ = type_parts(card.type_line)
        wanted = sorted(normalize(kind) for kind in oracle_types)
        have = sorted(normalize(str(kind)) for kind in engine_types)
        if wanted != have:
            return f"card types {', '.join(have) or 'none'} against {', '.join(wanted)}"
    _, card_types, _ = type_parts(card.type_line)
    if (
        "Creature" in card_types
        and card.power is not None
        and card.toughness is not None
        and not VARIABLE.search(card.power + card.toughness)
        and isinstance(data.get("power"), str)
    ):
        oracle_pt = f"{card.power}/{card.toughness}"
        engine_pt = f"{data.get('power')}/{data.get('toughness')}"
        if normalize(oracle_pt) != normalize(engine_pt):
            return f"power and toughness {engine_pt} against {oracle_pt}"
    return None


def plain(text: str, names: tuple[str, ...] = ()) -> str:
    """Rules text without markup, reminder text or the card's own names, with one kind of minus
    sign. Text that is all one reminder (a basic land's mana ability) keeps it, since the engine
    prints that ability as a rule."""
    body = html.unescape(MARKUP.sub(" ", text)).replace("−", "-").strip()
    if body.startswith("(") and body.endswith(")") and body.count("(") == 1:
        body = body[1:-1]
    # A dual or tri land's mana ability is reminder text on its own line.
    body = MANA_REMINDER.sub(r"\1", body)
    for name in sorted(names, key=len, reverse=True):
        if name:
            body = body.replace(name, " ")
    return REMINDER.sub(" ", body)


def significant(text: str, names: tuple[str, ...] = ()) -> set[str]:
    """Game symbols and numbers outside reminder text: what an erratum usually changes. Sets,
    because the engine prints "Add {G} or {W}" as two abilities."""
    body = plain(text, names)
    return {symbol.upper() for symbol in GAME_SYMBOL.findall(body)} | set(
        NUMBER.findall(SYMBOL.sub(" ", body))
    )


def wording_differs(card: Concept, found: Implementation) -> bool:
    """Whether the engine's rules text seems to disagree with today's Oracle text: a heuristic
    for the indicator shown with the card, never a reason to block it."""
    rules = found.data.get("rules")
    if not isinstance(rules, list):
        return False
    engine_text = "\n".join(str(line) for line in rules)
    oracle = card.oracle_text
    faces = found.data.get("faces")
    if (
        card.faces
        and card.layout != "split"
        and card.layout not in SPELL_FACE_LAYOUTS
        and not faces
    ):
        # The engine listed only the front face's rules; an adventure's include its spell.
        oracle = card.faces[0].oracle_text or ""
    elif isinstance(faces, list):
        engine_text += "\n" + "\n".join(
            str(line)
            for face in faces
            if isinstance(face, dict)
            for line in face.get("rules") or []
        )
    if card.layout in SPELL_FACE_LAYOUTS:
        # The engine prints the spell's cost in its rules ("Adventure Sorcery - Stomp {1}{R}", and
        # for a prepare card "Sorcery - Heroic Stanza {1}{W/B}").
        oracle += "\n" + " ".join(face.mana_cost or "" for face in card.faces[1:])
    names = (card.name, *(face.name for face in card.faces))
    return significant(engine_text, names) != significant(oracle, names)


def playable() -> ColumnElement[bool]:
    """The cards a game can be played with, and since v0.4.5 the only cards the site shows:
    certified, and still in Scryfall's catalog."""
    return and_(CardConcept.status == "certified", CardConcept.removed_revision.is_(None))


def unplayable_reason(status: str, detail: str | None, removed: bool) -> str:
    """Why a card is out of the game, in a sentence: for an import's line, or the note a deck
    shows when the card leaves its draft."""
    if removed:
        return "Scryfall's catalog no longer lists it."
    if status == "suspended" and detail and detail != SUSPENDED_DETAIL:
        return f"Suspended by the site's staff: {detail}"
    return detail or "The game engine cannot play it."


def playable_count(session: Session) -> int:
    return session.scalar(select(func.count()).select_from(CardConcept).where(playable())) or 0
