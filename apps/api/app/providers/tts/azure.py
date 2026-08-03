"""Azure Cognitive Services speech adapter (REST).

Speed is applied natively through SSML prosody, so a rate change is synthesized
rather than resampled. The REST endpoint returns no word boundaries — those are
only available over the streaming SDK — so this adapter reports no timing and
the client shows clearly-labelled estimated word progress.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

import httpx

from app.core.errors import ProviderError

from .base import TTSCapabilities, TTSProvider, TTSRequest, TTSResult, TTSVoice

OUTPUT_FORMAT = "audio-24khz-96kbitrate-mono-mp3"


class AzureTTSProvider(TTSProvider):
    name = "azure"

    def __init__(self, api_key: str, region: str, timeout: float) -> None:
        if not api_key or not region:
            raise ProviderError(
                code="not_configured",
                message="The speech provider is not configured for this deployment.",
            )
        self._api_key = api_key
        self._region = region
        self._client = httpx.AsyncClient(timeout=timeout)

    async def list_voices(self) -> list[TTSVoice]:
        url = f"https://{self._region}.tts.speech.microsoft.com/cognitiveservices/voices/list"
        try:
            response = await self._client.get(url, headers={"Ocp-Apim-Subscription-Key": self._api_key})
        except httpx.HTTPError as exc:
            raise ProviderError(
                code="provider_unavailable",
                message="The list of voices could not be loaded.",
                retryable=True,
                internal_detail=type(exc).__name__,
            ) from exc

        if response.status_code >= 400:
            raise _normalize_http_error(response)

        return [
            TTSVoice(
                id=entry.get("ShortName", ""),
                name=entry.get("DisplayName", entry.get("ShortName", "Voice")),
                language=entry.get("Locale", "en-US"),
                provider=self.name,
                gender=str(entry.get("Gender", "unspecified")).lower(),
                neural=entry.get("VoiceType", "").lower().startswith("neural"),
            )
            for entry in response.json()
        ]

    @property
    def capabilities(self) -> TTSCapabilities:
        return TTSCapabilities(
            provider=self.name,
            supports_streaming=False,
            # Word boundaries require the streaming SDK, not this REST endpoint.
            supports_word_timing=False,
            supports_sentence_timing=False,
            supports_pitch=True,
            speed_min=0.5,
            speed_max=2.0,
            max_chars_per_chunk=2500,
        )

    async def synthesize(self, request: TTSRequest) -> TTSResult:
        caps = self.capabilities
        if len(request.text) > caps.max_chars_per_chunk:
            raise ProviderError(
                code="text_too_long",
                message="This passage is longer than the speech provider accepts in one request.",
            )
        if not caps.speed_min <= request.speed <= caps.speed_max:
            raise ProviderError(
                code="unsupported_speed",
                message=f"This voice supports speeds from {caps.speed_min}x to {caps.speed_max}x.",
            )

        url = f"https://{self._region}.tts.speech.microsoft.com/cognitiveservices/v1"
        try:
            response = await self._client.post(
                url,
                headers={
                    "Ocp-Apim-Subscription-Key": self._api_key,
                    "Content-Type": "application/ssml+xml",
                    "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
                    "User-Agent": "pdf-human-reader",
                },
                content=build_ssml(request).encode("utf-8"),
            )
        except httpx.TimeoutException as exc:
            raise ProviderError(
                code="provider_timeout",
                message="The speech provider did not respond in time.",
                retryable=True,
                internal_detail=type(exc).__name__,
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(
                code="provider_unavailable",
                message="The speech provider could not be reached.",
                retryable=True,
                internal_detail=type(exc).__name__,
            ) from exc

        if response.status_code >= 400:
            raise _normalize_http_error(response)

        return TTSResult(
            chunk_id=request.chunk_id,
            audio=response.content,
            mime_type="audio/mpeg",
            provider=self.name,
            voice_id=request.voice_id,
            timing_source="none",
        )

    async def aclose(self) -> None:
        await self._client.aclose()


def build_ssml(request: TTSRequest) -> str:
    """Builds SSML with the document text safely escaped.

    The text is inserted through the XML serializer rather than string
    formatting, so a document containing '<' or '&' cannot alter the markup.
    """
    speak = ET.Element(
        "speak",
        {
            "version": "1.0",
            "xmlns": "http://www.w3.org/2001/10/synthesis",
            "xml:lang": request.language,
        },
    )
    voice = ET.SubElement(speak, "voice", {"name": request.voice_id})
    percent = round((request.speed - 1) * 100)
    prosody = ET.SubElement(voice, "prosody", {"rate": f"{percent:+d}%"})
    prosody.text = request.text
    return ET.tostring(speak, encoding="unicode")


def _normalize_http_error(response: httpx.Response) -> ProviderError:
    status = response.status_code
    if status in (401, 403):
        return ProviderError(
            code="not_configured",
            message="The speech provider rejected this deployment's credentials.",
            internal_detail=f"http {status}",
        )
    if status == 429:
        return ProviderError(
            code="rate_limited",
            message="The speech provider is rate limiting this deployment.",
            retryable=True,
            retry_after_seconds=10,
            internal_detail=f"http {status}",
        )
    if status == 400:
        return ProviderError(
            code="invalid_request",
            message="The speech provider rejected this request.",
            internal_detail=f"http {status}",
        )
    if status >= 500:
        return ProviderError(
            code="provider_unavailable",
            message="The speech provider is temporarily unavailable.",
            retryable=True,
            internal_detail=f"http {status}",
        )
    return ProviderError(
        code="internal_error",
        message="The speech request could not be completed.",
        internal_detail=f"http {status}",
    )
