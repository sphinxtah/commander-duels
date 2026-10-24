"""Guided deck creation (DECK06): a starting deck from a format, a commander or colors, a theme
and an experience level, every card explained and every choice editable.

The suggestions are deterministic heuristics, and the screen says so: nothing here judges a deck
competitive. Only playable cards are offered (certified, legal in the format, within the colors).
Roles come from Scryfall Tagger's oracle tags (ramp, card draw, removal, sweepers) and the cards'
types and Oracle text (the themes); among cards that fit, popularity on EDHREC orders them, and
for new players simpler cards (shorter text, fewer keywords) come first. A mana base follows the
colors the chosen spells ask for. No language model or paid service is involved. Since v0.3.1 a
player's suggestions come from their own library, at most the copies they own.
"""

from collections import defaultdict
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.library import Library
from api.models import CardConcept, CardTag, CardTagLink
from api.schemas import Contract
from api.search import colors as color_bits
from api.validation import DeckEntry, GameFormatName, Location
from catalog.statuses import in_game
from catalog.text import ALL_COLORS, colors_of, front, normalize, type_parts

Theme = Literal[
    "aggro",
    "midrange",
    "control",
    "tokens",
    "counters",
    "graveyard",
    "spells",
    "ramp",
    "tribal",
    "artifacts",
    "enchantments",
    "lifegain",
]
Experience = Literal["new", "experienced"]
BASICS = {"W": "Plains", "U": "Island", "B": "Swamp", "R": "Mountain", "G": "Forest"}
ROLE_TAGS = {
    "ramp": ("ramp",),
    "draw": ("draw", "card-advantage"),
    "removal": ("removal", "spot-removal"),
    "sweeper": ("sweeper", "board-wipe"),
}
THEME_TEXT: dict[str, tuple[str, ...]] = {
    "tokens": ("create", "token"),
    "counters": ("+1/+1 counter",),
    "graveyard": ("graveyard",),
    "lifegain": ("gain", "life"),
}
# Commander: 99 cards besides the commander. Legacy: 60, in fours.
COMMANDER_PLAN = {"lands": 37, "ramp": 10, "draw": 10, "removal": 8, "sweeper": 2}
LEGACY_LANDS = {"aggro": 20, "control": 24}


class GuidedRequest(Contract):
    format: GameFormatName
    commander_id: UUID | None = None
    partner_id: UUID | None = None
    colors: str | None = Field(default=None, max_length=5, pattern=r"^[wubrgWUBRG]*$")
    theme: Theme = "midrange"
    tribe: str | None = Field(default=None, max_length=40)
    experience: Experience = "experienced"


class Suggestion(Contract):
    card_id: UUID
    name: str
    quantity: int
    location: Location
    reason: str


class GuidedProposal(Contract):
    format: GameFormatName
    title: str
    identity: str
    entries: list[DeckEntry]
    suggestions: list[Suggestion]
    note: str


@dataclass
class Candidate:
    id: UUID
    name: str
    type_line: str
    text: str
    mana_value: float
    rank: int
    keywords: int
    produced: list[str]
    identity: int
    colors: int
    mana_cost: str
    # Copies in the player's library; None when not limited.
    owned: int | None = None

    def copies(self, wanted: int) -> int:
        return wanted if self.owned is None else min(wanted, self.owned)

    @property
    def types(self) -> list[str]:
        return type_parts(front(self.type_line))[1]

    @property
    def subtypes(self) -> list[str]:
        return type_parts(front(self.type_line))[2]

    @property
    def land(self) -> bool:
        return "Land" in self.types

    @property
    def creature(self) -> bool:
        return "Creature" in self.types


def tag_members(db: Session, slugs: tuple[str, ...]) -> set[UUID]:
    """Cards tagged with any of the slugs or a tag under them."""
    rows = db.execute(select(CardTag.id, CardTag.slug, CardTag.parent_ids)).all()
    children: dict[str, list[UUID]] = defaultdict(list)
    for row in rows:
        for parent in row.parent_ids or []:
            children[str(parent)].append(row.id)
    queue = [row.id for row in rows if row.slug in slugs]
    found: set[UUID] = set()
    while queue:
        tag = queue.pop()
        if tag not in found:
            found.add(tag)
            queue.extend(children.get(str(tag), []))
    if not found:
        return set()
    return set(db.scalars(select(CardTagLink.concept_id).where(CardTagLink.tag_id.in_(found))))


