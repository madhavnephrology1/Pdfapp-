"""Request and response schemas. These mirror packages/shared-types."""

from __future__ import annotations

from pydantic import BaseModel, Field


class VoiceOut(BaseModel):
    id: str
    name: str
    language: str
    provider: str
    gender: str = "unspecified"
    neural: bool = True


class CapabilitiesOut(BaseModel):
    provider: str
    supportsStreaming: bool
    supportsWordTiming: bool
    supportsSentenceTiming: bool
    supportsPitch: bool
    supportedSpeedRange: dict[str, float]
    maxCharsPerChunk: int


class VoicesResponse(BaseModel):
    """`configured` is false when no server provider is set up.

    The client then uses the browser's own speech synthesis and says so in the UI.
    """

    configured: bool
    provider: str | None = None
    voices: list[VoiceOut] = Field(default_factory=list)
    capabilities: CapabilitiesOut | None = None
    defaultVoiceId: str | None = None


class WordTimingOut(BaseModel):
    start: int
    end: int
    audioStart: float
    audioEnd: float


class SynthesizeRequest(BaseModel):
    text: str = Field(min_length=1)
    voiceId: str = Field(min_length=1)
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    language: str = "en-US"
    chunkId: str = Field(min_length=1)
    cacheKey: str = Field(min_length=1)
    format: str = Field(default="mp3", pattern="^(mp3|wav|opus)$")


class SynthesizeResponse(BaseModel):
    chunkId: str
    audio: str
    mimeType: str
    provider: str
    voiceId: str
    durationSeconds: float | None = None
    # 'provider-exact' | 'estimated' | 'none'. Never upgraded by the server.
    timingSource: str
    wordTimings: list[WordTimingOut] = Field(default_factory=list)
    cached: bool = False


class ErrorResponse(BaseModel):
    code: str
    message: str
    recovery: str | None = None
    retryable: bool = False
    retryAfterSeconds: int | None = None


class OCRRequest(BaseModel):
    image: str = Field(min_length=1, description="Base64-encoded page image")
    mimeType: str = Field(default="image/png", pattern="^image/(png|jpeg)$")
    pageNumber: int = Field(ge=1)
    documentId: str = Field(min_length=1)
    languageHints: list[str] = Field(default_factory=list)
    # Must be true; the server refuses to send a page image to a third party
    # without the user's explicit, informed consent.
    consent: bool = False


class OCRWordOut(BaseModel):
    text: str
    confidence: float
    x: float
    y: float
    width: float
    height: float


class OCRResponse(BaseModel):
    pageNumber: int
    text: str
    words: list[OCRWordOut]
    confidence: float
    provider: str
    language: str | None = None
    lowConfidenceWordIndexes: list[int]


class CacheStatsResponse(BaseModel):
    entries: int
    cleared: int = 0


class HealthResponse(BaseModel):
    status: str
    ttsProvider: str | None
    ocrProvider: str | None
    contentLoggingEnabled: bool
