"""Speech synthesis routes."""

from __future__ import annotations

import base64
import logging

from fastapi import APIRouter, Depends, Request

from app.api.deps import audio_cache_dep, enforce_rate_limit, settings_dep, tts_provider_dep
from app.core.config import Settings
from app.core.errors import ProviderError, not_configured
from app.models.schemas import (
    CacheStatsResponse,
    CapabilitiesOut,
    SynthesizeRequest,
    SynthesizeResponse,
    VoiceOut,
    VoicesResponse,
    WordTimingOut,
)
from app.providers.tts.base import TTSProvider, TTSRequest
from app.services.audio_cache import AudioCache

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/tts", tags=["tts"])


@router.get("/voices", response_model=VoicesResponse)
async def list_voices(
    provider: TTSProvider | None = Depends(tts_provider_dep),
    settings: Settings = Depends(settings_dep),
) -> VoicesResponse:
    """Voices available from the server provider.

    When no provider is configured this returns `configured: false` rather than
    an error, and the client falls back to the browser's own voices.
    """
    if provider is None:
        return VoicesResponse(configured=False)

    voices = await provider.list_voices()
    caps = provider.capabilities
    default_voice = settings.tts_default_voice or (voices[0].id if voices else None)

    return VoicesResponse(
        configured=True,
        provider=provider.name,
        defaultVoiceId=default_voice,
        voices=[
            VoiceOut(
                id=v.id,
                name=v.name,
                language=v.language,
                provider=v.provider,
                gender=v.gender,
                neural=v.neural,
            )
            for v in voices
        ],
        capabilities=CapabilitiesOut(
            provider=caps.provider,
            supportsStreaming=caps.supports_streaming,
            supportsWordTiming=caps.supports_word_timing,
            supportsSentenceTiming=caps.supports_sentence_timing,
            supportsPitch=caps.supports_pitch,
            supportedSpeedRange={"min": caps.speed_min, "max": caps.speed_max},
            maxCharsPerChunk=min(caps.max_chars_per_chunk, settings.tts_max_chars_per_chunk),
        ),
    )


@router.post("/synthesize", response_model=SynthesizeResponse)
async def synthesize(
    body: SynthesizeRequest,
    request: Request,
    provider: TTSProvider | None = Depends(tts_provider_dep),
    settings: Settings = Depends(settings_dep),
    cache: AudioCache = Depends(audio_cache_dep),
) -> SynthesizeResponse:
    if provider is None:
        raise not_configured()

    enforce_rate_limit(request, "tts", settings.rate_limit_tts_per_minute)

    if len(body.text) > settings.tts_max_chars_per_chunk:
        raise ProviderError(
            code="text_too_long",
            message="This passage is longer than this deployment allows in one request.",
            recovery="Reload the page; the reader will re-split the document into smaller passages.",
        )

    cached = cache.get(body.cacheKey)
    if cached is not None:
        return _to_response(cached, body.chunkId, cached_flag=True)

    # Document text is never logged: only sizes and identifiers.
    logger.info(
        "synthesize chunk=%s voice=%s speed=%.2f chars=%d",
        body.chunkId,
        body.voiceId,
        body.speed,
        len(body.text),
    )
    if settings.content_logging_enabled():
        logger.debug("synthesize text (development only): %s", body.text)

    result = await provider.synthesize(
        TTSRequest(
            text=body.text,
            voice_id=body.voiceId,
            speed=body.speed,
            chunk_id=body.chunkId,
            cache_key=body.cacheKey,
            language=body.language,
            audio_format=body.format,
        )
    )
    cache.put(body.cacheKey, result)
    return _to_response(result, body.chunkId, cached_flag=False)


@router.post("/cache/clear", response_model=CacheStatsResponse)
async def clear_cache(cache: AudioCache = Depends(audio_cache_dep)) -> CacheStatsResponse:
    """Drops every cached audio clip. Backs the user-facing delete action."""
    cleared = cache.clear()
    return CacheStatsResponse(entries=len(cache), cleared=cleared)


def _to_response(result, chunk_id: str, cached_flag: bool) -> SynthesizeResponse:
    return SynthesizeResponse(
        chunkId=chunk_id,
        audio=base64.b64encode(result.audio).decode("ascii"),
        mimeType=result.mime_type,
        provider=result.provider,
        voiceId=result.voice_id,
        durationSeconds=result.duration_seconds,
        # Passed through exactly as the adapter reported it. The server never
        # upgrades 'none' or 'estimated' to 'provider-exact'.
        timingSource=result.timing_source,
        wordTimings=[
            WordTimingOut(start=t.start, end=t.end, audioStart=t.audio_start, audioEnd=t.audio_end)
            for t in result.word_timings
        ],
        cached=cached_flag,
    )
