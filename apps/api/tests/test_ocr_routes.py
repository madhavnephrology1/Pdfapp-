from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import tiny_png_base64


def ocr_body(**overrides) -> dict:
    body = {
        "image": tiny_png_base64(),
        "mimeType": "image/png",
        "pageNumber": 3,
        "documentId": "doc-1",
        "languageHints": ["en"],
        "consent": True,
    }
    body.update(overrides)
    return body


class TestConsentGate:
    def test_refuses_without_consent(self, mock_client: TestClient) -> None:
        response = mock_client.post("/api/ocr/page", json=ocr_body(consent=False))
        assert response.status_code == 400
        body = response.json()
        assert "not sent" in body["message"]
        assert "third-party" in body["message"]

    def test_consent_defaults_to_false(self, mock_client: TestClient) -> None:
        payload = ocr_body()
        del payload["consent"]
        assert mock_client.post("/api/ocr/page", json=payload).status_code == 400

    def test_processes_with_consent(self, mock_client: TestClient) -> None:
        response = mock_client.post("/api/ocr/page", json=ocr_body())
        assert response.status_code == 200
        assert response.json()["pageNumber"] == 3


class TestUncertainty:
    def test_marks_low_confidence_words(self, mock_client: TestClient) -> None:
        body = mock_client.post("/api/ocr/page", json=ocr_body()).json()
        assert body["lowConfidenceWordIndexes"] == [0, 1]
        assert all(word["confidence"] < 0.75 for word in body["words"])

    def test_never_returns_a_guessed_word(self, mock_client: TestClient) -> None:
        body = mock_client.post("/api/ocr/page", json=ocr_body()).json()
        # Uncertain output is marked as such rather than replaced with a guess.
        assert all(word["text"] == "[unrecognized]" for word in body["words"])

    def test_reports_which_provider_produced_the_text(self, mock_client: TestClient) -> None:
        assert mock_client.post("/api/ocr/page", json=ocr_body()).json()["provider"] == "mock"


class TestDisabled:
    def test_reports_not_configured_rather_than_guessing(self, unconfigured_client: TestClient) -> None:
        response = unconfigured_client.post("/api/ocr/page", json=ocr_body())
        assert response.status_code == 503
        assert "guessed" in response.json()["recovery"]


class TestValidation:
    def test_rejects_a_malformed_image(self, mock_client: TestClient) -> None:
        response = mock_client.post("/api/ocr/page", json=ocr_body(image="not base64!!!"))
        assert response.status_code == 400
        assert response.json()["code"] == "invalid_request"

    def test_rejects_an_unsupported_mime_type(self, mock_client: TestClient) -> None:
        assert mock_client.post("/api/ocr/page", json=ocr_body(mimeType="image/svg+xml")).status_code == 422
