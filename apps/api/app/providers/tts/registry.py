"""Speech-provider selection.

The provider is chosen by the TTS_PROVIDER environment variable. No vendor is
hard-coded anywhere else in the application, and adding one means adding a
module here and nothing more.
"""

from __future__ import annotations

from collections.abc import Callable

from app.core.config import Settings
from app.core.errors import ProviderError, not_configured

from .azure import AzureTTSProvider
from .base import TTSProvider
from .elevenlabs import ElevenLabsTTSProvider
from .mock import MockTTSProvider
from .openai_tts import OpenAITTSProvider

ProviderFactory = Callable[[Settings], TTSProvider]

_FACTORIES: dict[str, ProviderFactory] = {
    "openai": lambda s: OpenAITTSProvider(s.tts_api_key, s.tts_request_timeout_seconds),
    "elevenlabs": lambda s: ElevenLabsTTSProvider(s.tts_api_key, s.tts_request_timeout_seconds),
    "azure": lambda s: AzureTTSProvider(s.tts_api_key, s.tts_region, s.tts_request_timeout_seconds),
    "mock": lambda _s: MockTTSProvider(),
}

AVAILABLE_PROVIDERS = tuple(_FACTORIES)


def create_tts_provider(settings: Settings) -> TTSProvider | None:
    """Builds the configured provider, or None when none is configured.

    Returning None is a supported state, not an error: the client falls back to
    the browser's own speech synthesis and the UI says which is in use.
    """
    name = settings.tts_provider
    if not name:
        return None

    factory = _FACTORIES.get(name)
    if factory is None:
        raise ProviderError(
            code="not_configured",
            message="This deployment is configured with an unknown speech provider.",
            internal_detail=f"unknown provider {name!r}; known: {', '.join(AVAILABLE_PROVIDERS)}",
        )

    try:
        return factory(settings)
    except ProviderError:
        raise
    except Exception as exc:  # pragma: no cover - defensive
        raise not_configured(name) from exc
