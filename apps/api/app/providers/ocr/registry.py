"""OCR provider selection.

Only a mock provider ships today. The interface, consent gate, confidence
handling and route are complete and tested, so adding a real vendor means adding
one adapter module. See LIMITATIONS.md.
"""

from __future__ import annotations

from collections.abc import Callable

from app.core.config import Settings
from app.core.errors import ProviderError

from .base import OCRProvider
from .mock import MockOCRProvider

_FACTORIES: dict[str, Callable[[Settings], OCRProvider]] = {
    "mock": lambda _s: MockOCRProvider(),
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
