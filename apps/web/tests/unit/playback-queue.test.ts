import { beforeEach, describe, expect, it } from 'vitest';
import type { DocumentRegion, SentenceRecord } from '@pdfreader/shared-types';
import { buildReadingQueue, type ReadingQueue } from '@/features/reader/queue';
import { DEFAULT_SETTINGS } from '@/features/settings/defaults';
import { usePlaybackStore } from '@/stores/playback-store';

/**
 * How the player behaves when the reading queue is rebuilt underneath it.
 *
 * This happens on every settings change, and — while a document is still being
 * analysed — every time another pass covers more pages. Two things must hold:
 * the reader must not be thrown back to the start of the document, and audio
 * that is playing must not be cut off mid-sentence.
 */

const region = (id: string, text: string, pageNumber: number): DocumentRegion => ({
  id,
  documentId: 'd',
  pageNumber,
  type: 'paragraph',
  text,
  confidence: 0.95,
  textItemIds: [],
  boundingBoxes: [{ pageNumber, x: 0, y: 0, width: 100, height: 10 }],
  included: true,
  inclusionReason: 'Body text.',
  classificationEvidence: ['test fixture'],
  readingOrder: 0,
});

const sentence = (
  id: string,
  regionId: string,
  text: string,
  pageNumber: number,
  documentIndex: number,
): SentenceRecord => ({
  id,
  documentId: 'd',
  pageNumber,
  regionId,
  paragraphId: `${regionId}:para0`,
  text,
  normalizedStart: 0,
  normalizedEnd: text.length,
  sourceTextItemIds: [],
  boundingBoxes: [],
  inclusionStatus: 'included',
  transformations: [],
  documentIndex,
});

/** A queue over `count` one-sentence pages, with an id prefix per pass. */
const queueOf = (texts: string[], idPrefix: string): ReadingQueue => {
  const regions = texts.map((text, index) => region(`${idPrefix}r${index}`, text, index + 1));
  const sentences = texts.map((text, index) =>
    sentence(`${idPrefix}s${index}`, `${idPrefix}r${index}`, text, index + 1, index),
  );
  return buildReadingQueue(regions, sentences, DEFAULT_SETTINGS);
};

const PAGE_TEXT = [
  'The kidney maintains extracellular fluid volume.',
  'Filtration begins at the glomerulus.',
  'Reabsorption occurs along the proximal tubule.',
  'Secretion adjusts the final composition of urine.',
];

describe('rebuilding the reading queue', () => {
  beforeEach(() => {
    usePlaybackStore.setState({
      chunks: [],
      chunkStates: {},
      queueSentences: [],
      pendingQueue: null,
      activeSentenceId: null,
      state: 'idle',
      voices: [],
      voiceId: null,
      providerName: null,
    });
  });

  it('starts at the first sentence when nothing was being read', () => {
    usePlaybackStore.getState().prepareQueue(queueOf(PAGE_TEXT.slice(0, 2), 'a:'), 'd');
    expect(usePlaybackStore.getState().activeSentenceId).toBe('a:s0');
    expect(usePlaybackStore.getState().state).toBe('paused');
  });

  it('keeps the reader in place when a longer pass renames the sentences', () => {
    const { prepareQueue } = usePlaybackStore.getState();
    prepareQueue(queueOf(PAGE_TEXT.slice(0, 2), 'a:'), 'd');
    usePlaybackStore.setState({ activeSentenceId: 'a:s1' });

    // A later pass sees more pages and assigns different ids to the same text.
    prepareQueue(queueOf(PAGE_TEXT, 'b:'), 'd');

    const after = usePlaybackStore.getState();
    expect(after.activeSentenceId).toBe('b:s1');
    expect(after.queueSentences).toHaveLength(4);
    // The reader's own page did not move.
    expect(after.activePage).toBe(2);
  });

  it('does not interrupt audio that is playing', () => {
    const { prepareQueue } = usePlaybackStore.getState();
    prepareQueue(queueOf(PAGE_TEXT.slice(0, 2), 'a:'), 'd');
    const chunksWhilePlaying = usePlaybackStore.getState().chunks;
    usePlaybackStore.setState({ state: 'playing', activeSentenceId: 'a:s1' });

    prepareQueue(queueOf(PAGE_TEXT, 'b:'), 'd');

    const after = usePlaybackStore.getState();
    expect(after.state).toBe('playing');
    expect(after.chunks).toEqual(chunksWhilePlaying);
    expect(after.queueSentences).toHaveLength(2);
    expect(after.pendingQueue).not.toBeNull();
  });

  it('takes on the held queue as soon as playback pauses', () => {
    const { prepareQueue } = usePlaybackStore.getState();
    prepareQueue(queueOf(PAGE_TEXT.slice(0, 2), 'a:'), 'd');
    usePlaybackStore.setState({ state: 'playing', activeSentenceId: 'a:s1' });
    prepareQueue(queueOf(PAGE_TEXT, 'b:'), 'd');

    usePlaybackStore.getState().pause();

    const after = usePlaybackStore.getState();
    expect(after.pendingQueue).toBeNull();
    expect(after.queueSentences).toHaveLength(4);
    expect(after.activeSentenceId).toBe('b:s1');
  });

  it('does not keep a superseded queue waiting once a newer one is applied', () => {
    const { prepareQueue } = usePlaybackStore.getState();
    prepareQueue(queueOf(PAGE_TEXT.slice(0, 2), 'a:'), 'd');
    usePlaybackStore.setState({ state: 'playing', activeSentenceId: 'a:s1' });
    prepareQueue(queueOf(PAGE_TEXT.slice(0, 3), 'b:'), 'd');

    usePlaybackStore.setState({ state: 'paused' });
    prepareQueue(queueOf(PAGE_TEXT, 'c:'), 'd');

    const after = usePlaybackStore.getState();
    expect(after.pendingQueue).toBeNull();
    expect(after.queueSentences).toHaveLength(4);
    expect(after.activeSentenceId).toBe('c:s1');
  });

  it('goes idle when a rebuilt queue has nothing left to read', () => {
    const { prepareQueue } = usePlaybackStore.getState();
    prepareQueue(queueOf(PAGE_TEXT, 'a:'), 'd');
    prepareQueue(queueOf([], 'b:'), 'd');

    const after = usePlaybackStore.getState();
    expect(after.state).toBe('idle');
    expect(after.activeSentenceId).toBeNull();
  });
});
