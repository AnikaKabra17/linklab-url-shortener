"""Business logic. Every SQL statement uses ``?`` placeholders; user input is
never interpolated into SQL text."""

from __future__ import annotations

import secrets
import sqlite3
import string
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from .database import Database
from .models import is_reserved

CODE_ALPHABET = string.ascii_letters + string.digits  # 62 symbols
CODE_LENGTH = 7  # 62**7 ≈ 3.5 trillion possible codes
MAX_CODE_ATTEMPTS = 10

LINK_COLUMNS = "short_code, original_url, created_at, clicks, expires_at"


class AliasTaken(Exception):
    pass


class LinkNotFound(Exception):
    pass


class LinkExpired(Exception):
    pass


class CodeGenerationFailed(Exception):
    pass


def generate_code() -> str:
    """Unpredictable short code from a cryptographically secure RNG."""
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def to_iso(moment: datetime) -> str:
    """Fixed-width UTC timestamp; strings in this format sort chronologically."""
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _is_expired(expires_at: str | None, now_iso: str) -> bool:
    return expires_at is not None and expires_at <= now_iso


def row_to_link(row: sqlite3.Row, base_url: str, now: datetime) -> dict:
    return {
        "short_code": row["short_code"],
        "short_url": f"{base_url}/{row['short_code']}",
        "original_url": row["original_url"],
        "created_at": row["created_at"],
        "clicks": row["clicks"],
        "expires_at": row["expires_at"],
        "is_expired": _is_expired(row["expires_at"], to_iso(now)),
    }


def _is_primary_key_clash(error: sqlite3.IntegrityError) -> bool:
    return "UNIQUE constraint failed" in str(error)


def create_link(
    db: Database,
    original_url: str,
    now: datetime,
    custom_alias: str | None = None,
    expires_in_minutes: int | None = None,
    code_factory: Callable[[], str] = generate_code,
) -> sqlite3.Row:
    """Insert a new mapping. The PRIMARY KEY on short_code is what guarantees
    uniqueness; the INSERT itself detects clashes, so there is no
    check-then-insert race."""
    created_at = to_iso(now)
    expires_at = to_iso(now + timedelta(minutes=expires_in_minutes)) if expires_in_minutes else None
    insert = "INSERT INTO urls (short_code, original_url, created_at, expires_at) VALUES (?, ?, ?, ?)"

    if custom_alias:
        candidates = [custom_alias]
    else:
        candidates = (code_factory() for _ in range(MAX_CODE_ATTEMPTS))

    with db.session() as conn:
        for code in candidates:
            if not custom_alias and is_reserved(code):
                continue
            try:
                conn.execute(insert, (code, original_url, created_at, expires_at))
            except sqlite3.IntegrityError as error:
                if not _is_primary_key_clash(error):
                    raise
                if custom_alias:
                    raise AliasTaken(custom_alias) from None
                continue  # random collision: try another code
            return conn.execute(
                f"SELECT {LINK_COLUMNS} FROM urls WHERE short_code = ?", (code,)
            ).fetchone()

    raise CodeGenerationFailed(f"no free code after {MAX_CODE_ATTEMPTS} attempts")


def get_link(db: Database, code: str) -> sqlite3.Row:
    with db.session() as conn:
        row = conn.execute(f"SELECT {LINK_COLUMNS} FROM urls WHERE short_code = ?", (code,)).fetchone()
    if row is None:
        raise LinkNotFound(code)
    return row


def list_links(db: Database, limit: int) -> tuple[int, list[sqlite3.Row]]:
    with db.session() as conn:
        total = conn.execute("SELECT COUNT(*) FROM urls").fetchone()[0]
        rows = conn.execute(
            f"SELECT {LINK_COLUMNS} FROM urls ORDER BY created_at DESC, rowid DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return total, rows


def delete_link(db: Database, code: str) -> None:
    with db.session() as conn:
        deleted = conn.execute("DELETE FROM urls WHERE short_code = ?", (code,)).rowcount
    if deleted == 0:
        raise LinkNotFound(code)


def resolve_redirect(db: Database, code: str, now: datetime) -> str:
    """Return the destination and count ONE click, atomically.

    Lookup, expiry check and click increment run in one locked transaction,
    so concurrent visits can neither lose increments nor count an expired hit.
    """
    with db.session() as conn:
        row = conn.execute(
            "SELECT original_url, expires_at FROM urls WHERE short_code = ?", (code,)
        ).fetchone()
        if row is None:
            raise LinkNotFound(code)
        if _is_expired(row["expires_at"], to_iso(now)):
            raise LinkExpired(code)
        conn.execute("UPDATE urls SET clicks = clicks + 1 WHERE short_code = ?", (code,))
        return row["original_url"]


def summary(db: Database, now: datetime) -> tuple[sqlite3.Row, sqlite3.Row | None]:
    now_iso = to_iso(now)
    day_ago = to_iso(now - timedelta(hours=24))
    with db.session() as conn:
        totals = conn.execute(
            """
            SELECT COUNT(*)                                                   AS total_links,
                   COALESCE(SUM(clicks), 0)                                   AS total_clicks,
                   COALESCE(SUM(expires_at IS NOT NULL AND expires_at <= ?), 0) AS expired_links,
                   COALESCE(SUM(created_at >= ?), 0)                          AS links_created_24h
            FROM urls
            """,
            (now_iso, day_ago),
        ).fetchone()
        top = conn.execute(
            f"SELECT {LINK_COLUMNS} FROM urls WHERE clicks > 0 "
            "ORDER BY clicks DESC, created_at ASC LIMIT 1"
        ).fetchone()
    return totals, top


def count_links(db: Database) -> int:
    with db.session() as conn:
        return conn.execute("SELECT COUNT(*) FROM urls").fetchone()[0]
