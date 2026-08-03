"""Health and configuration disclosure."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import settings_dep
from app.core.config import Settings
from app.models.schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/api/health", response_model=HealthResponse)
async def health(settings: Settings = Depends(settings_dep)) -> HealthResponse:
    """Reports which third-party providers this deployment is configured to use.

    The client shows this in the privacy notice so a user can see, before
    uploading anything, where their text would be sent.
    """
    return HealthResponse(
        status="ok",
        ttsProvider=settings.tts_provider or None,
        ocrProvider=settings.ocr_provider or None,
        contentLoggingEnabled=settings.content_logging_enabled(),
    )
