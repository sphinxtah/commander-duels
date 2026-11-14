"""Reads the Reserved List and writes content/reserved-list.json (v0.9.12).

    python scripts/reserved_list.py            # refresh the list from Scryfall
    python scripts/reserved_list.py --check    # name every listed card a campaign deck holds

The campaign's opponents play no Power Nine card and no card of the Reserved List (the owner,
2026-11-13): a warden's deck is won whole and for good, and its cards are sellable, so a deck that
held them handed every player who finished the campaign the game's scarcest cards. The Reserved
List is Wizards of the Coast's list of cards it has promised never to print again; Scryfall marks
each of them (`is:reserved`), and this reads that search once and commits the names, as
content/pack-prices.json and content/starter-deck-prices.json are read once and committed. The
Power Nine are all on it; they are named apart because the rule names them.

tests/test_campaign.py and the engine's CourtDecksTest check every opponent's deck against the
committed file on every push. Standard library only; a tenth of a second between requests, as
Scryfall asks of its clients.
"""

import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CAMPAIGN = ROOT / "content" / "campaign.json"
OUT = ROOT / "content" / "reserved-list.json"
API = "https://api.scryfall.com"
HEADERS = {"User-Agent": "CommanderDuels/0.9 (reserved list)", "Accept": "application/json"}
QUERY = "is:reserved"
POWER_NINE = (
    "Ancestral Recall",
    "Black Lotus",
    "Mox Emerald",
    "Mox Jet",
    "Mox Pearl",
    "Mox Ruby",
    "Mox Sapphire",
    "Time Walk",
    "Timetwister",
)


def ask(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=60) as response:
        found: dict[str, Any] = json.load(response)
    time.sleep(0.1)
    return found


def read_list() -> list[str]:
    """Every card Scryfall marks as reserved, by name, each once."""
    query = urllib.parse.urlencode({"q": QUERY, "unique": "cards", "order": "name"})
    url: str | None = f"{API}/cards/search?{query}"
    names: set[str] = set()
    expected = None
    while url:
        page = ask(url)
        expected = page.get("total_cards", expected)
        names.update(card["name"] for card in page["data"])
        url = page.get("next_page") if page.get("has_more") else None
    if expected is not None and len(names) != expected:
        raise SystemExit(f"Scryfall counts {expected} reserved cards; {len(names)} were read")
    return sorted(names)


def listed() -> frozenset[str]:
    """The committed list: the Reserved List and the Power Nine."""
    held = json.loads(OUT.read_text(encoding="utf-8"))
    return frozenset(held["cards"]) | frozenset(held["power_nine"])


def decks() -> list[tuple[str, list[str]]]:
    """Each deck a campaign opponent plays: every ward's, and the court's two Generals' gifts.

    The court's King plays ward 14's deck and the player's bot Generals play wards 12's and 13's
    (`cards_from`, `deck_from`), so those are covered by their wards."""
    campaign = json.loads(CAMPAIGN.read_text(encoding="utf-8"))
    found = []
    for encounter in campaign["encounters"]:
        ward = f"ward {encounter['number']} ({encounter['name']})"
        owners = [(ward, encounter)] + [
            (f"{ward}, {general['deck_title']}", general)
            for general in (encounter.get("court") or {}).get("generals", [])
        ]
        for label, deck in owners:
            names = [card["name"] for card in deck.get("cards", [])]
            for key in ("commander", "fallback_commander"):
                if deck.get(key):
                    names.append(deck[key])
            found.append((label, names))
    return found


def check() -> int:
    excluded = listed()
    held = [(ward, sorted(set(names) & excluded)) for ward, names in decks()]
    for ward, names in held:
        if names:
            print(f"{ward}: {', '.join(names)}")
    count = sum(len(names) for _, names in held)
    print(f"{count} listed cards in the campaign's decks")
    return 1 if count else 0


def main() -> int:
    if sys.argv[1:] == ["--check"]:
        return check()
    cards = read_list()
    missing = [name for name in POWER_NINE if name not in cards]
    if missing:
        raise SystemExit(f"The Power Nine are reserved, but Scryfall's list lacks {missing}")
    OUT.write_text(
        json.dumps(
            {
                "about": (
                    "The Reserved List (the cards Wizards of the Coast has promised never to print"
                    " again) and the Power Nine. No campaign opponent's deck holds a card named"
                    " here: docs/campaign.md, scripts/reserved_list.py."
                ),
                "source": f"Scryfall, the search {QUERY}",
                "read": date.today().isoformat(),
                "power_nine": list(POWER_NINE),
                "cards": cards,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"{len(cards)} reserved cards written to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
