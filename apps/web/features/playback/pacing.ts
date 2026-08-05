/**
 * The silence between one spoken sentence and the next.
 *
 * The browser's speech engine fires utterances back to back with no gap at all,
 * so a full stop is inaudible and a heading runs straight into the paragraph
 * below it as a single breath. Reported plainly by a reader: "doesn't indicate
 * sentence ends".
 *
 * This changes TIMING ONLY. No word, sound or punctuation is ever added to what
 * is spoken — the spoken text is the same text it was — so it cannot alter what
 * the document says.
 *
 * The server-audio path is untouched. There the pause between sentences is
 * whatever the provider rendered into the audio it returned, and inserting
 * silence would mean editing that audio.
 */

/** Between two sentences of the same paragraph: a breath, not a stop. */
const SENTENCE_PAUSE_MS = 260;
/** Between paragraphs, and after a heading: long enough to hear as structure. */
const PARAGRAPH_PAUSE_MS = 540;
/** Nobody wants to wait this long, whatever the speed setting works out to. */
const MAX_PAUSE_MS = 900;

export interface SentenceBoundary {
  paragraphId: string;
  regionId: string;
}

export interface PauseInput {
  /** The sentence that just finished. */
  finished: SentenceBoundary | null;
  /** The sentence about to be spoken. Null at the end of the document. */
  next: SentenceBoundary | null;
  /** Playback rate, so pauses shorten as the reading speeds up. */
  speed: number;
}

/**
 * How long to wait before speaking the next sentence, in milliseconds.
 *
 * Pauses scale inversely with speed, because a gap that reads as a full stop at
 * 1× reads as a stall at 2×. Someone who has doubled the rate has asked to get
 * through it faster, and the silence should honour that too.
 */
export function pauseBeforeNextSentence(input: PauseInput): number {
  const { finished, next, speed } = input;
  if (!finished || !next) return 0;

  const sameParagraph = finished.paragraphId === next.paragraphId;
  const sameRegion = finished.regionId === next.regionId;
  const base = sameParagraph && sameRegion ? SENTENCE_PAUSE_MS : PARAGRAPH_PAUSE_MS;

  const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return Math.min(MAX_PAUSE_MS, Math.round(base / rate));
}
