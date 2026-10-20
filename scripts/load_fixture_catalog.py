"""Imports the test slice of Scryfall's bulk data (tests/fixtures) as a catalog revision, for the
browser journeys: CI's database has no catalog, and the journeys must not download Scryfall's.

    python scripts/load_fixture_catalog.py            # into CD_DATABASE_URL
    python scripts/load_fixture_catalog.py /fixtures  # from another folder (inside a container)

The engine's list for the same cards (engine_implementations.json) decides which are playable.
A database that already holds a catalog is left alone.
"""

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from api.config import Settings
from api.database import build_engine
from api.models import CatalogRevision
from catalog import engine_export
from catalog.importer import Apply, Source, validate
from catalog.scryfall import DATASETS, Limits
from catalog.statuses import EngineCards, playable_count


def main(argv: list[str]) -> None:
    folder = Path(argv[0]) if argv else Path(__file__).parent.parent / "tests" / "fixtures"
    sources = {
        dataset: Source(dataset, folder / "scryfall" / f"{dataset}.jsonl.gz", "jsonl")
        for dataset in DATASETS
    }
    export = json.loads((folder / "engine_implementations.json").read_text(encoding="utf-8"))
    engine = build_engine(Settings().database_url)
    with Session(engine) as session, session.begin():
        if session.scalar(select(CatalogRevision.id).limit(1)) is not None:
            print("The database holds a catalog already; nothing imported.")
            return
        engine_export.store(session, export)
        cards = EngineCards.load(session, str(export["build"]))
        validated = validate(sources, Limits(), {})
        applied = Apply(session, sources, Limits(), cards, datetime.now(UTC)).run(
            validated, None, {}
        )
        playable = playable_count(session)
    print(f"Catalog revision {applied.revision_id}: {playable} playable cards.")


if __name__ == "__main__":
    main(sys.argv[1:])
