import type { PageBlocks } from './repeated';
import { repetitionSignature } from './repeated';

/**
 * Watermark detection.
 *
 * Two signals, both structural rather than semantic:
 *   - the text is drawn rotated (a non-trivial skew in its text matrix), which
 *     ordinary body text never is;
 *   - a very large glyph size repeated across many pages.
 *
 * Both must be corroborated by repetition, so a rotated table header on one page
 * is not mistaken for a watermark.
 */

/** Ratio of matrix skew to scale above which text counts as rotated. */
const ROTATION_RATIO = 0.15;
/** Font size relative to body above which text is "oversized". */
const OVERSIZED_RATIO = 2.5;
/** Share of pages a candidate must appear on. */
const MIN_PAGE_SHARE = 0.5;

export interface WatermarkFinding {
  blockId: string;
  confidence: number;
  evidence: string[];
}

function isRotated(transform: number[]): boolean {
  const [a, b, c, d] = transform;
  const scale = Math.max(Math.abs(a), Math.abs(d)) || 1;
  return Math.max(Math.abs(b), Math.abs(c)) / scale > ROTATION_RATIO;
}

export function detectWatermarks(
  pages: PageBlocks[],
  bodyFontSize: number,
): Map<string, WatermarkFinding> {
  const findings = new Map<string, WatermarkFinding>();
  if (pages.length === 0) return findings;

  interface Candidate {
    blockId: string;
    pageNumber: number;
    signature: string;
    rotated: boolean;
    oversized: boolean;
    fontSize: number;
  }

  const candidates: Candidate[] = [];
  for (const page of pages) {
    for (const block of page.blocks) {
      const items = block.lines.flatMap((line) => line.items);
      if (items.length === 0) continue;
      const rotated = items.every((item) => isRotated(item.transform));
      const fontSize = block.lines[0]?.fontSize ?? 0;
      const oversized = bodyFontSize > 0 && fontSize >= bodyFontSize * OVERSIZED_RATIO;
      if (!rotated && !oversized) continue;
      candidates.push({
        blockId: block.id,
        pageNumber: page.pageNumber,
        signature: repetitionSignature(block.lines.map((line) => line.text).join(' ')),
        rotated,
        oversized,
        fontSize,
      });
    }
  }

  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const bucket = groups.get(candidate.signature) ?? [];
    bucket.push(candidate);
    groups.set(candidate.signature, bucket);
  }

  for (const group of groups.values()) {
    const distinctPages = new Set(group.map((c) => c.pageNumber));
    const share = distinctPages.size / pages.length;
    // A single-page document cannot corroborate by repetition; require rotation.
    const repeated = pages.length > 1 ? share >= MIN_PAGE_SHARE : group[0].rotated;
    if (!repeated) continue;

    const evidence: string[] = [];
    let confidence = 0.4;
    if (group[0].rotated) {
      evidence.push('the text is drawn rotated, which body text is not');
      confidence += 0.35;
    }
    if (group[0].oversized) {
      evidence.push(
        `glyph size ${group[0].fontSize.toFixed(0)}pt is more than ${OVERSIZED_RATIO}x the body size ${bodyFontSize.toFixed(0)}pt`,
      );
      confidence += 0.2;
    }
    if (pages.length > 1) {
      evidence.push(`appears on ${distinctPages.size} of ${pages.length} pages`);
      confidence += 0.15;
    }

    for (const candidate of group) {
      findings.set(candidate.blockId, {
        blockId: candidate.blockId,
        confidence: Math.min(0.95, confidence),
        evidence: [...evidence],
      });
    }
  }

  return findings;
}
