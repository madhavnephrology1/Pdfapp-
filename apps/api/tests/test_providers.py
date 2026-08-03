from __future__ import annotations

import base64
import xml.etree.ElementTree as ET

import httpx
import pytest
import respx

from app.core.config import Settings
from app.core.errors import ProviderError
from app.providers.tts.azure import AzureTTSProvider, build_ssml
from app.providers.tts.base import TTSRequest
from app.providers.tts.elevenlabs import ElevenLabsTTSProvider, _alignment_to_word_timings
from app.providers.tts.mock import MockTTSProvider
from app.providers.tts.openai_tts import OpenAITTSProvider
from app.providers.tts.registry import create_tts_provider


def request(text: str = "One two three.", speed: float = 1.0) -> TTSRequest:
    return TTSRequest(text=text, voice_id="v1", speed=speed, chunk_id="c0", cache_key="k0", language="en-US")


class TestRegistry:
    def _settings(self, **kwargs) -> Settings:
        base = {"tts_provider": "", "tts_api_key": "", "tts_region": "", "_env_file": None}
        base.update(kwargs)
        return Settings(**base)

    def test_returns_none_when_nothing_is_configured(self) -> None:
        assert create_tts_provider(self._settings()) is None

    def test_builds_each_known_provider(self) -> None:
        assert create_tts_provider(self._settings(tts_provider="mock")).name == "mock"
        assert create_tts_provider(self._settings(tts_provider="openai", tts_api_key="k")).name == "openai"
        assert (
            create_tts_provider(self._settings(tts_provider="elevenlabs", tts_api_key="k")).name
            == "elevenlabs"
        )
        assert (
            create_tts_provider(
                self._settings(tts_provider="azure", tts_api_key="k", tts_region="eastus")
            ).name
            == "azure"
        )

    def test_rejects_an_unknown_provider(self) -> None:
        with pytest.raises(ProviderError) as excinfo:
            create_tts_provider(self._settings(tts_provider="nonexistent"))
        assert excinfo.value.code == "not_configured"
        # The neutral message must not name the bogus provider back to the user.
        assert "nonexistent" not in excinfo.value.message

    def test_missing_credentials_surface_as_not_configured(self) -> None:
        with pytest.raises(ProviderError) as excinfo:
            create_tts_provider(self._settings(tts_provider="openai", tts_api_key=""))
        assert excinfo.value.code == "not_configured"

    def test_provider_name_is_case_insensitive(self) -> None:
        assert create_tts_provider(self._settings(tts_provider="  MOCK  ")).name == "mock"


class TestMockProvider:
    async def test_returns_a_wav_and_word_timings(self) -> None:
        result = await MockTTSProvider().synthesize(request())
        assert result.audio[:4] == b"RIFF"
        assert result.timing_source == "provider-exact"
        assert [t.start for t in result.word_timings] == [0, 4, 8]

    async def test_timings_are_monotonic(self) -> None:
        result = await MockTTSProvider().synthesize(request("alpha beta gamma delta"))
        starts = [t.audio_start for t in result.word_timings]
        assert starts == sorted(starts)

    async def test_faster_speed_yields_shorter_audio(self) -> None:
        slow = await MockTTSProvider().synthesize(request(speed=1.0))
        fast = await MockTTSProvider().synthesize(request(speed=2.0))
        assert fast.duration_seconds < slow.duration_seconds

    async def test_rejects_empty_text(self) -> None:
        with pytest.raises(ProviderError) as excinfo:
            await MockTTSProvider().synthesize(request("   "))
        assert excinfo.value.code == "invalid_request"


