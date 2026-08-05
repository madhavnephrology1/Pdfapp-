import type { CitationSettings, TransformationRecord } from '@pdfreader/shared-types';

/**
 * Citation markers in body prose.
 *
 * CRITICAL RULE: the author's sentence is never modified. The reader always
 * displays the full sentence. What this module produces is a separate SPOKEN
 * projection of the sentence, in which isolated citation markers may be
 * skipped, together with an offset map back to the displayed text so word
 * highlighting still lands on the right words.
 *
 * Parenthetical prose citations such as "(Smith argued the opposite)" are kept,
 * because removing them would change the meaning of the sentence. Only markers
 * that are purely bibliographic pointers are eligible to be skipped.
 */

/** "[12]", "[12,13]", "[12-15]" - a pure numeric bracket pointer. */
const NUMERIC_BRACKET = /\[\s*\d{1,3}(?:\s*[,;-–]\s*\d{1,3})*\s*\]/g;
/** "(12)" standing alone between a word and punctuation. */
const NUMERIC_PAREN = /\(\s*\d{1,3}(?:\s*[,;-–]\s*\d{1,3})*\s*\)/g;
/**
 * Superscript digit runs written with the Unicode superscript characters, e.g.
 * "sodium¹²".
 *
 * Most PDFs do not use these. A typographic superscript is ordinary digits set
 * smaller and raised, which no pattern over the text can tell apart from real
 * content — "3-5" glued to a word looks exactly like the 2 in "H2O". Those are
 * identified by geometry during extraction instead and arrive here as
 * `markerSpans`; this pattern only covers the rarer literal form.
 */
const SUPERSCRIPT = /[¹²³⁰⁴-⁹]+/g;
/**
 * "(Smith, 2019)", "(Smith & Jones, 2019; Cho et al., 2021)".
 * Author-year forms only: capitalised names plus a four-digit year.
 */
const AUTHOR_YEAR =
  /\(\s*(?:e\.g\.,?\s*|see\s+|cf\.\s*)?\p{Lu}[\p{L}'’-]+(?:\s+(?:et\s+al\.?|and|&|,)\s*[\p{L}'’.-]*)*,?\s*(?:19|20)\d{2}[a-z]?(?:\s*[;,]\s*[^()]{0,60}?(?:19|20)\d{2}[a-z]?)*\s*\)/gu;

export interface SkippedSpan {
  start: number;
  end: number;
  text: string;
  reason: string;
}

export interface SpeechProjection {
  /** Text handed to the TTS provider. */
  text: string;
  /** Spans of the DISPLAY text that were not spoken. */
  skipped: SkippedSpan[];
  transformations: TransformationRecord[];
  /**
   * Maps an offset in the spoken text back to an offset in the display text.
   * Used so word-boundary events highlight the correct displayed word.
   */
  toDisplayOffset(spokenOffset: number): number;
}

function identityProjection(text: string): SpeechProjection {
  return {
    text,
    skipped: [],
    transformations: [],
    toDisplayOffset: (offset) => offset,
  };
}

/**
 * Builds the spoken projection of one sentence.
 *
 * `strictVerbatim` short-circuits every skip: in Strict Verbatim Mode the spoken
 * text is exactly the displayed text.
 */
export function buildSpeechProjection(
  displayText: string,
  settings: CitationSettings,
  options: {
    strictVerbatim?: boolean;
    sourceTextItemIds?: string[];
    /**
     * Character ranges known from the PAGE GEOMETRY to be raised or dropped —
     * superscript citation markers. Positions, not patterns, so nothing that
     * merely looks like a marker is ever removed.
     */
    markerSpans?: { start: number; end: number }[];
  } = {},
): SpeechProjection {
  if (options.strictVerbatim) return identityProjection(displayText);

  const sourceTextItemIds = options.sourceTextItemIds ?? [];
  const candidates: SkippedSpan[] = [];

  const collect = (regex: RegExp, reason: string): void => {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(displayText)) !== null) {
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        reason,
      });
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  };

  if (settings.skipIsolatedNumericMarkers) {
    collect(NUMERIC_BRACKET, 'isolated numeric citation marker');
    collect(NUMERIC_PAREN, 'isolated numeric citation marker');
  }
  if (settings.skipSuperscriptMarkers) {
    collect(SUPERSCRIPT, 'superscript citation marker');
    for (const span of options.markerSpans ?? []) {
      const start = Math.max(0, span.start);
      const end = Math.min(displayText.length, span.end);
      if (end <= start) continue;
      const text = displayText.slice(start, end);
      // A raised run that is not a bibliographic pointer is left alone. A
      // footnote dagger or an ordinal "1st" carries meaning; a run of digits
      // and separators does not.
      if (!/^[\d\s,;.\u2013\u2014-]+$/.test(text)) continue;
      candidates.push({ start, end, text, reason: 'superscript citation marker' });
    }
  }
  if (!settings.readParentheticalCitations) {
    collect(AUTHOR_YEAR, 'parenthetical author-year citation');
  }

  if (candidates.length === 0) return identityProjection(displayText);

  // Resolve overlaps: keep the earliest, longest span.
  candidates.sort((a, b) => (a.start !== b.start ? a.start - b.start : b.end - a.end));
  const skipped: SkippedSpan[] = [];
  for (const candidate of candidates) {
    const last = skipped[skipped.length - 1];
    if (last && candidate.start < last.end) continue;
    skipped.push(candidate);
  }

  const transformations: TransformationRecord[] = [];
  /** Pairs of (spokenOffset, displayOffset) at each segment start. */
  const anchors: { spoken: number; display: number }[] = [];
  let spoken = '';
  let cursor = 0;

  for (const span of skipped) {
    anchors.push({ spoken: spoken.length, display: cursor });
    spoken += displayText.slice(cursor, span.start);
    transformations.push({
      kind: 'citation-marker-skip',
      offset: spoken.length,
      before: span.text,
      after: '',
      sourceTextItemIds,
    });
    // Collapse the whitespace the removed marker leaves behind, so the provider
    // never receives a double space or a space before punctuation. This affects
    // the spoken text only; the displayed sentence is untouched.
    const remainder = displayText.slice(span.end);
    if (/\s$/.test(spoken) && /^[\s.,;:!?)\]}]/.test(remainder)) {
      spoken = spoken.replace(/\s+$/, '');
    }
    cursor = span.end;
  }
  anchors.push({ spoken: spoken.length, display: cursor });
  spoken += displayText.slice(cursor);

  return {
    text: spoken,
    skipped,
    transformations,
    toDisplayOffset(spokenOffset: number): number {
      let best = anchors[0];
      for (const anchor of anchors) {
        if (anchor.spoken <= spokenOffset) best = anchor;
        else break;
      }
      return best.display + (spokenOffset - best.spoken);
    },
  };
}

export const DEFAULT_CITATION_SETTINGS: CitationSettings = {
  // Preserve the author's sentence: parenthetical prose citations are read.
  readParentheticalCitations: true,
  // Isolated pointers carry no spoken meaning.
  skipIsolatedNumericMarkers: true,
  skipSuperscriptMarkers: true,
  footnoteReading: 'after-page',
  // Full bibliographies are skipped by default; fully reversible in settings.
  includeReferenceLists: false,
};
