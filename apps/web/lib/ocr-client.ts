import type { NormalizedError, OCRPageResult } from '@pdfreader/shared-types';
import { API_BASE } from './tts-client';

/**
 * Client for the server text-recognition API.
 *
 * A page image leaves this device when — and only when — this is called. The
 * caller must have obtained explicit consent naming the provider first; the
 * server refuses the request without the consent flag, so a bug here fails
 * closed rather than sending the image anyway.
 */

export class OCRClientError extends Error {
  constructor(readonly normalized: NormalizedError) {
    super(normalized.message);
    this.name = 'OCRClientError';
  }
}

const GENERIC_NETWORK_ERROR: NormalizedError = {
  code: 'provider_unavailable',
  message: 'The text-recognition service could not be reached.',
  recovery: 'Check your connection and try this page again.',
  retryable: true,
};

async function parseError(response: Response): Promise<NormalizedError> {
  try {
    const body = await response.json();
    if (body && typeof body.code === 'string' && typeof body.message === 'string') {
      return body as NormalizedError;
    }
  } catch {
    // Never surface a raw response body: it can carry provider detail.
  }
  return GENERIC_NETWORK_ERROR;
}

export interface RecognizePageParams {
  /** Base64 of the rendered page image, without a data: prefix. */
  image: string;
  mimeType: string;
  pageNumber: number;
  documentId: string;
  languageHints?: string[];
  /**
   * The reader's explicit agreement to send this image to the named provider.
   * There is no default: a caller has to state it.
   */
  consent: boolean;
  signal?: AbortSignal;
}

export async function recognizePage(params: RecognizePageParams): Promise<OCRPageResult> {
  const { signal, ...body } = params;

  // Belt and braces. The server enforces this too, but refusing here means an
  // interface bug cannot put an image on the wire.
  if (!body.consent) {
    throw new OCRClientError({
      code: 'invalid_request',
      message: 'This page image was not sent, because you have not agreed to send page images.',
      recovery: 'Turn on text recognition in Settings if you want scanned pages processed.',
      retryable: false,
    });
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/ocr/page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new OCRClientError(GENERIC_NETWORK_ERROR);
  }

  if (!response.ok) throw new OCRClientError(await parseError(response));
  return (await response.json()) as OCRPageResult;
}
