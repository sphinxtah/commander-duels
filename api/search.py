"""Card search syntax: a subset of Scryfall's, parsed into parameterized queries (DECK04).

A query is terms separated by spaces, all of which must match; "or" between terms makes either
enough; a leading "-" negates a term or a group; parentheses group. A term is a bare word or a
"quoted phrase" (in the card's name), !Exact Name or !"exact name" (the whole name), or a key, an
operator and a value. Keys and operators:

    t: type:                 type line contains                   t:legendary t:"creature — elf"
    o: oracle: text:         Oracle text contains                 o:"draw a card"
    c: color:                colors; with = != < <= > >= too       c:rg  c>=u  c:colorless  c:m
    id: identity: ci:        color identity within (":" and <=)   id:wub  id=g
    mv: cmc: manavalue:      mana value; = != < <= > >=, even, odd mv<=2  mv=even
    r: rarity:               any printing's rarity, with order     r:mythic  r>=rare
    s: set: e: edition:      printed in that set                  s:lea
    f: format: legal:        legal in a format                    f:commander
    banned:                  banned in a format                   banned:legacy
    is:                      commander, companion, partner, background, playable, unsupported,
                             reserved, gamechanger, permanent, and layouts (split, flip,
                             transform, mdfc, meld, adventure, saga, class, case, leveler,
                             prototype, mutate, battle)
    k: keyword:              has a keyword ability                k:flying
    otag: function:          tagged by Scryfall Tagger            otag:ramp  function:removal
    year:                    first printed in that year            year>=2020
    status:                  catalog status                       status:implemented

Values are matched as written: no value becomes SQL, and %, _ and \\ are literal. An unknown key
or operator, or a value a key does not take, is refused with an explanation naming what is
supported. Nothing here promises compatibility with Scryfall's other operators.
"""

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Any

from sqlalchemy import (
    ColumnElement,
    Integer,
    Text,
    and_,
    cast,
    exists,
    false,
    not_,
    or_,
    select,
    true,
)
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import SQLCoreOperations

from api.models import CARD_STATUSES, CardConcept, CardPrinting, CardTag, CardTagLink
from catalog.text import COLOR_BITS, normalize

# A column or mapped attribute.
Column = SQLCoreOperations[Any]
MAX_QUERY = 500
MAX_TERMS = 40
MAX_DEPTH = 8
TOKEN = re.compile(
    r"""\s*(?:
        (?P<open>\() | (?P<close>\)) |
        (?P<neg>-)(?=[^\s)]) |
        (?P<key>[A-Za-z]+)(?P<op>:|<=|>=|!=|=|<|>)(?P<value>"[^"]*"?|[^\s()]*) |
        (?P<bang>!)?(?P<word>"[^"]*"?|[^\s()]+)
    )""",
    re.X,
)
COLOR_WORDS = {
    "white": "w",
    "blue": "u",
    "black": "b",
    "red": "r",
    "green": "g",
    "azorius": "wu",
    "dimir": "ub",
    "rakdos": "br",
    "gruul": "rg",
    "selesnya": "gw",
    "orzhov": "wb",
    "izzet": "ur",
    "golgari": "bg",
    "boros": "rw",
    "simic": "gu",
    "esper": "wub",
    "grixis": "ubr",
    "jund": "brg",
    "naya": "rgw",
    "bant": "gwu",
    "abzan": "wbg",
    "jeskai": "urw",
    "sultai": "bgu",
    "mardu": "rwb",
    "temur": "gur",
}
RARITIES = ["common", "uncommon", "rare", "mythic", "special", "bonus"]
RARITY_WORDS = {"c": "common", "u": "uncommon", "r": "rare", "m": "mythic", "s": "special"}
LAYOUT_WORDS = {
    "split": "split",
    "flip": "flip",
    "transform": "transform",
    "mdfc": "modal_dfc",
    "modal_dfc": "modal_dfc",
    "meld": "meld",
    "adventure": "adventure",
    "saga": "saga",
    "class": "class",
    "case": "case",
    "leveler": "leveler",
    "prototype": "prototype",
    "mutate": "mutate",
    "battle": "battle",
}
PERMANENT_TYPES = ("artifact", "creature", "enchantment", "land", "planeswalker", "battle")
FORMATS = {
    "standard",
    "pioneer",
    "modern",
    "legacy",
    "vintage",
    "commander",
    "pauper",
    "brawl",
    "historic",
    "timeless",
    "oathbreaker",
    "premodern",
    "oldschool",
    "predh",
    "penny",
    "duel",
    "paupercommander",
}
OPERATORS = (":", "=", "!=", "<", "<=", ">", ">=")


