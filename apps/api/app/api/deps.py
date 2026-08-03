"""Shared request dependencies."""

from __future__ import annotations

from fastapi import Request

from app.core.config import Settings, get_settings
from app.core.errors import ProviderError
from app.providers.ocr.base import OCRProvider
from app.providers.tts.base import TTSProvider
from app.security.rate_limit import get_limiter
from app.services.audio_cache import AudioCache
from app.services.temp_files import TempFileStore


def settings_dep() -> Settings:
    return get_settings()


def tts_provider_dep(request: Request) -> TTSProvider | None:
    return getattr(request.app.state, "tts_provider", None)


def ocr_provider_dep(request: Request) -> OCRProvider | None:
    return getattr(request.app.state, "ocr_provider", None)


def audio_cache_dep(request: Request) -> AudioCache:
    return request.app.state.audio_cache


def temp_store_dep(request: Request) -> TempFileStore:
    return request.app.state.temp_store


def client_key(request: Request) -> str:
    """Identifies a caller for rate limiting.

    Uses the socket peer, plus a forwarded header when running behind a proxy.
    It is never logged and never persisted.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def enforce_rate_limit(request: Request, bucket: str, limit_per_minute: int) -> None:
    limiter = get_limiter(bucket, limit_per_minute)
    allowed, retry_after = limiter.check(f"{bucket}:{client_key(request)}")
    if not allowed:
        raise ProviderError(
            code="rate_limited",
            message="You are making requests faster than this deployment allows.",
            recovery="Playback will continue automatically in a few seconds.",
            retryable=True,
            retry_after_seconds=retry_after,
        )
