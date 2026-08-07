/**
 * Sentence segmentation.
 *
 * The segmenter only ever SPLITS text. It never inserts, removes or reorders a
 * character, so concatenating every sentence of a paragraph reproduces the
 * paragraph exactly. `assertSegmentationIsLossless` enforces that invariant and
 * is called by the extraction pipeline on every paragraph.
 */

/** Abbreviations whose trailing period does not end a sentence. */
export const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'st',
  'jr',
  'sr',
  'vs',
  'etc',
  'inc',
  'ltd',
  'co',
  'corp',
  'dept',
  'univ',
  'est',
  'approx',
  'no',
  'vol',
  'ed',
  'eds',
  'pp',
  'fig',
  'figs',
  'al',
  'et',
  'eg',
  'ie',
  'cf',
  'ca',
  'i.e',
  'e.g',
  'a.m',
  'p.m',
  'u.s',
  'u.k',
]);

export interface SentenceSpan {
  /** Offsets into the paragraph text. */
  start: number;
  end: number;
  text: string;
}

const TERMINATORS = new Set(['.', '!', '?', '…']);
const CLOSERS = new Set(['"', "'", '’', '”', ')', ']', '}', '»']);

/**
 * Characters that begin a list item.
 *
 * A bulleted list carries no terminating punctuation, so the whole list arrived
 * as ONE sentence: "we perform the following initial evaluation: ● We repeat
 * the measurement ● We review the patient's medications ● We review serum
 * biochemistry". Read aloud that is a single unbroken run — no pause between
 * items, and the highlight covering all of them at once. On a clinical
 * reference article, 39 of 180 spoken sentences were lists like this.
 *
 * The bullet is where one item ends and the next begins, so it is treated as a
 * boundary. This only ever SPLITS, exactly like every other rule here: the
 * bullet stays in the text and the spans still concatenate to the input.
 */
const LIST_MARKERS = new Set(['●', '•', '▪', '◦', '‣', '·', '∙']);

function isUpperOrDigit(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[\p{Lu}\p{N}"'“‘(\[]/u.test(ch);
}

/** Word immediately before `index`, lowercased and stripped of punctuation. */
function previousWord(text: string, index: number): string {
  let end = index;
  while (end > 0 && /[\s]/.test(text[end - 1])) end -= 1;
  let start = end;
  while (start > 0 && /[^\s]/.test(text[start - 1])) start -= 1;
  return text
    .slice(start, end)
    .toLowerCase()
    .replace(/[^a-z.]/g, '');
}

/**
 * Splits a paragraph into sentences.
 *
 * Trailing whitespace between sentences is attached to the preceding sentence
 * so that the concatenation of all spans equals the input exactly.
 */
export function segmentSentences(text: string): SentenceSpan[] {
  if (text.length === 0) return [];
  const spans: SentenceSpan[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    // A list marker ends the item before it. It must stand alone — preceded by
    // space and followed by space — so a bullet used as a character inside a
    // word or a number cannot break a sentence in half.
    if (
      LIST_MARKERS.has(ch) &&
      i > start &&
      /\s/.test(text[i - 1] ?? '') &&
      /\s/.test(text[i + 1] ?? '')
    ) {
      spans.push({ start, end: i, text: text.slice(start, i) });
      start = i;
      continue;
    }

    if (!TERMINATORS.has(ch)) continue;

    // Consume repeated terminators and any closing quotes/brackets.
    let end = i + 1;
    while (end < text.length && (TERMINATORS.has(text[end]) || CLOSERS.has(text[end]))) end += 1;

    const nextNonSpace = text.slice(end).match(/\S/);
    const nextChar = nextNonSpace ? nextNonSpace[0] : undefined;
    const hasSpaceAfter = end >= text.length || /\s/.test(text[end]);

    if (!hasSpaceAfter) continue; // e.g. "3.14", "www.example.com"

    if (ch === '.') {
      const word = previousWord(text, i);
      if (ABBREVIATIONS.has(word) || ABBREVIATIONS.has(word.replace(/\.$/, ''))) continue;
      // A single capital letter before the period is an initial ("J. Smith").
      if (/^[a-z]$/i.test(text[i - 1] ?? '') && /[\s(]/.test(text[i - 2] ?? ' ')) continue;
      // Initials run together, as author lists write them: "H.J.L. Heerspink",
      // "D.C. Wheeler". The rule above only sees a space before the letter, so
      // it matched the FIRST period of such a cluster and not the last — which
      // ended the sentence on the author's own initials and started the next
      // one on their surname. Two or more letter-period pairs are required:
      // one on its own is "vitamin D." and is left to the rule above, so this
      // changes nothing about where a real sentence ends.
      if (/^(?:[a-z]\.){2,5}$/.test(previousWord(text, i + 1))) continue;
      // Decimal or numbered-list separator followed by a digit.
      if (/\d/.test(text[i - 1] ?? '') && /^\d/.test(nextChar ?? '')) continue;
    }

    if (end < text.length && !isUpperOrDigit(nextChar)) continue;

    // Absorb the whitespace run so no character is lost between sentences.
    let boundary = end;
    while (boundary < text.length && /\s/.test(text[boundary])) boundary += 1;

    spans.push({ start, end: boundary, text: text.slice(start, boundary) });
    start = boundary;
    i = boundary - 1;
  }

  if (start < text.length) {
    spans.push({ start, end: text.length, text: text.slice(start) });
  }
  return spans;
}

/** Throws when segmentation lost or altered a character. */
export function assertSegmentationIsLossless(text: string, spans: SentenceSpan[]): void {
  const rebuilt = spans.map((span) => span.text).join('');
  if (rebuilt !== text) {
    throw new Error(
      `Sentence segmentation altered the source text (${text.length} chars in, ${rebuilt.length} out). ` +
        'Refusing to continue: the reader must never speak text that differs from the document.',
    );
  }
}

/**
 * Splits a sentence into word spans for word-level highlighting.
 * Punctuation stays attached to its word so offsets map back cleanly.
 */
export function splitWords(text: string): { start: number; end: number; text: string }[] {
  const words: { start: number; end: number; text: string }[] = [];
  const regex = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    words.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    });
  }
  return words;
}
