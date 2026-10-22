"""Prices the ten starter decks from their cards: content/starter-deck-prices.json (v0.4.2).

    python scripts/starter_deck_prices.py

Leng's card shop sells the starter decks once a player has chosen their two free ones. A deck's
price follows the cards buying it grants: every card but the basic lands (which a library holds
without limit), each at the market price of the printing the owner chose for it, as Scryfall gives
it (TCGplayer's market price, in US dollars). A printing with no US dollar price takes its foil or
etched price, and a card whose printing has none at all takes the lowest price of any printing of
the same card. The API turns the total into tokens at the current pack's rate (api/products.py).

The prices are a snapshot of a moving market, read once and committed, like
content/pack-prices.json; running this again refreshes them. Standard library only; it asks
Scryfall's card collection endpoint, 75 cards a request, a tenth of a second apart, as Scryfall
asks of its clients.
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
DECKS = ROOT / "content" / "starter-decks.json"
OUT = ROOT / "content" / "starter-deck-prices.json"
API = "https://api.scryfall.com"
HEADERS = {"User-Agent": "CommanderDuels/0.4 (starter deck prices)", "Accept": "application/json"}
BATCH = 75


def ask(path: str, body: dict[str, object] | None = None) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode()
    headers = {**HEADERS, **({"Content-Type": "application/json"} if data else {})}
    request = urllib.request.Request(API + path, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        found: dict[str, Any] = json.load(response)
    time.sleep(0.1)
    return found


def price(card: dict[str, Any]) -> float | None:
    prices = card.get("prices") or {}
    for finish in ("usd", "usd_foil", "usd_etched"):
        if prices.get(finish):
            return float(prices[finish])
    return None


def lowest_of(name: str) -> float | None:
    """The lowest price of any printing of the card, by its exact name."""
    query = urllib.parse.urlencode(
        {"q": f'!"{name}"', "unique": "prints", "order": "usd", "dir": "asc"}
    )
    found = ask(f"/cards/search?{query}")
    prices = [value for card in found.get("data", []) if (value := price(card)) is not None]
    return min(prices) if prices else None


def main() -> int:
    decks = json.loads(DECKS.read_text(encoding="utf-8"))["decks"]
    wanted = {
        (card["set"].lower(), card["collector_number"]) for deck in decks for card in deck["cards"]
    }
    cards: dict[tuple[str, str], dict[str, Any]] = {}
    keys = sorted(wanted)
    for start in range(0, len(keys), BATCH):
        identifiers = [
            {"set": set_code, "collector_number": number}
            for set_code, number in keys[start : start + BATCH]
        ]
        for card in ask("/cards/collection", {"identifiers": identifiers})["data"]:
            cards[(card["set"].lower(), card["collector_number"])] = card
    fallback: dict[str, float | None] = {}
    rows = []
    for deck in decks:
        usd = 0.0
        priced = basics = 0
        estimated: list[str] = []
        unpriced: list[str] = []
        for entry in deck["cards"]:
            card = cards.get((entry["set"].lower(), entry["collector_number"]))
            type_line = (card or {}).get("type_line", "")
            if type_line.startswith("Basic "):
                basics += entry["quantity"]
                continue
            value = price(card) if card else None
            if value is None:
                if entry["name"] not in fallback:
                    fallback[entry["name"]] = lowest_of(entry["name"])
                value = fallback[entry["name"]]
                if value is None:
                    unpriced.append(entry["name"])
                    continue
                estimated.append(entry["name"])
            usd += value * entry["quantity"]
            priced += entry["quantity"]
        rows.append(
            {
                "id": deck["id"],
                "title": deck["title"],
                "usd": round(usd, 2),
                "cards_priced": priced,
                "basic_lands": basics,
                "lowest_printing": estimated,
                "unpriced": unpriced,
            }
        )
        print(f"{deck['title']}: ${usd:,.2f} for {priced} cards ({len(unpriced)} unpriced)")
    content = {
        "as_of": date.today().isoformat(),
        "currency": "USD",
        "source": "Scryfall (TCGplayer market prices) for each card's chosen printing",
        "note": "The market value of the cards each starter deck grants, basic lands left out: "
        "inputs for the shop's token price, not trading advice. lowest_printing names the cards "
        "whose chosen printing has no price, priced at their cheapest printing instead.",
        "decks": rows,
    }
    OUT.write_text(json.dumps(content, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"Wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
