"""Google Cloud Vision text-recognition adapter.

Uses `DOCUMENT_TEXT_DETECTION`, which is the dense-text model and the only one
that returns a per-word confidence. The confidence is the entire point: this
application marks uncertain words rather than presenting them as read, so a
provider that returns text without confidence cannot be used honestly here.

Word text is assembled from the symbols the provider returns and is never
altered, completed or spell-corrected. When the provider recognises nothing, the
result is empty — that is reported as "nothing was recognised" rather than
filled in.

Coordinates are returned in the pixels of the image that was sent, with the
origin at its top-left corner. The client knows the scale it rendered at and
converts them back to PDF coordinates.
"""

from __future__ import annotations

import base64
from typing import Any

import httpx

from app.core.errors import ProviderError

from .base import OCRPageInput, OCRPageResult, OCRProvider, OCRWord

ENDPOINT = "https://vision.googleapis.com/v1/images:annotate"


class GoogleVisionOCRProvider(OCRProvider):
    name = "google-vision"

    def __init__(self, api_key: str, timeout: float) -> None:
        if not api_key:
            raise ProviderError(
                code="not_configured",
                message="Text recognition is not configured for this deployment.",
            )
        self._api_key = api_key
        self._client = httpx.AsyncClient(timeout=timeout)

    async def recognize_page(self, page: OCRPageInput) -> OCRPageResult:
        payload: dict[str, Any] = {
            "requests": [
                {
                    "image": {"content": base64.b64encode(page.image).decode("ascii")},
                    "features": [{"type": "DOCUMENT_TEXT_DETECTION"}],
                }
            ]
        }
        if page.language_hints:
            payload["requests"][0]["imageContext"] = {"languageHints": list(page.language_hints)}

        try:
            response = await self._client.post(
                ENDPOINT,
                params={"key": self._api_key},
                json=payload,
            )
        except httpx.TimeoutException as exc:
            raise ProviderError(
                code="provider_timeout",
                message="The text-recognition service did not respond in time.",
                recovery="Try this page again.",
                retryable=True,
                internal_detail=type(exc).__name__,
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(
                code="provider_unavailable",
                message="The text-recognition service could not be reached.",
                recovery="Try this page again, or continue without text recognition.",
                retryable=True,
                internal_detail=type(exc).__name__,
            ) from exc

        if response.status_code >= 400:
            raise _normalize_http_error(response)

        try:
            body = response.json()
        except ValueError as exc:
            raise ProviderError(
                code="internal_error",
                message="The text-recognition service returned a response that could not be read.",
                internal_detail="response was not JSON",
            ) from exc

        results = body.get("responses") or [{}]
        result = results[0] if isinstance(results[0], dict) else {}

        # Vision reports per-image failures inside a 200 response.
        error = result.get("error")
        if isinstance(error, dict) and error.get("code"):
            raise ProviderError(
                code="provider_unavailable",
                message="That page could not be recognised by the text-recognition service.",
                recovery="Try the page again, or continue without text recognition.",
                retryable=True,
                internal_detail=f"vision error code {error.get('code')}",
            )

        annotation = result.get("fullTextAnnotation") or {}
        words = _words_from_annotation(annotation)

        return OCRPageResult(
            page_number=page.page_number,
            # The provider's own assembled text, verbatim.
            text=annotation.get("text", ""),
            words=words,
            confidence=(sum(w.confidence for w in words) / len(words)) if words else 0.0,
            provider=self.name,
            language=_dominant_language(annotation),
        )

    async def aclose(self) -> None:
        await self._client.aclose()


def _words_from_annotation(annotation: dict[str, Any]) -> list[OCRWord]:
    """Flattens Vision's page/block/paragraph/word/symbol tree into words.

    Word text is the concatenation of its symbols, exactly as returned. A word
    the provider gave no confidence for is treated as 0.0 — unknown confidence
    is uncertainty, never assumed correctness.
    """
    words: list[OCRWord] = []
    for vision_page in annotation.get("pages") or []:
        for block in vision_page.get("blocks") or []:
            for paragraph in block.get("paragraphs") or []:
                for word in paragraph.get("words") or []:
                    text = "".join(symbol.get("text", "") for symbol in word.get("symbols") or [])
                    if not text:
                        continue
                    box = _bounding_box(word.get("boundingBox") or {})
                    words.append(
                        OCRWord(
                            text=text,
                            confidence=float(word.get("confidence") or 0.0),
                            x=box[0],
                            y=box[1],
                            width=box[2],
                            height=box[3],
                        )
                    )
    return words


def _bounding_box(box: dict[str, Any]) -> tuple[float, float, float, float]:
    """Axis-aligned bounds of a Vision vertex list, in image pixels.

    Vision returns four vertices which are not necessarily axis-aligned on a
    skewed scan, and omits a coordinate entirely when it is zero.
    """
    vertices = box.get("vertices") or box.get("normalizedVertices") or []
    xs = [float(vertex.get("x", 0) or 0) for vertex in vertices]
    ys = [float(vertex.get("y", 0) or 0) for vertex in vertices]
    if not xs or not ys:
        return (0.0, 0.0, 0.0, 0.0)
    return (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))


def _dominant_language(annotation: dict[str, Any]) -> str | None:
    for vision_page in annotation.get("pages") or []:
        detected = (vision_page.get("property") or {}).get("detectedLanguages") or []
        if detected:
            code = detected[0].get("languageCode")
            if code:
                return str(code)
    return None


def _normalize_http_error(response: httpx.Response) -> ProviderError:
    status = response.status_code
    if status in (401, 403):
        return ProviderError(
            code="not_configured",
            message="The text-recognition service rejected this deployment's credentials.",
            recovery="Scanned pages will be listed as unreadable rather than guessed at.",
            internal_detail=f"http {status}",
        )
    if status == 429:
        return ProviderError(
            code="rate_limited",
            message="The text-recognition service is rate limiting this deployment.",
            recovery="Wait a moment and try this page again.",
            retryable=True,
            retry_after_seconds=10,
            internal_detail=f"http {status}",
        )
    if status == 400:
        return ProviderError(
            code="invalid_request",
            message="The text-recognition service rejected that page image.",
            recovery="Try a different page, or continue without text recognition.",
            internal_detail=f"http {status}",
        )
    if status >= 500:
        return ProviderError(
            code="provider_unavailable",
            message="The text-recognition service is temporarily unavailable.",
            recovery="Try this page again shortly.",
            retryable=True,
            internal_detail=f"http {status}",
        )
    return ProviderError(
        code="internal_error",
        message="That page could not be recognised.",
        internal_detail=f"http {status}",
    )
