"""Normalized, user-safe errors.

No stack trace, provider payload or credential ever reaches the client. Every
error carries a plain-language message and a concrete recovery action.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

ProviderErrorCode = Literal[
    "provider_unavailable",
    "provider_timeout",
    "quota_exhausted",
    "rate_limited",
    "invalid_voice",
    "invalid_request",
    "unsupported_speed",
    "text_too_long",
    "not_configured",
    "internal_error",
]

_STATUS_BY_CODE: dict[str, int] = {
    "provider_unavailable": 502,
    "provider_timeout": 504,
    "quota_exhausted": 429,
    "rate_limited": 429,
    "invalid_voice": 400,
    "invalid_request": 400,
    "unsupported_speed": 400,
    "text_too_long": 413,
    "not_configured": 503,
    "internal_error": 500,
}

_DEFAULT_RECOVERY: dict[str, str] = {
    "provider_unavailable": "Switch to your browser's built-in voice in the player, or try again shortly.",
    "provider_timeout": "Try again. If it keeps timing out, switch to your browser's built-in voice.",
    "quota_exhausted": (
        "The speech quota for this deployment is used up. Switch to your browser's built-in voice."
    ),
    "rate_limited": ("Too many requests at once. Playback will continue automatically in a moment."),
    "invalid_voice": "Choose a different voice in the player.",
    "invalid_request": "Reload the page and try again.",
    "unsupported_speed": "Choose a speed within the range this voice supports.",
    "text_too_long": (
        "This passage is too long for the speech provider. Reduce the chunk size in configuration."
    ),
    "not_configured": "No server speech provider is configured. Use your browser's built-in voice.",
    "internal_error": "Something went wrong on our side. Your reading position has been kept.",
}


@dataclass
class ProviderError(Exception):
    """Raised by adapters; converted to a safe JSON envelope at the edge."""

    code: ProviderErrorCode
    message: str
    retryable: bool = False
    retry_after_seconds: int | None = None
    recovery: str | None = None
    # Internal-only detail. Logged (without document content), never returned.
    internal_detail: str = field(default="", repr=False)

    def __post_init__(self) -> None:
        super().__init__(self.message)

    @property
    def status_code(self) -> int:
        return _STATUS_BY_CODE.get(self.code, 500)

    def to_payload(self) -> dict[str, object]:
        return {
            "code": self.code,
            "message": self.message,
            "recovery": self.recovery or _DEFAULT_RECOVERY.get(self.code),
            "retryable": self.retryable,
            "retryAfterSeconds": self.retry_after_seconds,
        }


def not_configured(provider: str = "") -> ProviderError:
    name = f' "{provider}"' if provider else ""
    return ProviderError(
        code="not_configured",
        message=f"No server-side speech provider{name} is configured for this deployment.",
        retryable=False,
    )
