from __future__ import annotations

import io
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import segno

from app import services
from app.database import Database, DatabaseUnavailable
from app.main import create_app


def shorten(client, url="https://example.com/some/long/path", **extra):
    return client.post("/shorten", json={"url": url, **extra})


# ----------------------------------------------------------------- 1. health

def test_health_reports_ok_and_in_memory_database(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok", "storage": "sqlite-in-memory", "links": 0}


def test_health_returns_503_when_database_is_closed(client):
    client.app.state.db.close()
    response = client.get("/health")
    assert response.status_code == 503
    assert response.json()["status"] == "unavailable"


def test_api_returns_503_when_database_is_closed(client):
    client.app.state.db.close()
    response = shorten(client)
    assert response.status_code == 503
    assert "unavailable" in response.json()["detail"]


# --------------------------------------------------------------- 2. creation

def test_create_short_link(client):
    response = shorten(client, "https://example.com/a/very/long/page")
    assert response.status_code == 201
    body = response.json()
    assert body["original_url"] == "https://example.com/a/very/long/page"
    assert len(body["short_code"]) == services.CODE_LENGTH
    assert body["short_code"].isalnum()
    assert body["short_url"] == f"http://testserver/{body['short_code']}"
    assert body["clicks"] == 0
    assert body["expires_at"] is None
    assert body["is_expired"] is False
    assert body["created_at"] == "2026-01-15T12:00:00Z"


def test_destination_is_stored_exactly_as_submitted(client):
    url = "https://Example.com/Path/To?b=2&a=1&empty=&q=hello%20world#frag"
    body = shorten(client, f"  {url}  ").json()
    assert body["original_url"] == url
    redirect = client.get(f"/{body['short_code']}")
    assert redirect.headers["location"] == url


def test_bare_domain_is_not_given_a_trailing_slash(client):
    assert shorten(client, "https://example.com").json()["original_url"] == "https://example.com"


def test_public_base_url_is_used_for_short_urls(make_client):
    client = make_client(public_base_url="https://lnk.example/")
    body = shorten(client).json()
    assert body["short_url"] == f"https://lnk.example/{body['short_code']}"


# ----------------------------------------------------------- 3/4. aliases

def test_create_with_custom_alias(client):
    response = shorten(client, custom_alias="my-link_1")
    assert response.status_code == 201
    assert response.json()["short_code"] == "my-link_1"
    assert response.json()["short_url"] == "http://testserver/my-link_1"


def test_duplicate_custom_alias_is_rejected_with_409(client):
    assert shorten(client, custom_alias="promo").status_code == 201
    response = shorten(client, "https://other.example.org", custom_alias="promo")
    assert response.status_code == 409
    assert "already taken" in response.json()["detail"]
    # the original mapping is untouched
    assert client.get("/url/promo").json()["original_url"] == "https://example.com/some/long/path"


def test_aliases_are_case_sensitive(client):
    assert shorten(client, custom_alias="Promo").status_code == 201
    assert shorten(client, custom_alias="promo").status_code == 201


def test_empty_alias_means_random_code(client):
    response = shorten(client, custom_alias="   ")
    assert response.status_code == 201
    assert len(response.json()["short_code"]) == services.CODE_LENGTH


@pytest.mark.parametrize("alias", ["ab", "x" * 31, "has space", "slash/es", "dot.dot", "émoji", "a?b"])
def test_invalid_aliases_are_rejected(client, alias):
    response = shorten(client, custom_alias=alias)
    assert response.status_code == 422
    assert response.json()["errors"][0]["field"] == "custom_alias"


@pytest.mark.parametrize("alias", ["health", "docs", "DOCS", "redoc", "static", "urls", "url", "api", "shorten"])
def test_reserved_aliases_are_rejected(client, alias):
    response = shorten(client, custom_alias=alias)
    assert response.status_code == 422
    assert "reserved" in response.json()["detail"]


# ----------------------------------------------------- 5. random code space

def test_random_codes_are_unique(client):
    codes = {shorten(client, f"https://example.com/{i}").json()["short_code"] for i in range(200)}
    assert len(codes) == 200


def test_random_code_collision_is_retried(make_client):
    sequence = iter(["Taken01", "Taken01", "Fresh02"])
    client = make_client(code_factory=lambda: next(sequence))
    assert shorten(client).json()["short_code"] == "Taken01"
    assert shorten(client).json()["short_code"] == "Fresh02"  # first attempt collided


def test_reserved_word_is_never_issued_as_random_code(make_client):
    sequence = iter(["favicon", "Okcode1"])
    client = make_client(code_factory=lambda: next(sequence))
    assert shorten(client).json()["short_code"] == "Okcode1"


def test_persistent_collisions_give_controlled_error(make_client):
    client = make_client(code_factory=lambda: "Same123")
    assert shorten(client).status_code == 201
    response = shorten(client)
    assert response.status_code == 503
    assert "unique short code" in response.json()["detail"]


def test_generated_codes_use_expected_alphabet():
    for _ in range(100):
        code = services.generate_code()
        assert len(code) == services.CODE_LENGTH
        assert set(code) <= set(services.CODE_ALPHABET)


# ---------------------------------------------------------- 6. validation

@pytest.mark.parametrize(
    "url",
    [
        "",
        "   ",
        "not a url",
        "example.com",
        "ftp://example.com/file",
        "javascript:alert(1)",
        "JAVASCRIPT:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "file:///etc/passwd",
        "mailto:someone@example.com",
        "http://",
        "https:///path-only",
        "https://exa mple.com",
        "https://example.com/has space",
        "https://-bad-.com",
        "https://nodot",
        "https://1.2.3.999",
        "https://user:pass@example.com",
        "https://example.com:99999",
        "https://example.com/" + "a" * 2100,
    ],
)
def test_invalid_urls_are_rejected(client, url):
    response = shorten(client, url)
    assert response.status_code == 422
    body = response.json()
    assert isinstance(body["detail"], str) and body["detail"]
    assert body["errors"][0]["field"] == "url"
    assert client.get("/urls").json()["total"] == 0


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:3000/dev",
        "https://127.0.0.1/admin",
        "https://[2001:db8::1]/v6",
        "https://sub.domain.example.co.uk/x?y=z",
        "https://bücher.example/straße",
        "HTTPS://EXAMPLE.COM/UPPER",
    ],
)
def test_valid_urls_are_accepted(client, url):
    assert shorten(client, url).status_code == 201


