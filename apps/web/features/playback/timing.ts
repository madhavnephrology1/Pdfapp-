import type { TimingSource, TTSChunk, WordTiming } from '@pdfreader/shared-types';
import { splitWords } from '@/features/extraction/sentences';

/**
 * Word- and sentence-level synchronization.
 *
 * THE RULE: `timingSource` is propagated everywhere and must never be upgraded.
 * If a provider returned no word boundaries, the word highlight is derived from
 * a duration estimate, and the UI is required to label it as estimated. There is
 * no code path that reports estimated timing as 'provider-exact'.
 */

export interface WordProgress {
  wordIndex: number;
  source: TimingSource;
  /** True when the highlight position is inferred rather than measured. */
  estimated: boolean;
}

/** Resolves the active sentence from an audio timestamp within a chunk. */
export function sentenceAtTime(
  chunk: TTSChunk,
  audioTime: number,
  durationSeconds: number,
  sentenceTimings?: { sentenceId: string; audioStart: number; audioEnd: number }[],
): string | null {
  if (chunk.sentenceOffsets.length === 0) return null;

  if (sentenceTimings && sentenceTimings.length > 0) {
    const match = sentenceTimings.find(
      (timing) => audioTime >= timing.audioStart && audioTime < timing.audioEnd,
    );
    if (match) return match.sentenceId;
    return sentenceTimings[sentenceTimings.length - 1].sentenceId;
  }

  // No provider timings: distribute by character share of the chunk. This is an
  // ESTIMATE and callers must treat it as such.
  if (durationSeconds <= 0) return chunk.sentenceOffsets[0].sentenceId;
  const ratio = Math.min(1, Math.max(0, audioTime / durationSeconds));
  const targetOffset = ratio * chunk.text.length;
  for (const entry of chunk.sentenceOffsets) {
    if (targetOffset < entry.end) return entry.sentenceId;
  }
  return chunk.sentenceOffsets[chunk.sentenceOffsets.length - 1].sentenceId;
}

/**
 * Resolves the active word within a sentence.
 *
 * Three tiers, in order of trustworthiness:
 *   1. provider word boundaries      -> exact
 *   2. browser boundary events       -> exact for the browser voice
 *   3. proportional duration estimate -> ESTIMATED, and labelled as such
 */
export function wordProgress(params: {
  sentenceText: string;
  /** Time elapsed within this sentence, in seconds. */
  elapsedInSentence: number;
  /** Duration of this sentence's audio, in seconds. */
  sentenceDuration: number;
  /** Provider word timings, already narrowed to this sentence and rebased to 0. */
  wordTimings?: WordTiming[];
  /** Character offset reported by a browser boundary event. */
  browserCharIndex?: number;
  timingSource: TimingSource;
}): WordProgress | null {
  const words = splitWords(params.sentenceText);
  if (words.length === 0) return null;

  if (params.timingSource === 'provider-exact' && params.wordTimings && params.wordTimings.length > 0) {
    let index = 0;
    for (let i = 0; i < params.wordTimings.length; i += 1) {
      if (params.elapsedInSentence >= params.wordTimings[i].audioStart) index = i;
      else break;
    }
    return { wordIndex: Math.min(index, words.length - 1), source: 'provider-exact', estimated: false };
  }

  if (params.timingSource === 'browser-boundary' && params.browserCharIndex !== undefined) {
    const index = words.findIndex(
      (word) => params.browserCharIndex! >= word.start && params.browserCharIndex! < word.end,
    );
    return {
      wordIndex: index >= 0 ? index : words.length - 1,
      source: 'browser-boundary',
      estimated: false,
    };
  }

  // Tier 3. Proportional to elapsed time. Explicitly estimated.
  if (params.sentenceDuration <= 0) return { wordIndex: 0, source: 'estimated', estimated: true };
  const ratio = Math.min(1, Math.max(0, params.elapsedInSentence / params.sentenceDuration));
  const index = Math.min(words.length - 1, Math.floor(ratio * words.length));
  return { wordIndex: index, source: 'estimated', estimated: true };
}

/**
 * Splits a chunk's duration across its sentences by character share.
 * Used only when the provider gave no sentence timings; the result is an estimate.
 */
export function estimateSentenceTimings(
  chunk: TTSChunk,
  durationSeconds: number,
): { sentenceId: string; audioStart: number; audioEnd: number }[] {
  const total = chunk.text.length || 1;
  return chunk.sentenceOffsets.map((entry) => ({
    sentenceId: entry.sentenceId,
    audioStart: (entry.start / total) * durationSeconds,
    audioEnd: (entry.end / total) * durationSeconds,
  }));
}

/**
 * Narrows chunk-level word timings to one sentence and rebases them to zero.
 * Returns null when the provider gave no usable timings for that sentence.
 */
export function wordTimingsForSentence(
  chunk: TTSChunk,
  sentenceId: string,
  wordTimings: WordTiming[] | undefined,
): WordTiming[] | null {
  if (!wordTimings || wordTimings.length === 0) return null;
  const offset = chunk.sentenceOffsets.find((entry) => entry.sentenceId === sentenceId);
  if (!offset) return null;

  const within = wordTimings.filter((timing) => timing.start >= offset.start && timing.end <= offset.end);
  if (within.length === 0) return null;
  const base = within[0].audioStart;
  return within.map((timing) => ({
    start: timing.start - offset.start,
    end: timing.end - offset.start,
    audioStart: timing.audioStart - base,
    audioEnd: timing.audioEnd - base,
  }));
}

/** Human-readable label for the timing tier. Shown in the UI verbatim. */
export function timingSourceLabel(source: TimingSource): string {
  switch (source) {
    case 'provider-exact':
      return 'Exact word timing from the speech provider';
    case 'browser-boundary':
      return 'Exact word timing from your browser';
    case 'estimated':
      return 'Estimated word position (the provider did not supply word timings)';
    case 'none':
    default:
      return 'Sentence-level highlighting only';
  }
}

/** Whether the word highlight for this source is an estimate. */
export const isEstimatedTiming = (source: TimingSource): boolean =>
  source === 'estimated' || source === 'none';

/** Formats seconds as m:ss for the player. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Estimates remaining reading time from characters left in the queue.
 * Labelled "estimated" in the UI; it is not a measured duration.
 */
export function estimateRemainingSeconds(charactersRemaining: number, speed: number): number {
  // ~14.5 characters per second at 1x is a typical neural TTS rate. This is a
  // display estimate only and never drives synchronization.
  const charsPerSecond = 14.5 * Math.max(0.1, speed);
  return charactersRemaining / charsPerSecond;
}
