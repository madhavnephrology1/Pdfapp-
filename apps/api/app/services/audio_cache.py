"""In-memory audio cache.

Keyed by the client-computed cache key, which already folds in provider, voice,
speed, language and a hash of the exact text. Entries are evicted by age and by
count so a long reading session cannot grow without bound.

Audio is held in memory only and is never written to disk. Nothing here is
persisted across a restart, which is deliberate: cached audio is derived from a
user's private document.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass
from threading import Lock

from app.providers.tts.base import TTSResult


@dataclass
class CacheEntry:
    result: TTSResult
    stored_at: float


class AudioCache:
    def __init__(self, max_entries: int, ttl_seconds: float) -> None:
        self._max_entries = max_entries
        self._ttl = ttl_seconds
        self._entries: OrderedDict[str, CacheEntry] = OrderedDict()
        self._lock = Lock()

    def get(self, key: str, now: float | None = None) -> TTSResult | None:
        moment = now if now is not None else time.monotonic()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            if moment - entry.stored_at > self._ttl:
                del self._entries[key]
                return None
            self._entries.move_to_end(key)
            return entry.result

    def put(self, key: str, result: TTSResult, now: float | None = None) -> None:
        moment = now if now is not None else time.monotonic()
        with self._lock:
            self._entries[key] = CacheEntry(result=result, stored_at=moment)
            self._entries.move_to_end(key)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)

    def purge_expired(self, now: float | None = None) -> int:
        moment = now if now is not None else time.monotonic()
        with self._lock:
            expired = [key for key, entry in self._entries.items() if moment - entry.stored_at > self._ttl]
            for key in expired:
                del self._entries[key]
            return len(expired)

    def clear(self) -> int:
        """Drops every cached item. Backs the user-facing "delete cached data" action."""
        with self._lock:
            count = len(self._entries)
            self._entries.clear()
            return count

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)
