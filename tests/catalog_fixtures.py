"""A slice of Scryfall's bulk data (tests/fixtures/scryfall, taken on 2026-10-20) and the engine's
implementation list for the same cards, with helpers that import them into a test database."""

import copy
import gzip
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

from api.models import Base
from catalog import engine_export
from catalog.importer import Applied, Apply, Source, validate
from catalog.scryfall import DATASETS, Limits
from catalog.statuses import EngineCards

FIXTURES = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)


def records(dataset: str) -> list[dict[str, Any]]:
    with gzip.open(FIXTURES / "scryfall" / f"{dataset}.jsonl.gz", "rt", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def engine_list() -> dict[str, Any]:
    return json.loads((FIXTURES / "engine_implementations.json").read_text(encoding="utf-8"))


def write(folder: Path, dataset: str, rows: list[dict[str, Any]]) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{dataset}.jsonl.gz"
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return path


def bulk(**changed: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    data = {dataset: copy.deepcopy(records(dataset)) for dataset in DATASETS}
    data.update(changed)
    return data


def stage(folder: Path, data: dict[str, list[dict[str, Any]]]) -> dict[str, Source]:
    return {
        dataset: Source(dataset, write(folder, dataset, rows), "jsonl")
        for dataset, rows in data.items()
    }


def database(tmp_path: Path) -> Engine:
    engine = create_engine(f"sqlite:///{tmp_path}/catalog.db")
    Base.metadata.create_all(engine)
    return engine


def import_bulk(
    engine: Engine,
    folder: Path,
    data: dict[str, list[dict[str, Any]]],
    export: dict[str, Any] | None = None,
    now: datetime = NOW,
    previous: dict[str, int] | None = None,
) -> Applied:
    sources = stage(folder, data)
    with Session(engine) as session, session.begin():
        cards: EngineCards | None = None
        if export is not None:
            engine_export.store(session, export)
            cards = EngineCards.load(session, str(export["build"]))
        validated = validate(sources, Limits(), previous or {})
        return Apply(session, sources, Limits(), cards, now).run(validated, None, {})


def by_name(rows: list[dict[str, Any]], name: str) -> dict[str, Any]:
    return next(row for row in rows if row["name"] == name)
