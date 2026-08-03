/** Provider-neutral TTS contracts shared by the web app and the API. */

export interface TTSVoice {
  id: string;
  name: string;
  language: string;
  /** Provider that owns this voice, e.g. "openai", "browser". */
  provider: string;
  gender?: 'male' | 'female' | 'neutral' | 'unspecified';
  /** True when the provider markets this as a neural / premium voice. */
  neural?: boolean;
  previewUrl?: string;
}

export interface TTSRequest {
  text: string;
  voiceId: string;
  /** 1.0 = natural rate. */
  speed: number;
  language?: string;
  /** Opaque id echoed back so the client can match a response to a queue slot. */
  chunkId: string;
  /** Client-computed cache key; the server uses it verbatim for cache lookup. */
  cacheKey: string;
  format?: 'mp3' | 'wav' | 'opus';
}

export type TimingSource = 'provider-exact' | 'browser-boundary' | 'estimated' | 'none';

export interface WordTiming {
  /** Character offset of the word within the chunk text. */
  start: number;
  end: number;
  /** Seconds from the start of the chunk audio. */
  audioStart: number;
  audioEnd: number;
}

export interface SentenceTiming {
  sentenceId: string;
  audioStart: number;
  audioEnd: number;
}

export interface TTSResult {
  chunkId: string;
  /** Base64 audio payload. */
  audio: string;
  mimeType: string;
  durationSeconds?: number;
  /**
   * How the timing below was produced. NEVER report 'provider-exact' unless the
   * provider actually returned word boundaries.
   */
  timingSource: TimingSource;
  wordTimings?: WordTiming[];
  sentenceTimings?: SentenceTiming[];
  provider: string;
  voiceId: string;
  cached: boolean;
}

export interface TTSCapabilities {
  provider: string;
  supportsStreaming: boolean;
  supportsWordTiming: boolean;
  supportsSentenceTiming: boolean;
  supportsPitch: boolean;
  supportedSpeedRange: { min: number; max: number };
  maxCharsPerChunk: number;
}

/** Provider-neutral interface implemented on both the server and the browser fallback. */
export interface TTSProvider {
  readonly name: string;
  listVoices(): Promise<TTSVoice[]>;
  synthesize(request: TTSRequest): Promise<TTSResult>;
  readonly supportsStreaming: boolean;
  readonly supportsWordTiming: boolean;
  readonly supportsSentenceTiming: boolean;
  readonly supportsPitch: boolean;
  readonly supportedSpeedRange: { min: number; max: number };
}

export interface TTSChunk {
  id: string;
  documentId: string;
  /** Text sent to the provider, byte-for-byte. */
  text: string;
  /** Sentences contained in this chunk, in reading order. */
  sentenceIds: string[];
  /** Character offset of each sentence within `text`. */
  sentenceOffsets: { sentenceId: string; start: number; end: number }[];
  pageNumbers: number[];
  /** Deterministic hash of the chunk text. */
  textHash: string;
  /** Full cache key: provider + voice + speed + language + textHash. */
  cacheKey: string;
  index: number;
  /**
   * True when this chunk continues the previous one WITHOUT a word break,
   * because a single word exceeded the provider's character limit. Concatenating
   * chunk texts must not insert a space at such a boundary.
   *
   * Mid-word splits are audible; they only happen for words longer than the
   * provider limit, which in practice means malformed text-layer output.
   */
  continuesMidWord?: boolean;
}

export type ProviderErrorCode =
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'invalid_voice'
  | 'invalid_request'
  | 'unsupported_speed'
  | 'text_too_long'
  | 'not_configured'
  | 'internal_error';

/** Normalized error envelope. Never carries stack traces or provider payloads. */
export interface NormalizedError {
  code: ProviderErrorCode;
  /** Plain-language message shown directly to users. */
  message: string;
  /** Suggested user-facing recovery action. */
  recovery?: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}