def pool(db: Session, fmt: str, identity: int, library: Library | None = None) -> list[Candidate]:
    query = select(CardConcept).where(
        CardConcept.status == "certified",
        CardConcept.deck_card.is_(True),
        CardConcept.removed_revision.is_(None),
        CardConcept.legalities[fmt].as_string() == "legal",
        CardConcept.identity_mask.op("&")(ALL_COLORS & ~identity) == 0,
    )
    limited = library is not None and not library.unlimited
    if limited:
        owned = [key for key, copies in library.copies.items() if copies > 0]  # type: ignore[union-attr]
        query = query.where(CardConcept.construction_key.in_(owned))
    rows = db.scalars(query)
    return [
        Candidate(
            id=row.id,
            name=row.name,
            type_line=row.type_line,
            text=row.text_search,
            mana_value=row.mana_value,
            rank=row.edhrec_rank if row.edhrec_rank is not None else 10**6,
            keywords=len(row.keywords or []),
            produced=list(row.produced_mana or []),
            identity=row.identity_mask,
            colors=row.colors_mask,
            mana_cost=row.mana_cost or "",
            owned=(
                library.owned(row.construction_key)  # type: ignore[union-attr]
                if limited
                else None
            ),
        )
        for row in rows
    ]


def fits(card: Candidate, theme: Theme, tribe: str | None) -> bool:
    if theme == "aggro":
        return card.creature and card.mana_value <= 3
    if theme == "midrange":
        return card.creature and 2 <= card.mana_value <= 5
    if theme == "control":
        return "Instant" in card.types or "counter target" in card.text
    if theme == "spells":
        return "Instant" in card.types or "Sorcery" in card.types
    if theme == "artifacts":
        return "Artifact" in card.types or "artifact" in card.text
    if theme == "enchantments":
        return "Enchantment" in card.types or "enchantment" in card.text
    if theme == "ramp":
        return "add {" in card.text or "search your library for a basic land" in card.text
    if theme == "tribal":
        wanted = normalize(tribe or "")
        return bool(wanted) and (
            wanted in (normalize(kind) for kind in card.subtypes) or wanted in card.text
        )
    return all(word in card.text for word in THEME_TEXT[theme])


def score(card: Candidate, experience: Experience) -> tuple[float, str]:
    """Lower is better: popularity, and for new players simple cards first."""
    penalty = 0.0
    if experience == "new":
        penalty = len(card.text) * 20 + card.keywords * 500
    return (card.rank + penalty, normalize(card.name))


def propose(db: Session, body: GuidedRequest, library: Library | None = None) -> GuidedProposal:
    """The proposal; the caller saves it as a new deck if the player keeps it."""
    leaders: list[CardConcept] = []
    for card_id in (body.commander_id, body.partner_id):
        if card_id is not None:
            # Only a card in the game may lead (v0.4.5), since v0.6.2 a stand-in the player chose
            # too; the proposal's own cards are all ones the engine plays as written.
            found = db.scalar(select(CardConcept).where(CardConcept.id == card_id, in_game()))
            if found is not None:
                leaders.append(found)
    if body.format == "commander" and leaders:
        identity = 0
        for leader in leaders:
            identity |= leader.identity_mask
    else:
        identity = color_bits(body.colors or "c", "colors") if body.colors else 0
    candidates = [
        card
        for card in pool(db, body.format, identity, library)
        if card.id not in {c.id for c in leaders}
    ]
    roles = {role: tag_members(db, slugs) for role, slugs in ROLE_TAGS.items()}
    chosen: list[Suggestion] = []
    taken: set[UUID] = set()
    copies = 1 if body.format == "commander" else 4

    def take(cards: list[Candidate], count: int, reason: str) -> None:
        for card in sorted(cards, key=lambda item: score(item, body.experience)):
            if count <= 0:
                return
            if card.id in taken or card.land:
                continue
            taken.add(card.id)
            chosen.append(
                Suggestion(
                    card_id=card.id,
                    name=card.name,
                    quantity=card.copies(copies),
                    location="main",
                    reason=reason,
                )
            )
            count -= 1

    # The cards besides the commanders: 99 with one, 98 with a pair; a Legacy main deck of 60.
    slots = 100 - max(1, len(leaders)) if body.format == "commander" else 60
    spells_total: int
    if body.format == "commander":
        for role, wanted in COMMANDER_PLAN.items():
            if role == "lands":
                continue
            count = wanted + (
                2 if body.theme == "control" and role in ("removal", "sweeper") else 0
            )
            if body.experience == "new" and role == "sweeper":
                count = 1
            label = {
                "ramp": "Ramp: it gives you more mana sooner (Scryfall Tagger: ramp).",
                "draw": "Card draw: it keeps your hand full (Scryfall Tagger: card draw).",
                "removal": "Removal: it answers a threat (Scryfall Tagger: removal).",
                "sweeper": "Sweeper: it clears the board when you fall behind.",
            }[role]
            take([card for card in candidates if card.id in roles[role]], count, label)
        spells_total = slots - COMMANDER_PLAN["lands"]
    else:
        spells_total = (60 - LEGACY_LANDS.get(body.theme, 22)) // 4
        if body.theme in ("control", "midrange"):
            take(
                [card for card in candidates if card.id in roles["removal"]],
                2,
                "Removal: it answers a threat (Scryfall Tagger: removal).",
            )
    theme_name = body.theme if body.theme != "tribal" else f"{body.tribe or 'creature type'} tribal"
    theme_cards = [card for card in candidates if fits(card, body.theme, body.tribe)]
    remaining = spells_total - len(chosen)
    take(
        theme_cards,
        max(0, remaining - (6 if body.format == "commander" else 0)),
        f"Theme ({theme_name}): it fits the plan you chose.",
    )
    remaining = spells_total - len(chosen)
    creatures = [card for card in candidates if card.creature]
    take(
        creatures if body.experience == "new" else candidates,
        remaining,
        "A popular card in these colors, to round out the deck (EDHREC rank).",
    )
    # The lands fill what the spells leave, so the deck has its size even from a small pool.
    left = slots - sum(item.quantity for item in chosen)
    lands = mana_base(db, body, candidates, chosen, identity, taken, left, library)
    chosen.extend(lands)
    entries = [
        DeckEntry(card_id=leader.id, quantity=1, location="commander") for leader in leaders
    ] + [
        DeckEntry(card_id=item.card_id, quantity=item.quantity, location=item.location)
        for item in chosen
    ]
    letters = "".join(colors_of(identity)) or "C"
    leader_names = " & ".join(leader.name.split(",")[0] for leader in leaders)
    title = f"{leader_names} {body.theme}" if leader_names else f"{letters} {theme_name}"
    return GuidedProposal(
        format=body.format,
        title=title[:80],
        identity=letters,
        entries=entries,
        suggestions=chosen,
        note="Suggestions follow simple, documented rules (card roles, colors, popularity). "
        "They are a starting point, not a promise that the deck is strong: change anything.",
    )


