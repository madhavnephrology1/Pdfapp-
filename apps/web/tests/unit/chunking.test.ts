import { describe, expect, it } from 'vitest';
import type { SentenceRecord } from '@pdfreader/shared-types';
import {
  assertChunkingIsLossless,
  buildChunks,
  computeCacheKey,
  findChunkForSentence,
  type QueueItem,
} from '@/features/playback/chunking';

const sentence = (id: string, text: string, page = 1): SentenceRecord => ({
  id,
  documentId: 'doc',
  pageNumber: page,
  regionId: 'r1',
  paragraphId: 'p1',
  text,
  normalizedStart: 0,
  normalizedEnd: text.length,
  sourceTextItemIds: ['i1'],
  boundingBoxes: [],
  inclusionStatus: 'included',
  transformations: [],
  documentIndex: 0,
});

const queueOf = (...texts: string[]): QueueItem[] =>
  texts.map((text, index) => ({ sentence: sentence(`s${index}`, text), speechText: text }));

const options = {
  maxChars: 100,
  voiceId: 'voice-a',
  speed: 1,
  language: 'en-US',
  provider: 'mock',
  documentId: 'doc',
};

describe('buildChunks', () => {
  it('packs several sentences into one chunk', () => {
    const chunks = buildChunks(queueOf('One.', 'Two.', 'Three.'), options);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('One. Two. Three.');
    expect(chunks[0].sentenceIds).toEqual(['s0', 's1', 's2']);
  });

  it('never exceeds the provider character limit', () => {
    const queue = queueOf(...Array.from({ length: 40 }, (_, i) => `Sentence number ${i} of the queue.`));
    const chunks = buildChunks(queue, { ...options, maxChars: 120 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(120);
  });

  it('prefers sentence boundaries', () => {
    const chunks = buildChunks(queueOf('A'.repeat(60) + '.', 'B'.repeat(60) + '.'), {
      ...options,
      maxChars: 100,
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe('A'.repeat(60) + '.');
    expect(chunks[1].text).toBe('B'.repeat(60) + '.');
  });

  it('splits an over-long sentence at word boundaries only', () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const chunks = buildChunks(queueOf(long), { ...options, maxChars: 60 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(60);
      // No chunk may begin or end mid-word.
      expect(chunk.text).not.toMatch(/^\S*\d\S*$|^ /);
    }
    expect(chunks.map((c) => c.text).join(' ')).toBe(long);
  });

  it('splits a single word longer than the limit rather than dropping it', () => {
    const word = 'x'.repeat(150);
    const chunks = buildChunks(queueOf(word), { ...options, maxChars: 50 });
    expect(chunks.map((c) => c.text).join('')).toBe(word);
  });

  it('keeps the sentence id on every part of a split sentence', () => {
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const chunks = buildChunks(queueOf(long), { ...options, maxChars: 60 });
    for (const chunk of chunks) expect(chunk.sentenceIds).toEqual(['s0']);
  });

  it('records offsets that index into the chunk text', () => {
    const chunks = buildChunks(queueOf('First sentence.', 'Second sentence.'), options);
    const chunk = chunks[0];
    for (const entry of chunk.sentenceOffsets) {
      const slice = chunk.text.slice(entry.start, entry.end);
      expect(slice.trim().length).toBeGreaterThan(0);
    }
    expect(chunk.text.slice(chunk.sentenceOffsets[1].start, chunk.sentenceOffsets[1].end)).toBe(
      'Second sentence.',
    );
  });

  it('records every page the chunk covers', () => {
    const queue: QueueItem[] = [
      { sentence: sentence('s0', 'On page one.', 1), speechText: 'On page one.' },
      { sentence: sentence('s1', 'On page two.', 2), speechText: 'On page two.' },
    ];
    expect(buildChunks(queue, options)[0].pageNumbers).toEqual([1, 2]);
  });

  it('skips empty speech text without creating an empty chunk', () => {
    const queue: QueueItem[] = [
      { sentence: sentence('s0', '[12]'), speechText: '' },
      { sentence: sentence('s1', 'Real text.'), speechText: 'Real text.' },
    ];
    const chunks = buildChunks(queue, options);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sentenceIds).toEqual(['s1']);
  });

  it('produces nothing for an empty queue', () => {
    expect(buildChunks([], options)).toEqual([]);
  });
});

describe('chunking is lossless', () => {
  const cases: [string, string[], number][] = [
    ['short sentences', ['One.', 'Two.', 'Three.'], 100],
    ['tight limit', ['One.', 'Two.', 'Three.'], 10],
    ['long sentence', [Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')], 40],
    ['mixed', ['Short.', 'x'.repeat(80), 'Also short.'], 50],
  ];

  it.each(cases)('%s: loses and duplicates nothing', (_name, texts, maxChars) => {
    const queue = queueOf(...texts);
    const chunks = buildChunks(queue, { ...options, maxChars });
    expect(() => assertChunkingIsLossless(queue, chunks)).not.toThrow();
  });

  it('throws when a word would be lost', () => {
    const queue = queueOf('One two three.');
    expect(() =>
      assertChunkingIsLossless(queue, [
        {
          id: 'c0',
          documentId: 'doc',
          text: 'One two.',
          sentenceIds: ['s0'],
          sentenceOffsets: [],
          pageNumbers: [1],
          textHash: 'x',
          cacheKey: 'y',
          index: 0,
        },
      ]),
    ).toThrow(/changed the reading queue/);
  });
});

describe('computeCacheKey', () => {
  it('is deterministic', () => {
    expect(computeCacheKey('hello', options)).toBe(computeCacheKey('hello', options));
  });

  it('changes with the text', () => {
    expect(computeCacheKey('hello', options)).not.toBe(computeCacheKey('hello!', options));
  });

  it('changes with the voice', () => {
    expect(computeCacheKey('hello', options)).not.toBe(
      computeCacheKey('hello', { ...options, voiceId: 'voice-b' }),
    );
  });

  it('changes with the speed', () => {
    expect(computeCacheKey('hello', options)).not.toBe(
      computeCacheKey('hello', { ...options, speed: 1.5 }),
    );
  });

  it('changes with the language', () => {
    expect(computeCacheKey('hello', options)).not.toBe(
      computeCacheKey('hello', { ...options, language: 'fr-FR' }),
    );
  });

  it('changes with the provider', () => {
    expect(computeCacheKey('hello', options)).not.toBe(
      computeCacheKey('hello', { ...options, provider: 'other' }),
    );
  });

  it('does not collide on field-boundary ambiguity', () => {
    const a = computeCacheKey('x', { ...options, voiceId: 'ab', provider: 'c' });
    const b = computeCacheKey('x', { ...options, voiceId: 'a', provider: 'bc' });
    expect(a).not.toBe(b);
  });
});

describe('findChunkForSentence', () => {
  it('locates the chunk containing a sentence', () => {
    const chunks = buildChunks(queueOf('One.', 'Two.', 'Three.'), { ...options, maxChars: 10 });
    const found = findChunkForSentence(chunks, 's2');
    expect(found).not.toBeNull();
    expect(found!.chunk.text.slice(found!.start, found!.end)).toBe('Three.');
  });

  it('returns null for an unknown sentence', () => {
    expect(findChunkForSentence(buildChunks(queueOf('One.'), options), 'missing')).toBeNull();
  });
});
