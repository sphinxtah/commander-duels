"""The Planeswalker Alliance's tiers and roster (v0.3.1).

A player's level is their number of game wins. Six tiers, ten times apart from Silver on, each open
more Planeswalkers to ally with. The roster is content/planeswalkers.json, made from the owner's
tier list by scripts/planeswalkers.py; it changes through a commit, not in Administration.

An alliance brings that Planeswalker's own Planeswalker cards into the player's library, a playset
of each: every deck card in the catalog with a face whose types include Planeswalker and whose
subtypes include the roster's Planeswalker subtype (The Wanderer, whose card has none, by its
name). The Godlike tier's Planeswalker has no catalog cards: its custom cards are SysOp's uploads
(api/custom_cards.py).
"""

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session
from starlette.requests import HTTPConnection

from api.identity import settings_of
from api.models import CardConcept, CatalogRevision
from catalog.text import FACE_SEPARATOR, type_parts

TierId = Literal["bronze", "silver", "gold", "platinum", "mythic", "godlike"]
# Copies of each of the alliance Planeswalker's cards in the library: a playset.
ALLIANCE_COPIES = 4


@dataclass(frozen=True)
class Tier:
    id: TierId
    name: str
    wins: int


TIERS = (
    Tier("bronze", "Bronze", 0),
    Tier("silver", "Silver", 10),
    Tier("gold", "Gold", 100),
    Tier("platinum", "Platinum", 1_000),
    Tier("mythic", "Mythic", 10_000),
    Tier("godlike", "Godlike", 100_000),
)
TIER_IDS: tuple[TierId, ...] = tuple(tier.id for tier in TIERS)
GODLIKE = TIERS[-1]


def tier_of(wins: int) -> Tier:
    return next(tier for tier in reversed(TIERS) if wins >= tier.wins)


def next_tier(tier: Tier) -> Tier | None:
    index = TIERS.index(tier)
    return TIERS[index + 1] if index + 1 < len(TIERS) else None


@dataclass(frozen=True)
class Planeswalker:
    id: str
    name: str
    tier: TierId
    subtype: str | None
    first_card: str | None
    first_printed: str | None
    description: str | None
    portrait: bool
    custom: bool

    def opened_by(self, tier: Tier) -> bool:
        return TIER_IDS.index(self.tier) <= TIER_IDS.index(tier.id)

    @property
    def threshold(self) -> int:
        return TIERS[TIER_IDS.index(self.tier)].wins


@lru_cache(maxsize=4)
def load(folder: str) -> dict[str, Planeswalker]:
    content = json.loads((Path(folder) / "planeswalkers.json").read_text(encoding="utf-8"))
    return {
        entry["id"]: Planeswalker(
            id=entry["id"],
            name=entry["name"],
            tier=entry["tier"],
            subtype=entry["subtype"],
            first_card=entry["first_card"],
            first_printed=entry["first_printed"],
            description=entry["description"],
            portrait=entry["portrait"],
            custom=entry["custom"],
        )
        for entry in content["planeswalkers"]
    }


def roster_of(conn: HTTPConnection) -> dict[str, Planeswalker]:
    return load(settings_of(conn).content_dir)


def belongs(planeswalker: Planeswalker, name: str, type_line: str) -> bool:
    """Whether a catalog card is one of the Planeswalker's own Planeswalker cards."""
    if planeswalker.custom:
        return False
    if planeswalker.subtype is None:
        return name == planeswalker.first_card
    wanted = set(planeswalker.subtype.split())
    for face in type_line.split(FACE_SEPARATOR):
        _, types, subtypes = type_parts(face)
        if "Planeswalker" in types and wanted <= set(subtypes):
            return True
    return False


# The cards of every alliance, decided once per catalog revision: (revision, {id: [card ids]}).
_cards: dict[str, tuple[int | None, dict[str, list[UUID]]]] = {}


def alliance_cards(db: Session, roster: dict[str, Planeswalker]) -> dict[str, list[UUID]]:
    """Each Planeswalker's own Planeswalker cards in the catalog, by roster ID."""
    revision = db.scalar(select(func.max(CatalogRevision.id)))
    key = f"{db.get_bind().engine.url}|{','.join(roster)}"
    cached = _cards.get(key)
    if cached is not None and cached[0] == revision:
        return cached[1]
    rows = db.execute(
        select(CardConcept.id, CardConcept.name, CardConcept.type_line).where(
            CardConcept.deck_card.is_(True),
            CardConcept.removed_revision.is_(None),
            CardConcept.type_line.contains("Planeswalker"),
        )
    ).all()
    found: dict[str, list[UUID]] = {}
    for planeswalker in roster.values():
        found[planeswalker.id] = [
            card_id for card_id, name, type_line in rows if belongs(planeswalker, name, type_line)
        ]
    _cards.clear()
    _cards[key] = (revision, found)
    return found
