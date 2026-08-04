"""Deterministic offline OCR provider.

Returns a fixed low-confidence result so the consent gate, the uncertain-word
marking and the correction flow can be exercised without contacting a vendor.

It never invents plausible document text: the words it returns are obviously
placeholders, and they are all marked low confidence.
"""

from __future__ import annotations

from app.core.errors import ProviderError

from .base import OCRPageInput, OCRPageResult, OCRProvider, OCRWord


class MockOCRProvider(OCRProvider):
    name = "mock"

    async def recognize_page(self, page: OCRPageInput) -> OCRPageResult:
        if not page.image:
            raise ProviderError(
                code="invalid_request",
                message="That page image could not be read.",
                recovery="Try the page again, or continue without text recognition.",
            )

        # Image pixels, origin top-left: see OCRWord. These sit near the top of
        # a page rendered at 2x, which is the client's default scale.
        words = [
            OCRWord(text="[unrecognized]", confidence=0.4, x=144, y=160, width=120, height=24),
            OCRWord(text="[unrecognized]", confidence=0.4, x=280, y=160, width=120, height=24),
        ]
        return OCRPageResult(
            page_number=page.page_number,
            text=" ".join(word.text for word in words),
            words=words,
            confidence=0.4,
            provider=self.name,
            language=page.language_hints[0] if page.language_hints else None,
        )