class SearchError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class Leaf:
    key: str | None
    op: str
    value: str
    exact: bool = False


@dataclass(frozen=True)
class Not:
    node: "Node"


@dataclass(frozen=True)
class All:
    nodes: tuple["Node", ...]


@dataclass(frozen=True)
class Any_:
    nodes: tuple["Node", ...]


Node = Leaf | Not | All | Any_


@dataclass
class Token:
    kind: str
    leaf: Leaf | None = None


def tokens(query: str) -> list[Token]:
    if len(query) > MAX_QUERY:
        raise SearchError(f"A search is at most {MAX_QUERY} characters.")
    found: list[Token] = []
    position = 0
    while position < len(query):
        if query[position:].strip() == "":
            break
        match = TOKEN.match(query, position)
        if match is None or match.end() == position:
            raise SearchError(f"The search could not be read from “{query[position:][:20]}”.")
        position = match.end()
        if match["open"]:
            found.append(Token("("))
        elif match["close"]:
            found.append(Token(")"))
        elif match["neg"]:
            found.append(Token("-"))
        elif match["key"]:
            value = unquote(match["value"])
            if not value:
                raise SearchError(f"“{match['key']}{match['op']}” needs a value.")
            found.append(Token("term", Leaf(match["key"].casefold(), match["op"], value)))
        else:
            word = match["word"]
            if word.casefold() == "or" and not match["bang"]:
                found.append(Token("or"))
            else:
                found.append(Token("term", Leaf(None, ":", unquote(word), bool(match["bang"]))))
    if sum(1 for token in found if token.kind == "term") > MAX_TERMS:
        raise SearchError(f"A search has at most {MAX_TERMS} terms.")
    return found


def unquote(value: str) -> str:
    if value.startswith('"'):
        value = value[1:-1] if value.endswith('"') and len(value) > 1 else value[1:]
    return value.strip()


class Parser:
    def __init__(self, found: list[Token]) -> None:
        self.tokens, self.position = found, 0

    def peek(self) -> str | None:
        return self.tokens[self.position].kind if self.position < len(self.tokens) else None

    def take(self) -> Token:
        token = self.tokens[self.position]
        self.position += 1
        return token

    def parse(self) -> Node | None:
        if not self.tokens:
            return None
        node = self.either(0)
        if self.peek() is not None:
            raise SearchError("A “)” has no matching “(”.")
        return node

    def either(self, depth: int) -> Node:
        if depth > MAX_DEPTH:
            raise SearchError(f"Groups nest at most {MAX_DEPTH} deep.")
        nodes = [self.every(depth)]
        while self.peek() == "or":
            self.take()
            nodes.append(self.every(depth))
        return nodes[0] if len(nodes) == 1 else Any_(tuple(nodes))

    def every(self, depth: int) -> Node:
        nodes: list[Node] = []
        while self.peek() not in (None, ")", "or"):
            nodes.append(self.unary(depth))
        if not nodes:
            raise SearchError("“or” and “(” need a term after them.")
        return nodes[0] if len(nodes) == 1 else All(tuple(nodes))

    def unary(self, depth: int) -> Node:
        if self.peek() == "-":
            self.take()
            return Not(self.unary(depth))
        token = self.take()
        if token.kind == "(":
            node = self.either(depth + 1)
            if self.peek() != ")":
                raise SearchError("A “(” is never closed.")
            self.take()
            return node
        if token.kind == "term" and token.leaf is not None:
            return token.leaf
        raise SearchError(f"Unexpected “{token.kind}”.")


