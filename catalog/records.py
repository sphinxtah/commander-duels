"""Scryfall records as catalog rows (CAT02–CAT04).

An Oracle card becomes a concept with its faces; a default-cards record becomes a printing. Two
hashes decide what changed: the gameplay hash covers what the rules read (names, costs, types,
text, characteristics, layout), the cosmetic hash what a printing shows. Prices, ranks and links
change daily and are no change to a card, so neither hash reads them. Fields this version does
not map are kept in extra, as they came, and a layout it does not know is kept but quarantined.
"""

import hashlib
import json
from dataclasses import dataclass, field
from datetime import date
from typing import Any
from uuid import UUID

from catalog.roles import Roles, roles
from catalog.scryfall import SyncError
from catalog.text import FACE_SEPARATOR, mask, normalize

# Layouts this version understands, from Scryfall's card object definitions. Another layout is
# imported but its cards stay unsupported until a version learns it.
KNOWN_LAYOUTS = frozenset(
    {
        "normal",
        "split",
        "flip",
        "transform",
        "modal_dfc",
        "meld",
        "leveler",
        "class",
        "case",
        "saga",
        "adventure",
        # Since v0.4.5: a creature with a spell it may cast a copy of while prepared (Secrets of
        # Strixhaven). XMage models it as an adventure, under its front face's name.
        "prepare",
        "mutate",
        "prototype",
        "battle",
        "planar",
        "scheme",
        "vanguard",
        "token",
        "double_faced_token",
        "emblem",
        "augment",
        "host",
        "art_series",
        "reversible_card",
    }
)
# Objects no deck holds: they are made by cards, belong to other game variants, or are art.
NON_DECK_LAYOUTS = frozenset(
    {"token", "double_faced_token", "emblem", "art_series", "planar", "scheme", "vanguard"}
)
# Layouts whose faces have one name together ("Fire // Ice"); on the others the front face names
# the card in a game.
JOINED_NAME_LAYOUTS = frozenset({"split"})
# Layouts whose second face is a spell cast from the card: the engine prints the spell, with its
# cost, among the card's rules.
SPELL_FACE_LAYOUTS = frozenset({"adventure", "prepare"})

# Changes daily, or only points elsewhere on Scryfall.
VOLATILE = frozenset(
    {
        "prices",
        "edhrec_rank",
        "penny_rank",
        "purchase_uris",
        "related_uris",
        "uri",
        "scryfall_uri",
        "rulings_uri",
        "prints_search_uri",
        "set_uri",
        "set_search_uri",
        "scryfall_set_uri",
        "object",
    }
)
GAMEPLAY = (
    "name",
    "layout",
    "mana_cost",
    "cmc",
    "type_line",
    "oracle_text",
    "power",
    "toughness",
    "loyalty",
    "defense",
    "colors",
    "color_identity",
    "color_indicator",
    "keywords",
    "produced_mana",
    "hand_modifier",
    "life_modifier",
)
FACE_GAMEPLAY = (
    "name",
    "mana_cost",
    "type_line",
    "oracle_text",
    "colors",
    "color_indicator",
    "power",
    "toughness",
    "loyalty",
    "defense",
)
CONCEPT_FIELDS = frozenset(
    {
        *GAMEPLAY,
        "oracle_id",
        "legalities",
        "reserved",
        "game_changer",
        "card_faces",
        "all_parts",
    }
)
PRINTING_FIELDS = (
    "set",
    "set_name",
    "set_type",
    "collector_number",
    "lang",
    "released_at",
    "rarity",
    "layout",
    "finishes",
    "frame",
    "frame_effects",
    "border_color",
    "full_art",
    "promo",
    "promo_types",
    "digital",
    "games",
    "artist",
    "illustration_id",
    "image_status",
    "image_uris",
    "flavor_name",
    "printed_name",
)
# Mapped elsewhere, or kept in a printing's own columns.
PRINTING_OWN = frozenset({*PRINTING_FIELDS, *CONCEPT_FIELDS, "id", "card_faces"})
# Printing-level fields a printing keeps in its extra; an Oracle card, which is also one of its
# printings, does not repeat them.
PRINTING_EXTRA = frozenset(
    {
        "multiverse_ids",
        "mtgo_id",
        "mtgo_foil_id",
        "arena_id",
        "tcgplayer_id",
        "tcgplayer_etched_id",
        "cardmarket_id",
        "resource_id",
        "highres_image",
        "image_updated_at",
        "foil",
        "nonfoil",
        "oversized",
        "reprint",
        "variation",
        "variation_of",
        "set_id",
        "textless",
        "booster",
        "story_spotlight",
        "artist_ids",
        "card_back_id",
        "flavor_text",
        "security_stamp",
        "preview",
        "watermark",
        "printed_text",
        "printed_type_line",
        "content_warning",
        "attraction_lights",
    }
)
IMAGE_SIZES = ("small", "normal", "large", "png", "art_crop", "border_crop")
FACE_PRINTING = ("name", "artist", "illustration_id", "flavor_name", "printed_name")
MAX_NAME = 300
MAX_TEXT = 20_000


def digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def text(record: dict[str, Any], key: str, limit: int = MAX_TEXT) -> str | None:
    value = record.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f"{key} is not text of at most {limit} characters")
    return value


def strings(record: dict[str, Any], key: str) -> list[str]:
    value = record.get(key) or []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"{key} is not a list of text")
    return list(value)


def uuid(record: dict[str, Any], key: str) -> UUID:
    try:
        return UUID(str(record[key]))
    except (KeyError, ValueError):
        raise ValueError(f"{key} is not an ID") from None


def day(record: dict[str, Any], key: str) -> date | None:
    value = record.get(key)
    if value is None:
        return None
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        raise ValueError(f"{key} is not a date") from None


def images(value: object) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    return {size: str(value[size]) for size in IMAGE_SIZES if isinstance(value.get(size), str)}


@dataclass
class Face:
    position: int
    name: str
    mana_cost: str | None
    type_line: str | None
    oracle_text: str | None
    colors: list[str] | None
    color_indicator: list[str] | None
    power: str | None
    toughness: str | None
    loyalty: str | None
    defense: str | None


@dataclass
class Concept:
    oracle_id: UUID
    name: str
    layout: str
    known_layout: bool
    deck_card: bool
    mana_cost: str | None
    mana_value: float
    type_line: str
    oracle_text: str
    power: str | None
    toughness: str | None
    loyalty: str | None
    defense: str | None
    colors: list[str]
    color_identity: list[str]
    color_indicator: list[str] | None
    keywords: list[str]
    produced_mana: list[str]
    legalities: dict[str, str]
    reserved: bool
    game_changer: bool
    edhrec_rank: int | None
    faces: list[Face]
    relations: list[dict[str, Any]]
    extra: dict[str, object]
    gameplay_hash: str
    legality_hash: str
    # The name a game uses: the joined name of a split card, otherwise the front face's.
    game_name: str
    meld_result: bool = False

    @property
    def normalized_name(self) -> str:
        return normalize(self.name)

    @property
    def construction_key(self) -> str:
        return normalize(self.name)

    @property
    def name_search(self) -> str:
        names = [self.name, *(face.name for face in self.faces)]
        return " | ".join(dict.fromkeys(normalize(name) for name in names))

    @property
    def type_search(self) -> str:
        return normalize(self.type_line)

    @property
    def text_search(self) -> str:
        parts = [self.oracle_text, *(face.oracle_text or "" for face in self.faces)]
        return normalize("\n".join(part for part in parts if part))

    @property
    def roles(self) -> Roles:
        """Commander, pair, companion and copy rules; a card no deck holds has none of them."""
        front = self.faces[0].type_line if self.faces and self.layout != "split" else None
        found = roles(self.type_line, self.oracle_text, self.keywords, front)
        if not self.deck_card:
            return Roles(False, None, False, None, found.activated)
        return found

    def row(self) -> dict[str, object]:
        """The card_concepts columns this record decides."""
        found = self.roles
        return {
            "commander": found.commander,
            "partner": found.partner,
            "companion": found.companion,
            "copy_limit": found.copy_limit,
            "activated": found.activated,
            "oracle_id": self.oracle_id,
            "name": self.name,
            "normalized_name": self.normalized_name,
            "construction_key": self.construction_key,
            "layout": self.layout,
            "deck_card": self.deck_card,
            "mana_cost": self.mana_cost,
            "mana_value": self.mana_value,
            "type_line": self.type_line,
            "oracle_text": self.oracle_text,
            "power": self.power,
            "toughness": self.toughness,
            "loyalty": self.loyalty,
            "defense": self.defense,
            "colors": self.colors,
            "color_identity": self.color_identity,
            "color_indicator": self.color_indicator,
            "colors_mask": mask(self.colors),
            "identity_mask": mask(self.color_identity),
            "keywords": self.keywords,
            "produced_mana": self.produced_mana,
            "legalities": self.legalities,
            "reserved": self.reserved,
            "game_changer": self.game_changer,
            "edhrec_rank": self.edhrec_rank,
            "name_search": self.name_search,
            "type_search": self.type_search,
            "text_search": self.text_search,
            "gameplay_hash": self.gameplay_hash,
            "legality_hash": self.legality_hash,
            "extra": self.extra,
        }


