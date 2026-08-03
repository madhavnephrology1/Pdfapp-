"""Deterministic offline speech provider.

Generates a silent WAV of a length proportional to the text, with word timings
it computes itself. It exists so the whole playback path — chunking, queueing,
caching, synchronization, error recovery — can be tested end to end without a
network call or an API key.

It reports 'provider-exact' timings because it genuinely produces the boundaries
for the audio it returns. It is not a speech engine and is never a default in
production; `TTS_PROVIDER=mock` must be set explicitly.
"""

from __future__ import annotations

import io
import struct
import wave

from app.core.errors import ProviderError

from .base import TTSCapabilities, TTSProvider, TTSRequest, TTSResult, TTSVoice, WordTiming

SAMPLE_RATE = 22_050
# Characters per second of speech at 1.0x, used to size the generated audio.
CHARS_PER_SECOND = 14.5


def _silent_wav(duration_seconds: float) -> bytes:
    frames = max(1, int(SAMPLE_RATE * duration_seconds))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(struct.pack("<h", 0) * frames)
    return buffer.getvalue()


class MockTTSProvider(TTSProvider):
    name = "mock"

    async def list_voices(self) -> list[TTSVoice]:
        return [
            TTSVoice(id="mock-en-1", name="Test Voice (Neutral)", language="en-US", provider=self.name),
            TTSVoice(id="mock-en-2", name="Test Voice (Warm)", language="en-US", provider=self.name),
        ]

    @property
    def capabilities(self) -> TTSCapabilities:
        return TTSCapabilities(
            provider=self.name,
            supports_streaming=False,
            supports_word_timing=True,
            supports_sentence_timing=False,
            supports_pitch=False,
            speed_min=0.5,
            speed_max=3.0,
            max_chars_per_chunk=2500,
        )

    async def synthesize(self, request: TTSRequest) -> TTSResult:
        if not request.text.strip():
            raise ProviderError(code="invalid_request", message="There is no text to read in this passage.")

        caps = self.capabilities
        if not caps.speed_min <= request.speed <= caps.speed_max:
            raise ProviderError(
                code="unsupported_speed",
                message=f"This voice supports speeds from {caps.speed_min}x to {caps.speed_max}x.",
            )

        duration = len(request.text) / (CHARS_PER_SECOND * request.speed)

        # Word boundaries proportional to word length, matching the audio above.
        timings: list[WordTiming] = []
        cursor = 0
        elapsed = 0.0
        for word in request.text.split(" "):
            if word:
                start = request.text.index(word, cursor)
                end = start + len(word)
                word_duration = len(word) / (CHARS_PER_SECOND * request.speed)
                timings.append(
                    WordTiming(start=start, end=end, audio_start=elapsed, audio_end=elapsed + word_duration)
                )
                elapsed += word_duration
                cursor = end
            elapsed += 1 / (CHARS_PER_SECOND * request.speed)

        return TTSResult(
            chunk_id=request.chunk_id,
            audio=_silent_wav(duration),
            mime_type="audio/wav",
            provider=self.name,
            voice_id=request.voice_id,
            timing_source="provider-exact",
            duration_seconds=duration,
            word_timings=timings,
        )