def mana_base(
    db: Session,
    body: GuidedRequest,
    candidates: list[Candidate],
    chosen: list[Suggestion],
    identity: int,
    taken: set[UUID],
    total: int,
    library: Library | None = None,
) -> list[Suggestion]:
    """`total` lands: a few that make two or more of the colors, then basics in proportion to the
    colored symbols the chosen spells ask for; since v0.6.0, from a library, no more of each basic
    than it holds (basic lands are counted like any card), so the deck may come out short."""

    def most(card: CardConcept, wanted: int) -> int:
        if library is None or library.unlimited:
            return wanted
        return min(wanted, library.owned(card.construction_key) or 0)

    copies = 1 if body.format == "commander" else 4
    colors = colors_of(identity)
    lands: list[Suggestion] = []
    if len(colors) >= 2:
        fixing = [
            card
            for card in candidates
            if card.land
            and card.id not in taken
            and len({color for color in card.produced if color in colors}) >= 2
        ]
        wanted = 10 if body.format == "commander" else 2
        for card in sorted(fixing, key=lambda item: score(item, "experienced"))[:wanted]:
            if sum(item.quantity for item in lands) + card.copies(copies) > total:
                break
            taken.add(card.id)
            lands.append(
                Suggestion(
                    card_id=card.id,
                    name=card.name,
                    quantity=card.copies(copies),
                    location="main",
                    reason="Mana: it makes two or more of your colors.",
                )
            )
    left = total - sum(item.quantity for item in lands)
    if not colors:
        wastes = db.scalar(select(CardConcept).where(CardConcept.normalized_name == "wastes"))
        if wastes is not None and most(wastes, left) > 0:
            lands.append(
                Suggestion(
                    card_id=wastes.id,
                    name=wastes.name,
                    quantity=most(wastes, left),
                    location="main",
                    reason="Mana: colorless basic lands.",
                )
            )
        return lands
    pips: dict[str, int] = {color: 1 for color in colors}
    names = {item.card_id for item in chosen}
    for card in candidates:
        if card.id in names:
            cost = card.mana_cost.upper()
            for color in colors:
                # {R} and the hybrid {R/G} both ask for red.
                pips[color] += cost.count("{" + color)
    weight = sum(pips.values()) or 1
    counts = {color: max(1, round(left * pips[color] / weight)) for color in colors}
    # Rounding may miss the total by a land or two: the largest color takes the difference.
    largest = max(colors, key=lambda color: pips[color])
    counts[largest] += left - sum(counts.values())
    basics = {
        row.normalized_name: row
        for row in db.scalars(
            select(CardConcept).where(
                CardConcept.normalized_name.in_([normalize(name) for name in BASICS.values()])
            )
        )
    }
    for color in colors:
        basic = basics.get(normalize(BASICS[color]))
        if basic is not None and most(basic, counts[color]) > 0:
            lands.append(
                Suggestion(
                    card_id=basic.id,
                    name=basic.name,
                    quantity=most(basic, counts[color]),
                    location="main",
                    reason=f"Mana: {BASICS[color]}s, in proportion to the {color} your spells "
                    "ask for.",
                )
            )
    return lands
