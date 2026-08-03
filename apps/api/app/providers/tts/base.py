"""Provider-neutral text-to-speech contracts.

Adapters translate between these types and one vendor's API. Nothing outside an
adapter module may reference a vendor name, a vendor-specific environment
variable, or a vendor error shape.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field


@dataclass(frozen=True)
class TTSVoice:
    id: str
    name: str
    language: str
    provider: str
    gender: str = "unspecified"
    neural: bool = True


@dataclass(frozen=True)
class TTSRequest:
    text: str
    voice_id: str
    speed: float
    chunk_id: str
    cache_key: str
    language: str = "en-US"
    audio_format: str = "mp3"


@dataclass(frozen=True)
class WordTiming:
    start: int
    end: int
    audio_start: float
    audio_end: float


@dataclass
class TTSResult:
    chunk_id: str
    audio: bytes
    mime_type: str
    provider: str
    voice_id: str
    # 'provider-exact' ONLY when the vendor actually returned word boundaries.
    # Adapters must not claim exact timing they did not receive.
    timing_source: str = "none"
    duration_seconds: float | None = None
    word_timings: list[WordTiming] = field(default_factory=list)
    cached: bool = False


@dataclass(frozen=True)
class TTSCapabilities:
    provider: str
    supports_streaming: bool
    supports_word_timing: bool
    supports_sentence_timing: bool
    supports_pitch: bool
    speed_min: float
    speed_max: float
    max_chars_per_chunk: int


class TTSProvider(abc.ABC):
    """The interface every speech adapter implements."""

    name: str = "base"

    @abc.abstractmethod
    async def list_voices(self) -> list[TTSVoice]:
        """Voices this provider can use, for the player's voice selector."""

    @abc.abstractmethod
    async def synthesize(self, request: TTSRequest) -> TTSResult:
        """Synthesize one chunk. Must raise ProviderError on any failure."""

    @property
    @abc.abstractmethod
    def capabilities(self) -> TTSCapabilities:
        """What this provider can actually do. Drives which controls the UI shows."""

    async def aclose(self) -> None:
        """Release any long-lived client resources."""
        return None
