import type { NormalizedError, TTSCapabilities, TTSResult, TTSVoice } from '@pdfreader/shared-types';

/**
 * Client for the server speech API.
 *
 * The browser never holds a provider credential: it asks this app's own API,
 * which holds the key and normalizes every provider error.
 */

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000';

export interface ServerVoices {
  configured: boolean;
  provider: string | null;
  voices: TTSVoice[];
  capabilities: TTSCapabilities | null;
  defaultVoiceId: string | null;
}

export class TTSClientError extends Error {
  constructor(readonly normalized: NormalizedError) {
    super(normalized.message);
    this.name = 'TTSClientError';
  }
}

const GENERIC_NETWORK_ERROR: NormalizedError = {
  code: 'provider_unavailable',
  message: 'The speech service could not be reached.',
  recovery: "Check your connection, or switch to your browser's built-in voice in the player.",
  retryable: true,
};

async function parseError(response: Response): Promise<NormalizedError> {
  try {
    const body = await response.json();
    if (body && typeof body.code === 'string' && typeof body.message === 'string') {
      return body as NormalizedError;
    }
  } catch {
    // Fall through to the generic message; never surface a raw response body.
  }
  return GENERIC_NETWORK_ERROR;
}

export async function fetchServerVoices(signal?: AbortSignal): Promise<ServerVoices> {
  try {
    const response = await fetch(`${API_BASE}/api/tts/voices`, { signal });
    if (!response.ok) throw new TTSClientError(await parseError(response));
    return (await response.json()) as ServerVoices;
  } catch (error) {
    if (error instanceof TTSClientError) throw error;
    if ((error as Error)?.name === 'AbortError') throw error;
    // The API being absent is a supported state, not a failure: the app falls
    // back to browser speech and says so.
    return { configured: false, provider: null, voices: [], capabilities: null, defaultVoiceId: null };
  }
}

export interface SynthesizeParams {
  text: string;
  voiceId: string;
  speed: number;
  language: string;
  chunkId: string;
  cacheKey: string;
  format?: 'mp3' | 'wav' | 'opus';
  signal?: AbortSignal;
}

export async function synthesizeChunk(params: SynthesizeParams): Promise<TTSResult> {
  const { signal, ...body } = params;
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/tts/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, format: body.format ?? 'mp3' }),
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new TTSClientError(GENERIC_NETWORK_ERROR);
  }

  if (!response.ok) throw new TTSClientError(await parseError(response));

  const payload = await response.json();
  return {
    chunkId: payload.chunkId,
    audio: payload.audio,
    mimeType: payload.mimeType,
    durationSeconds: payload.durationSeconds ?? undefined,
    // Passed through untouched. The client never claims better timing than the
    // server reported.
    timingSource: payload.timingSource,
    wordTimings: payload.wordTimings,
    provider: payload.provider,
    voiceId: payload.voiceId,
    cached: payload.cached,
  };
}

export async function clearServerAudioCache(): Promise<number> {
  try {
    const response = await fetch(`${API_BASE}/api/tts/cache/clear`, { method: 'POST' });
    if (!response.ok) return 0;
    return (await response.json()).cleared ?? 0;
  } catch {
    return 0;
  }
}

export interface ServerHealth {
  status: string;
  ttsProvider: string | null;
  ocrProvider: string | null;
  contentLoggingEnabled: boolean;
}

/** Which third parties this deployment is configured to use; shown in the privacy notice. */
export async function fetchHealth(): Promise<ServerHealth | null> {
  try {
    const response = await fetch(`${API_BASE}/api/health`);
    if (!response.ok) return null;
    return (await response.json()) as ServerHealth;
  } catch {
    return null;
  }
}

/** Converts a base64 payload into a playable object URL. */
export function audioUrlFromBase64(base64: string, mimeType: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}
