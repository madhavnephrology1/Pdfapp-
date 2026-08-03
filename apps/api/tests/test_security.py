from __future__ import annotations

import logging
import time
from pathlib import Path

import pytest

from app.core.errors import ProviderError
from app.core.logging import RedactingFilter
from app.providers.tts.base import TTSResult
from app.security.rate_limit import RateLimiter
from app.security.uploads import sanitize_filename, validate_pdf_signature, validate_upload_size
from app.services.audio_cache import AudioCache
from app.services.temp_files import TempFileStore


class TestSanitizeFilename:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("report.pdf", "report.pdf"),
            ("../../etc/passwd", "passwd"),
            ("..\\..\\windows\\system32", "system32"),
            ("/absolute/path/doc.pdf", "doc.pdf"),
            ("....//....//evil.pdf", "evil.pdf"),
            ("naïve résumé.pdf", "naive_resume.pdf"),
            ("file\x00name.pdf", "file_name.pdf"),
            ("", "document.pdf"),
            ("...", "document.pdf"),
            ("   ", "document.pdf"),
        ],
    )
    def test_reduces_to_a_safe_basename(self, raw: str, expected: str) -> None:
        assert sanitize_filename(raw) == expected

    def test_never_yields_a_path_separator(self) -> None:
        for raw in ["a/b/c.pdf", "a\\b\\c.pdf", "../..", "%2e%2e/x"]:
            result = sanitize_filename(raw)
            assert "/" not in result and "\\" not in result

    def test_truncates_very_long_names(self) -> None:
        assert len(sanitize_filename("a" * 500 + ".pdf")) <= 120


class TestPdfSignature:
    def test_accepts_a_real_pdf(self) -> None:
        validate_pdf_signature(b"%PDF-1.4\n...body...\ntrailer\n%%EOF\n")

    def test_rejects_a_renamed_non_pdf(self) -> None:
        with pytest.raises(ProviderError) as excinfo:
            validate_pdf_signature(b"\x89PNG\r\n\x1a\n" + b"0" * 100 + b"%%EOF")
        assert "not a PDF" in excinfo.value.message

    def test_rejects_an_empty_file(self) -> None:
        with pytest.raises(ProviderError) as excinfo:
            validate_pdf_signature(b"")
        assert "empty" in excinfo.value.message

    def test_rejects_a_truncated_pdf(self) -> None:
        with pytest.raises(ProviderError) as excinfo:
            validate_pdf_signature(b"%PDF-1.4\n" + b"x" * 5000)
        assert "incomplete" in excinfo.value.message

    def test_ignores_the_declared_content_type(self) -> None:
        # The decision is made from bytes alone; there is no content-type input.
        with pytest.raises(ProviderError):
            validate_pdf_signature(b"GIF89a" + b"%%EOF")


class TestUploadSize:
    def test_accepts_within_the_limit(self) -> None:
        validate_upload_size(1024, 2048)

    def test_rejects_over_the_limit_with_the_actual_numbers(self) -> None:
        with pytest.raises(ProviderError) as excinfo:
            validate_upload_size(200 * 1_048_576, 100 * 1_048_576)
        assert "200 MB" in excinfo.value.message
        assert "100 MB" in excinfo.value.message


class TestRateLimiter:
    def test_allows_up_to_the_limit(self) -> None:
        limiter = RateLimiter(limit_per_minute=3)
        for _ in range(3):
            assert limiter.check("client", now=100.0)[0] is True
        allowed, retry_after = limiter.check("client", now=100.0)
        assert allowed is False
        assert retry_after > 0

    def test_tracks_clients_independently(self) -> None:
        limiter = RateLimiter(limit_per_minute=1)
        assert limiter.check("a", now=0.0)[0] is True
        assert limiter.check("b", now=0.0)[0] is True
        assert limiter.check("a", now=0.0)[0] is False

    def test_window_resets_after_a_minute(self) -> None:
        limiter = RateLimiter(limit_per_minute=1)
        assert limiter.check("a", now=0.0)[0] is True
        assert limiter.check("a", now=30.0)[0] is False
        assert limiter.check("a", now=61.0)[0] is True

    def test_zero_limit_disables_limiting(self) -> None:
        limiter = RateLimiter(limit_per_minute=0)
        for _ in range(100):
            assert limiter.check("a", now=0.0)[0] is True


