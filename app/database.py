"""In-memory SQLite storage.

The whole application shares ONE ``sqlite3`` connection to a ``:memory:``
database. An in-memory database lives inside that connection, so every request
must use the same connection to see the same data.

FastAPI runs ordinary ``def`` endpoints in a thread pool, which means several
requests can touch the database at the same time. A ``sqlite3.Connection`` is
not safe to use from several threads at once, so every access goes through
``Database.session()``, which:

1. acquires a process-wide lock (one database operation at a time), and
2. opens a transaction that is committed on success or rolled back on error.

Queries are tiny, so serialising them costs nothing noticeable for this
project and keeps related reads and writes (e.g. "check expiry, then count
the click") atomic.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager

# Deliberately NOT configurable: the specification requires an in-memory
# database, so there is no way to silently switch to a file or remote server.
IN_MEMORY = ":memory:"

SCHEMA = """
CREATE TABLE IF NOT EXISTS urls (
    short_code   TEXT    PRIMARY KEY
                         CHECK (length(short_code) BETWEEN 3 AND 30),
    original_url TEXT    NOT NULL
                         CHECK (length(original_url) BETWEEN 1 AND 2048),
    created_at   TEXT    NOT NULL,              -- ISO-8601 UTC, e.g. 2026-01-31T09:15:00Z
    clicks       INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
    expires_at   TEXT,                          -- NULL = never expires
    CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_urls_created_at ON urls (created_at);
"""


class DatabaseUnavailable(RuntimeError):
    """Raised when the database is not open (startup not finished / shut down)."""


class Database:
    def __init__(self) -> None:
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.Lock()

    @property
    def is_open(self) -> bool:
        return self._conn is not None

    def open(self) -> None:
        """Create the in-memory database and its schema (called on startup)."""
        with self._lock:
            if self._conn is not None:
                return
            # check_same_thread=False is safe here only because self._lock
            # guarantees that one thread at a time uses the connection.
            conn = sqlite3.connect(IN_MEMORY, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.executescript(SCHEMA)
            self._conn = conn

    def close(self) -> None:
        """Close the connection; this destroys all stored links (called on shutdown)."""
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    @contextmanager
    def session(self) -> Iterator[sqlite3.Connection]:
        """Exclusive access to the connection inside a single transaction."""
        with self._lock:
            if self._conn is None:
                raise DatabaseUnavailable("Database is not available")
            # `with connection` commits on success and rolls back on exception.
            with self._conn:
                yield self._conn

    def is_in_memory(self) -> bool:
        """True when the main database has no backing file (i.e. it is :memory:)."""
        with self.session() as conn:
            for row in conn.execute("PRAGMA database_list"):
                if row["name"] == "main":
                    return row["file"] == ""
        return False