def parse(query: str) -> Node | None:
    return Parser(tokens(query)).parse()


def colors(value: str, key: str) -> int:
    """Color letters or names as bits; c and colorless are no color, m multicolor is refused
    here and handled by its caller."""
    word = value.casefold()
    if word in ("c", "colorless"):
        return 0
    letters = COLOR_WORDS.get(word, word)
    if not letters or any(letter not in "wubrg" for letter in letters):
        raise SearchError(
            f"“{key}:{value}” is not a color: use letters w, u, b, r, g, c (colorless) or m "
            "(multicolor), or a color or guild name."
        )
    return sum(COLOR_BITS[letter.upper()] for letter in set(letters))


def compare_colors(column: Column, op: str, bits: int) -> ColumnElement[bool]:
    """Set comparison of a color mask with bits: = exactly, >= including, <= within."""
    within = (column.op("&")(31 & ~bits)) == 0
    including = (column.op("&")(bits)) == bits
    if op in ("=",):
        return column == bits
    if op == "!=":
        return column != bits
    if op == ">=":
        return including
    if op == ">":
        return and_(including, column != bits)
    if op == "<=":
        return within
    if op == "<":
        return and_(within, column != bits)
    raise SearchError(f"Unknown operator {op}.")


def multicolor(column: Column) -> ColumnElement[bool]:
    return column.in_([bits for bits in range(32) if bin(bits).count("1") >= 2])


def number(value: str, key: str) -> float:
    try:
        return float(value)
    except ValueError:
        raise SearchError(f"“{key}” takes a number, not “{value}”.") from None


def compare(column: Column, op: str, value: float) -> ColumnElement[bool]:
    return {
        ":": column == value,
        "=": column == value,
        "!=": column != value,
        "<": column < value,
        "<=": column <= value,
        ">": column > value,
        ">=": column >= value,
    }[op]


def printed(condition: ColumnElement[bool]) -> ColumnElement[bool]:
    return exists(
        select(CardPrinting.id).where(
            CardPrinting.concept_id == CardConcept.id,
            CardPrinting.removed_revision.is_(None),
            condition,
        )
    )


