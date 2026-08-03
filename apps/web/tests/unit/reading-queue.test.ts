import { describe, expect, it } from 'vitest';
import type { DocumentRegion, DocumentSettings, SentenceRecord } from '@pdfreader/shared-types';
import {
  applyFootnoteOrdering,
  buildReadingQueue,
  type ReadingQueueEntry,
} from '@/features/reader/queue';
import { DEFAULT_SETTINGS } from '@/features/settings/defaults';

const entry = (
  id: string,
  regionType: DocumentRegion['type'],
  pageNumber = 1,
): ReadingQueueEntry => ({
  sentence: {
    id,
    documentId: 'd',
    pageNumber,
    regionId: `r-${id}`,
    paragraphId: `p-${id}`,
    text: id,
    normalizedStart: 0,
    normalizedEnd: id.length,
    sourceTextItemIds: [],
    boundingBoxes: [],
    inclusionStatus: 'included',
    transformations: [],
    documentIndex: 0,
  },
  speechText: id,
  skipped: [],
  regionType,
});

const ids = (entries: ReadingQueueEntry[]): string[] => entries.map((e) => e.sentence.id);

describe('applyFootnoteOrdering', () => {
  const page1 = [
    entry('body-1a', 'paragraph', 1),
    entry('note-1', 'footnote', 1),
    entry('body-1b', 'paragraph', 1),
  ];
  const page2 = [entry('body-2a', 'paragraph', 2), entry('note-2', 'footnote', 2)];

  it('drops footnotes when set to skip', () => {
    expect(ids(applyFootnoteOrdering([...page1, ...page2], 'skip'))).toEqual([
      'body-1a',
      'body-1b',
      'body-2a',
    ]);
  });

  it('moves footnotes to the end of their page', () => {
    expect(ids(applyFootnoteOrdering([...page1, ...page2], 'after-page'))).toEqual([
      'body-1a',
      'body-1b',
      'note-1',
      'body-2a',
      'note-2',
    ]);
  });

  it('moves footnotes to the end of their section', () => {
    const entries = [
      entry('h1', 'heading', 1),
      entry('body-a', 'paragraph', 1),
      entry('note-a', 'footnote', 1),
      entry('h2', 'heading', 2),
      entry('body-b', 'paragraph', 2),
      entry('note-b', 'footnote', 2),
    ];
    expect(ids(applyFootnoteOrdering(entries, 'after-section'))).toEqual([
      'h1',
      'body-a',
      'note-a',
      'h2',
      'body-b',
      'note-b',
    ]);
  });

  it('keeps a footnote with its own section when the section spans pages', () => {
    const entries = [
      entry('h1', 'heading', 1),
      entry('body-1', 'paragraph', 1),
      entry('body-2', 'paragraph', 2),
      entry('note-1', 'footnote', 1),
    ];
    // By section, the note follows all of the section's body text.
    expect(ids(applyFootnoteOrdering(entries, 'after-section'))).toEqual([
      'h1',
      'body-1',
      'body-2',
      'note-1',
    ]);
    // By page, it returns to page 1.
    expect(ids(applyFootnoteOrdering(entries, 'after-page'))).toEqual([
      'h1',
      'body-1',
      'note-1',
      'body-2',
    ]);
  });

  it('preserves the relative order of multiple footnotes', () => {
    const entries = [
      entry('body', 'paragraph', 1),
      entry('note-1', 'footnote', 1),
      entry('note-2', 'footnote', 1),
      entry('note-3', 'footnote', 1),
    ];
    expect(ids(applyFootnoteOrdering(entries, 'after-page'))).toEqual([
      'body',
      'note-1',
      'note-2',
      'note-3',
    ]);
  });

  it('changes nothing when there are no footnotes', () => {
    const entries = [entry('a', 'paragraph'), entry('b', 'paragraph')];
    expect(applyFootnoteOrdering(entries, 'after-page')).toBe(entries);
  });

  it('never loses a non-footnote entry', () => {
    for (const mode of ['after-page', 'after-section', 'skip'] as const) {
      const result = applyFootnoteOrdering([...page1, ...page2], mode);
      const body = ids(result).filter((id) => id.startsWith('body'));
      expect(body).toEqual(['body-1a', 'body-1b', 'body-2a']);
    }
  });
});

