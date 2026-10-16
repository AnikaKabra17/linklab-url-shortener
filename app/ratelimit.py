"""A tiny sliding-window rate limiter kept in process memory.

Limitations (by design, to stay within one container and no extra services):
- counters live in this process only and reset when it restarts;
- clients are identified by the connecting IP, so users behind the same
  proxy/NAT share a budget, and behind a reverse proxy the proxy's IP is seen
  unless Uvicorn is told to trust forwarded headers (FORWARDED_ALLOW_IPS).
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable


class RateLimiter:
    def __init__(self, limit: int, window_seconds: float = 60.0, clock: Callable[[], float] = time.monotonic):
        self.limit = limit
        self.window = window_seconds
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self.limit > 0

    def check(self, key: str) -> float | None:
        """Record a hit for `key`. Returns None if allowed, otherwise the
        number of seconds until the next request would be allowed."""
        if not self.enabled:
            return None
        now = self._clock()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and hits[0] <= now - self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                return max(hits[0] + self.window - now, 0.0)
            hits.append(now)
            if len(self._hits) > 10_000:  # keep memory bounded
                self._prune(now)
            return None

    def _prune(self, now: float) -> None:
        for key in [k for k, v in self._hits.items() if not v or v[-1] <= now - self.window]:
            del self._hits[key]