class Compiler:
    """Leaves into conditions on card_concepts. Tags are looked up once per search."""

    def __init__(self, session: Session) -> None:
        self.session = session

    def compile(self, node: Node) -> ColumnElement[bool]:
        if isinstance(node, Not):
            return not_(self.compile(node.node))
        if isinstance(node, All):
            return and_(*(self.compile(child) for child in node.nodes))
        if isinstance(node, Any_):
            return or_(*(self.compile(child) for child in node.nodes))
        return self.leaf(node)

    def leaf(self, leaf: Leaf) -> ColumnElement[bool]:
        if leaf.key is None:
            word = normalize(leaf.value)
            if leaf.exact:
                return CardConcept.normalized_name == word
            return CardConcept.name_search.contains(word, autoescape=True)
        handler = KEYS.get(leaf.key)
        if handler is None:
            raise SearchError(
                f"“{leaf.key}:” is not a search key here. Supported: " + ", ".join(SUPPORTED) + "."
            )
        if leaf.op not in OPERATORS:
            raise SearchError(f"Unknown operator {leaf.op}.")
        return handler(self, leaf)

    def text_key(self, column: Column, leaf: Leaf) -> ColumnElement[bool]:
        if leaf.op not in (":", "="):
            raise SearchError(f"“{leaf.key}” takes “:”.")
        return column.contains(normalize(leaf.value), autoescape=True)

    def type_(self, leaf: Leaf) -> ColumnElement[bool]:
        return self.text_key(CardConcept.type_search, leaf)

    def oracle(self, leaf: Leaf) -> ColumnElement[bool]:
        return self.text_key(CardConcept.text_search, leaf)

    def name(self, leaf: Leaf) -> ColumnElement[bool]:
        return self.text_key(CardConcept.name_search, leaf)

    def color(self, leaf: Leaf) -> ColumnElement[bool]:
        if leaf.value.casefold() in ("m", "multicolor"):
            return multicolor(CardConcept.colors_mask)
        op = ">=" if leaf.op == ":" else leaf.op
        return compare_colors(CardConcept.colors_mask, op, colors(leaf.value, leaf.key or "c"))

    def identity(self, leaf: Leaf) -> ColumnElement[bool]:
        if leaf.value.casefold() in ("m", "multicolor"):
            return multicolor(CardConcept.identity_mask)
        op = "<=" if leaf.op == ":" else leaf.op
        return compare_colors(CardConcept.identity_mask, op, colors(leaf.value, leaf.key or "id"))

    def mana_value(self, leaf: Leaf) -> ColumnElement[bool]:
        word = leaf.value.casefold()
        if word in ("even", "odd"):
            if leaf.op not in (":", "="):
                raise SearchError("mv:even and mv:odd take “:”.")
            whole = cast(CardConcept.mana_value, Integer)
            remainder = 1 if word == "odd" else 0
            return and_(CardConcept.mana_value == whole, whole.op("%")(2) == remainder)
        return compare(CardConcept.mana_value, leaf.op, number(leaf.value, leaf.key or "mv"))

    def rarity(self, leaf: Leaf) -> ColumnElement[bool]:
        word = RARITY_WORDS.get(leaf.value.casefold(), leaf.value.casefold())
        if word not in RARITIES:
            raise SearchError(f"“{leaf.value}” is not a rarity: " + ", ".join(RARITIES) + ".")
        index = RARITIES.index(word)
        chosen = {
            ":": [word],
            "=": [word],
            "!=": [r for r in RARITIES if r != word],
            "<": RARITIES[:index],
            "<=": RARITIES[: index + 1],
            ">": RARITIES[index + 1 :],
            ">=": RARITIES[index:],
        }[leaf.op]
        return printed(CardPrinting.rarity.in_(chosen))

    def set_(self, leaf: Leaf) -> ColumnElement[bool]:
        if leaf.op not in (":", "="):
            raise SearchError("“set” takes “:”.")
        return printed(CardPrinting.set_code == leaf.value.casefold())

    def legal(self, leaf: Leaf, status: str = "legal") -> ColumnElement[bool]:
        fmt = leaf.value.casefold()
        if fmt not in FORMATS or leaf.op not in (":", "="):
            raise SearchError(f"“{leaf.key}:” takes a format: " + ", ".join(sorted(FORMATS)) + ".")
        return legality(fmt) == status

    def banned(self, leaf: Leaf) -> ColumnElement[bool]:
        return self.legal(leaf, "banned")

    def is_(self, leaf: Leaf) -> ColumnElement[bool]:
        word = leaf.value.casefold()
        if leaf.op not in (":", "="):
            raise SearchError("“is” takes “:”.")
        if word in LAYOUT_WORDS:
            return CardConcept.layout == LAYOUT_WORDS[word]
        simple: dict[str, ColumnElement[bool]] = {
            "commander": CardConcept.commander.is_(True),
            "companion": CardConcept.companion.is_(True),
            "partner": and_(CardConcept.partner.is_not(None), CardConcept.partner != "background"),
            "background": CardConcept.partner == "background",
            "playable": CardConcept.status == "certified",
            "supported": CardConcept.status == "certified",
            "unsupported": CardConcept.status != "certified",
            "reserved": CardConcept.reserved.is_(True),
            "gamechanger": CardConcept.game_changer.is_(True),
            "permanent": or_(*(CardConcept.type_search.contains(kind) for kind in PERMANENT_TYPES)),
        }
        if word not in simple:
            raise SearchError(
                f"“is:{leaf.value}” is not supported. Supported: "
                + ", ".join(sorted([*simple, *LAYOUT_WORDS]))
                + "."
            )
        return simple[word]

    def keyword(self, leaf: Leaf) -> ColumnElement[bool]:
        if leaf.op not in (":", "="):
            raise SearchError("“keyword” takes “:”.")
        listed = '"' + leaf.value.casefold() + '"'
        found: ColumnElement[bool] = cast(CardConcept.keywords, Text).ilike(
            f"%{escape(listed)}%", escape="\\"
        )
        return found

    def tag(self, leaf: Leaf) -> ColumnElement[bool]:
        if leaf.op not in (":", "="):
            raise SearchError("“otag” takes “:”.")
        ids = self.tag_ids(leaf.value)
        if not ids:
            return false()
        return exists(
            select(CardTagLink.tag_id).where(
                CardTagLink.concept_id == CardConcept.id, CardTagLink.tag_id.in_(ids)
            )
        )

    def tag_ids(self, value: str) -> list[object]:
        """The tag by slug or alias, and every tag under it."""
        slug = value.casefold().replace(" ", "-")
        rows = self.session.execute(
            select(CardTag.id, CardTag.slug, CardTag.aliases, CardTag.parent_ids)
        ).all()
        children: dict[str, list[object]] = {}
        roots: list[object] = []
        for row in rows:
            for parent in row.parent_ids or []:
                children.setdefault(str(parent), []).append(row.id)
            names = {row.slug, *(alias.casefold().replace(" ", "-") for alias in row.aliases)}
            if slug in names:
                roots.append(row.id)
        found: list[object] = []
        queue = list(roots)
        while queue and len(found) < 2000:
            tag_id = queue.pop()
            if tag_id in found:
                continue
            found.append(tag_id)
            queue.extend(children.get(str(tag_id), []))
        return found

    def year(self, leaf: Leaf) -> ColumnElement[bool]:
        year = int(number(leaf.value, "year"))
        start, end = date(year, 1, 1), date(year, 12, 31)
        column = CardConcept.first_released_at
        return {
            ":": column.between(start, end),
            "=": column.between(start, end),
            "!=": not_(column.between(start, end)),
            "<": column < start,
            "<=": column <= end,
            ">": column > end,
            ">=": column >= start,
        }[leaf.op]

    def status(self, leaf: Leaf) -> ColumnElement[bool]:
        word = leaf.value.casefold()
        if word not in CARD_STATUSES or leaf.op not in (":", "="):
            raise SearchError("“status:” takes " + ", ".join(CARD_STATUSES) + ".")
        return CardConcept.status == word


