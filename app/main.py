"""LinkLab — URL Shortener Service.

One FastAPI process serves the web UI (static files), the JSON API, and the
short-link redirects, backed by an in-memory SQLite database.

Run locally:  uvicorn app.main:app --reload
"""

from __future__ import annotations

import html
import io
import logging
import mimetypes
import os
import sqlite3
from collections.abc import Callable
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import segno
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import services
from .database import Database, DatabaseUnavailable
from .models import ALIAS_PATTERN, ErrorOut, Health, LinkList, LinkOut, ShortenRequest, Summary
from .ratelimit import RateLimiter

logger = logging.getLogger("uvicorn.error")  # shows up in the Uvicorn / container logs

STATIC_DIR = Path(__file__).parent / "static"
mimetypes.add_type("font/woff2", ".woff2")  # not in every OS mime table (e.g. slim images)
API_VERSION = "2.0.0"

# Pages we serve ourselves get a strict CSP. Swagger UI (/docs) and ReDoc load
# their assets from a CDN, so they are left with FastAPI's defaults.
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; "
    "form-action 'self'"
)
CSP_EXEMPT_PREFIXES = ("/docs", "/redoc")

ERROR_RESPONSES = {404: {"model": ErrorOut, "description": "Short code not found"}}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def create_app(
    *,
    clock: Callable[[], datetime] = _utcnow,
    rate_limit_per_minute: int | None = None,
    public_base_url: str | None = None,
    code_factory: Callable[[], str] = services.generate_code,
) -> FastAPI:
    """Build an application instance. Each instance owns its own, fresh
    in-memory database, which is what lets the tests run in isolation."""

    if rate_limit_per_minute is None:
        rate_limit_per_minute = _env_int("RATE_LIMIT_PER_MINUTE", 30)
    if public_base_url is None:
        public_base_url = os.environ.get("PUBLIC_BASE_URL", "")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.db.open()
        logger.info("In-memory SQLite database initialised")
        try:
            yield
        finally:
            app.state.db.close()
            logger.info("In-memory SQLite database closed; all links discarded")

    app = FastAPI(
        title="LinkLab — URL Shortener Service",
        description=(
            "A minimal service that maps long URLs to short aliases and redirects visitors. "
            "Data is stored in an **in-memory SQLite** database inside a single container, "
            "so all links are lost when the process restarts."
        ),
        version=API_VERSION,
        lifespan=lifespan,
    )
    app.state.db = Database()
    app.state.clock = clock
    app.state.code_factory = code_factory
    app.state.rate_limiter = RateLimiter(rate_limit_per_minute)
    app.state.public_base_url = public_base_url.rstrip("/")

    def base_url(request: Request) -> str:
        return request.app.state.public_base_url or str(request.base_url).rstrip("/")

    def link_out(request: Request, row: sqlite3.Row) -> dict:
        return services.row_to_link(row, base_url(request), request.app.state.clock())

    # ------------------------------------------------------------------ errors

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = []
        for err in exc.errors():
            message = str(err.get("msg", "Invalid value")).removeprefix("Value error, ")
            loc = [str(part) for part in err.get("loc", ()) if part not in ("body", "query", "path")]
            errors.append({"field": ".".join(loc) or None, "message": message})
        first = errors[0] if errors else {"field": None, "message": "Invalid request"}
        detail = first["message"] if first["field"] in (None, "url", "custom_alias") else (
            f"{first['field']}: {first['message']}"
        )
        return JSONResponse(status_code=422, content={"detail": detail, "errors": errors})

    @app.exception_handler(DatabaseUnavailable)
    async def database_unavailable(_: Request, __: DatabaseUnavailable) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": "Database is temporarily unavailable. Try again shortly."})

    @app.exception_handler(sqlite3.OperationalError)
    async def database_operational_error(_: Request, exc: sqlite3.OperationalError) -> JSONResponse:
        logger.exception("SQLite operational error", exc_info=exc)
        return JSONResponse(status_code=503, content={"detail": "Database is temporarily unavailable. Try again shortly."})

    @app.exception_handler(Exception)
    async def unexpected_error(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled error", exc_info=exc)
        return JSONResponse(status_code=500, content={"detail": "Internal server error"})

    # --------------------------------------------------------------- middleware

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        if not request.url.path.startswith(CSP_EXEMPT_PREFIXES):
            response.headers.setdefault("Content-Security-Policy", CSP)
        return response

    # ------------------------------------------------------------------ system

    @app.get("/health", response_model=Health, tags=["system"], summary="Service and database health",
             responses={503: {"model": Health, "description": "Database unavailable"}})
    def health(request: Request):
        db: Database = request.app.state.db
        try:
            links = services.count_links(db)  # a real query against SQLite
            storage = "sqlite-in-memory" if db.is_in_memory() else "sqlite-file"
        except (DatabaseUnavailable, sqlite3.Error):
            return JSONResponse(
                status_code=503,
                content={"status": "unavailable", "database": "unavailable", "storage": "sqlite-in-memory", "links": 0},
            )
        return {"status": "ok", "database": "ok", "storage": storage, "links": links}

    # ------------------------------------------------------------------- links

    @app.post(
        "/shorten",
        response_model=LinkOut,
        status_code=201,
        tags=["links"],
        summary="Create a short link",
        responses={
            400: {"model": ErrorOut, "description": "URL points at this service"},
            409: {"model": ErrorOut, "description": "Custom alias already taken"},
            422: {"description": "Invalid URL, alias or expiry"},
            429: {"model": ErrorOut, "description": "Rate limit exceeded"},
            503: {"model": ErrorOut, "description": "Database unavailable or no free code"},
        },
    )
    def shorten(payload: ShortenRequest, request: Request):
        client = request.client.host if request.client else "unknown"
        retry_after = request.app.state.rate_limiter.check(client)
        if retry_after is not None:
            raise HTTPException(
                status_code=429,
                detail="Too many links created in a short time. Please wait a minute and try again.",
                headers={"Retry-After": str(max(1, round(retry_after)))},
            )

        own_host = urlsplit(base_url(request)).netloc.lower()
        if urlsplit(payload.url).netloc.lower() == own_host:
            raise HTTPException(status_code=400, detail="Links that point to this service itself cannot be shortened.")

        try:
            row = services.create_link(
                request.app.state.db,
                payload.url,
                now=request.app.state.clock(),
                custom_alias=payload.custom_alias,
                expires_in_minutes=payload.expires_in_minutes,
                code_factory=request.app.state.code_factory,
            )
        except services.AliasTaken:
            raise HTTPException(status_code=409, detail=f"The alias '{payload.custom_alias}' is already taken.") from None
        except services.CodeGenerationFailed:
            logger.error("Could not generate a unique short code")
            raise HTTPException(status_code=503, detail="Could not generate a unique short code. Please try again.") from None
        return link_out(request, row)

    @app.get("/urls", response_model=LinkList, tags=["links"], summary="List stored links (newest first)")
    def list_urls(request: Request, limit: int = Query(500, ge=1, le=1000, description="Maximum links to return")):
        total, rows = services.list_links(request.app.state.db, limit)
        return {"total": total, "items": [link_out(request, row) for row in rows]}

    @app.get("/url/{short_code}", response_model=LinkOut, tags=["links"], summary="Get a link's details",
             responses=ERROR_RESPONSES)
    def get_url(short_code: str, request: Request):
        try:
            return link_out(request, services.get_link(request.app.state.db, short_code))
        except services.LinkNotFound:
            raise HTTPException(status_code=404, detail="Short URL not found") from None

    @app.delete("/url/{short_code}", status_code=204, tags=["links"], summary="Delete a link",
                responses=ERROR_RESPONSES)
    def delete_url(short_code: str, request: Request):
        try:
            services.delete_link(request.app.state.db, short_code)
        except services.LinkNotFound:
            raise HTTPException(status_code=404, detail="Short URL not found") from None
        return Response(status_code=204)

    @app.get(
        "/url/{short_code}/qr",
        tags=["links"],
        summary="QR code (SVG) encoding the short URL",
        response_class=Response,
        responses={200: {"content": {"image/svg+xml": {}}}, **ERROR_RESPONSES},
    )
    def qr_code(short_code: str, request: Request):
        try:
            row = services.get_link(request.app.state.db, short_code)
        except services.LinkNotFound:
            raise HTTPException(status_code=404, detail="Short URL not found") from None
        short_url = f"{base_url(request)}/{row['short_code']}"
        buffer = io.BytesIO()
        segno.make(short_url, error="m").save(buffer, kind="svg", scale=8, border=2, dark="#0f172a", light="#ffffff")
        return Response(content=buffer.getvalue(), media_type="image/svg+xml")

    # --------------------------------------------------------------- analytics

    @app.get("/api/analytics/summary", response_model=Summary, tags=["analytics"], summary="Dashboard totals")
    def analytics_summary(request: Request):
        totals, top = services.summary(request.app.state.db, request.app.state.clock())
        return {
            "total_links": totals["total_links"],
            "active_links": totals["total_links"] - totals["expired_links"],
            "expired_links": totals["expired_links"],
            "total_clicks": totals["total_clicks"],
            "links_created_24h": totals["links_created_24h"],
            "top_link": link_out(request, top) if top else None,
        }

    # -------------------------------------------------------------- frontend

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/dashboard", include_in_schema=False)
    def dashboard():
        return FileResponse(STATIC_DIR / "dashboard.html")

    @app.get("/how-it-works", include_in_schema=False)
    def how_it_works():
        return FileResponse(STATIC_DIR / "how-it-works.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    # ----------------------------------------------------------------- redirect
    # Registered LAST so that /health, /docs, /urls, /static ... always win.

    @app.get(
        "/{short_code}",
        tags=["redirect"],
        summary="Redirect to the original URL",
        status_code=307,
        response_class=RedirectResponse,
        responses={
            307: {"description": "Temporary redirect to the destination (click recorded)"},
            404: {"model": ErrorOut, "description": "Unknown short code"},
            410: {"model": ErrorOut, "description": "Link has expired"},
        },
    )
    def redirect(short_code: str, request: Request):
        try:
            if not ALIAS_PATTERN.match(short_code):
                raise services.LinkNotFound(short_code)
            destination = services.resolve_redirect(request.app.state.db, short_code, request.app.state.clock())
        except services.LinkNotFound:
            return _error_page(request, 404, "Link not found",
                               f"No short link uses the alias “{short_code}”. It may have been deleted, "
                               "or the service restarted (links are stored in memory).")
        except services.LinkExpired:
            return _error_page(request, 410, "This link has expired",
                               f"The short link “{short_code}” reached its expiry time and no longer redirects.")
        # 307 = temporary: browsers must come back each time, so every visit is counted.
        return RedirectResponse(destination, status_code=307, headers={"Cache-Control": "no-store"})

    return app


ERROR_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · LinkLab</title>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/styles.css">
<script src="/static/theme.js"></script>
</head>
<body class="status-page">
<main class="status-card">
  <svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect class="logo-bg" width="32" height="32" rx="8"/><path class="logo-fg" d="M13.6 18.4a4 4 0 0 0 5.66 0l2.83-2.83a4 4 0 0 0-5.66-5.66l-.71.71M18.4 13.6a4 4 0 0 0-5.66 0l-2.83 2.83a4 4 0 0 0 5.66 5.66l.71-.71" fill="none" stroke-width="2.2" stroke-linecap="round"/><circle class="logo-dot" cx="25" cy="7" r="2.4"/></svg>
  <p class="status-code">HTTP {status}</p>
  <h1>{title}</h1>
  <p>{message}</p>
  <a class="btn btn-primary" href="/">Create a new short link</a>
</main>
</body>
</html>
"""


def _error_page(request: Request, status: int, title: str, message: str) -> Response:
    """HTML page for browsers, JSON for API clients (content negotiation)."""
    if "text/html" in request.headers.get("accept", ""):
        body = ERROR_PAGE.format(status=status, title=html.escape(title), message=html.escape(message))
        return HTMLResponse(body, status_code=status, headers={"Cache-Control": "no-store"})
    detail = "Short URL not found" if status == 404 else "Short URL has expired"
    return JSONResponse(status_code=status, content={"detail": detail})


app = create_app()
