from __future__ import annotations

import base64

import pytest
from fastapi.testclient import TestClient

from tests.conftest import build_client


def synth_body(**overrides) -> dict:
    body = {
        "text": "The kidney maintains extracellular fluid volume.",
        "voiceId": "mock-en-1",
        "speed": 1.0,
        "language": "en-US",
        "chunkId": "doc:chunk0",
        "cacheKey": "key-abc",
        "format": "wav",
    }
    body.update(overrides)
    return body


class TestVoices:
    def test_reports_not_configured_instead_of_failing(self, unconfigured_client: TestClient) -> None:
        response = unconfigured_client.get("/api/tts/voices")
        assert response.status_code == 200
        assert response.json() == {
            "configured": False,
            "provider": None,
            "voices": [],
            "capabilities": None,
            "defaultVoiceId": None,
        }

    def test_lists_voices_and_capabilities(self, mock_client: TestClient) -> None:
        body = mock_client.get("/api/tts/voices").json()
        assert body["configured"] is True
        assert body["provider"] == "mock"
        assert len(body["voices"]) == 2
        assert body["capabilities"]["supportsWordTiming"] is True
        assert body["capabilities"]["supportedSpeedRange"] == {"min": 0.5, "max": 3.0}

    def test_caps_chunk_size_to_the_deployment_limit(self, monkeypatch: pytest.MonkeyPatch) -> None:
        with build_client(monkeypatch, TTS_PROVIDER="mock", TTS_MAX_CHARS_PER_CHUNK="500") as client:
            caps = client.get("/api/tts/voices").json()["capabilities"]
            assert caps["maxCharsPerChunk"] == 500


class TestSynthesize:
    def test_returns_audio_and_timings(self, mock_client: TestClient) -> None:
        response = mock_client.post("/api/tts/synthesize", json=synth_body())
        assert response.status_code == 200
        body = response.json()
        assert body["chunkId"] == "doc:chunk0"
        assert body["mimeType"] == "audio/wav"
        assert base64.b64decode(body["audio"])[:4] == b"RIFF"
        assert body["timingSource"] == "provider-exact"
        assert len(body["wordTimings"]) == 6
        assert body["cached"] is False

    def test_word_timings_index_into_the_submitted_text(self, mock_client: TestClient) -> None:
        text = "One two three."
        body = mock_client.post("/api/tts/synthesize", json=synth_body(text=text)).json()
        for timing in body["wordTimings"]:
            assert text[timing["start"] : timing["end"]].strip() != ""

    def test_second_identical_request_is_served_from_cache(self, mock_client: TestClient) -> None:
        mock_client.post("/api/tts/synthesize", json=synth_body())
        second = mock_client.post("/api/tts/synthesize", json=synth_body())
        assert second.json()["cached"] is True

    def test_a_different_cache_key_is_not_served_from_cache(self, mock_client: TestClient) -> None:
        mock_client.post("/api/tts/synthesize", json=synth_body())
        other = mock_client.post("/api/tts/synthesize", json=synth_body(cacheKey="key-def"))
        assert other.json()["cached"] is False

    def test_clearing_the_cache_empties_it(self, mock_client: TestClient) -> None:
        mock_client.post("/api/tts/synthesize", json=synth_body())
        cleared = mock_client.post("/api/tts/cache/clear").json()
        assert cleared["cleared"] == 1
        assert cleared["entries"] == 0
        again = mock_client.post("/api/tts/synthesize", json=synth_body())
        assert again.json()["cached"] is False

    def test_unconfigured_provider_gives_a_recovery_action(self, unconfigured_client: TestClient) -> None:
        response = unconfigured_client.post("/api/tts/synthesize", json=synth_body())
        assert response.status_code == 503
        body = response.json()
        assert body["code"] == "not_configured"
        assert "browser" in body["recovery"].lower()

    def test_rejects_a_speed_outside_the_provider_range(self, mock_client: TestClient) -> None:
        response = mock_client.post("/api/tts/synthesize", json=synth_body(speed=3.5))
        assert response.status_code == 400
        assert response.json()["code"] == "unsupported_speed"

    def test_rejects_text_over_the_deployment_limit(self, monkeypatch: pytest.MonkeyPatch) -> None:
        with build_client(monkeypatch, TTS_PROVIDER="mock", TTS_MAX_CHARS_PER_CHUNK="20") as client:
            response = client.post("/api/tts/synthesize", json=synth_body(text="x" * 200))
            assert response.status_code == 413
            assert response.json()["code"] == "text_too_long"

    def test_validation_errors_do_not_echo_document_text(self, mock_client: TestClient) -> None:
        secret = "CONFIDENTIAL PATIENT NAME"
        response = mock_client.post("/api/tts/synthesize", json=synth_body(text=secret, speed="fast"))
        assert response.status_code == 422
        assert secret not in response.text
        assert response.json()["code"] == "invalid_request"

    def test_errors_never_leak_a_stack_trace(self, unconfigured_client: TestClient) -> None:
        body = unconfigured_client.post("/api/tts/synthesize", json=synth_body()).text
        assert "Traceback" not in body
        assert 'File "' not in body


class TestRateLimiting:
    def test_blocks_past_the_configured_limit(self, monkeypatch: pytest.MonkeyPatch) -> None:
        with build_client(monkeypatch, TTS_PROVIDER="mock", RATE_LIMIT_TTS_PER_MINUTE="3") as client:
            for index in range(3):
                ok = client.post("/api/tts/synthesize", json=synth_body(cacheKey=f"k{index}"))
                assert ok.status_code == 200
            blocked = client.post("/api/tts/synthesize", json=synth_body(cacheKey="k-final"))
            assert blocked.status_code == 429
            assert blocked.json()["code"] == "rate_limited"
            assert blocked.json()["retryable"] is True
            assert "Retry-After" in blocked.headers


class TestSecurityHeaders:
    def test_sets_hardening_headers(self, mock_client: TestClient) -> None:
        headers = mock_client.get("/api/health").headers
        assert headers["X-Content-Type-Options"] == "nosniff"
        assert headers["Referrer-Policy"] == "no-referrer"
        assert headers["Cache-Control"] == "no-store"

    def test_health_discloses_configured_providers(self, mock_client: TestClient) -> None:
        body = mock_client.get("/api/health").json()
        assert body["ttsProvider"] == "mock"
        assert body["ocrProvider"] == "mock"
        assert body["contentLoggingEnabled"] is False

    def test_content_logging_is_forced_off_in_production(self, monkeypatch: pytest.MonkeyPatch) -> None:
        with build_client(monkeypatch, APP_ENV="production", LOG_DOCUMENT_CONTENT="true") as client:
            assert client.get("/api/health").json()["contentLoggingEnabled"] is False