class TestOpenAIProvider:
    @respx.mock
    async def test_posts_the_text_and_returns_audio(self) -> None:
        route = respx.post("https://api.openai.com/v1/audio/speech").mock(
            return_value=httpx.Response(200, content=b"ID3audio")
        )
        provider = OpenAITTSProvider(api_key="test-key", timeout=5)
        result = await provider.synthesize(request())
        assert result.audio == b"ID3audio"
        # No boundaries were returned, so none may be claimed.
        assert result.timing_source == "none"
        assert route.calls.last.request.headers["authorization"] == "Bearer test-key"
        await provider.aclose()

    @respx.mock
    async def test_maps_429_to_a_retryable_error(self) -> None:
        respx.post("https://api.openai.com/v1/audio/speech").mock(
            return_value=httpx.Response(429, headers={"retry-after": "7"}, text="slow down")
        )
        provider = OpenAITTSProvider(api_key="k", timeout=5)
        with pytest.raises(ProviderError) as excinfo:
            await provider.synthesize(request())
        assert excinfo.value.retryable is True
        assert excinfo.value.retry_after_seconds == 7
        await provider.aclose()

    @respx.mock
    async def test_maps_401_without_leaking_the_body(self) -> None:
        respx.post("https://api.openai.com/v1/audio/speech").mock(
            return_value=httpx.Response(401, text="Incorrect API key provided: sk-secret123")
        )
        provider = OpenAITTSProvider(api_key="k", timeout=5)
        with pytest.raises(ProviderError) as excinfo:
            await provider.synthesize(request())
        assert excinfo.value.code == "not_configured"
        assert "sk-secret123" not in excinfo.value.message
        await provider.aclose()

    @respx.mock
    async def test_maps_a_timeout(self) -> None:
        respx.post("https://api.openai.com/v1/audio/speech").mock(side_effect=httpx.ReadTimeout("timed out"))
        provider = OpenAITTSProvider(api_key="k", timeout=1)
        with pytest.raises(ProviderError) as excinfo:
            await provider.synthesize(request())
        assert excinfo.value.code == "provider_timeout"
        await provider.aclose()

    async def test_requires_an_api_key(self) -> None:
        with pytest.raises(ProviderError):
            OpenAITTSProvider(api_key="", timeout=5)


class TestElevenLabsAlignment:
    def test_folds_characters_into_words(self) -> None:
        text = "ab cd"
        timings = _alignment_to_word_timings(
            text,
            {
                "characters": ["a", "b", " ", "c", "d"],
                "character_start_times_seconds": [0.0, 0.1, 0.2, 0.3, 0.4],
                "character_end_times_seconds": [0.1, 0.2, 0.3, 0.4, 0.5],
            },
        )
        assert [(t.start, t.end) for t in timings] == [(0, 2), (3, 5)]
        assert timings[1].audio_start == 0.3
        assert timings[1].audio_end == 0.5

    def test_returns_nothing_when_the_alignment_does_not_match_the_text(self) -> None:
        # Rather than highlighting the wrong words, report no timing at all.
        assert (
            _alignment_to_word_timings(
                "expected text",
                {
                    "characters": ["x", "y"],
                    "character_start_times_seconds": [0.0, 0.1],
                    "character_end_times_seconds": [0.1, 0.2],
                },
            )
            == []
        )

    def test_returns_nothing_for_a_missing_alignment(self) -> None:
        assert _alignment_to_word_timings("abc", None) == []

    @respx.mock
    async def test_reports_none_when_no_alignment_comes_back(self) -> None:
        respx.post("https://api.elevenlabs.io/v1/text-to-speech/v1/with-timestamps").mock(
            return_value=httpx.Response(200, json={"audio_base64": base64.b64encode(b"mp3").decode()})
        )
        provider = ElevenLabsTTSProvider(api_key="k", timeout=5)
        result = await provider.synthesize(request())
        assert result.timing_source == "none"
        assert result.word_timings == []
        await provider.aclose()


class TestAzureSsml:
    def test_escapes_document_text(self) -> None:
        ssml = build_ssml(request(text='5 < 6 & "quoted" </voice>'))
        root = ET.fromstring(ssml)
        prosody = root.find(".//{http://www.w3.org/2001/10/synthesis}prosody")
        # The text survives intact as TEXT, not as markup.
        assert prosody.text == '5 < 6 & "quoted" </voice>'
        assert len(list(prosody)) == 0

    @pytest.mark.parametrize(("speed", "rate"), [(1.0, "+0%"), (1.5, "+50%"), (0.75, "-25%")])
    def test_maps_speed_to_a_prosody_rate(self, speed: float, rate: str) -> None:
        root = ET.fromstring(build_ssml(request(speed=speed)))
        prosody = root.find(".//{http://www.w3.org/2001/10/synthesis}prosody")
        assert prosody.get("rate") == rate

    async def test_requires_a_key_and_a_region(self) -> None:
        with pytest.raises(ProviderError):
            AzureTTSProvider(api_key="k", region="", timeout=5)
        with pytest.raises(ProviderError):
            AzureTTSProvider(api_key="", region="eastus", timeout=5)

    async def test_rejects_a_speed_outside_its_range(self) -> None:
        provider = AzureTTSProvider(api_key="k", region="eastus", timeout=5)
        with pytest.raises(ProviderError) as excinfo:
            await provider.synthesize(request(speed=2.5))
        assert excinfo.value.code == "unsupported_speed"
        await provider.aclose()
