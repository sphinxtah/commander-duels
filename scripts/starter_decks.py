"""Turns the owner's starter-deck workbook into content/starter-decks.json.

    python scripts/starter_decks.py Commander_Duels_Starter_Decks.xlsx

The workbook stays out of git: it holds private production notes (reference prices and which card
is a deck's guaranteed bonus) that must not reach players or the client. This keeps only what a
player may see: each deck's name, commander, colours, description, how to play it, what it teaches,
and its 100 cards with the printing chosen for each. Standard library only.
"""

import html
import json
import re
import sys
import zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "content" / "starter-decks.json"
COLUMNS = ("quantity", "name", "role", "type", "cost", "mv", "rarity", "reuse", "set", "number")
GUILDS = {
    "WU": "Azorius",
    "UB": "Dimir",
    "BR": "Rakdos",
    "RG": "Gruul",
    "GW": "Selesnya",
    "WB": "Orzhov",
    "UR": "Izzet",
    "BG": "Golgari",
    "RW": "Boros",
    "GU": "Simic",
}


def cell_ref(ref: str) -> tuple[int, int]:
    match = re.fullmatch(r"([A-Z]+)(\d+)", ref)
    if match is None:
        raise ValueError(f"Not a cell reference: {ref}")
    column = 0
    for letter in match.group(1):
        column = column * 26 + ord(letter) - 64
    return int(match.group(2)), column


def read(path: str) -> list[tuple[str, dict[tuple[int, int], str]]]:
    """Every sheet as its name and its cells, by (row, column), 1-based."""
    book = zipfile.ZipFile(path)

    def xml(name: str) -> str:
        # The workbook prefixes every element with x:; drop it so the patterns stay plain.
        text = book.read(name).decode("utf-8-sig")
        return re.sub(r"<(/?)x:", lambda match: "<" + match.group(1), text)

    shared = [
        html.unescape("".join(re.findall(r"<t[^>]*>([^<]*)</t>", item)))
        for item in re.findall(r"<si>(.*?)</si>", xml("xl/sharedStrings.xml"), re.S)
    ]
    targets = {}
    for rel in re.findall(r"<Relationship [^>]*/?>", xml("xl/_rels/workbook.xml.rels")):
        found_id = re.search(r'Id="([^"]+)"', rel)
        found_target = re.search(r'Target="([^"]+)"', rel)
        if found_id and found_target:
            targets[found_id.group(1)] = found_target.group(1).lstrip("/")
    sheets = []
    for name, rel_id in re.findall(
        r'<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"', xml("xl/workbook.xml")
    ):
        target = targets[rel_id]
        if not target.startswith("xl/"):
            target = "xl/" + target
        cells: dict[tuple[int, int], str] = {}
        for attrs, body in re.findall(r"<c ([^>]*?)(?:/>|>(.*?)</c>)", xml(target), re.S):
            ref = re.search(r'r="([A-Z]+\d+)"', attrs)
            if ref is None:
                continue
            kind = re.search(r't="([^"]+)"', attrs)
            value = re.search(r"<v>([^<]*)</v>", body or "")
            inline = re.search(r"<is>.*?<t[^>]*>([^<]*)</t>", body or "", re.S)
            if kind and kind.group(1) == "s" and value:
                text = shared[int(value.group(1))]
            elif inline:
                text = html.unescape(inline.group(1))
            elif value:
                text = html.unescape(value.group(1))
            else:
                continue
            cells[cell_ref(ref.group(1))] = text.strip()
        sheets.append((html.unescape(name), cells))
    return sheets


def deck(name: str, cells: dict[tuple[int, int], str]) -> dict[str, object]:
    def at(row: int, column: int = 1) -> str:
        return cells.get((row, column), "")

    def labelled(label: str) -> str:
        for (row, column), text in cells.items():
            if column == 2 and text == label:
                return at(row, 3)
        raise ValueError(f"{name}: no {label!r} row")

    # Row 2 holds the number and title, row 3 the commander and colours. A merged range keeps its
    # text in its top-left cell: the description is A4:K5, how to play A6:K7, what it teaches A8.
    pair = name.split(" ", 1)[0]
    number, title = at(2).split(None, 1)
    commander, colours = (part.strip() for part in at(3).split("·", 1))
    header = next(row for (row, column), text in cells.items() if column == 1 and text == "Qty")
    cards = []
    row = header + 1
    while at(row).isdigit():
        line = dict(zip(COLUMNS, (at(row, column) for column in range(1, 11)), strict=True))
        cards.append(
            {
                "quantity": int(line["quantity"]),
                "name": line["name"],
                "role": line["role"],
                "set": line["set"].lower(),
                "collector_number": line["number"],
            }
        )
        row += 1
    total = sum(card["quantity"] for card in cards)  # type: ignore[misc]
    if total != 100 or cards[0]["role"] != "Commander":
        raise ValueError(f"{name}: {total} cards, first role {cards[0]['role']}")
    return {
        "id": labelled("Starter ID"),
        "number": int(number),
        "title": title.strip(),
        "commander": commander,
        "colors": pair,
        "color_names": colours.split("(")[0].strip(),
        "guild": GUILDS[pair],
        "description": at(4),
        "how_to_play": at(6).removeprefix("How to play:").strip(),
        "teaches": at(8).removeprefix("Teaches:").strip(),
        "cards": cards,
    }


def main(argv: list[str]) -> None:
    if len(argv) != 2:
        raise SystemExit(__doc__)
    decks = []
    for name, cells in read(argv[1]):
        decks.append(deck(name, cells))
    content = {
        "version": 1,
        "source": "The owner's starter decks, checked against Scryfall on 2026-10-20.",
        "decks": decks,
    }
    # LF on every system, as the repository keeps text.
    with OUT.open("w", encoding="utf-8", newline="\n") as out:
        out.write(json.dumps(content, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(decks)} decks written to {OUT}")


if __name__ == "__main__":
    main(sys.argv)
