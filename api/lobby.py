"""The live lobby (v0.9.4): Find a game learns at once that the tables changed.

Every signed-in tab already holds the chat's WebSocket (api/chat.py), so the lobby rides on it: when
a commit changes a human table, its seats or its invitations, each open tab gets
``{"type": "lobby", "revision": n}`` and Find a game asks for its page again, with its own filters,
over HTTP. The message carries nothing about any table, so a private table leaks nothing, and the
page's slower polling still catches what this process did not see (the worker's own changes).

The changes are found from the ORM, for every session on the app's database: rows of GameTable,
TableSeat and TableInvite added, changed or deleted in a flush, and ORM update and delete statements
on them. Notices close together are sent as one (COALESCE_SECONDS).
"""

import asyncio
import threading
from collections.abc import Callable
from typing import Any

from sqlalchemy import Delete, Update, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import ORMExecuteState, Session, UOWTransaction

from api.models import GameTable, TableInvite, TableSeat

LOBBY_MODELS = (GameTable, TableSeat, TableInvite)
LOBBY_TABLES = frozenset(model.__tablename__ for model in LOBBY_MODELS)
COALESCE_SECONDS = 0.25
CHANGED = "commander_duels_lobby_changed"

_listeners: dict[int, tuple[Engine, Callable[[], None]]] = {}
_lock = threading.Lock()
_installed = False


def _bind_of(session: Session) -> Any:
    try:
        return session.get_bind()
    except Exception:  # noqa: BLE001 - an unbound session changes no app's lobby
        return None


def _after_flush(session: Session, _context: UOWTransaction) -> None:
    for instance in (*session.new, *session.dirty, *session.deleted):
        if isinstance(instance, LOBBY_MODELS):
            session.info[CHANGED] = True
            return


def _on_execute(state: ORMExecuteState) -> None:
    statement = state.statement
    if (
        isinstance(statement, Update | Delete)
        and getattr(statement.table, "name", None) in LOBBY_TABLES
    ):
        state.session.info[CHANGED] = True


def _after_commit(session: Session) -> None:
    if not session.info.pop(CHANGED, False):
        return
    bind = _bind_of(session)
    with _lock:
        listeners = [notify for engine, notify in _listeners.values() if engine is bind]
    for notify in listeners:
        notify()


def _after_rollback(session: Session, _previous: Any) -> None:
    session.info.pop(CHANGED, None)


def install() -> None:
    """Listens to every session, once per process."""
    global _installed
    with _lock:
        if _installed:
            return
        _installed = True
    event.listen(Session, "after_flush", _after_flush)
    event.listen(Session, "do_orm_execute", _on_execute)
    event.listen(Session, "after_commit", _after_commit)
    event.listen(Session, "after_soft_rollback", _after_rollback)


def subscribe(database: Engine, notify: Callable[[], None]) -> Callable[[], None]:
    """Calls notify, from the committing thread, after each commit on the database that changed
    the lobby. Returns the unsubscriber."""
    install()
    key = id(notify)
    with _lock:
        _listeners[key] = (database, notify)

    def unsubscribe() -> None:
        with _lock:
            _listeners.pop(key, None)

    return unsubscribe


class LobbyNotices:
    """Sends the lobby's notice to every open tab, at most once per COALESCE_SECONDS."""

    def __init__(self, loop: asyncio.AbstractEventLoop, send_all: Callable[[dict[str, Any]], None]):
        self.loop = loop
        self.send_all = send_all
        self.revision = 0
        self.pending = False

    def changed(self) -> None:
        """From any thread."""
        try:
            self.loop.call_soon_threadsafe(self._schedule)
        except RuntimeError:
            # The loop has closed: the API is stopping.
            pass

    def _schedule(self) -> None:
        self.revision += 1
        if self.pending:
            return
        self.pending = True
        self.loop.call_later(COALESCE_SECONDS, self._send)

    def _send(self) -> None:
        self.pending = False
        self.send_all({"type": "lobby", "revision": self.revision})
