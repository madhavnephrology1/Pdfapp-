import { describe, expect, it } from 'vitest';
import type { TTSChunk } from '@pdfreader/shared-types';
import {
  estimateRemainingSeconds,
  estimateSentenceTimings,
  formatTime,
  isEstimatedTiming,
  sentenceAtTime,
  timingSourceLabel,
  wordProgress,
  wordTimingsForSentence,
} from '@/features/playback/timing';

const chunk: TTSChunk = {
  id: 'c0',
  documentId: 'doc',
  text: 'First sentence here. Second sentence here.',
  sentenceIds: ['s0', 's1'],
  sentenceOffsets: [
    { sentenceId: 's0', start: 0, end: 20 },
    { sentenceId: 's1', start: 21, end: 42 },
  ],
  pageNumbers: [1],
  textHash: 'h',
  cacheKey: 'k',
  index: 0,
};

describe('sentenceAtTime', () => {
  it('uses provider sentence timings when available', () => {
    const timings = [
      { sentenceId: 's0', audioStart: 0, audioEnd: 2 },
      { sentenceId: 's1', audioStart: 2, audioEnd: 5 },
    ];
    expect(sentenceAtTime(chunk, 1, 5, timings)).toBe('s0');
    expect(sentenceAtTime(chunk, 3, 5, timings)).toBe('s1');
  });

  it('falls back to a character-share estimate', () => {
    expect(sentenceAtTime(chunk, 0.1, 10)).toBe('s0');
    expect(sentenceAtTime(chunk, 9, 10)).toBe('s1');
  });

  it('never returns past the end of the chunk', () => {
    expect(sentenceAtTime(chunk, 999, 10)).toBe('s1');
  });
});

describe('wordProgress', () => {
  const sentenceText = 'One two three four five.';

  it('uses provider word timings and reports exact', () => {
    const result = wordProgress({
      sentenceText,
      elapsedInSentence: 1.1,
      sentenceDuration: 2.5,
      timingSource: 'provider-exact',
      wordTimings: [
        { start: 0, end: 3, audioStart: 0, audioEnd: 0.5 },
        { start: 4, end: 7, audioStart: 0.5, audioEnd: 1 },
        { start: 8, end: 13, audioStart: 1, audioEnd: 1.5 },
      ],
    });
    expect(result).toEqual({ wordIndex: 2, source: 'provider-exact', estimated: false });
  });

  it('uses browser boundary character offsets and reports exact', () => {
    const result = wordProgress({
      sentenceText,
      elapsedInSentence: 0,
      sentenceDuration: 2.5,
      timingSource: 'browser-boundary',
      browserCharIndex: 8,
    });
    expect(result).toEqual({ wordIndex: 2, source: 'browser-boundary', estimated: false });
  });

  it('falls back to a proportional estimate and LABELS it estimated', () => {
    const result = wordProgress({
      sentenceText,
      elapsedInSentence: 1.25,
      sentenceDuration: 2.5,
      timingSource: 'estimated',
    });
    expect(result!.estimated).toBe(true);
    expect(result!.source).toBe('estimated');
  });

  it('never reports exact timing when the provider gave none', () => {
    // Even if the caller claims 'provider-exact', absent timings degrade to an
    // estimate rather than fabricating an exact position.
    const result = wordProgress({
      sentenceText,
      elapsedInSentence: 1,
      sentenceDuration: 2,
      timingSource: 'provider-exact',
      wordTimings: undefined,
    });
    expect(result!.estimated).toBe(true);
    expect(result!.source).toBe('estimated');
  });

  it('returns null for an empty sentence', () => {
    expect(
      wordProgress({ sentenceText: '   ', elapsedInSentence: 0, sentenceDuration: 1, timingSource: 'none' }),
    ).toBeNull();
  });

  it('never runs past the last word', () => {
    const result = wordProgress({
      sentenceText,
      elapsedInSentence: 100,
      sentenceDuration: 2,
      timingSource: 'estimated',
    });
    expect(result!.wordIndex).toBe(4);
  });
});

describe('estimateSentenceTimings', () => {
  it('splits the duration by character share', () => {
    const timings = estimateSentenceTimings(chunk, 10);
    expect(timings).toHaveLength(2);
    expect(timings[0].audioStart).toBe(0);
    expect(timings[1].audioEnd).toBeCloseTo(10, 5);
  });
});

describe('wordTimingsForSentence', () => {
  it('rebases timings to the sentence start', () => {
    const result = wordTimingsForSentence(chunk, 's1', [
      { start: 0, end: 5, audioStart: 0, audioEnd: 1 },
      { start: 21, end: 27, audioStart: 2, audioEnd: 3 },
      { start: 28, end: 36, audioStart: 3, audioEnd: 4 },
    ]);
    expect(result).toEqual([
      { start: 0, end: 6, audioStart: 0, audioEnd: 1 },
      { start: 7, end: 15, audioStart: 1, audioEnd: 2 },
    ]);
  });

  it('returns null when the provider gave no timings', () => {
    expect(wordTimingsForSentence(chunk, 's0', undefined)).toBeNull();
    expect(wordTimingsForSentence(chunk, 's0', [])).toBeNull();
  });
});

describe('timing labels', () => {
  it('marks estimated and none as estimates', () => {
    expect(isEstimatedTiming('estimated')).toBe(true);
    expect(isEstimatedTiming('none')).toBe(true);
    expect(isEstimatedTiming('provider-exact')).toBe(false);
    expect(isEstimatedTiming('browser-boundary')).toBe(false);
  });

  it('never describes an estimate as exact', () => {
    expect(timingSourceLabel('estimated')).toContain('Estimated');
    expect(timingSourceLabel('estimated')).not.toContain('Exact');
    expect(timingSourceLabel('provider-exact')).toContain('Exact');
  });
});

describe('formatTime', () => {
  it.each([
    [0, '0:00'],
    [9, '0:09'],
    [61, '1:01'],
    [3599, '59:59'],
    [-5, '0:00'],
    [Number.NaN, '0:00'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatTime(input)).toBe(expected);
  });
});

describe('estimateRemainingSeconds', () => {
  it('shrinks as speed increases', () => {
    expect(estimateRemainingSeconds(1450, 2)).toBeLessThan(estimateRemainingSeconds(1450, 1));
  });
});