@pytest.mark.parametrize("url", ["example.com/page", "example.com:8080/page", "www.example.com"])
def test_missing_scheme_gets_actionable_message(client, url):
    response = shorten(client, url)
    assert response.status_code == 422
    assert "https://" in response.json()["detail"] and "Include the scheme" in response.json()["detail"]


def test_dangerous_scheme_message_is_unchanged(client):
    assert shorten(client, "javascript:alert(1)").json()["detail"] == "Only http:// and https:// URLs can be shortened."


def test_missing_url_field_is_422(client):
    response = client.post("/shorten", json={})
    assert response.status_code == 422
    assert response.json()["errors"][0]["field"] == "url"


@pytest.mark.parametrize("minutes", [0, -5, 525601, "soon", True, "60", 60.5])
def test_invalid_expiry_is_rejected(client, minutes):
    assert shorten(client, expires_in_minutes=minutes).status_code == 422


def test_link_to_the_service_itself_is_rejected(make_client):
    client = make_client(public_base_url="https://lnk.example")
    response = shorten(client, "https://lnk.example/abc")
    assert response.status_code == 400


# -------------------------------------------------------- 7/8. redirects

def test_redirect_to_original_destination(client):
    code = shorten(client, "https://example.com/target?x=1").json()["short_code"]
    response = client.get(f"/{code}")
    assert response.status_code == 307
    assert response.headers["location"] == "https://example.com/target?x=1"
    assert response.headers["cache-control"] == "no-store"


def test_click_count_increments_once_per_redirect(client):
    code = shorten(client, custom_alias="counted").json()["short_code"]
    assert client.get(f"/url/{code}").json()["clicks"] == 0
    for expected in (1, 2, 3):
        assert client.get(f"/{code}").status_code == 307
        assert client.get(f"/url/{code}").json()["clicks"] == expected


def test_reading_details_and_listing_do_not_count_clicks(client):
    shorten(client, custom_alias="quiet")
    client.get("/url/quiet")
    client.get("/urls")
    client.get("/api/analytics/summary")
    client.get("/url/quiet/qr")
    assert client.get("/url/quiet").json()["clicks"] == 0


# ---------------------------------------------------------- 9. not found

def test_unknown_code_returns_json_404(client):
    response = client.get("/doesNotExist")
    assert response.status_code == 404
    assert response.json() == {"detail": "Short URL not found"}


def test_unknown_code_returns_html_page_for_browsers(client):
    response = client.get("/nope-123", headers={"Accept": "text/html,application/xhtml+xml"})
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("text/html")
    assert "Link not found" in response.text


def test_html_error_page_escapes_the_requested_code(client):
    response = client.get("/%3Cscript%3E", headers={"Accept": "text/html"})
    assert response.status_code == 404
    assert "<script>" not in response.text
    assert "&lt;script&gt;" in response.text


