"""OCR provider selection.

A provider is only usable here if it returns a per-word confidence, because this
application marks uncertain words rather than presenting them as read. See
LIMITATIONS.md for what has and has not been exercised against a live service.
"""

from __future__ import annotations

from collections.abc import Callable

from app.core.config import Settings
from app.core.errors import ProviderError

from .base import OCRProvider
from .google_vision import GoogleVisionOCRProvider
from .mock import MockOCRProvider

_FACTORIES: dict[str, Callable[[Settings], OCRProvider]] = {
    "mock": lambda _s: MockOCRProvider(),
    "google-vision": lambda s: GoogleVisionOCRProvider(s.ocr_api_key, s.ocr_request_timeout_seconds),
}

AVAILABLE_PROVIDERS = tuple(_FACTORIES)


def create_ocr_provider(settings: Settings) -> OCRProvider | None:
    name = settings.ocr_provider
    if not name:
        return None
    factory = _FACTORIES.get(name)
    if factory is None:
        raise ProviderError(
            code="not_configured",
            message="This deployment is configured with an unknown text-recognition provider.",
            internal_detail=f"unknown ocr provider {name!r}; known: {', '.join(AVAILABLE_PROVIDERS)}",
        )
    return factory(settings)
