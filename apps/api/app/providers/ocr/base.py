"""Provider-neutral OCR contracts.

OCR output is treated as UNCERTAIN by construction. Every word carries the
provider's own confidence, and low-confidence words are listed explicitly so the
UI can mark them and offer correction. Nothing in this layer ever guesses,
completes or repairs a word.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field

LOW_CONFIDENCE_THRESHOLD = 0.75


@dataclass(frozen=True)
class OCRWord:
    """One recognised word, exactly as the provider returned it.

    Coordinates are in the PIXELS OF THE IMAGE THAT WAS SENT, with the origin at
    its top-left corner — the convention every OCR vendor uses. They are not PDF
    coordinates, whose origin is the bottom-left and whose unit is the point. The
    client rendered the image and knows the scale, so it does the conversion;
    doing it here would mean this layer guessing at a page size it never saw.
    """

    text: str
    confidence: float
    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class OCRPageInput:
    image: bytes
    mime_type: str
    page_number: int
    document_id: str
    language_hints: tuple[str, ...] = ()


@dataclass
class OCRPageResult:
    page_number: int
    text: str
    words: list[OCRWord]
    confidence: float
    provider: str
    language: str | None = None
    low_confidence_word_indexes: list[int] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.low_confidence_word_indexes:
            self.low_confidence_word_indexes = [
                index for index, word in enumerate(self.words) if word.confidence < LOW_CONFIDENCE_THRESHOLD
            ]


class OCRProvider(abc.ABC):
    name: str = "base"

    @abc.abstractmethod
    async def recognize_page(self, page: OCRPageInput) -> OCRPageResult:
        """Recognize one page image. Must raise ProviderError on failure."""

    async def aclose(self) -> None:
        return None
