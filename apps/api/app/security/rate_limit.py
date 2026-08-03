"""In-process rate limiting.

A fixed-window counter per client per route. It protects the deployment's
provider quota from a runaway client. It is per-process and therefore not a
substitute for an edge rate limiter in a multi-instance deployment; see
LIMITATIONS.md.
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field
from threading import Lock


@dataclass
class RateLimiter:
    limit_per_minute: int
    _window: dict[str, tuple[int, float]] = field(default_factory=dict)
    _lock: Lock = field(default_factory=Lock)

    def check(self, key: str, now: float | None = None) -> tuple[bool, int]:
        """Returns (allowed, retry_after_seconds)."""
        if self.limit_per_minute <= 0:
            return True, 0
        moment = now if now is not None else time.monotonic()

        with self._lock:
            count, window_start = self._window.get(key, (0, moment))
            if moment - window_start >= 60:
                count, window_start = 0, moment
            if count >= self.limit_per_minute:
                return False, max(1, int(60 - (moment - window_start)))
            self._window[key] = (count + 1, window_start)
            return True, 0

    def reset(self) -> None:
        with self._lock:
            self._window.clear()


_limiters: dict[str, RateLimiter] = {}
_registry_lock = Lock()


def get_limiter(name: str, limit_per_minute: int) -> RateLimiter:
    with _registry_lock:
        limiter = _limiters.get(name)
        if limiter is None or limiter.limit_per_minute != limit_per_minute:
            limiter = RateLimiter(limit_per_minute=limit_per_minute)
            _limiters[name] = limiter
        return limiter


def reset_all_limiters() -> None:
    with _registry_lock:
        for limiter in _limiters.values():
            limiter.reset()


# Kept for symmetry with defaultdict-based implementations in tests.
__all__ = ["RateLimiter", "get_limiter", "reset_all_limiters", "defaultdict"]
