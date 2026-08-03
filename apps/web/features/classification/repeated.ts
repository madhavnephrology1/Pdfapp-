import type { LayoutBlock } from '@/features/extraction/types';

/**
 * Running header / footer detection.
 *
 * A region is only proposed for exclusion when SEVERAL independent signals
 * agree: the same normalized string appears on multiple pages, at nearly the
 * same vertical position, inside a page margin band, and it is not structurally
 * part of a body paragraph. Weak evidence yields a low confidence score, which
 * keeps the region INCLUDED and merely flagged for review.
 */

/** Share of page height treated as the header band. */
export const HEADER_BAND = 0.1;
/** Share of page height treated as the footer band. */
export const FOOTER_BAND = 0.1;
/** A repeated region must appear on at least this share of pages. */
const MIN_REPETITION_SHARE = 0.3;
/** ...and on at least this many pages, so a 2-page document still works. */
const MIN_REPETITION_PAGES = 2;
/** Vertical position spread (points) above which repetition is less convincing. */
const POSITION_SPREAD_TIGHT = 3;
const POSITION_SPREAD_LOOSE = 8;
/** A running head is short; long blocks in the band are body text. */
const MAX_LINES = 2;
/**
 * A running head is set at or below the body size. A section heading that
 * happens to repeat in normalized form ("Section 1." / "Section 2.") is set
 * LARGER than the body, and must never be mistaken for page furniture.
 */
const MAX_FONT_SIZE_RATIO = 1.05;

/**
 * Collapses page-specific detail so "Chapter 3, page 41" and "Chapter 3, page 42"
 * compare as the same running element.
 */
export function repetitionSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .trim();
}

export interface RepeatedCandidate {
  blockId: string;
  pageNumber: number;
  band: 'header' | 'footer';
  signature: string;
  /** Distance from the page edge, in points. */
  edgeDistance: number;
  y: number;
}

export interface PageBlocks {
  pageNumber: number;
  pageHeight: number;
  pageWidth: number;
  blocks: LayoutBlock[];
  /** Body font size for this page; running heads are never larger than this. */
  bodyFontSize: number;
}

export interface RepeatedFinding {
  blockId: string;
  type: 'header' | 'footer';
  confidence: number;
  evidence: string[];
}

function collectCandidates(pages: PageBlocks[]): RepeatedCandidate[] {
  const candidates: RepeatedCandidate[] = [];
  for (const page of pages) {
    const headerLimit = page.pageHeight * (1 - HEADER_BAND);
    const footerLimit = page.pageHeight * FOOTER_BAND;
    for (const block of page.blocks) {
      if (block.lines.length > MAX_LINES) continue;
      const text = block.lines
        .map((line) => line.text)
        .join(' ')
        .trim();
      if (text === '') continue;
      // A block set larger than the body is a heading, not a running head, even
      // if its normalized form repeats across pages.
      const fontSize = block.lines[0]?.fontSize ?? 0;
      if (page.bodyFontSize > 0 && fontSize > page.bodyFontSize * MAX_FONT_SIZE_RATIO) continue;
      const bottom = block.boundingBox.y;
      const top = block.boundingBox.y + block.boundingBox.height;

      if (bottom >= headerLimit) {
        candidates.push({
          blockId: block.id,
          pageNumber: page.pageNumber,
          band: 'header',
          signature: repetitionSignature(text),
          edgeDistance: page.pageHeight - top,
          y: bottom,
        });
      } else if (top <= footerLimit) {
        candidates.push({
          blockId: block.id,
          pageNumber: page.pageNumber,
          band: 'footer',
          signature: repetitionSignature(text),
          edgeDistance: bottom,
          y: bottom,
        });
      }
    }
  }
  return candidates;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Scores every margin-band block for "running header/footer"-ness.
 * Returns one finding per block, with the evidence that produced the score.
 */
export function detectRepeatedRegions(pages: PageBlocks[]): Map<string, RepeatedFinding> {
  const findings = new Map<string, RepeatedFinding>();
  if (pages.length < 2) return findings;

  const candidates = collectCandidates(pages);
  const groups = new Map<string, RepeatedCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.band}|${candidate.signature}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(candidate);
    groups.set(key, bucket);
  }

  const requiredPages = Math.max(
    MIN_REPETITION_PAGES,
    Math.ceil(pages.length * MIN_REPETITION_SHARE),
  );

  for (const [, group] of groups) {
    const distinctPages = new Set(group.map((c) => c.pageNumber));
    if (distinctPages.size < MIN_REPETITION_PAGES) continue;

    const evidence: string[] = [];
    const share = distinctPages.size / pages.length;
    evidence.push(
      `the same text (page numbers normalized) appears on ${distinctPages.size} of ${pages.length} pages`,
    );

    const spread = standardDeviation(group.map((c) => c.y));
    evidence.push(`vertical position varies by ${spread.toFixed(1)}pt across pages`);

    const meanEdge = group.reduce((sum, c) => sum + c.edgeDistance, 0) / group.length;
    evidence.push(`sits ${meanEdge.toFixed(0)}pt from the page edge`);
    evidence.push('set at or below the body text size, as running heads are');

    let confidence = 0.35;
    if (distinctPages.size >= requiredPages) confidence += 0.25;
    else
      evidence.push(
        `below the ${requiredPages}-page repetition threshold, so confidence is reduced`,
      );
    if (share >= 0.6) confidence += 0.15;
    if (spread <= POSITION_SPREAD_TIGHT) confidence += 0.2;
    else if (spread <= POSITION_SPREAD_LOOSE) confidence += 0.1;
    else evidence.push('position is inconsistent, which argues against a running element');
    if (meanEdge <= 40) confidence += 0.1;

    confidence = Math.min(0.97, confidence);

    for (const candidate of group) {
      findings.set(candidate.blockId, {
        blockId: candidate.blockId,
        type: candidate.band,
        confidence,
        evidence: [...evidence],
      });
    }
  }

  return findings;
}