def test_details_of_unknown_code_is_404(client):
    assert client.get("/url/missing").status_code == 404


# ------------------------------------------------------------ 10. details

def test_url_details(client):
    shorten(client, "https://example.com/details", custom_alias="info")
    response = client.get("/url/info")
    assert response.status_code == 200
    assert response.json() == {
        "short_code": "info",
        "short_url": "http://testserver/info",
        "original_url": "https://example.com/details",
        "created_at": "2026-01-15T12:00:00Z",
        "clicks": 0,
        "expires_at": None,
        "is_expired": False,
    }


# ------------------------------------------------- 11. listing & analytics

def test_empty_listing_and_summary(client):
    assert client.get("/urls").json() == {"total": 0, "items": []}
    assert client.get("/api/analytics/summary").json() == {
        "total_links": 0, "active_links": 0, "expired_links": 0,
        "total_clicks": 0, "links_created_24h": 0, "top_link": None,
    }


def test_listing_returns_newest_first(client, clock):
    shorten(client, custom_alias="first")
    clock.advance(minutes=1)
    shorten(client, custom_alias="second")
    clock.advance(minutes=1)
    shorten(client, custom_alias="third")
    body = client.get("/urls").json()
    assert body["total"] == 3
    assert [item["short_code"] for item in body["items"]] == ["third", "second", "first"]
    assert client.get("/urls", params={"limit": 2}).json()["total"] == 3
    assert len(client.get("/urls", params={"limit": 2}).json()["items"]) == 2


def test_listing_limit_is_validated(client):
    assert client.get("/urls", params={"limit": 0}).status_code == 422
    assert client.get("/urls", params={"limit": 5000}).status_code == 422


def test_analytics_summary_matches_database(client, clock):
    shorten(client, custom_alias="aaa")
    shorten(client, custom_alias="bbb")
    shorten(client, custom_alias="ccc", expires_in_minutes=10)
    for _ in range(3):
        client.get("/aaa")
    client.get("/bbb")
    client.get("/ccc")

    clock.advance(minutes=11)  # ccc is now expired
    client.get("/ccc")         # refused, must not count
    summary = client.get("/api/analytics/summary").json()
    assert summary["total_links"] == 3
    assert summary["active_links"] == 2
    assert summary["expired_links"] == 1
    assert summary["total_clicks"] == 5
    assert summary["links_created_24h"] == 3
    assert summary["top_link"]["short_code"] == "aaa"
    assert summary["top_link"]["clicks"] == 3

    clock.advance(hours=25)
    assert client.get("/api/analytics/summary").json()["links_created_24h"] == 0


# ----------------------------------------------------------- 12. deletion

def test_delete_link(client):
    shorten(client, custom_alias="gone")
    response = client.delete("/url/gone")
    assert response.status_code == 204
    assert response.content == b""
    assert client.get("/url/gone").status_code == 404
    assert client.get("/gone").status_code == 404
    assert client.delete("/url/gone").status_code == 404
    # the alias can be reused after deletion
    assert shorten(client, custom_alias="gone").status_code == 201


# ------------------------------------------------------------ 13. expiry

def test_expired_link_does_not_redirect(client, clock):
    body = shorten(client, custom_alias="soon", expires_in_minutes=60).json()
    assert body["expires_at"] == "2026-01-15T13:00:00Z"

    clock.advance(minutes=59)
    assert client.get("/soon").status_code == 307

    clock.advance(minutes=1)  # exactly at expiry -> expired
    response = client.get("/soon")
    assert response.status_code == 410
    assert "location" not in response.headers
    assert response.json() == {"detail": "Short URL has expired"}

    html = client.get("/soon", headers={"Accept": "text/html"})
    assert html.status_code == 410
    assert "expired" in html.text

    details = client.get("/url/soon").json()
    assert details["is_expired"] is True
    assert details["clicks"] == 1  # only the accepted redirect was counted


# ------------------------------------------------------------- QR code

def test_qr_code_encodes_the_short_url(client):
    short_url = shorten(client, custom_alias="qr-me").json()["short_url"]
    response = client.get("/url/qr-me/qr")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/svg+xml"
    expected = io.BytesIO()
    segno.make(short_url, error="m").save(expected, kind="svg", scale=8, border=2, dark="#0f172a", light="#ffffff")
    assert response.content == expected.getvalue()
    assert client.get("/url/missing/qr").status_code == 404


# ------------------------------------------------- 14. database lifecycle

