"""Upload validation.

File type is decided by the file's own bytes, never by its name or the
client-supplied content type. Names are sanitized before they are ever used to
build a path.
"""

from __future__ import annotations

import re
import unicodedata

from app.core.errors import ProviderError

PDF_MAGIC = b"%PDF-"
# A PDF must contain a trailer marker; a file that has the header but no EOF
# marker is truncated.
PDF_EOF = b"%%EOF"

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")
_LEADING_DOTS = re.compile(r"^\.+")


def sanitize_filename(name: str, fallback: str = "document.pdf") -> str:
    """Reduces a filename to a safe basename.

    Strips directory components, unicode tricks, and anything that is not a
    plain character, so the result can never traverse a path.
    """
    if not name:
        return fallback
    # Take the basename under both separators before anything else.
    base = name.replace("\\", "/").split("/")[-1]
    base = unicodedata.normalize("NFKD", base)
    base = base.encode("ascii", "ignore").decode("ascii")
    base = _UNSAFE.sub("_", base)
    base = _LEADING_DOTS.sub("", base)
    base = base.strip("._")
    if not base:
        return fallback
    return base[:120]


def validate_pdf_signature(data: bytes) -> None:
    """Raises unless the bytes really are a PDF."""
    if len(data) < len(PDF_MAGIC):
        raise ProviderError(
            code="invalid_request",
            message="That file is empty.",
            recovery="Choose a PDF file and try again.",
        )
    if not data.startswith(PDF_MAGIC):
        raise ProviderError(
            code="invalid_request",
            message="That file is not a PDF.",
            recovery="Choose a file whose contents are a PDF, then try again.",
        )
    # Only inspect the tail; a valid PDF ends with the EOF marker.
    if PDF_EOF not in data[-2048:]:
        raise ProviderError(
            code="invalid_request",
            message="That PDF looks incomplete or damaged.",
            recovery="Re-download or re-export the file, then try again.",
        )


def validate_upload_size(size: int, max_bytes: int) -> None:
    if size > max_bytes:
        raise ProviderError(
            code="invalid_request",
            message=(
                f"That file is {size / 1_048_576:.0f} MB, which is larger than the "
                f"{max_bytes / 1_048_576:.0f} MB limit for this deployment."
            ),
            recovery="Split the document, or raise MAX_UPLOAD_SIZE_MB if you run this yourself.",
        )