@dataclass
class Printing:
    scryfall_id: UUID
    oracle_id: UUID
    values: dict[str, object]
    cosmetic_hash: str
    released_at: date | None
    paper: bool
    aliases: list[tuple[str, str]] = field(default_factory=list)


def concept(record: dict[str, Any]) -> Concept:
    """An oracle_cards record. Raises SyncError naming what is wrong with it."""
    try:
        return _concept(record)
    except (ValueError, TypeError) as error:
        raise SyncError("record_malformed", f"oracle card {record.get('id')}: {error}") from None


def _concept(record: dict[str, Any]) -> Concept:
    name = text(record, "name", MAX_NAME)
    layout = text(record, "layout", 64)
    if not name or not layout:
        raise ValueError("a card needs a name and a layout")
    faces_raw = record.get("card_faces") or []
    if not isinstance(faces_raw, list) or not all(isinstance(face, dict) for face in faces_raw):
        raise ValueError("card_faces is not a list of faces")
    faces = [
        Face(
            position=index,
            name=text(face, "name", MAX_NAME) or "",
            mana_cost=text(face, "mana_cost"),
            type_line=text(face, "type_line"),
            oracle_text=text(face, "oracle_text"),
            colors=strings(face, "colors") if "colors" in face else None,
            color_indicator=strings(face, "color_indicator") if "color_indicator" in face else None,
            power=text(face, "power", 16),
            toughness=text(face, "toughness", 16),
            loyalty=text(face, "loyalty", 16),
            defense=text(face, "defense", 16),
        )
        for index, face in enumerate(faces_raw)
    ]
    if any(not face.name for face in faces):
        raise ValueError("a face has no name")
    type_line = text(record, "type_line") or FACE_SEPARATOR.join(
        face.type_line or "" for face in faces
    )
    oracle = text(record, "oracle_text")
    if oracle is None:
        oracle = "\n//\n".join(face.oracle_text or "" for face in faces)
    colors = strings(record, "colors") if "colors" in record else None
    if colors is None:
        colors = sorted({color for face in faces for color in face.colors or []})
    cmc = record.get("cmc", 0)
    if not isinstance(cmc, int | float) or isinstance(cmc, bool):
        raise ValueError("cmc is not a number")
    legalities = record.get("legalities") or {}
    if not isinstance(legalities, dict) or not all(
        isinstance(value, str) for value in legalities.values()
    ):
        raise ValueError("legalities is not a map of text")
    relations = [
        part
        for part in record.get("all_parts") or []
        if isinstance(part, dict) and part.get("id") and part.get("name")
    ]
    # A meld result is the back half of two cards: Scryfall lists it as a card of its own.
    meld_result = layout == "meld" and any(
        part.get("component") == "meld_result" and part.get("name") == name for part in relations
    )
    gameplay = {key: record.get(key) for key in GAMEPLAY}
    gameplay["faces"] = [{key: face.get(key) for key in FACE_GAMEPLAY} for face in faces_raw]
    rank = record.get("edhrec_rank")
    known = layout in KNOWN_LAYOUTS
    game_name = name if layout in JOINED_NAME_LAYOUTS or not faces else faces[0].name
    return Concept(
        oracle_id=uuid(record, "oracle_id"),
        name=name,
        layout=layout,
        known_layout=known,
        deck_card=layout not in NON_DECK_LAYOUTS
        and not meld_result
        and (known or any(value != "not_legal" for value in legalities.values())),
        meld_result=meld_result,
        mana_cost=text(record, "mana_cost"),
        mana_value=float(cmc),
        type_line=type_line,
        oracle_text=oracle,
        power=text(record, "power", 16),
        toughness=text(record, "toughness", 16),
        loyalty=text(record, "loyalty", 16),
        defense=text(record, "defense", 16),
        colors=colors,
        color_identity=strings(record, "color_identity"),
        color_indicator=strings(record, "color_indicator") if "color_indicator" in record else None,
        keywords=strings(record, "keywords"),
        produced_mana=strings(record, "produced_mana"),
        legalities=dict(legalities),
        reserved=bool(record.get("reserved")),
        game_changer=bool(record.get("game_changer")),
        edhrec_rank=rank if isinstance(rank, int) and not isinstance(rank, bool) else None,
        faces=faces,
        relations=relations,
        extra={
            key: value
            for key, value in record.items()
            if key not in PRINTING_OWN and key not in PRINTING_EXTRA and key not in VOLATILE
        },
        gameplay_hash=digest(gameplay),
        legality_hash=digest(legalities),
        game_name=game_name,
    )


