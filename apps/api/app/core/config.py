"""Application configuration.

Every provider credential is read here, on the server, and never leaves it.
The web client talks only to this API and never holds a provider key.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    app_env: str = "development"
    # Comma-separated. Both loopback spellings are allowed by default because a
    # browser treats them as different origins and either may be used locally.
    web_origin: str = "http://localhost:3000,http://127.0.0.1:3000"
    api_host: str = "0.0.0.0"
    api_port: int = 8000

    # --- Text to speech -------------------------------------------------
    # Empty means "no server provider configured"; the client then uses the
    # browser's own speech synthesis and the UI says so.
    tts_provider: str = ""
    tts_api_key: str = ""
    tts_region: str = ""
    tts_default_voice: str = ""
    tts_request_timeout_seconds: float = 30.0
    tts_max_chars_per_chunk: int = 2500

    # --- Optical character recognition ----------------------------------
    ocr_provider: str = ""
    ocr_api_key: str = ""
    ocr_region: str = ""
    # A page image is a much larger request than a passage of text, and a dense
    # scan can take a while to recognise, so this is longer than the TTS one.
    ocr_request_timeout_seconds: float = 60.0

    # --- Temporary files -------------------------------------------------
    temp_file_directory: str = ""
    temp_file_retention_minutes: int = 60

    # --- Limits and rate control ------------------------------------------
    max_upload_size_mb: int = 100
    rate_limit_tts_per_minute: int = 20
    rate_limit_ocr_per_minute: int = 10

    # --- Logging -----------------------------------------------------------
    log_level: str = "INFO"
    # MUST stay false in production: enabling it writes document text to logs.
    log_document_content: bool = False

    # --- Audio cache --------------------------------------------------------
    audio_cache_max_entries: int = 512
    audio_cache_ttl_minutes: int = 60

    @field_validator("tts_provider", "ocr_provider", mode="before")
    @classmethod
    def _normalize_provider(cls, value: str | None) -> str:
        return (value or "").strip().lower()

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.web_origin.split(",") if origin.strip()]

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_size_mb * 1024 * 1024

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() in {"production", "prod"}

    @property
    def temp_dir(self) -> Path:
        base = self.temp_file_directory or os.path.join(os.getcwd(), "tmp", "pdf-human-reader")
        path = Path(base)
        path.mkdir(parents=True, exist_ok=True)
        return path

    def content_logging_enabled(self) -> bool:
        """Document content is never logged in production, whatever the flag says."""
        return self.log_document_content and not self.is_production


@lru_cache
def get_settings() -> Settings:
    return Settings()
