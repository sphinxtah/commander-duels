"""Which of the Godlike tier's custom cards the running engine has loaded (v0.4.0).

The public engine image knows XMage's cards only. The owner's private image adds the custom cards
as a plugin and rebuilds its card database with them (docs/engine/xmage-spike.md, Plugins), so a
custom card is playable only where the running engine knows its exact name (case aside, as the
engine reads deck lists). The API asks the engine's card search, the service route behind SysOp's
deck lists (GET /v1/service/cards), once for each custom card's name.

The answers are kept for one engine start: while the engine's /health describes the same card
database (its XMage build, card counts and implementation list), checked at most every 30 seconds.
An engine started on another image, or one that refuses a game for an unknown card, is asked
again. Games ask afresh before they start. The names come from the custom_cards table; nothing
here names a card.
"""

import asyncio
import json
import time
from collections.abc import Callable, Iterable
from typing import Protocol, cast

import httpx
from starlette.requests import HTTPConnection

# How long one look at the engine's /health stands for its current start.
START_SECONDS = 30.0
SEARCH_LIMIT = 50
SERVICE_HEADER = "X-Service-Token"


class Engine(Protocol):
    """What this needs of api.games.EngineClient."""

    base_url: str
    token: str
    client: httpx.AsyncClient


class EngineCards:
    """The answers for the running engine, by name (case aside). One per API process."""

    def __init__(self, engine: Engine | None) -> None:
        self.engine = engine
        self.lock = asyncio.Lock()
        # The engine start the answers belong to, and when it was last looked at.
        self.start: str | None = None
        self.seen = -float("inf")
        self.known: dict[str, bool] = {}
        # Replaced in tests.
        self.clock: Callable[[], float] = time.monotonic

    def forget(self) -> None:
        """Asks everything again: the engine refused a name it was thought to know."""
        self.start, self.seen, self.known = None, -float("inf"), {}

    async def current_start(self, fresh: bool) -> str | None:
        """The engine's card database as its /health describes it, or None when the engine is
        not ready or cannot say."""
        if not fresh and self.clock() - self.seen < START_SECONDS and self.start is not None:
            return self.start
        assert self.engine is not None
        try:
            response = await self.engine.client.get(f"{self.engine.base_url}/health", timeout=3.0)
            health = response.json() if response.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            health = None
        if not isinstance(health, dict) or health.get("status") != "ready":
            return None
        self.seen = self.clock()
        return json.dumps(
            {key: health.get(key) for key in ("xmage", "cards", "implementations")},
            sort_keys=True,
        )

    async def ask(self, name: str) -> bool | None:
        """Whether the engine knows the name; None when it cannot be asked."""
        assert self.engine is not None
        try:
            response = await self.engine.client.get(
                f"{self.engine.base_url}/v1/service/cards",
                params={"q": name, "limit": SEARCH_LIMIT},
                headers={SERVICE_HEADER: self.engine.token},
                timeout=5.0,
            )
            found = response.json() if response.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            return None
        names = found.get("names") if isinstance(found, dict) else None
        if not isinstance(names, list):
            return None
        wanted = name.casefold()
        return any(isinstance(each, str) and each.casefold() == wanted for each in names)

    async def loaded(self, names: Iterable[str], *, fresh: bool = False) -> dict[str, bool] | None:
        """By name (case aside), whether the running engine has loaded each card; None when the
        engine is not set up or cannot be asked. fresh asks the engine again, for a game's start."""
        if self.engine is None:
            return None
        wanted = {name.casefold(): name for name in names}
        async with self.lock:
            start = await self.current_start(fresh)
            if start is None or start != self.start:
                self.known = {}
            self.start = start
            answers: dict[str, bool] = {}
            for key, name in wanted.items():
                known = None if fresh or start is None else self.known.get(key)
                if known is None:
                    known = await self.ask(name)
                    if known is None:
                        return None
                    if start is not None:
                        self.known[key] = known
                answers[key] = known
            return answers


def engine_cards_of(conn: HTTPConnection) -> EngineCards | None:
    return cast(EngineCards | None, getattr(conn.app.state, "engine_cards", None))
