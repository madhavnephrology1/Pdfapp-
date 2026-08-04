"""Text-recognition provider adapters.

The Google Vision adapter has never been run against the live service — there is
no credential in this repository and no network access in CI. These tests pin
its behaviour against the response shapes the API documents, which is what can
honestly be verified here. See LIMITATIONS.md.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from app.core.config import Settings
from app.core.errors import ProviderError
from app.providers.ocr.base import OCRPageInput
from app.providers.ocr.google_vision import ENDPOINT, GoogleVisionOCRProvider
from app.providers.ocr.registry import create_ocr_provider


def page(image: bytes = b"\x89PNG-bytes", **kwargs) -> OCRPageInput:
    defaults = {
        "mime_type": "image/png",
        "page_number": 4,
        "document_id": "doc-1",
        "language_hints": ("en",),
    }
    defaults.update(kwargs)
    return OCRPageInput(image=image, **defaults)


def vision_word(text: str, confidence: float, x: int, y: int, w: int = 40, h: int = 20) -> dict:
    return {
        "symbols": [{"text": character} for character in text],
        "confidence": confidence,
        "boundingBox": {
            "vertices": [
                {"x": x, "y": y},
                {"x": x + w, "y": y},
                {"x": x + w, "y": y + h},
                {"x": x, "y": y + h},
            ]
        },
    }


def vision_response(words: list[dict], text: str = "", language: str | None = "en") -> dict:
    page_property = {"detectedLanguages": [{"languageCode": language}]} if language else {}
    return {
        "responses": [
            {
                "fullTextAnnotation": {
                    "text": text,
                    "pages": [
                        {
                            "property": page_property,
                            "blocks": [{"paragraphs": [{"words": words}]}],
                        }
                    ],
                }
            }
        ]
    }


class TestRegistry:
    def _settings(self, **kwargs) -> Settings:
        base = {"ocr_provider": "", "ocr_api_key": "", "_env_file": None}
        base.update(kwargs)
        return Settings(**base)

    def test_returns_none_when_nothing_is_configured(self) -> None:
        assert create_ocr_provider(self._settings()) is None

    def test_builds_the_google_adapter(self) -> None:
        provider = create_ocr_provider(self._settings(ocr_provider="google-vision", ocr_api_key="k"))
        assert provider is not None
        assert provider.name == "google-vision"

    def test_rejects_an_unknown_provider_by_name(self) -> None:
        with pytest.raises(ProviderError) as excinfo:
            create_ocr_provider(self._settings(ocr_provider="not-a-provider"))
        assert excinfo.value.code == "not_configured"

    def test_requires_a_credential(self) -> None:
        with pytest.raises(ProviderError):
            create_ocr_provider(self._settings(ocr_provider="google-vision"))


class TestGoogleVisionRequest:
    @respx.mock
    async def test_asks_for_the_dense_text_model_and_passes_language_hints(self) -> None:
        route = respx.post(ENDPOINT).mock(return_value=httpx.Response(200, json=vision_response([])))
        provider = GoogleVisionOCRProvider(api_key="test-key", timeout=5)
        await provider.recognize_page(page())

        sent = route.calls.last.request
        body = sent.read().decode()
        # DOCUMENT_TEXT_DETECTION is the only model that returns per-word
        # confidence, which this application requires.
        assert "DOCUMENT_TEXT_DETECTION" in body
        assert "languageHints" in body
        assert "key=test-key" in str(sent.url)
        await provider.aclose()

    @respx.mock
    async def test_omits_the_language_hint_when_none_was_given(self) -> None:
        route = respx.post(ENDPOINT).mock(return_value=httpx.Response(200, json=vision_response([])))
        provider = GoogleVisionOCRProvider(api_key="k", timeout=5)
        await provider.recognize_page(page(language_hints=()))
        assert "imageContext" not in route.calls.last.request.read().decode()
        await provider.aclose()


class TestGoogleVisionResult:
    @respx.mock
    async def test_assembles_word_text_from_symbols_without_altering_it(self) -> None:
        respx.post(ENDPOINT).mock(
            return_value=httpx.Response(
                200,
                json=vision_response([vision_word("Glomerulus", 0.97, 10, 20)], text="Glomerulus\n"),
            )
        )
        provider = GoogleVisionOCRProvider(api_key="k", timeout=5)
        result = await provider.recognize_page(page())
        assert [word.text for word in result.words] == ["Glomerulus"]
        # The provider's own assembled text is passed through verbatim.
        assert result.text == "Glomerulus\n"
        assert result.language == "en"
        await provider.aclose()

    @respx.mock
    async def test_reports_image_pixel_bounds_from_the_vertex_list(self) -> None:
        respx.post(ENDPOINT).mock(
            return_value=httpx.Response(
                200, json=vision_response([vision_word("word", 0.9, 100, 200, 60, 24)])
            )
        )
        provider = GoogleVisionOCRProvider(api_key="k", timeout=5)
        word = (await provider.recognize_page(page())).words[0]
        assert (word.x, word.y, word.width, word.height) == (100, 200, 60, 24)
        await provider.aclose()

    @respx.mock
    async def test_handles_a_skewed_word_and_omitted_zero_coordinates(self) -> None:
        # Vision omits a coordinate when it is zero, and a scan is rarely square
        # to the page, so the four vertices do not form an axis-aligned box.
        skewed = {
            "symbols": [{"text": "a"}],
            "confidence": 0.8,
            "boundingBox": {"vertices": [{"y": 4}, {"x": 30, "y": 2}, {"x": 32, "y": 22}, {"x": 2, "y": 24}]},
        }
        respx.post(ENDPOINT).mock(return_value=httpx.Response(200, json=vision_response([skewed])))
        provider = GoogleVisionOCRProvider(api_key="k", timeout=5)
        word = (await provider.recognize_page(page())).words[0]
        assert (word.x, word.y, word.width, word.height) == (0, 2, 32, 22)
        await provider.aclose()

    @respx.mock
    async def test_marks_low_confidence_words_and_never_drops_them(self) -> None:
        respx.post(ENDPOINT).mock(
            return_value=httpx.Response(
                200,
                json=vision_response(
                    [
                        vision_word("clear", 0.99, 10, 10),
                        vision_word("smudged", 0.31, 60, 10),
                        vision_word("also", 0.95, 120, 10),
                    ]
                ),
            )
        )
        provider = GoogleVisionOCRProvider(api_key="k", timeout=5)
        result = await provider.recognize_page(page())
        assert result.low_confidence_word_indexes == [1]
        # The uncertain word is kept and flagged, never removed or replaced.
        assert [word.text for word in result.words] == ["clear", "smudged", "also"]
        await provider.aclose()

    @respx.mock
    async def test_treats_a_missing_confidence_as_no_confidence(self) -> None:
        no_confidence = {"symbols": [{"text": "x"}], "boundingBox": {"vertices": [{"x": 1, "y": 1}]}}
        respx.post(ENDPOINT).mock(return_value=httpx.Response(200, json=vision_response([no_confidence])))
        provider = GoogleVisionOCRProvider(api_key="k", timeout=5)
        result = await provider.recognize_page(page())
        # Unknown confidence is uncertainty, not assumed correctness.
        assert result.words[0].confidence == 0.0
        assert result.low_confidence_word_indexes == [0]
        await provider.aclose()

    @respx.mock
    async def test_reports_an_empty_page_rather_than_inventing_text(self) -> None:
        respx.post(ENDPOINT).mock(return_value=httpx.Response(200, json={"responses": [{}]}))
        provider = GoogleVisionOCRProvider(api_key="k", timeout=5)
        result = await provider.recognize_page(page())
        assert result.text == ""
        assert result.words == []
        assert result.confidence == 0.0
        await provider.aclose()

    @respx.mock
    async def test_averages_word_confidence_for_the_page(self) -> None:
        respx.post(ENDPOINT).mock(
            return_value=httpx.Response(
                200,
                json=vision_response([vision_word("a", 0.9, 0, 0), vision_word("b", 0.5, 50, 0)]),
            )
        )
        provider = GoogleVisionOCRProvider(api_key="k", timeout=5)
        assert (await provider.recognize_page(page())).confidence == pytest.approx(0.7)
        await provider.aclose()


class TestGoogleVisionErrors:
    @respx.mock
    async def test_maps_a_per_image_error_inside_a_200_response(self) -> None:
        respx.post(ENDPOINT).mock(
            return_value=httpx.Response(
                200, json={"responses": [{"error": {"code": 3, "message": "Bad image data"}}]}
            )
        )
        provider = GoogleVisionOCRProvider(api_key="k", timeout=5)
        with pytest.raises(ProviderError) as excinfo:
            await provider.recognize_page(page())
        assert excinfo.value.retryable is True
        await provider.aclose()

    @respx.mock
    async def test_maps_403_without_leaking_the_body(self) -> None:
        respx.post(ENDPOINT).mock(
            return_value=httpx.Response(403, text="API key not valid: AIzaSecretKey123")
        )
        provider = GoogleVisionOCRProvider(api_key="k", timeout=5)
        with pytest.raises(ProviderError) as excinfo:
            await provider.recognize_page(page())
        assert excinfo.value.code == "not_configured"
        assert "AIzaSecretKey123" not in excinfo.value.message
        assert "guessed" in (excinfo.value.recovery or "")
        await provider.aclose()

    @respx.mock
    async def test_maps_429_to_a_retryable_error(self) -> None:
        respx.post(ENDPOINT).mock(return_value=httpx.Response(429, text="quota"))
        provider = GoogleVisionOCRProvider(api_key="k", timeout=5)
        with pytest.raises(ProviderError) as excinfo:
            await provider.recognize_page(page())
        assert excinfo.value.code == "rate_limited"
        assert excinfo.value.retryable is True
        await provider.aclose()

    @respx.mock
    async def test_maps_a_server_error_to_a_retryable_error(self) -> None:
        respx.post(ENDPOINT).mock(return_value=httpx.Response(503, text="unavailable"))
        provider = GoogleVisionOCRProvider(api_key="k", timeout=5)
        with pytest.raises(ProviderError) as excinfo:
            await provider.recognize_page(page())
        assert excinfo.value.code == "provider_unavailable"
        await provider.aclose()

    @respx.mock
    async def test_maps_a_timeout(self) -> None:
        respx.post(ENDPOINT).mock(side_effect=httpx.ReadTimeout("timed out"))
        provider = GoogleVisionOCRProvider(api_key="k", timeout=1)
        with pytest.raises(ProviderError) as excinfo:
            await provider.recognize_page(page())
        assert excinfo.value.code == "provider_timeout"
        await provider.aclose()

    @respx.mock
    async def test_maps_an_unreadable_response(self) -> None:
        respx.post(ENDPOINT).mock(return_value=httpx.Response(200, text="<html>nope</html>"))
        provider = GoogleVisionOCRProvider(api_key="k", timeout=5)
        with pytest.raises(ProviderError) as excinfo:
            await provider.recognize_page(page())
        assert excinfo.value.code == "internal_error"
        await provider.aclose()

    async def test_requires_an_api_key(self) -> None:
        with pytest.raises(ProviderError):
            GoogleVisionOCRProvider(api_key="", timeout=5)
