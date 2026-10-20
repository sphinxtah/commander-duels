"""The engine's own list of what it implements, fetched once per engine build (CAT09).

The engine image builds the list when it is made: every card name in XMage's database, the
class that implements it, its characteristics and rules text, and the automatic gates it passed.
/health names the build; a build the catalog has not seen is fetched from the service route and
stored, so later syncs read it from the database.
"""

import logging
from typing import Any

import httpx
from sqlalchemy import delete, insert
from sqlalchemy.orm import Session

from api.models import EngineCard
from catalog.importer import batches
from catalog.statuses import EngineCards
from catalog.text import normalize

log = logging.getLogger(__name__)
SERVICE_HEADER = "X-Service-Token"


def build_of(client: httpx.Client, engine_url: str) -> str | None:
    """The build named by the engine's health, or None while the engine is unavailable."""
    try:
        response = client.get(f"{engine_url.rstrip('/')}/health", timeout=5.0)
        response.raise_for_status()
        build = response.json().get("implementations", {}).get("build")
    except (httpx.HTTPError, ValueError, AttributeError):
        return None
    return build if isinstance(build, str) and build else None


def fetch(client: httpx.Client, engine_url: str, token: str) -> dict[str, Any] | None:
    try:
        response = client.get(
            f"{engine_url.rstrip('/')}/v1/service/implementations",
            headers={SERVICE_HEADER: token},
            timeout=120.0,
        )
        response.raise_for_status()
        export = response.json()
    except (httpx.HTTPError, ValueError) as error:
        log.warning("The engine's implementation list could not be fetched: %s", error)
        return None
    if not isinstance(export, dict) or not isinstance(export.get("cards"), list):
        log.warning("The engine's implementation list has an unknown shape")
        return None
    return export


def rows(export: dict[str, Any]) -> list[dict[str, Any]]:
    build = str(export["build"])
    found: dict[str, dict[str, Any]] = {}
    for card in export["cards"]:
        if not isinstance(card, dict) or not isinstance(card.get("name"), str):
            continue
        gates = card.get("gates") if isinstance(card.get("gates"), dict) else {}
        found[card["name"]] = {
            "engine_build": build,
            "name": card["name"],
            "normalized_name": normalize(card["name"]),
            "class_name": str(card.get("class", "")),
            "kind": str(card.get("kind", "normal"))[:16],
            "data": {
                key: card[key]
                for key in (
                    "mana_cost",
                    "types",
                    "subtypes",
                    "supertypes",
                    "power",
                    "toughness",
                    "loyalty",
                    "defense",
                    "rules",
                    "faces",
                    "set",
                    "number",
                )
                if key in card
            },
            "gates": gates,
            "passed": bool(card.get("passed")),
        }
    return list(found.values())


def store(session: Session, export: dict[str, Any]) -> None:
    """Replaces the stored list with this build's; a rolled-back engine is fetched again."""
    session.execute(delete(EngineCard))
    for batch in batches(rows(export)):
        session.execute(insert(EngineCard), batch)


def load(
    session: Session, client: httpx.Client, engine_url: str, token: str
) -> tuple[EngineCards | None, str | None]:
    """The engine's implementations and why they are missing, if they are."""
    build = build_of(client, engine_url)
    if build is None:
        return None, "engine_unavailable"
    cards = EngineCards.load(session, build)
    if cards is not None:
        return cards, None
    if not token:
        return None, "engine_service_off"
    export = fetch(client, engine_url, token)
    if export is None or str(export.get("build")) != build:
        return None, "engine_list_unavailable"
    store(session, export)
    return EngineCards.load(session, build), None
