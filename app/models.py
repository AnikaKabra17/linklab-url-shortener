"""Request/response schemas and input validation rules."""

from __future__ import annotations

import ipaddress
import re
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator

MAX_URL_LENGTH = 2048
MAX_EXPIRY_MINUTES = 365 * 24 * 60  # one year

ALIAS_PATTERN = re.compile(r"^[A-Za-z0-9_-]{3,30}$")

# Single-segment paths the app itself uses (or may plausibly use). A short code
# lives at /{code}, so these may never be handed out as aliases or random codes.
# Compared case-insensitively.
RESERVED_CODES = frozenset(
    {
        "api", "app", "admin", "assets", "docs", "redoc", "openapi", "health",
        "healthz", "static", "shorten", "url", "urls", "favicon", "robots",
        "sitemap", "index", "login", "logout", "about", "help", "dashboard",
        "how-it-works", "architecture",
    }
)

_HOST_LABEL = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")
_FORBIDDEN_CHARS = re.compile(r"[\s\x00-\x1f\x7f<>\"\\^`{|}]")


def is_reserved(code: str) -> bool:
    return code.lower() in RESERVED_CODES


def _valid_hostname(host: str) -> bool:
    """Accept IP addresses, `localhost`, or dotted DNS names (IDN allowed)."""
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    if host == "localhost":
        return True
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return False
    labels = ascii_host.rstrip(".").split(".")
    if len(labels) < 2 or len(ascii_host) > 253:
        return False
    if not all(_HOST_LABEL.match(label) for label in labels):
        return False
    return not labels[-1].isdigit()  # "1.2.3.999" is not a valid host


def validate_destination(value: str) -> str:
    """Validate a destination URL and return it, trimmed but otherwise unchanged.

    Nothing is fetched: validation is purely syntactic. Path, query string and
    fragment are stored exactly as submitted.
    """
    url = value.strip()
    if not url:
        raise ValueError("Enter a URL to shorten.")
    if len(url) > MAX_URL_LENGTH:
        raise ValueError(f"URL is too long (maximum {MAX_URL_LENGTH} characters).")
    if _FORBIDDEN_CHARS.search(url):
        raise ValueError("URL contains spaces or characters that are not allowed; percent-encode them.")

    try:
        parts = urlsplit(url)
        port = parts.port  # raises ValueError for an invalid port
    except ValueError:
        raise ValueError("URL is malformed.") from None

    if not parts.scheme or (parts.scheme.lower() not in {"http", "https"} and "://" not in url and "." in parts.scheme):
        raise ValueError("Include the scheme at the start, e.g. https://example.com/page.")
    if parts.scheme.lower() not in {"http", "https"}:
        raise ValueError("Only http:// and https:// URLs can be shortened.")
    if not parts.netloc or not parts.hostname:
        raise ValueError("URL must include a hostname, e.g. https://example.com/page.")
    if parts.username is not None or parts.password is not None:
        raise ValueError("URLs containing a username or password are not allowed.")
    if not _valid_hostname(parts.hostname):
        raise ValueError(f"'{parts.hostname}' is not a valid hostname.")
    if port == 0:
        raise ValueError("URL has an invalid port.")
    return url


class ShortenRequest(BaseModel):
    url: str = Field(
        ...,
        description="Destination URL (http or https, max 2048 characters).",
        examples=["https://example.com/a/very/long/path?with=query"],
    )
    custom_alias: str | None = Field(
        default=None,
        description="Optional alias: 3-30 letters, digits, '-' or '_'. Case-sensitive.",
        examples=["spring-sale"],
    )
    expires_in_minutes: int | None = Field(
        default=None,
        ge=1,
        le=MAX_EXPIRY_MINUTES,
        strict=True,  # reject true/false and "1440" instead of silently coercing them
        description="Optional lifetime in minutes (1 to 525600). Omit for a link that never expires.",
        examples=[1440],
    )

    @field_validator("url")
    @classmethod
    def _check_url(cls, value: str) -> str:
        return validate_destination(value)

    @field_validator("custom_alias")
    @classmethod
    def _check_alias(cls, value: str | None) -> str | None:
        if value is None:
            return None
        alias = value.strip()
        if not alias:
            return None  # an empty field in a form means "no alias"
        if not ALIAS_PATTERN.match(alias):
            raise ValueError(
                "Alias must be 3-30 characters using only letters, numbers, hyphens or underscores."
            )
        if is_reserved(alias):
            raise ValueError(f"'{alias}' is reserved by the service; choose another alias.")
        return alias


class LinkOut(BaseModel):
    short_code: str
    short_url: str
    original_url: str
    created_at: str = Field(description="ISO-8601 UTC timestamp")
    clicks: int
    expires_at: str | None = Field(description="ISO-8601 UTC timestamp, or null if the link never expires")
    is_expired: bool


class LinkList(BaseModel):
    total: int = Field(description="Number of links stored in the database (active + expired)")
    items: list[LinkOut]


class Summary(BaseModel):
    total_links: int = Field(description="All mappings currently stored in SQLite (active + expired)")
    active_links: int = Field(description="Stored links that have not expired and will redirect")
    expired_links: int = Field(description="Stored links past their expiry time; they no longer redirect")
    total_clicks: int = Field(description="Sum of recorded redirects across all stored links")
    links_created_24h: int = Field(description="Links created during the last 24 hours")
    top_link: LinkOut | None = Field(description="Most-clicked stored link, or null when no link has clicks")


class Health(BaseModel):
    status: str
    database: str
    storage: str
    links: int


class ErrorOut(BaseModel):
    detail: str
