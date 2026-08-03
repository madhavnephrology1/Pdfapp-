"""ElevenLabs speech adapter.

Uses the timestamped endpoint, which returns character-level alignment alongside
the audio. Those characters are folded into WORD boundaries, so this provider
supports genuinely exact word highlighting rather than an estimate.
"""

from __future__ import annotations

import base64

import httpx

from app.core.errors import ProviderError

from .base import TTSCapabilities, TTSProvider, TTSRequest, TTSResult, TTSVoice, WordTiming

API_BASE = "https://api.elevenlabs.io/v1"
DEFAULT_MODEL = "eleven_multilingual_v2"


class ElevenLabsTTSProvider(TTSProvider):
    name = "elevenlabs"

    def __init__(self, api_key: str, timeout: float, model: str = DEFAULT_MODEL) -> None:
        if not api_key:
            raise ProviderError(
                code="not_configured",
                message="The speech provider is not configured for this deployment.",
            )
        self._api_key = api_key
        self._model = model
        self._client = httpx.AsyncClient(timeout=timeout)

    @property
    def _headers(self) -> dict[str, str]:
        return {"xi-api-key": self._api_key}

    async def list_voices(self) -> list[TTSVoice]:
        try:
            response = await self._client.get(f"{API_BASE}/voices", headers=self._headers)
        except httpx.HTTPError as exc:
            raise ProviderError(
                code="provider_unavailable",
                message="The list of voices could not be loaded.",
                retryable=True,
                internal_detail=type(exc).__name__,
            ) from exc

        if response.status_code >= 400:
            raise _normalize_http_error(response)

        voices: list[TTSVoice] = []
        for entry in response.json().get("voices", []):
            labels = entry.get("labels") or {}
            voices.append(
                TTSVoice(
                    id=entry.get("voice_id", ""),
                    name=entry.get("name", "Unnamed voice"),
                    language=labels.get("language", "en-US"),
                    provider=self.name,
                    gender=labels.get("gender", "unspecified"),
                )
            )
        return voices

    @property
    def capabilities(self) -> TTSCapabilities:
        return TTSCapabilities(
            provider=self.name,
            supports_streaming=True,
            # Character alignment is returned and folded into word boundaries.
            supports_word_timing=True,
            supports_sentence_timing=False,
            supports_pitch=False,
            # Rate is applied client-side as a playback rate; see README.
            speed_min=0.5,
            speed_max=3.0,
            max_chars_per_chunk=2500,
        )

    async def synthesize(self, request: TTSRequest) -> TTSResult:
        caps = self.capabilities
        if len(request.text) > caps.max_chars_per_chunk:
            raise ProviderError(
                code="text_too_long",
                message="This passage is longer than the speech provider accepts in one request.",
            )

        try:
            response = await self._client.post(
                f"{API_BASE}/text-to-speech/{request.voice_id}/with-timestamps",
                headers=self._headers,
                json={
                    "text": request.text,
                    "model_id": self._model,
                    "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
                },
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

        body = response.json()
        audio_b64 = body.get("audio_base64")
        if not audio_b64:
            raise ProviderError(
                code="provider_unavailable",
                message="The speech provider returned no audio for this passage.",
                retryable=True,
            )

        alignment = body.get("alignment") or body.get("normalized_alignment")
        word_timings = _alignment_to_word_timings(request.text, alignment)

        return TTSResult(
            chunk_id=request.chunk_id,
            audio=base64.b64decode(audio_b64),
            mime_type="audio/mpeg",
            provider=self.name,
            voice_id=request.voice_id,
            timing_source="provider-exact" if word_timings else "none",
            duration_seconds=_duration_from_alignment(alignment),
            word_timings=word_timings,
        )

    async def aclose(self) -> None:
        await self._client.aclose()


def _duration_from_alignment(alignment: dict | None) -> float | None:
    if not alignment:
        return None
    ends = alignment.get("character_end_times_seconds") or []
    return float(ends[-1]) if ends else None


def _alignment_to_word_timings(text: str, alignment: dict | None) -> list[WordTiming]:
    """Folds per-character alignment into per-word boundaries.

    Returns an empty list if the alignment does not line up with the text; the
    caller then reports no timing rather than a fabricated one.
    """
    if not alignment:
        return []
    characters = alignment.get("characters") or []
    starts = alignment.get("character_start_times_seconds") or []
    ends = alignment.get("character_end_times_seconds") or []
    if not (len(characters) == len(starts) == len(ends)) or not characters:
        return []
    # The alignment must describe the text we sent; otherwise offsets would be
    # meaningless and the highlight would land on the wrong words.
    if "".join(characters) != text:
        return []

    timings: list[WordTiming] = []
    index = 0
    while index < len(characters):
        if characters[index].isspace():
            index += 1
            continue
        start_index = index
        while index < len(characters) and not characters[index].isspace():
            index += 1
        timings.append(
            WordTiming(
                start=start_index,
                end=index,
                audio_start=float(starts[start_index]),
                audio_end=float(ends[index - 1]),
            )
        )
    return timings


def _normalize_http_error(response: httpx.Response) -> ProviderError:
    status = response.status_code
    if status in (401, 403):
        return ProviderError(
            code="not_configured",
            message="The speech provider rejected this deployment's credentials.",
            internal_detail=f"http {status}",
        )
    if status == 422:
        return ProviderError(
            code="invalid_voice",
            message="The selected voice is not available.",
            internal_detail=f"http {status}",
        )
    if status == 429:
        return ProviderError(
            code="rate_limited",
            message="The speech provider is rate limiting this deployment.",
            retryable=True,
            retry_after_seconds=10,
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
