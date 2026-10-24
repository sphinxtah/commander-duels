"""Stand-ins (v0.6.2, docs/games.md "Stand-ins"): the cards a game plays without rules for them.

The owner's decision of v0.6.2: a pack gives the card it drew, and a casual game lets its owner
play it, whether the engine can play it or not. A deck card the engine lacks (or holds back:
catalog/statuses.py stand_in()) goes to the engine described, not named: its name in the game,
printed mana cost, card types, subtypes and supertypes, power and toughness, loyalty and defense,
and colours. The engine makes a card of exactly that (engine/src/.../StandInCard.java), with no
abilities: its rules text is inert. The game shows its picture by its name, which the table's
image cache looks up in the whole catalog.

A card with faces stands in as its front face, a split card as its whole name with its first
half's cost and types.
"""

from collections import defaultdict
from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from api.models import CardAlias, CardConcept, CardFace
from catalog.records import JOINED_NAME_LAYOUTS
from catalog.statuses import stand_in
from catalog.text import front, normalize, type_parts

# Colours in the order the engine's stand-in reads them (engine DeckLists).
COLOURS = "WUBRG"


def described(concept: CardConcept, faces: list[CardFace]) -> dict[str, object]:
    """The engine's description of a stand-in card: its front face's, or a split card's first
    half's under the whole card's name."""
    first = faces[0] if faces else None
    source: CardConcept | CardFace = first if first is not None else concept
    name = concept.name if first is None or concept.layout in JOINED_NAME_LAYOUTS else first.name
    type_line = source.type_line or front(concept.type_line)
    supertypes, types, subtypes = type_parts(front(type_line))
    colours = source.colors if source.colors is not None else concept.colors
    data: dict[str, object] = {
        "name": name,
        "mana_cost": source.mana_cost or "",
        "types": types,
        "subtypes": subtypes,
        "supertypes": supertypes,
        "colors": [colour for colour in COLOURS if colour in (colours or [])],
    }
    for field in ("power", "toughness", "loyalty", "defense"):
        value = getattr(source, field) or getattr(concept, field)
        if value is not None:
            data[field] = value
    return data


def stand_ins(db: Session, ids: Iterable[UUID]) -> dict[UUID, dict[str, object]]:
    """The stand-ins among these cards, each with the engine's description of it."""
    wanted = set(ids)
    if not wanted:
        return {}
    concepts = list(db.scalars(select(CardConcept).where(CardConcept.id.in_(wanted), stand_in())))
    if not concepts:
        return {}
    faces: dict[UUID, list[CardFace]] = defaultdict(list)
    for face in db.scalars(
        select(CardFace)
        .where(CardFace.concept_id.in_({concept.id for concept in concepts}))
        .order_by(CardFace.position)
    ):
        faces[face.concept_id].append(face)
    return {concept.id: described(concept, faces[concept.id]) for concept in concepts}


def stand_ins_named(db: Session, names: Iterable[str]) -> dict[str, dict[str, object]]:
    """For SysOp's deck lists: the names, normalized, that name a stand-in by its own name or a
    face's, each with its description."""
    wanted = {normalize(name) for name in names}
    if not wanted:
        return {}
    found: dict[str, UUID] = dict(
        db.execute(
            select(CardConcept.normalized_name, CardConcept.id).where(
                CardConcept.normalized_name.in_(wanted), stand_in()
            )
        ).all()
    )
    found |= dict(
        db.execute(
            select(CardAlias.alias, CardConcept.id)
            .join(CardConcept, CardConcept.id == CardAlias.concept_id)
            .where(CardAlias.alias.in_(wanted - found.keys()), stand_in())
        ).all()
    )
    described_by_id = stand_ins(db, set(found.values()))
    return {name: described_by_id[card] for name, card in found.items() if card in described_by_id}
