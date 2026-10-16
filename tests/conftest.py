from __future__ import annotations

from collections.abc import Iterator
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.main import create_app


class FakeClock:
    """Controllable 'now' so expiry can be tested without sleeping."""

    def __init__(self) -> None:
        self.now = datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **kwargs: float) -> None:
        self.now += timedelta(**kwargs)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def make_client(clock: FakeClock):
    """Factory: every call builds a NEW app with its own fresh in-memory DB.
    Entering TestClient runs the lifespan (DB open); exiting closes it."""
    stack = ExitStack()

    def factory(**kwargs) -> TestClient:
        kwargs.setdefault("clock", clock)
        kwargs.setdefault("rate_limit_per_minute", 0)  # disabled unless a test opts in
        kwargs.setdefault("public_base_url", "")
        return stack.enter_context(TestClient(create_app(**kwargs), follow_redirects=False))

    yield factory
    stack.close()


@pytest.fixture
def client(make_client) -> Iterator[TestClient]:
    yield make_client()
