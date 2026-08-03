"""Temporary file handling.

Files only ever exist here when a server-side step genuinely needs one (OCR).
They are written with owner-only permissions, tracked, and deleted as soon as
the request finishes; a sweeper also removes anything left behind by a crash.
"""

from __future__ import annotations

import contextlib
import logging
import os
import secrets
import time
from collections.abc import Iterator
from pathlib import Path

logger = logging.getLogger(__name__)

# Owner read/write only.
_FILE_MODE = 0o600


class TempFileStore:
    def __init__(self, directory: Path, retention_minutes: int) -> None:
        self._directory = directory
        self._retention_seconds = retention_minutes * 60
        self._directory.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            os.chmod(self._directory, 0o700)

    @contextlib.contextmanager
    def temporary_file(self, suffix: str = "") -> Iterator[Path]:
        """Writes a file that is deleted when the block exits, success or not."""
        name = f"{secrets.token_hex(16)}{suffix}"
        path = self._directory / name
        try:
            # O_EXCL so an attacker cannot pre-create the path.
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR, _FILE_MODE)
            os.close(fd)
            yield path
        finally:
            with contextlib.suppress(OSError):
                path.unlink(missing_ok=True)

    def sweep(self, now: float | None = None) -> int:
        """Deletes files older than the retention window. Returns how many."""
        moment = now if now is not None else time.time()
        removed = 0
        if not self._directory.exists():
            return 0
        for path in self._directory.iterdir():
            if not path.is_file():
                continue
            try:
                age = moment - path.stat().st_mtime
            except OSError:
                continue
            if age > self._retention_seconds:
                with contextlib.suppress(OSError):
                    path.unlink()
                    removed += 1
        if removed:
            # Count only; never the file names, which can carry document titles.
            logger.info("Swept %d expired temporary file(s)", removed)
        return removed

    def purge_all(self) -> int:
        removed = 0
        if not self._directory.exists():
            return 0
        for path in self._directory.iterdir():
            if path.is_file():
                with contextlib.suppress(OSError):
                    path.unlink()
                    removed += 1
        return removed

    @property
    def directory(self) -> Path:
        return self._directory
