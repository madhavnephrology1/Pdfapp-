import type { PlaybackSnapshot, PlaybackState, TimingSource } from '@pdfreader/shared-types';

/**
 * Playback as an explicit state machine.
 *
 * Using a machine rather than scattered booleans is what makes the hard
 * requirements testable: changing speed must not restart the document, pausing
 * and resuming must land on the same sentence, and a failed chunk must surface
 * as an error rather than silently skipping content.
 */

export type PlaybackEvent =
  | { type: 'PREPARE'; voiceId: string; provider: string }
  | { type: 'READY' }
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'STOP' }
  | { type: 'BUFFER' }
  | { type: 'SEEK_SENTENCE'; sentenceId: string; paragraphId: string; regionId: string; page: number }
  | { type: 'SEEK_TIME'; audioTimestamp: number }
  | { type: 'SEEK_COMMITTED' }
  | { type: 'TICK'; audioTimestamp: number }
  | { type: 'SENTENCE_ADVANCED'; sentenceId: string; paragraphId: string; regionId: string; page: number }
  | { type: 'WORD_BOUNDARY'; wordIndex: number; source: TimingSource }
  | { type: 'CHUNK_ACTIVE'; chunkId: string }
  | { type: 'SET_SPEED'; speed: number }
  | { type: 'SET_VOLUME'; volume: number }
  | { type: 'SET_VOICE'; voiceId: string; provider: string }
  | { type: 'END_OF_QUEUE' }
  | { type: 'ERROR'; message: string }
  | { type: 'CLEAR_ERROR' };

export const initialPlaybackSnapshot: PlaybackSnapshot = {
  state: 'idle',
  activeSentenceId: null,
  activeParagraphId: null,
  activeRegionId: null,
  activePage: null,
  activeChunkId: null,
  activeWordIndex: null,
  wordTimingSource: 'none',
  audioTimestamp: 0,
  speed: 1,
  volume: 1,
  voiceId: null,
  providerName: null,
  error: null,
};

/** Transitions that may resume playing after a transient state. */
const RESUMABLE: PlaybackState[] = ['playing', 'buffering', 'seeking'];

export function playbackReducer(state: PlaybackSnapshot, event: PlaybackEvent): PlaybackSnapshot {
  switch (event.type) {
    case 'PREPARE':
      return { ...state, state: 'preparing', voiceId: event.voiceId, providerName: event.provider, error: null };

    case 'READY':
      return { ...state, state: state.state === 'preparing' ? 'paused' : state.state };

    case 'PLAY':
      if (state.state === 'error') return state;
      return { ...state, state: 'playing', error: null };

    case 'PAUSE':
      // Pausing preserves the active sentence and audio position, which is what
      // makes resume land in exactly the same place.
      return RESUMABLE.includes(state.state) || state.state === 'preparing'
        ? { ...state, state: 'paused' }
        : state;

    case 'STOP':
      return {
        ...state,
        state: 'stopped',
        audioTimestamp: 0,
        activeWordIndex: null,
        activeChunkId: null,
      };

    case 'BUFFER':
      return state.state === 'playing' ? { ...state, state: 'buffering' } : state;

    case 'SEEK_SENTENCE':
      return {
        ...state,
        state: 'seeking',
        activeSentenceId: event.sentenceId,
        activeParagraphId: event.paragraphId,
        activeRegionId: event.regionId,
        activePage: event.page,
        activeWordIndex: null,
        audioTimestamp: 0,
        error: null,
      };

    case 'SEEK_TIME':
      return { ...state, state: 'seeking', audioTimestamp: Math.max(0, event.audioTimestamp) };

    case 'SEEK_COMMITTED':
      return { ...state, state: state.state === 'seeking' ? 'playing' : state.state };

    case 'TICK':
      return state.state === 'playing' || state.state === 'buffering'
        ? { ...state, state: 'playing', audioTimestamp: event.audioTimestamp }
        : state;

    case 'SENTENCE_ADVANCED':
      return {
        ...state,
        activeSentenceId: event.sentenceId,
        activeParagraphId: event.paragraphId,
        activeRegionId: event.regionId,
        activePage: event.page,
        activeWordIndex: null,
      };

    case 'WORD_BOUNDARY':
      return { ...state, activeWordIndex: event.wordIndex, wordTimingSource: event.source };

    case 'CHUNK_ACTIVE':
      return { ...state, activeChunkId: event.chunkId };

    case 'SET_SPEED':
      // Speed changes NEVER move the playhead or the active sentence. The audio
      // layer applies the new rate in place, or regenerates the current chunk
      // and resumes from the same sentence.
      return { ...state, speed: clampSpeed(event.speed) };

    case 'SET_VOLUME':
      return { ...state, volume: Math.min(1, Math.max(0, event.volume)) };

    case 'SET_VOICE':
      // A new voice invalidates generated audio but not the reading position.
      return {
        ...state,
        voiceId: event.voiceId,
        providerName: event.provider,
        state: state.state === 'playing' ? 'buffering' : state.state,
      };

    case 'END_OF_QUEUE':
      return { ...state, state: 'stopped', activeWordIndex: null };

    case 'ERROR':
      return { ...state, state: 'error', error: event.message };

    case 'CLEAR_ERROR':
      return { ...state, state: state.state === 'error' ? 'paused' : state.state, error: null };

    default:
      return state;
  }
}

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 3;

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(speed * 100) / 100));
}

/** True when the UI should show a "generating audio" indicator. */
export const isBusy = (state: PlaybackState): boolean =>
  state === 'preparing' || state === 'buffering' || state === 'seeking';

/** True when the play control should show a pause icon. */
export const isPlaying = (state: PlaybackState): boolean => state === 'playing' || state === 'buffering';
