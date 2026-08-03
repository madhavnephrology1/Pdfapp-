"""Text-recognition routes.

A page image is only ever sent to a provider when the request carries explicit
consent. The client must have shown the user which provider will receive the
image before setting that flag.
"""

from __future__ import annotations

import base64
import binascii
import logging

from fastapi import APIRouter, Depends, Request

from app.api.deps import enforce_rate_limit, ocr_provider_dep, settings_dep
from app.core.config import Settings
from app.core.errors import ProviderError
from app.models.schemas import OCRRequest, OCRResponse, OCRWordOut
from app.providers.ocr.base import OCRPageInput, OCRProvider

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ocr", tags=["ocr"])


@router.post("/page", response_model=OCRResponse)
async def recognize_page(
    body: OCRRequest,
    request: Request,
    provider: OCRProvider | None = Depends(ocr_provider_dep),
    settings: Settings = Depends(settings_dep),
) -> OCRResponse:
    if provider is None:
        raise ProviderError(
            code="not_configured",
            message="Text recognition is not enabled for this deployment.",
            recovery="Scanned pages will be listed as unreadable rather than guessed at.",
        )

    if not body.consent:
        raise ProviderError(
            code="invalid_request",
            message=(
                "This page image would be sent to a third-party text-recognition service. "
                "It was not sent because you have not agreed to that."
            ),
            recovery="Turn on text recognition in Settings if you want scanned pages processed.",
        )

    enforce_rate_limit(request, "ocr", settings.rate_limit_ocr_per_minute)

    try:
        image = base64.b64decode(body.image, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ProviderError(
            code="invalid_request",
            message="That page image could not be read.",
            recovery="Try the page again.",
        ) from exc

    if len(image) > settings.max_upload_bytes:
        raise ProviderError(
            code="invalid_request",
            message="That page image is larger than this deployment allows.",
            recovery="Reduce the render scale in Settings and try again.",
        )

    # Identifiers and sizes only; never the image or the recognized text.
    logger.info("ocr page=%d bytes=%d provider=%s", body.pageNumber, len(image), provider.name)

    result = await provider.recognize_page(
        OCRPageInput(
            image=image,
            mime_type=body.mimeType,
            page_number=body.pageNumber,
            document_id=body.documentId,
            language_hints=tuple(body.languageHints),
        )
    )

    return OCRResponse(
        pageNumber=result.page_number,
        text=result.text,
        words=[
            OCRWordOut(
                text=w.text,
                confidence=w.confidence,
                x=w.x,
                y=w.y,
                width=w.width,
                height=w.height,
            )
            for w in result.words
        ],
        confidence=result.confidence,
        provider=result.provider,
        language=result.language,
        lowConfidenceWordIndexes=result.low_confidence_word_indexes,
    )