def legality(fmt: str) -> ColumnElement[str]:
    """A card's Scryfall legality in a format, as text."""
    found: ColumnElement[str] = CardConcept.legalities[fmt].as_string()
    return found


def escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


Handler = Callable[[Compiler, Leaf], ColumnElement[bool]]
KEYS: dict[str, Handler] = {
    "t": Compiler.type_,
    "type": Compiler.type_,
    "o": Compiler.oracle,
    "oracle": Compiler.oracle,
    "text": Compiler.oracle,
    "name": Compiler.name,
    "c": Compiler.color,
    "color": Compiler.color,
    "colors": Compiler.color,
    "id": Compiler.identity,
    "identity": Compiler.identity,
    "ci": Compiler.identity,
    "mv": Compiler.mana_value,
    "cmc": Compiler.mana_value,
    "manavalue": Compiler.mana_value,
    "r": Compiler.rarity,
    "rarity": Compiler.rarity,
    "s": Compiler.set_,
    "set": Compiler.set_,
    "e": Compiler.set_,
    "edition": Compiler.set_,
    "f": Compiler.legal,
    "format": Compiler.legal,
    "legal": Compiler.legal,
    "banned": Compiler.banned,
    "is": Compiler.is_,
    "k": Compiler.keyword,
    "keyword": Compiler.keyword,
    "otag": Compiler.tag,
    "function": Compiler.tag,
    "oracletag": Compiler.tag,
    "year": Compiler.year,
    "status": Compiler.status,
}
SUPPORTED = sorted(
    {
        "t",
        "o",
        "name",
        "c",
        "id",
        "mv",
        "r",
        "s",
        "f",
        "banned",
        "is",
        "k",
        "otag",
        "year",
        "status",
    }
)


def condition(session: Session, query: str) -> ColumnElement[bool]:
    """The query as one condition; an empty query matches every card."""
    node = parse(query)
    return true() if node is None else Compiler(session).compile(node)
