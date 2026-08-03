from __future__ import annotations

import base64
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.main import create_app
from app.security.rate_limit import reset_all_limiters


@pytest.fixture(autouse=True)
def _clear_settings_cache() -> Iterator[None]:
    get_settings.cache_clear()
    reset_all_limiters()
    yield
    get_settings.cache_clear()
    reset_all_limiters()


def build_client(monkeypatch: pytest.MonkeyPatch, **env: str) -> TestClient:
    """Builds an app whose settings come only from the values given here."""
    defaults = {
        "APP_ENV": "test",
        "TTS_PROVIDER": "",
        "OCR_PROVIDER": "",
        "TTS_API_KEY": "",
        "LOG_LEVEL": "CRITICAL",
        "LOG_DOCUMENT_CONTENT": "false",
    }
    defaults.update(env)
    for key, value in defaults.items():
        monkeypatch.setenv(key, value)

    # Settings read .env files by default; tests must not depend on the host's.
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    get_settings.cache_clear()
    return TestClient(create_app())


@pytest.fixture
def mock_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    with build_client(monkeypatch, TTS_PROVIDER="mock", OCR_PROVIDER="mock") as client:
        yield client


@pytest.fixture
def unconfigured_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    with build_client(monkeypatch) as client:
        yield client


def tiny_png_base64() -> str:
    """A 1x1 PNG, used to exercise the OCR route without shipping an image."""
    png = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
        "890000000a49444154789c6300010000050001"
        "0d0a2db4"
        "0000000049454e44ae426082"
    )
    return base64.b64encode(png).decode("ascii")
