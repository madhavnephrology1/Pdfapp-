import { describe, expect, it } from 'vitest';
import {
  assertSegmentationIsLossless,
  segmentSentences,
  splitWords,
} from '@/features/extraction/sentences';

const texts = (input: string): string[] => segmentSentences(input).map((s) => s.text.trim());

describe('segmentSentences', () => {
  it('splits on sentence terminators', () => {
    expect(texts('One idea. Two ideas! Three ideas?')).toEqual([
      'One idea.',
      'Two ideas!',
      'Three ideas?',
    ]);
  });

  it('does not split on common abbreviations', () => {
    expect(texts('Dr. Alvarez reviewed the chart. It was complete.')).toEqual([
      'Dr. Alvarez reviewed the chart.',
      'It was complete.',
    ]);
  });

  it('does not split inside a decimal number', () => {
    expect(texts('The mean was 54.2 years in both groups.')).toEqual([
      'The mean was 54.2 years in both groups.',
    ]);
  });

  it('does not split on an initial in a name', () => {
    expect(texts('Reported by J. Smith and colleagues.')).toEqual([
      'Reported by J. Smith and colleagues.',
    ]);
  });

  it('does not split on et al.', () => {
    expect(texts('Described by Cho et al. in a later cohort.')).toEqual([
      'Described by Cho et al. in a later cohort.',
    ]);
  });

  it('keeps a closing quotation mark with its sentence', () => {
    expect(texts('He said "no evidence." The trial ended.')).toEqual([
      'He said "no evidence."',
      'The trial ended.',
    ]);
  });

  it('does not split inside a domain name', () => {
    expect(texts('Data came from www.example.com and was verified.')).toEqual([
      'Data came from www.example.com and was verified.',
    ]);
  });

  it('handles a sentence without a terminator', () => {
    expect(texts('An unterminated fragment')).toEqual(['An unterminated fragment']);
  });

  it('never completes a truncated sentence', () => {
    const truncated = 'The measured value was';
    expect(segmentSentences(truncated)[0].text).toBe(truncated);
  });

  it('returns nothing for empty input', () => {
    expect(segmentSentences('')).toEqual([]);
  });

  it('produces offsets that index the source text', () => {
    const source = 'First sentence. Second sentence.';
    for (const span of segmentSentences(source)) {
      expect(source.slice(span.start, span.end)).toBe(span.text);
    }
  });
});

describe('segmentation is lossless', () => {
  const samples = [
    'One idea. Two ideas! Three ideas?',
    'Dr. Alvarez reviewed the chart. It was complete.',
    '  Leading space and trailing space.  ',
    'No terminator at all',
    'Ellipsis... then more. And an end.',
    'Numbers 1. 2. 3. in a row.',
    'Parenthetical (Smith, 2019) stays put. So does this.',
  ];

  it.each(samples)('reproduces %j exactly', (sample) => {
    const spans = segmentSentences(sample);
    expect(() => assertSegmentationIsLossless(sample, spans)).not.toThrow();
    expect(spans.map((s) => s.text).join('')).toBe(sample);
  });

  it('throws when the invariant is violated', () => {
    expect(() =>
      assertSegmentationIsLossless('abc', [{ start: 0, end: 2, text: 'ab' }]),
    ).toThrow(/altered the source text/);
  });
});

describe('splitWords', () => {
  it('maps every word back to its offsets', () => {
    const text = 'Tubular reabsorption recovers sodium.';
    const words = splitWords(text);
    expect(words.map((w) => w.text)).toEqual([
      'Tubular',
      'reabsorption',
      'recovers',
      'sodium.',
    ]);
    for (const word of words) expect(text.slice(word.start, word.end)).toBe(word.text);
  });

  it('returns nothing for whitespace-only input', () => {
    expect(splitWords('   ')).toEqual([]);
  });
});
