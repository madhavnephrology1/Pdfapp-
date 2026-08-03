"""Logging setup.

Content minimization is a hard requirement: document text, extracted text,
provider request bodies and page images must never reach the logs in
production. This module installs a filter that redacts anything that looks like
a credential, as a defence in depth behind the call sites that already avoid
logging content.
"""

from __future__ import annotations

import logging
import re
import sys

_SECRET_PATTERNS = [
    re.compile(r"(?i)(api[_-]?key|authorization|bearer|xi-api-key|subscription-key)\s*[:=]\s*\S+"),
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),
]


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # pragma: no cover - defensive
            return True
        redacted = message
        for pattern in _SECRET_PATTERNS:
            redacted = pattern.sub("[redacted]", redacted)
        if redacted != message:
            record.msg = redacted
            record.args = ()
        return True


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    handler.addFilter(RedactingFilter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # httpx logs full request URLs, which can carry identifiers.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
