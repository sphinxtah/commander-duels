"""Imports the test slice of Scryfall's bulk data (tests/fixtures) as a catalog revision, for the
browser journeys: CI's database has no catalog, and the journeys must not download Scryfall's.

    python scripts/load_fixture_catalog.py            # into CD_DATABASE_URL
    python scripts/load_fixture_catalog.py /fixtures  # from another folder (inside a container)

The engine's list for the same cards (engine_implementations.json) decides which are playable.
A database that already holds a catalog is left alone.

The shop's test collation comes with it (v0.4.0): mtgjson/ZNR.json, a made-up set file whose
Zendikar Rising draft booster draws from the same cards, read as the booster data job reads
MTGJSON's. A database that holds a collation already is left alone.

The basic land packs (v0.6.4, api/lands.py) are built from the same catalog and taken off sale:
the shop's journey needs the test booster alone on the shelf, so the weekly sale holds it.
"""

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from api.config import Settings
from api.database import build_engine
from api.lands import ORIGIN, ensure_land_packs
from api.models import BoosterCollation, CatalogRevision, ShopProduct
from catalog import boosters, engine_export
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
    settings = Settings()
    engine = build_engine(settings.database_url)
    with Session(engine) as session, session.begin():
        if session.scalar(select(CatalogRevision.id).limit(1)) is not None:
            print("The database holds a catalog already; nothing imported.")
        else:
            engine_export.store(session, export)
            cards = EngineCards.load(session, str(export["build"]))
            validated = validate(sources, Limits(), {})
            applied = Apply(session, sources, Limits(), cards, datetime.now(UTC)).run(
                validated, None, {}
            )
            playable = playable_count(session)
            print(f"Catalog revision {applied.revision_id}: {playable} playable cards.")
    with Session(engine) as session:
        collated = (
            session.scalar(
                select(BoosterCollation.id)
                .join(ShopProduct, ShopProduct.id == BoosterCollation.product_id)
                .where(ShopProduct.origin != ORIGIN)
                .limit(1)
            )
            is not None
        )
    if collated:
        print("The database holds booster data already; nothing collated.")
    else:
        counts = boosters.load_local(engine, folder / "mtgjson", settings.content_dir)
        print(f"Booster data: {counts['ready']} product ready, {counts['unresolved']} unresolved.")
    ensure_land_packs(engine)
    with Session(engine) as session, session.begin():
        session.execute(
            update(ShopProduct)
            .where(ShopProduct.origin == ORIGIN)
            .values(on_sale=False, sale_reason="Off the browser journeys' shelf")
        )
    print("Basic land packs built and taken off sale.")


if __name__ == "__main__":
    main(sys.argv[1:])