describe('buildReadingQueue', () => {
  const region = (id: string, type: DocumentRegion['type'], confidence = 0.5): DocumentRegion => ({
    id,
    documentId: 'd',
    pageNumber: 1,
    type,
    confidence,
    textItemIds: [],
    boundingBoxes: [],
    included: true,
    inclusionReason: '',
    classificationEvidence: [],
    readingOrder: 0,
    text: 'text',
  });

  const sentence = (id: string, regionId: string, text: string): SentenceRecord => ({
    id,
    documentId: 'd',
    pageNumber: 1,
    regionId,
    paragraphId: `${regionId}:para0`,
    text,
    normalizedStart: 0,
    normalizedEnd: text.length,
    sourceTextItemIds: ['i1'],
    boundingBoxes: [],
    inclusionStatus: 'included',
    transformations: [],
    documentIndex: 0,
  });

  const regions = [
    region('body', 'paragraph'),
    region('head', 'header', 0.95),
    region('table', 'table', 0.85),
  ];
  const sentences = [
    sentence('s-body', 'body', 'The kidney regulates volume [4].'),
    sentence('s-head', 'head', 'Journal of Nephrology'),
    sentence('s-table', 'table', 'Age 54.2 55.8 0.41'),
  ];

  const settings = (over: Partial<DocumentSettings> = {}): DocumentSettings => ({
    ...DEFAULT_SETTINGS,
    ...over,
  });

  it('reads the body, skips the header and skips the table by default', () => {
    const queue = buildReadingQueue(regions, sentences, settings());
    expect(queue.entries.map((e) => e.sentence.id)).toEqual(['s-body']);
  });

  it('skips a citation marker in the audio but keeps the sentence for display', () => {
    const queue = buildReadingQueue(regions, sentences, settings());
    expect(queue.entries[0].speechText).toBe('The kidney regulates volume.');
    expect(queue.entries[0].sentence.text).toBe('The kidney regulates volume [4].');
    expect(queue.entries[0].skipped).toHaveLength(1);
  });

  it('reads the table when the user asks for row order', () => {
    const queue = buildReadingQueue(
      regions,
      sentences,
      settings({ tables: { mode: 'read-in-row-order' } }),
    );
    expect(queue.entries.map((e) => e.sentence.id)).toContain('s-table');
  });

  it('reads everything verbatim in Strict Verbatim Mode', () => {
    const queue = buildReadingQueue(
      regions,
      sentences,
      settings({ readingMode: 'strict-verbatim' }),
    );
    const spoken = queue.entries.map((e) => e.speechText);
    expect(queue.entries.map((e) => e.sentence.id)).toEqual(['s-body', 's-head', 's-table']);
    // The citation marker is NOT skipped in Strict Verbatim Mode.
    expect(spoken[0]).toBe('The kidney regulates volume [4].');
  });

  it('reports the regions it excluded so the UI can list them', () => {
    const queue = buildReadingQueue(regions, sentences, settings());
    expect(queue.excludedRegions.map((r) => r.id)).toEqual(['head']);
  });

  it('a user override brings an excluded region back', () => {
    const queue = buildReadingQueue(
      regions,
      sentences,
      settings({ regionOverrides: { head: 'include' } }),
    );
    expect(queue.entries.map((e) => e.sentence.id)).toContain('s-head');
    expect(queue.excludedRegions).toHaveLength(0);
  });

  it('counts characters of the final queue, not the discarded entries', () => {
    const queue = buildReadingQueue(regions, sentences, settings());
    expect(queue.totalCharacters).toBe(queue.entries[0].speechText.length);
  });

  it('never mutates the sentences it was given', () => {
    const before = JSON.stringify(sentences);
    buildReadingQueue(regions, sentences, settings());
    expect(JSON.stringify(sentences)).toBe(before);
  });
});