def printing(record: dict[str, Any]) -> Printing:
    """A default_cards record. A reversible card names its Oracle ID on its faces."""
    try:
        return _printing(record)
    except (ValueError, TypeError) as error:
        raise SyncError("record_malformed", f"printing {record.get('id')}: {error}") from None


def _printing(record: dict[str, Any]) -> Printing:
    faces_raw = record.get("card_faces") or []
    if not isinstance(faces_raw, list) or not all(isinstance(face, dict) for face in faces_raw):
        raise ValueError("card_faces is not a list of faces")
    oracle = record.get("oracle_id") or next(
        (face.get("oracle_id") for face in faces_raw if face.get("oracle_id")), None
    )
    if oracle is None:
        raise ValueError("no oracle_id on the card or its faces")
    collector = text(record, "collector_number", 32)
    set_code = text(record, "set", 16)
    if not collector or not set_code:
        raise ValueError("a printing needs a set and a collector number")
    illustration = record.get("illustration_id")
    values: dict[str, object] = {
        "set_code": set_code,
        "set_name": text(record, "set_name", 200) or set_code,
        "set_type": text(record, "set_type", 32) or "unknown",
        "collector_number": collector,
        "lang": text(record, "lang", 8) or "en",
        "released_at": day(record, "released_at"),
        "rarity": text(record, "rarity", 16) or "unknown",
        "layout": text(record, "layout", 32) or "unknown",
        "finishes": strings(record, "finishes"),
        "frame": text(record, "frame", 16),
        "frame_effects": strings(record, "frame_effects"),
        "border_color": text(record, "border_color", 16),
        "full_art": bool(record.get("full_art")),
        "promo": bool(record.get("promo")),
        "promo_types": strings(record, "promo_types"),
        "digital": bool(record.get("digital")),
        "games": strings(record, "games"),
        "artist": text(record, "artist", 200),
        "illustration_id": UUID(str(illustration)) if illustration else None,
        "image_status": text(record, "image_status", 32),
        "image_uris": images(record.get("image_uris")),
        "faces": [
            {
                **{key: face.get(key) for key in FACE_PRINTING if face.get(key) is not None},
                "image_uris": images(face.get("image_uris")),
            }
            for face in faces_raw
        ],
        "flavor_name": text(record, "flavor_name", MAX_NAME),
        "printed_name": text(record, "printed_name", MAX_NAME),
        "extra": {
            key: value
            for key, value in record.items()
            if key not in PRINTING_OWN and key not in VOLATILE
        },
    }
    cosmetic = {**values, "released_at": str(values["released_at"])}
    cosmetic["illustration_id"] = str(illustration) if illustration else None
    aliases = [
        (str(name), kind)
        for kind, name in (
            ("flavor_name", values["flavor_name"]),
            ("printed_name", values["printed_name"]),
        )
        if name
    ]
    for face in faces_raw:
        for kind in ("flavor_name", "printed_name"):
            if isinstance(face.get(kind), str):
                aliases.append((face[kind], kind))
    return Printing(
        scryfall_id=uuid(record, "id"),
        oracle_id=UUID(str(oracle)),
        values=values,
        cosmetic_hash=digest(cosmetic),
        released_at=values["released_at"],  # type: ignore[arg-type]
        paper="paper" in values["games"],  # type: ignore[operator]
        aliases=aliases,
    )


