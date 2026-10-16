from app.ratelimit import RateLimiter


def test_sliding_window_allows_again_after_window():
    now = [0.0]
    limiter = RateLimiter(limit=2, window_seconds=60, clock=lambda: now[0])
    assert limiter.check("a") is None
    assert limiter.check("a") is None
    assert limiter.check("a") == 60
    assert limiter.check("b") is None  # separate budget per client
    now[0] = 60.0
    assert limiter.check("a") is None


def test_zero_limit_disables_limiter():
    limiter = RateLimiter(limit=0)
    assert all(limiter.check("x") is None for _ in range(1000))
