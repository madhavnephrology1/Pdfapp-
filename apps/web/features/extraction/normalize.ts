import type { TransformationRecord } from '@pdfreader/shared-types';

/**
 * PERMITTED NORMALIZATION ONLY.
 *
 * This module implements the complete, closed set of text changes the product
 * is allowed to make. Anything not listed here is forbidden:
 *
 *   - joining words split by a line-ending hyphen
 *   - reconstructing paragraph line wraps
 *   - normalizing repeated whitespace
 *   - converting typographic ligatures to equivalent characters
 *   - removing zero-width / control characters that are not real content
 *
 * There is deliberately NO spelling correction, NO grammar correction, NO
 * sentence completion and NO vocabulary substitution. Every change is recorded
 * as a TransformationRecord so the reader can show the raw text beside it.
 */

/** Ligature -> equivalent characters. Purely a character-encoding equivalence. */
export const LIGATURES: Record<string, string> = {
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
  '\uFB05': 'st',
  '\uFB06': 'st',
  '\u0132': 'IJ',
  '\u0133': 'ij',
  '\u0152': 'OE',
  '\u0153': 'oe',
  '\u00C6': 'AE',
  '\u00E6': 'ae',
};

/** Characters that carry no spoken content and no layout meaning. */
const INVISIBLE_CHARS = /[\u200B\u200C\u200D\uFEFF\u2060]/g;
/** C0/C1 control characters except tab and newline. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** Discretionary (soft) hyphen: an instruction to the renderer, not content. */
const SOFT_HYPHEN = /\u00AD/g;

/** Every hyphen-like character that can end a wrapped line. */
export const LINE_END_HYPHENS = ['-', '\u2010', '\u2011'];

export interface NormalizationResult {
  text: string;
  transformations: TransformationRecord[];
}

/**
 * Normalizes a single raw text item.
 *
 * Whitespace is collapsed but NOT trimmed at the edges here, because leading and
 * trailing spaces carry word-boundary information when items are joined.
 */
export function normalizeItemText(text: string, sourceTextItemId: string): NormalizationResult {
  const transformations: TransformationRecord[] = [];
  let out = '';

  for (let i = 0; i < text.length;) {
    const ch = text[i];
    const expansion = LIGATURES[ch];
    if (expansion) {
      transformations.push({
        kind: 'ligature-expand',
        offset: out.length,
        before: ch,
        after: expansion,
        sourceTextItemIds: [sourceTextItemId],
      });
      out += expansion;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }

  const withoutSoftHyphen = out.replace(SOFT_HYPHEN, (match, offset: number) => {
    transformations.push({
      kind: 'soft-hyphen-removal',
      offset,
      before: match,
      after: '',
      sourceTextItemIds: [sourceTextItemId],
    });
    return '';
  });

  const withoutInvisible = withoutSoftHyphen
    .replace(INVISIBLE_CHARS, '')
    .replace(CONTROL_CHARS, (match, offset: number) => {
      transformations.push({
        kind: 'control-char-removal',
        offset,
        before: match,
        after: '',
        sourceTextItemIds: [sourceTextItemId],
      });
      return '';
    });

  const collapsed = withoutInvisible.replace(
    /[ \t\u00A0\u2000-\u200A\u202F\u205F\u3000]{2,}/g,
    (match, offset: number) => {
      transformations.push({
        kind: 'whitespace-collapse',
        offset,
        before: match,
        after: ' ',
        sourceTextItemIds: [sourceTextItemId],
      });
      return ' ';
    },
  );

  // Single non-breaking / exotic spaces still normalize to U+0020 so that
  // sentence segmentation and word splitting behave consistently. This is a
  // whitespace equivalence, not a content change.
  const spaceNormalized = collapsed.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');

  return { text: spaceNormalized, transformations };
}

/**
 * Decides whether two consecutive lines should be joined with a hyphen removal.
 *
 * Conservative on purpose: a trailing hyphen is only treated as a *word-splitting*
 * hyphen when the next line starts with a lowercase letter. "state-\nof-the-art"
 * and "COVID-\n19" keep their hyphen, because removing it would alter the word.
 */
export function isWordSplittingHyphen(currentLine: string, nextLine: string): boolean {
  const trimmed = currentLine.trimEnd();
  const lastChar = trimmed.slice(-1);
  if (!LINE_END_HYPHENS.includes(lastChar)) return false;

  const beforeHyphen = trimmed.slice(0, -1);
  // Require at least two letters before the hyphen so "- item" style leaders
  // are never treated as a split word.
  if (!/\p{L}\p{L}$/u.test(beforeHyphen)) return false;

  const nextStart = nextLine.trimStart();
  // Only lowercase continuations. An uppercase or digit start is far more likely
  // to be a genuine compound (e.g. "anti-\nInflammatory" stays hyphenated).
  return /^\p{Ll}/u.test(nextStart);
}

/** Maps a character range of the joined text back to one raw text item. */
export interface OffsetSpan {
  start: number;
  end: number;
  itemId: string;
}

export interface WrappedLine {
  text: string;
  sourceTextItemIds: string[];
  /** Per-item offsets within this line's own text. */
  spans?: OffsetSpan[];
}

export interface JoinedLines {
  text: string;
  transformations: TransformationRecord[];
  /** Per-item offsets within the JOINED text. This is what makes every
   *  spoken sentence traceable to specific PDF text items. */
  spans: OffsetSpan[];
}

/**
 * Reconstructs a paragraph from its wrapped lines.
 *
 * Two operations only:
 *   - hyphen-join   : "bar-" + "rier"  -> "barrier"
 *   - line-wrap-join: "foo" + "bar"    -> "foo bar"
 */
export function joinWrappedLines(lines: WrappedLine[]): JoinedLines {
  const transformations: TransformationRecord[] = [];
  const spans: OffsetSpan[] = [];
  let text = '';

  /** Re-bases a line's own spans onto the joined text, clipping to `limit`. */
  const emitSpans = (line: WrappedLine, base: number, limit: number): void => {
    const lineSpans = line.spans ?? [
      {
        start: 0,
        end: line.text.length,
        itemId: line.sourceTextItemIds[0] ?? '',
      },
    ];
    for (const span of lineSpans) {
      if (span.itemId === '') continue;
      const start = base + span.start;
      const end = Math.min(base + span.end, limit);
      if (end > start) spans.push({ start, end, itemId: span.itemId });
    }
  };

  lines.forEach((line, index) => {
    const isLast = index === lines.length - 1;
    const next = lines[index + 1];
    const current = line.text.replace(/\s+$/, '');

    if (!isLast && next && isWordSplittingHyphen(current, next.text)) {
      const base = text.length;
      const withoutHyphen = current.slice(0, -1);
      text += withoutHyphen;
      emitSpans(line, base, text.length);
      transformations.push({
        kind: 'hyphen-join',
        offset: text.length,
        before: `${current.slice(-1)}\n`,
        after: '',
        sourceTextItemIds: [...line.sourceTextItemIds, ...next.sourceTextItemIds],
      });
      return;
    }

    const base = text.length;
    text += current;
    emitSpans(line, base, text.length);
    if (!isLast && next) {
      // Do not insert a space if the line already ends with one or the next
      // line begins with punctuation that must hug the previous word.
      const needsSpace = !/\s$/.test(text) && text.length > 0;
      if (needsSpace) {
        transformations.push({
          kind: 'line-wrap-join',
          offset: text.length,
          before: '\n',
          after: ' ',
          sourceTextItemIds: [...line.sourceTextItemIds, ...next.sourceTextItemIds],
        });
        text += ' ';
      }
    }
  });

  return { text, transformations, spans };
}