def printing_rank(values: dict[str, object]) -> tuple[int, ...]:
    """Higher is a better printing to show when a deck names none: English, on paper, a regular
    printing with a high-resolution scan, then the newest."""
    released = values.get("released_at")
    return (
        int(values.get("lang") == "en"),
        int(not values.get("digital")),
        int("paper" in (values.get("games") or [])),  # type: ignore[operator]
        int(not values.get("promo")),
        int(
            values.get("set_type")
            in {"core", "expansion", "masters", "commander", "draft_innovation", "starter"}
        ),
        int(values.get("border_color") == "black"),
        int(values.get("image_status") == "highres_scan"),
        released.toordinal() if isinstance(released, date) else 0,
    )


@dataclass
class Ruling:
    oracle_id: UUID
    source: str
    published_at: date
    comment: str


def ruling(record: dict[str, Any]) -> Ruling:
    try:
        published = day(record, "published_at")
        comment = text(record, "comment")
        if published is None or not comment:
            raise ValueError("a ruling needs a date and a comment")
        return Ruling(
            uuid(record, "oracle_id"), text(record, "source", 16) or "", published, comment
        )
    except (ValueError, TypeError) as error:
        raise SyncError(
            "record_malformed", f"ruling for {record.get('oracle_id')}: {error}"
        ) from None


@dataclass
class Tag:
    id: UUID
    slug: str
    label: str
    description: str | None
    parent_ids: list[str]
    aliases: list[str]
    taggings: list[tuple[UUID, str]]


def tag(record: dict[str, Any]) -> Tag | None:
    """An oracle tag; tags of other kinds (art tags) are skipped."""
    if record.get("type") != "oracle":
        return None
    try:
        slug = text(record, "slug", 200)
        if not slug:
            raise ValueError("a tag needs a slug")
        taggings = [
            (uuid(item, "oracle_id"), str(item.get("weight") or "median"))
            for item in record.get("taggings") or []
            if isinstance(item, dict)
        ]
        return Tag(
            id=uuid(record, "id"),
            slug=slug,
            label=text(record, "label", 200) or slug,
            description=text(record, "description", 2000),
            parent_ids=strings(record, "parent_ids"),
            aliases=strings(record, "aliases"),
            taggings=taggings,
        )
    except (ValueError, TypeError) as error:
        raise SyncError("record_malformed", f"tag {record.get('slug')}: {error}") from None
