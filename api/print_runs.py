"""Print runs (v0.5.1): a printing made in a known, small number of copies is never pulled from
packs more often, across every account, than it was printed (docs/shop.md "Print runs").

The owner asked on 2026-10-23: "make sure you're following the actual counts for releases of
specific cards so they can't be over pulled", with The One Ring's serialized poster (LTR #748z)
as the example, of which 100 were printed. The counts are content/print-runs.json, each with
where it was read: the serialized printings Scryfall lists, with the serial's denominator from
Wizards of the Coast's own collecting articles or the card itself.

A printing's copies dealt are every copy any library was ever granted of it, from packs, starter
decks or a one-of-a-kind grant, before an account's reset too: a copy pulled stays printed. A
copy bought at the auction house (v0.6.0) changed hands, so it is not counted again. A pack
that would deal a copy beyond the run deals another card from the same sheet instead, as for a
card the game cannot play (api/collation.py draw). The check takes a row lock on each limited
printing the pack drew, in a fixed order, so two packs opened at once never both take the last
copy.
"""

import json
from functools import lru_cache
from pathlib import Path
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.models import CardPrinting, LibraryGrant


@lru_cache(maxsize=4)
def runs_in(folder: str) -> dict[UUID, int]:
    """The print runs by Scryfall ID: content/print-runs.json, the printings whose count is known.
    None (the file missing) limits nothing."""
    path = Path(folder) / "print-runs.json"
    if not path.is_file():
        return {}
    listed = json.loads(path.read_text(encoding="utf-8"))["printings"]
    return {
        UUID(item["scryfall_id"]): int(item["copies"])
        for item in listed
        if item.get("copies") is not None
    }


def limited(db: Session, folder: str, printings: set[UUID]) -> dict[UUID, int]:
    """Of these catalog printings, those with a print run: printing ID to copies printed."""
    runs = runs_in(folder)
    if not runs or not printings:
        return {}
    return {
        printing_id: runs[scryfall_id]
        for printing_id, scryfall_id in db.execute(
            select(CardPrinting.id, CardPrinting.scryfall_id).where(
                CardPrinting.id.in_(printings), CardPrinting.scryfall_id.in_(runs)
            )
        )
    }


def dealt(db: Session, printings: set[UUID], lock: bool = False) -> dict[UUID, int]:
    """Copies granted so far of each printing, to every account. With lock, each printing's row
    is locked first (by ID, so two openings always lock in the same order) until the caller's
    transaction ends."""
    if not printings:
        return {}
    if lock:
        db.execute(
            select(CardPrinting.id)
            .where(CardPrinting.id.in_(printings))
            .order_by(CardPrinting.id)
            .with_for_update()
        )
    counted = {printing_id: 0 for printing_id in printings}
    for printing_id, copies in db.execute(
        select(LibraryGrant.printing_id, func.sum(LibraryGrant.quantity))
        .where(LibraryGrant.printing_id.in_(printings), LibraryGrant.source != "auction")
        .group_by(LibraryGrant.printing_id)
    ):
        counted[printing_id] = int(copies or 0)
    return counted
