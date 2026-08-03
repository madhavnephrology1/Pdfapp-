import type { SentenceRecord } from '@pdfreader/shared-types';

/**
 * Locating the reader's place after the reading queue has been rebuilt.
 *
 * Sentence ids encode the block a sentence came from, and block grouping
 * depends on document-wide measurements such as the body font size. A pass over
 * more of the document can therefore give the very same sentence a different
 * id. Without this, every provisional extraction pass — and every settings
 * change — would send the reader back to the first sentence.
 *
 * Nothing here rewrites text. It only decides which existing sentence the
 * reader was on, and says honestly whether it found that sentence or merely the
 * nearest one to it.
 */

export interface SentenceMatch {
  /** Index into the sentence list that was searched. */
  index: number;
  /**
   * True when this is the same sentence the reader was on, identified by id or
   * by its text. False when it is only the nearest sentence to that position,
   * because the passage itself is no longer in the queue.
   */
  exact: boolean;
}

const matchKey = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Finds `previousId` — a sentence from the `previous` list — in the `next` list.
 *
 * Returns `null` when there is nothing sensible to point at, in which case the
 * caller should start from the beginning of the new queue.
 */
export function remapSentence(
  previousId: string | null,
  previous: readonly SentenceRecord[],
  next: readonly SentenceRecord[],
): SentenceMatch | null {
  if (!previousId || next.length === 0) return null;

  const byId = next.findIndex((sentence) => sentence.id === previousId);
  if (byId >= 0) return { index: byId, exact: true };

  const old = previous.find((sentence) => sentence.id === previousId);
  if (!old) return null;

  // The id changed but the passage is still there: match on the text itself,
  // restricted to the same page so a repeated line elsewhere cannot capture it.
  const key = matchKey(old.text);
  const byText = next.findIndex(
    (sentence) => sentence.pageNumber === old.pageNumber && matchKey(sentence.text) === key,
  );
  if (byText >= 0) return { index: byText, exact: true };

  // The passage is genuinely gone from the queue — most often because a later
  // pass recognised it as a running header, or because a setting now excludes
  // it. Fall back to the first sentence at or after where the reader was. The
  // queue is not strictly page-ordered once footnotes are moved to the end of a
  // page, so this is approximate, and it is reported as such.
  const following = next.findIndex(
    (sentence) =>
      sentence.pageNumber > old.pageNumber ||
      (sentence.pageNumber === old.pageNumber && sentence.documentIndex >= old.documentIndex),
  );
  if (following >= 0) return { index: following, exact: false };

  // Everything left is before the old position: the reader was past the end.
  return { index: next.length - 1, exact: false };
}
