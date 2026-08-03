import { describe, expect, it } from 'vitest';
import {
  clampSpeed,
  initialPlaybackSnapshot,
  playbackReducer,
  type PlaybackEvent,
} from '@/features/playback/machine';

const run = (events: PlaybackEvent[], from = initialPlaybackSnapshot) =>
  events.reduce(playbackReducer, from);

describe('playback state machine', () => {
  it('starts idle', () => {
    expect(initialPlaybackSnapshot.state).toBe('idle');
  });

  it('moves through prepare to paused to playing', () => {
    const prepared = run([{ type: 'PREPARE', voiceId: 'v', provider: 'mock' }]);
    expect(prepared.state).toBe('preparing');
    const ready = playbackReducer(prepared, { type: 'READY' });
    expect(ready.state).toBe('paused');
    expect(playbackReducer(ready, { type: 'PLAY' }).state).toBe('playing');
  });

  it('does not autoplay: PREPARE alone never reaches playing', () => {
    const prepared = run([{ type: 'PREPARE', voiceId: 'v', provider: 'mock' }, { type: 'READY' }]);
    expect(prepared.state).not.toBe('playing');
  });

  it('pause then resume keeps the same sentence and timestamp', () => {
    const playing = run([
      { type: 'PREPARE', voiceId: 'v', provider: 'mock' },
      { type: 'READY' },
      { type: 'PLAY' },
      {
        type: 'SENTENCE_ADVANCED',
        sentenceId: 's5',
        paragraphId: 'p1',
        regionId: 'r1',
        page: 3,
      },
      { type: 'TICK', audioTimestamp: 12.5 },
    ]);
    const paused = playbackReducer(playing, { type: 'PAUSE' });
    expect(paused.state).toBe('paused');
    expect(paused.activeSentenceId).toBe('s5');
    expect(paused.audioTimestamp).toBe(12.5);

    const resumed = playbackReducer(paused, { type: 'PLAY' });
    expect(resumed.state).toBe('playing');
    expect(resumed.activeSentenceId).toBe('s5');
    expect(resumed.audioTimestamp).toBe(12.5);
  });

  it('changing speed preserves the active sentence and position', () => {
    const playing = run([
      { type: 'PREPARE', voiceId: 'v', provider: 'mock' },
      { type: 'READY' },
      { type: 'PLAY' },
      {
        type: 'SENTENCE_ADVANCED',
        sentenceId: 's9',
        paragraphId: 'p2',
        regionId: 'r2',
        page: 4,
      },
      { type: 'TICK', audioTimestamp: 30 },
    ]);
    const faster = playbackReducer(playing, { type: 'SET_SPEED', speed: 1.75 });
    expect(faster.speed).toBe(1.75);
    expect(faster.activeSentenceId).toBe('s9');
    expect(faster.audioTimestamp).toBe(30);
    expect(faster.state).toBe('playing');
  });

  it('changing voice keeps the reading position', () => {
    const playing = run([
      { type: 'PREPARE', voiceId: 'v', provider: 'mock' },
      { type: 'READY' },
      { type: 'PLAY' },
      {
        type: 'SENTENCE_ADVANCED',
        sentenceId: 's3',
        paragraphId: 'p1',
        regionId: 'r1',
        page: 1,
      },
    ]);
    const switched = playbackReducer(playing, {
      type: 'SET_VOICE',
      voiceId: 'v2',
      provider: 'browser',
    });
    expect(switched.voiceId).toBe('v2');
    expect(switched.activeSentenceId).toBe('s3');
    expect(switched.state).toBe('buffering');
  });

  it('stop resets the playhead but not the document', () => {
    const stopped = run([
      { type: 'PREPARE', voiceId: 'v', provider: 'mock' },
      { type: 'READY' },
      { type: 'PLAY' },
      {
        type: 'SENTENCE_ADVANCED',
        sentenceId: 's2',
        paragraphId: 'p1',
        regionId: 'r1',
        page: 1,
      },
      { type: 'TICK', audioTimestamp: 8 },
      { type: 'STOP' },
    ]);
    expect(stopped.state).toBe('stopped');
    expect(stopped.audioTimestamp).toBe(0);
    expect(stopped.activeSentenceId).toBe('s2');
  });

  it('seeking to a sentence enters seeking then resumes playing', () => {
    const seeking = run([
      { type: 'PREPARE', voiceId: 'v', provider: 'mock' },
      { type: 'READY' },
      { type: 'PLAY' },
      {
        type: 'SEEK_SENTENCE',
        sentenceId: 's7',
        paragraphId: 'p3',
        regionId: 'r3',
        page: 2,
      },
    ]);
    expect(seeking.state).toBe('seeking');
    expect(seeking.activeSentenceId).toBe('s7');
    expect(playbackReducer(seeking, { type: 'SEEK_COMMITTED' }).state).toBe('playing');
  });

  it('records the timing source with every word boundary', () => {
    const state = playbackReducer(initialPlaybackSnapshot, {
      type: 'WORD_BOUNDARY',
      wordIndex: 4,
      source: 'estimated',
    });
    expect(state.activeWordIndex).toBe(4);
    expect(state.wordTimingSource).toBe('estimated');
  });

  it('enters error state and can recover to paused', () => {
    const errored = playbackReducer(initialPlaybackSnapshot, {
      type: 'ERROR',
      message: 'Provider unavailable',
    });
    expect(errored.state).toBe('error');
    expect(errored.error).toBe('Provider unavailable');
    // PLAY must not silently clear an error.
    expect(playbackReducer(errored, { type: 'PLAY' }).state).toBe('error');
    const cleared = playbackReducer(errored, { type: 'CLEAR_ERROR' });
    expect(cleared.state).toBe('paused');
    expect(cleared.error).toBeNull();
  });

  it('advancing a sentence clears the stale word highlight', () => {
    const state = run([
      { type: 'WORD_BOUNDARY', wordIndex: 6, source: 'provider-exact' },
      {
        type: 'SENTENCE_ADVANCED',
        sentenceId: 's2',
        paragraphId: 'p1',
        regionId: 'r1',
        page: 1,
      },
    ]);
    expect(state.activeWordIndex).toBeNull();
  });

  it('clamps volume to 0..1', () => {
    expect(
      playbackReducer(initialPlaybackSnapshot, {
        type: 'SET_VOLUME',
        volume: 2,
      }).volume,
    ).toBe(1);
    expect(
      playbackReducer(initialPlaybackSnapshot, {
        type: 'SET_VOLUME',
        volume: -1,
      }).volume,
    ).toBe(0);
  });
});

describe('clampSpeed', () => {
  it.each([
    [0.1, 0.5],
    [0.5, 0.5],
    [1, 1],
    [2.5, 2.5],
    [9, 3],
    [Number.NaN, 1],
  ])('clamps %s to %s', (input, expected) => {
    expect(clampSpeed(input)).toBe(expected);
  });
});