def test_database_is_created_on_startup_and_closed_on_shutdown(clock):
    app = create_app(clock=clock, rate_limit_per_minute=0)
    assert not app.state.db.is_open
    from fastapi.testclient import TestClient

    with TestClient(app) as client:
        assert app.state.db.is_open
        assert app.state.db.is_in_memory()
        assert shorten(client).status_code == 201
    assert not app.state.db.is_open
    with pytest.raises(DatabaseUnavailable):
        with app.state.db.session():
            pass


def test_restart_discards_all_links(clock):
    from fastapi.testclient import TestClient

    app = create_app(clock=clock, rate_limit_per_minute=0)
    with TestClient(app) as client:
        shorten(client, custom_alias="ephemeral")
    with TestClient(app) as client:  # "restart": a brand-new in-memory database
        assert client.get("/url/ephemeral").status_code == 404
        assert client.get("/urls").json()["total"] == 0


def test_each_app_instance_has_an_isolated_database(make_client):
    first, second = make_client(), make_client()
    shorten(first, custom_alias="only-here")
    assert first.get("/url/only-here").status_code == 200
    assert second.get("/url/only-here").status_code == 404


def test_no_database_file_is_written(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    shorten(client)
    assert list(Path(tmp_path).iterdir()) == []
    assert not any(name.endswith((".db", ".sqlite", ".sqlite3")) for name in os.listdir(Path(__file__).parents[1]))


def test_schema_constraints():
    db = Database()
    db.open()
    try:
        with pytest.raises(Exception):
            with db.session() as conn:
                conn.execute("INSERT INTO urls (short_code, original_url, created_at) VALUES ('ab', 'x', 't')")
        with pytest.raises(Exception):
            with db.session() as conn:
                conn.execute(
                    "INSERT INTO urls (short_code, original_url, created_at, clicks) VALUES ('abc', 'x', 't', -1)"
                )
    finally:
        db.close()


# ---------------------------------------------------------- 15. concurrency

def test_concurrent_redirects_count_every_click(client):
    shorten(client, custom_alias="busy")
    with ThreadPoolExecutor(max_workers=16) as pool:
        statuses = list(pool.map(lambda _: client.get("/busy").status_code, range(200)))
    assert statuses == [307] * 200
    assert client.get("/url/busy").json()["clicks"] == 200


def test_concurrent_creations_are_all_stored_uniquely(client):
    with ThreadPoolExecutor(max_workers=16) as pool:
        responses = list(pool.map(lambda i: shorten(client, f"https://example.com/{i}"), range(100)))
    assert all(r.status_code == 201 for r in responses)
    codes = {r.json()["short_code"] for r in responses}
    assert len(codes) == 100
    assert client.get("/urls").json()["total"] == 100


def test_concurrent_requests_for_same_alias_allow_exactly_one(client):
    with ThreadPoolExecutor(max_workers=16) as pool:
        statuses = list(pool.map(lambda i: shorten(client, f"https://example.com/{i}", custom_alias="race").status_code,
                                 range(40)))
    assert statuses.count(201) == 1
    assert statuses.count(409) == 39


# ------------------------------------------------------ routing & security

def test_reserved_routes_are_not_treated_as_short_codes(client):
    assert client.get("/health").json()["status"] == "ok"
    assert client.get("/docs").status_code == 200
    assert client.get("/redoc").status_code == 200
    assert client.get("/openapi.json").json()["info"]["title"].startswith("LinkLab")
    assert client.get("/urls").status_code == 200


def test_frontend_is_served(client):
    page = client.get("/")
    assert page.status_code == 200
    assert "LinkLab" in page.text
    for asset, media in [("/static/app.js", "javascript"), ("/static/styles.css", "text/css"),
                         ("/static/favicon.svg", "image/svg+xml")]:
        response = client.get(asset)
        assert response.status_code == 200, asset
        assert media in response.headers["content-type"]


def test_security_headers(client):
    response = client.get("/")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert "default-src 'self'" in response.headers["content-security-policy"]
    # Swagger UI loads assets from a CDN, so it is exempt from the strict CSP
    assert "content-security-policy" not in client.get("/docs").headers


def test_rate_limit_on_link_creation(make_client):
    client = make_client(rate_limit_per_minute=3)
    assert [shorten(client).status_code for _ in range(3)] == [201, 201, 201]
    response = shorten(client)
    assert response.status_code == 429
    assert int(response.headers["retry-after"]) >= 1
    # reads and redirects are not limited
    assert client.get("/urls").status_code == 200


def test_sql_injection_is_inert(client):
    shorten(client, custom_alias="safe")
    response = client.get("/url/x' OR '1'='1")
    assert response.status_code == 404
    assert client.delete("/url/x' OR '1'='1").status_code == 404
    assert client.get("/urls").json()["total"] == 1
