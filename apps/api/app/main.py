"""FastAPI application entry point."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import health, ocr, tts
from app.core.config import get_settings
from app.core.errors import ProviderError
from app.core.logging import configure_logging
from app.providers.ocr.registry import create_ocr_provider
from app.providers.tts.registry import create_tts_provider
from app.services.audio_cache import AudioCache
from app.services.temp_files import TempFileStore

logger = logging.getLogger(__name__)

SWEEP_INTERVAL_SECONDS = 300


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(settings.log_level)

    app.state.audio_cache = AudioCache(
        max_entries=settings.audio_cache_max_entries,
        ttl_seconds=settings.audio_cache_ttl_minutes * 60,
    )
    app.state.temp_store = TempFileStore(settings.temp_dir, settings.temp_file_retention_minutes)

    # A misconfigured provider must not stop the server: the client can still
    # read with the browser's own voice, and the UI reports the situation.
    try:
        app.state.tts_provider = create_tts_provider(settings)
    except ProviderError as exc:
        logger.error("Speech provider unavailable: %s", exc.internal_detail or exc.code)
        app.state.tts_provider = None
    try:
        app.state.ocr_provider = create_ocr_provider(settings)
    except ProviderError as exc:
        logger.error("Text-recognition provider unavailable: %s", exc.internal_detail or exc.code)
        app.state.ocr_provider = None

    if settings.is_production and settings.log_document_content:
        logger.warning(
            "LOG_DOCUMENT_CONTENT is set but this is a production environment; "
            "document content logging stays disabled."
        )

    sweeper = asyncio.create_task(_sweep_temp_files(app))
    try:
        yield
    finally:
        sweeper.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sweeper
        for provider in (app.state.tts_provider, app.state.ocr_provider):
            if provider is not None:
                await provider.aclose()
        # Nothing derived from a user's document outlives the process.
        app.state.audio_cache.clear()
        app.state.temp_store.purge_all()


async def _sweep_temp_files(app: FastAPI) -> None:
    while True:
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
        try:
            app.state.temp_store.sweep()
            app.state.audio_cache.purge_expired()
        except Exception:  # pragma: no cover - the sweeper must never die
            logger.exception("Temporary-file sweep failed")


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)

    app = FastAPI(
        title="PDF Human Reader API",
        description=(
            "Server-side speech and text-recognition for the PDF reader. "
            "Holds provider credentials so the browser never does."
        ),
        version="0.1.0",
        lifespan=lifespan,
        # Interactive docs are development-only.
        docs_url=None if settings.is_production else "/docs",
        redoc_url=None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
        max_age=600,
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Cache-Control"] = "no-store"
        if settings.is_production:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

    @app.exception_handler(ProviderError)
    async def provider_error_handler(_request: Request, exc: ProviderError) -> JSONResponse:
        # The internal detail is logged; only the safe envelope is returned.
        if exc.internal_detail:
            logger.warning("provider error code=%s detail=%s", exc.code, exc.internal_detail)
        headers = {}
        if exc.retry_after_seconds:
            headers["Retry-After"] = str(exc.retry_after_seconds)
        return JSONResponse(status_code=exc.status_code, content=exc.to_payload(), headers=headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
        # Field names only. Validation errors echo submitted values by default,
        # which for this API would mean echoing document text.
        fields = sorted({".".join(str(part) for part in error["loc"][1:]) for error in exc.errors()})
        return JSONResponse(
            status_code=422,
            content={
                "code": "invalid_request",
                "message": "That request was not valid.",
                "recovery": f"Check these fields and try again: {', '.join(fields) or 'request body'}.",
                "retryable": False,
                "retryAfterSeconds": None,
            },
        )

    @app.exception_handler(Exception)
    async def unhandled_error_handler(_request: Request, exc: Exception) -> JSONResponse:
        # Logged with a traceback server-side; never returned to the client.
        logger.exception("Unhandled error: %s", type(exc).__name__)
        return JSONResponse(
            status_code=500,
            content={
                "code": "internal_error",
                "message": "Something went wrong on our side. Your reading position has been kept.",
                "recovery": "Try again. If it keeps happening, switch to your browser's built-in voice.",
                "retryable": True,
                "retryAfterSeconds": None,
            },
        )

    app.include_router(health.router)
    app.include_router(tts.router)
    app.include_router(ocr.router)
    return app


app = create_app()
