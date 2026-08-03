import type { TimingSource } from './tts';

export type PlaybackState =
  'idle' | 'preparing' | 'buffering' | 'playing' | 'paused' | 'seeking' | 'stopped' | 'error';

export type ChunkStatus = 'queued' | 'generating' | 'ready' | 'failed' | 'cancelled';

export interface ChunkRuntimeState {
  chunkId: string;
  status: ChunkStatus;
  /** Object URL for generated audio, when ready. */
  audioUrl?: string;
  durationSeconds?: number;
  timingSource?: TimingSource;
  error?: string;
  attempts: number;
}

export interface PlaybackSnapshot {
  state: PlaybackState;
  activeSentenceId: string | null;
  activeParagraphId: string | null;
  activeRegionId: string | null;
  activePage: number | null;
  activeChunkId: string | null;
  /** Index of the highlighted word within the active sentence, or null. */
  activeWordIndex: number | null;
  /**
   * Whether the word highlight is derived from real provider/browser boundaries
   * or from a duration estimate. Surfaced in the UI verbatim.
   */
  wordTimingSource: TimingSource;
  audioTimestamp: number;
  speed: number;
  volume: number;
  voiceId: string | null;
  providerName: string | null;
  error: string | null;
}

export interface ReadingPosition {
  fingerprint: string;
  fileName: string;
  lastOpenedAt: number;
  lastPage: number;
  lastSentenceId: string | null;
  lastWordIndex: number | null;
  lastAudioTimestamp: number;
}
