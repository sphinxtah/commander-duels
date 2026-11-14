"""Counts an operator reads (v0.9.13, the specification's section 15; docs/operations.md).

What the API refused and what it could not settle, counted in this process since it started, beside
the engine's own numbers for recordings, recovery and the bots' budgets (docs/engine/isolation.md).
One process runs the games (api/games.py), so one set of counts is the site's; a restart starts
them again, and ``since`` says when.

A count has a name and labels, and a label is a code the API already answers with, a status or a
workflow's name: never an account, a game, a deck or a card. An operator reads how often something
went wrong and of what kind, and nothing concealed.

- ``access.refused``: a request refused for who asked: 401 and 403 by their code, a game's socket
  closed for the same, a timeline asked for by an account with no view of the game, access that
  could not be given (api/access.py), a workflow that is not rolled out (api/rollout.py).
- ``settlement.retried``: a write that must land waited for the database (api/games.py retried).
- ``settlement.failed``: a game's end could not be recorded as it ended, by how far it fell back:
  ``recorded_interrupted`` (no result, nothing paid), ``forced`` (the game alone marked
  interrupted), ``lost`` (not even that; the restart's sweep takes it).
- ``settlement.recorded``: a game's end recorded, by its status, for the rate.
"""

import threading
from datetime import UTC, datetime

from pydantic import Field

from api.schemas import Contract


class Count(Contract):
    name: str
    labels: dict[str, str] = Field(description="Codes, statuses and workflow names only.")
    count: int


class Counters:
    """Counts by name and labels. Routes run in the thread pool, so adding takes a lock."""

    def __init__(self) -> None:
        self.since = datetime.now(UTC)
        self.lock = threading.Lock()
        self.counts: dict[tuple[str, tuple[tuple[str, str], ...]], int] = {}

    def count(self, name: str, **labels: str) -> None:
        key = (name, tuple(sorted(labels.items())))
        with self.lock:
            self.counts[key] = self.counts.get(key, 0) + 1

    def read(self, name: str, **labels: str) -> int:
        """The count of a name: every label's when none is given, else of those that match."""
        wanted = set(labels.items())
        with self.lock:
            return sum(
                count
                for (counted, found), count in self.counts.items()
                if counted == name and wanted <= set(found)
            )

    def snapshot(self) -> list[Count]:
        with self.lock:
            counts = sorted(self.counts.items())
        return [
            Count(name=name, labels=dict(labels), count=count) for (name, labels), count in counts
        ]

    def reset(self) -> None:
        with self.lock:
            self.counts.clear()
            self.since = datetime.now(UTC)


COUNTERS = Counters()


def count(name: str, **labels: str) -> None:
    COUNTERS.count(name, **labels)
