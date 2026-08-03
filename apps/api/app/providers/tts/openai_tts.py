"""OpenAI speech adapter.

Vendor specifics — endpoint, model names, error shapes — are confined to this
module. The rest of the application only sees the provider-neutral contracts.

This API returns audio without word boundaries, so `timing_source` is 'none'
and the client falls back to clearly-labelled estimated word progress.
"""

from __future__ import annotations

import httpx

from app.core.errors import ProviderError

from .base import TTSCapabilities, TTSProvider, TTSRequest, TTSResult, TTSVoice

API_URL = "https://api.openai.com/v1/audio/speech"
DEFAULT_MODEL = "gpt-4o-mini-tts"

# Fixed voice catalogue: this API has no voice-listing endpoint.
VOICES = [
    ("alloy", "Alloy", "neutral"),
    ("ash", "Ash", "male"),
    ("ballad", "Ballad", "male"),
    ("coral", "Coral", "female"),
    ("echo", "Echo", "male"),
    ("fable", "Fable", "neutral"),
    ("nova", "Nova", "female"),
    ("onyx", "Onyx", "male"),
    ("sage", "Sage", "female"),
    ("shimmer", "Shimmer", "female"),
]

_FORMAT_MIME = {"mp3": "audio/mpeg", "wav": "audio/wav", "opus": "audio/ogg"}


class OpenAITTSProvider(TTSProvider):
    name = "openai"

    def __init__(self, api_key: str, timeout: float, model: str = DEFAULT_MODEL) -> None:
        if not api_key:
            raise ProviderError(
                code="not_configured",
                message="The speech provider is not configured for this deployment.",
            )
        self._api_key = api_key
        self._model = model
        self._client = httpx.AsyncClient(timeout=timeout)

    async def list_voices(self) -> list[TTSVoice]:
        return [
            TTSVoice(id=vid, name=name, language="en-US", provider=self.name, gender=gender)
            for vid, name, gender in VOICES
        ]

    @property
    def capabilities(self) -> TTSCapabilities:
        return TTSCapabilities(
            provider=self.name,
            supports_streaming=False,
            # This endpoint returns audio only, with no boundary metadata.
            supports_word_timing=False,
            supports_sentence_timing=False,
            supports_pitch=False,
            speed_min=0.25,
            speed_max=4.0,
            max_chars_per_chunk=4096,
        )

    async def synthesize(self, request: TTSRequest) -> TTSResult:
        caps = self.capabilities
        if len(request.text) > caps.max_chars_per_chunk:
            raise ProviderError(
                code="text_too_long",
                message="This passage is longer than the speech provider accepts in one request.",
            )
        if not caps.speed_min <= request.speed <= caps.speed_max:
            raise ProviderError(
                code="unsupported_speed",
                message=f"This voice supports speeds from {caps.speed_min}x to {caps.speed_max}x.",
            )

        payload = {
            "model": self._model,
            "voice": request.voice_id,
            "input": request.text,
            "speed": request.speed,
            "response_format": request.audio_format,
        }

        try:
            response = await self._client.post(
                API_URL,
                headers={"Authorization": f"Bearer {self._api_key}"},
                json=payload,
            )
        except httpx.TimeoutException as exc:
            raise ProviderError(
                code="provider_timeout",
                message="The speech provider did not respond in time.",
                retryable=True,
                internal_detail=type(exc).__name__,
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(
                code="provider_unavailable",
                message="The speech provider could not be reached.",
                retryable=True,
                internal_detail=type(exc).__name__,
            ) from exc

        if response.status_code >= 400:
            raise _normalize_http_error(response)

        return TTSResult(
            chunk_id=request.chunk_id,
            audio=response.content,
            mime_type=_FORMAT_MIME.get(request.audio_format, "audio/mpeg"),
            provider=self.name,
            voice_id=request.voice_id,
            # No boundaries were returned, so none are claimed.
            timing_source="none",
        )

    async def aclose(self) -> None:
        await self._client.aclose()


def _normalize_http_error(response: httpx.Response) -> ProviderError:
    """Maps vendor status codes onto neutral codes, discarding the vendor body."""
    status = response.status_code
    if status == 401 or status == 403:
        return ProviderError(
            code="not_configured",
            message="The speech provider rejected this deployment's credentials.",
            internal_detail=f"http {status}",
        )
    if status == 429:
        retry_after = response.headers.get("retry-after")
        return ProviderError(
            code="quota_exhausted" if "quota" in response.text[:200].lower() else "rate_limited",
            message="The speech provider is rate limiting this deployment.",
            retryable=True,
            retry_after_seconds=int(retry_after) if retry_after and retry_after.isdigit() else 10,
            internal_detail=f"http {status}",
        )
    if status == 400:
        return ProviderError(
            code="invalid_request",
            message="The speech provider rejected this request.",
            internal_detail=f"http {status}",
        )
    if status >= 500:
        return ProviderError(
            code="provider_unavailable",
            message="The speech provider is temporarily unavailable.",
            retryable=True,
            internal_detail=f"http {status}",
        )
    return ProviderError(
        code="internal_error",
        message="The speech request could not be completed.",
        internal_detail=f"http {status}",
    )
