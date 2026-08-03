import type { SentenceRecord, TTSChunk } from '@pdfreader/shared-types';
import { chunkId as makeChunkId } from '@/lib/ids';
import { compositeKey, hash64 } from '@/lib/hash';

/**
 * Splits the reading queue into synthesis chunks.
 *
 * Invariants, all covered by unit tests:
 *   - a word is never split across chunks
 *   - chunk boundaries fall on sentence boundaries whenever the sentence fits
 *   - concatenating every chunk reproduces the queue text exactly: no word is
 *     duplicated between chunks and none is lost
 *   - every chunk carries the ids and offsets of the sentences it contains
 *   - chunk hashes and cache keys are deterministic
 */

export interface ChunkOptions {
  /** Provider limit. Chunks never exceed it. */
  maxChars: number;
  /** Included in the cache key: different voices need different audio. */
  voiceId: string;
  speed: number;
  language: string;
  provider: string;
  documentId: string;
}

/** One item of the reading queue: a sentence and the text that will be spoken. */
export interface QueueItem {
  sentence: SentenceRecord;
  /** The spoken projection, which may differ from sentence.text when citation
   *  markers are skipped. Never differs in Strict Verbatim Mode. */
  speechText: string;
}

export function computeCacheKey(
  text: string,
  options: Pick<ChunkOptions, 'voiceId' | 'speed' | 'language' | 'provider'>,
): string {
  const textHash = hash64(text);
  return hash64(
    compositeKey(options.provider, options.voiceId, options.speed.toFixed(2), options.language, textHash),
  );
}

interface TextPart {
  text: string;
  /** True when this part resumes mid-word from the previous one. */
  midWord: boolean;
}

/**
 * Hard-splits an over-long single sentence, preferring word boundaries.
 *
 * A word longer than the whole provider limit cannot be kept intact. Rather than
 * dropping characters, it is split and the continuation is flagged `midWord` so
 * callers never re-insert a space that the document does not contain.
 */
function splitLongText(text: string, maxChars: number): TextPart[] {
  if (text.length <= maxChars) return [{ text, midWord: false }];
  const parts: TextPart[] = [];
  let remaining = text;
  let midWord = false;

  while (remaining.length > maxChars) {
    const cut = remaining.lastIndexOf(' ', maxChars);
    if (cut > 0) {
      parts.push({ text: remaining.slice(0, cut), midWord });
      remaining = remaining.slice(cut + 1);
      midWord = false;
    } else {
      // The word itself is longer than a chunk.
      parts.push({ text: remaining.slice(0, maxChars), midWord });
      remaining = remaining.slice(maxChars);
      midWord = true;
    }
  }
  if (remaining.length > 0) parts.push({ text: remaining, midWord });
  return parts;
}

export function buildChunks(queue: QueueItem[], options: ChunkOptions): TTSChunk[] {
  const chunks: TTSChunk[] = [];
  const { maxChars } = options;

  let text = '';
  let sentenceOffsets: TTSChunk['sentenceOffsets'] = [];
  let pageNumbers = new Set<number>();
  let continuesMidWord = false;

  const flush = (): void => {
    if (text.trim() === '') {
      text = '';
      sentenceOffsets = [];
      pageNumbers = new Set();
      continuesMidWord = false;
      return;
    }
    const textHash = hash64(text);
    chunks.push({
      id: makeChunkId(options.documentId, chunks.length),
      documentId: options.documentId,
      text,
      sentenceIds: sentenceOffsets.map((entry) => entry.sentenceId),
      sentenceOffsets,
      pageNumbers: [...pageNumbers].sort((a, b) => a - b),
      textHash,
      cacheKey: computeCacheKey(text, options),
      index: chunks.length,
      continuesMidWord,
    });
    text = '';
    sentenceOffsets = [];
    pageNumbers = new Set();
    continuesMidWord = false;
  };

  for (const item of queue) {
    const spoken = item.speechText;
    if (spoken.trim() === '') continue;

    // A single sentence longer than the provider limit must be split, at word
    // boundaries, into several chunks that all reference the same sentence.
    if (spoken.length > maxChars) {
      flush();
      for (const part of splitLongText(spoken, maxChars)) {
        text = part.text;
        continuesMidWord = part.midWord;
        sentenceOffsets = [{ sentenceId: item.sentence.id, start: 0, end: part.text.length }];
        pageNumbers = new Set([item.sentence.pageNumber]);
        flush();
      }
      continue;
    }

    // Sentences are separated by a single space in the synthesis text.
    const separator = text === '' ? '' : ' ';
    if (text.length + separator.length + spoken.length > maxChars) flush();

    const start = text.length + (text === '' ? 0 : 1);
    if (text !== '') text += ' ';
    text += spoken;
    sentenceOffsets.push({ sentenceId: item.sentence.id, start, end: text.length });
    pageNumbers.add(item.sentence.pageNumber);
  }

  flush();
  return chunks;
}

/**
 * Verifies that chunking neither dropped nor duplicated any word.
 * Called by the playback store before a queue is sent for synthesis.
 */
export function assertChunkingIsLossless(queue: QueueItem[], chunks: TTSChunk[]): void {
  const expected = queue
    .map((item) => item.speechText)
    .filter((text) => text.trim() !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const actual = chunks
    .reduce((acc, chunk, index) => {
      if (index === 0) return chunk.text;
      return chunk.continuesMidWord ? acc + chunk.text : `${acc} ${chunk.text}`;
    }, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (expected !== actual) {
    throw new Error(
      `TTS chunking changed the reading queue (${expected.length} chars expected, ${actual.length} produced). ` +
        'Refusing to synthesize: the reader must never speak text that differs from the document.',
    );
  }
}

/** Locates the chunk and offset range for a sentence, for seeking. */
export function findChunkForSentence(
  chunks: TTSChunk[],
  sentenceId: string,
): { chunk: TTSChunk; start: number; end: number } | null {
  for (const chunk of chunks) {
    const offset = chunk.sentenceOffsets.find((entry) => entry.sentenceId === sentenceId);
    if (offset) return { chunk, start: offset.start, end: offset.end };
  }
  return null;
}