class TestAudioCache:
    def _result(self, marker: bytes = b"audio") -> TTSResult:
        return TTSResult(
            chunk_id="c",
            audio=marker,
            mime_type="audio/wav",
            provider="mock",
            voice_id="v",
        )

    def test_stores_and_returns(self) -> None:
        cache = AudioCache(max_entries=4, ttl_seconds=60)
        cache.put("k", self._result(), now=0.0)
        assert cache.get("k", now=1.0).audio == b"audio"

    def test_misses_after_the_ttl(self) -> None:
        cache = AudioCache(max_entries=4, ttl_seconds=60)
        cache.put("k", self._result(), now=0.0)
        assert cache.get("k", now=61.0) is None

    def test_evicts_least_recently_used(self) -> None:
        cache = AudioCache(max_entries=2, ttl_seconds=600)
        cache.put("a", self._result(b"a"), now=0.0)
        cache.put("b", self._result(b"b"), now=0.0)
        cache.get("a", now=1.0)  # refresh a
        cache.put("c", self._result(b"c"), now=2.0)
        assert cache.get("a", now=3.0) is not None
        assert cache.get("b", now=3.0) is None
        assert cache.get("c", now=3.0) is not None

    def test_clear_empties_everything(self) -> None:
        cache = AudioCache(max_entries=4, ttl_seconds=60)
        cache.put("a", self._result(), now=0.0)
        cache.put("b", self._result(), now=0.0)
        assert cache.clear() == 2
        assert len(cache) == 0

    def test_purge_expired_removes_only_stale_entries(self) -> None:
        cache = AudioCache(max_entries=4, ttl_seconds=60)
        cache.put("old", self._result(), now=0.0)
        cache.put("new", self._result(), now=50.0)
        assert cache.purge_expired(now=70.0) == 1
        assert cache.get("new", now=70.0) is not None


class TestTempFileStore:
    def test_deletes_the_file_when_the_block_exits(self, tmp_path: Path) -> None:
        store = TempFileStore(tmp_path, retention_minutes=60)
        with store.temporary_file(".png") as path:
            path.write_bytes(b"data")
            assert path.exists()
        assert not path.exists()

    def test_deletes_the_file_even_when_the_block_raises(self, tmp_path: Path) -> None:
        store = TempFileStore(tmp_path, retention_minutes=60)
        captured: Path | None = None
        with pytest.raises(RuntimeError):
            with store.temporary_file() as path:
                captured = path
                raise RuntimeError("boom")
        assert captured is not None and not captured.exists()

    def test_creates_owner_only_files(self, tmp_path: Path) -> None:
        store = TempFileStore(tmp_path, retention_minutes=60)
        with store.temporary_file() as path:
            assert oct(path.stat().st_mode)[-3:] == "600"

    def test_uses_unguessable_names(self, tmp_path: Path) -> None:
        store = TempFileStore(tmp_path, retention_minutes=60)
        with store.temporary_file() as first, store.temporary_file() as second:
            assert first.name != second.name
            assert len(first.stem) >= 32

    def test_sweep_removes_files_past_retention(self, tmp_path: Path) -> None:
        store = TempFileStore(tmp_path, retention_minutes=1)
        stale = tmp_path / "stale.tmp"
        stale.write_bytes(b"x")
        fresh = tmp_path / "fresh.tmp"
        fresh.write_bytes(b"x")
        import os

        os.utime(stale, (time.time() - 3600, time.time() - 3600))
        assert store.sweep() == 1
        assert not stale.exists()
        assert fresh.exists()

    def test_purge_all_removes_everything(self, tmp_path: Path) -> None:
        store = TempFileStore(tmp_path, retention_minutes=60)
        (tmp_path / "a.tmp").write_bytes(b"x")
        (tmp_path / "b.tmp").write_bytes(b"x")
        assert store.purge_all() == 2


class TestRedactingFilter:
    def _record(self, message: str) -> logging.LogRecord:
        return logging.LogRecord("t", logging.INFO, "f", 1, message, None, None)

    @pytest.mark.parametrize(
        "message",
        [
            "calling provider with api_key=sk-abcdefghijklmnopqrstuvwxyz",
            "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz",
            "xi-api-key: 0123456789abcdef0123456789abcdef",
        ],
    )
    def test_redacts_credentials(self, message: str) -> None:
        record = self._record(message)
        RedactingFilter().filter(record)
        assert "sk-abcdefghijklmnopqrstuvwxyz" not in record.getMessage()
        assert "0123456789abcdef0123456789abcdef" not in record.getMessage()

    def test_leaves_ordinary_messages_alone(self) -> None:
        record = self._record("synthesize chunk=doc:chunk0 chars=120")
        RedactingFilter().filter(record)
        assert record.getMessage() == "synthesize chunk=doc:chunk0 chars=120"
