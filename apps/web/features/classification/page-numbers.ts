import type { LayoutBlock } from '@/features/extraction/types';
import { FOOTER_BAND, HEADER_BAND } from './repeated';

/**
 * Standalone page-number detection.
 *
 * A number is only a page number when the WHOLE region consists of the number
 * and the region sits in a page margin band. That rule is what stops the
 * detector from eating numbers inside prose, equations, tables or headings:
 * those never form a region on their own in the margin.
 */

interface Pattern {
  name: string;
  regex: RegExp;
}

const PATTERNS: Pattern[] = [
  { name: 'arabic numeral', regex: /^\d{1,4}$/ },
  { name: 'roman numeral', regex: /^[ivxlcdm]{1,7}$/i },
  { name: 'dashed numeral', regex: /^[-–—]\s*\d{1,4}\s*[-–—]$/ },
  { name: '"Page N"', regex: /^(page|p\.?|pg\.?)\s*\d{1,4}$/i },
  { name: '"N of M"', regex: /^\d{1,4}\s*(of|\/)\s*\d{1,4}$/i },
  { name: '"Page N of M"', regex: /^page\s*\d{1,4}\s*(of|\/)\s*\d{1,4}$/i },
  { name: 'chapter-page numeral', regex: /^\d{1,3}[-–]\d{1,4}$/ },
];

export interface PageNumberFinding {
  blockId: string;
  confidence: number;
  evidence: string[];
}

export interface PageNumberInput {
  pageNumber: number;
  pageHeight: number;
  pageWidth: number;
  blocks: LayoutBlock[];
}

/** True when the isolated string looks like a page number in a margin. */
export function matchPageNumberPattern(text: string): Pattern | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  for (const pattern of PATTERNS) {
    if (pattern.regex.test(trimmed)) return pattern;
  }
  return null;
}

export function detectPageNumbers(pages: PageNumberInput[]): Map<string, PageNumberFinding> {
  const findings = new Map<string, PageNumberFinding>();

  // Horizontal positions of accepted candidates, to reward consistency.
  const positions: number[] = [];
  const provisional: { blockId: string; pattern: Pattern; centreX: number; evidence: string[] }[] = [];

  for (const page of pages) {
    const headerLimit = page.pageHeight * (1 - HEADER_BAND);
    const footerLimit = page.pageHeight * FOOTER_BAND;

    for (const block of page.blocks) {
      if (block.lines.length !== 1) continue;
      const text = block.lines[0].text.trim();
      const pattern = matchPageNumberPattern(text);
      if (!pattern) continue;

      const bottom = block.boundingBox.y;
      const top = bottom + block.boundingBox.height;
      const inHeader = bottom >= headerLimit;
      const inFooter = top <= footerLimit;
      if (!inHeader && !inFooter) continue;

      const centreX = block.boundingBox.x + block.boundingBox.width / 2;
      positions.push(centreX);
      provisional.push({
        blockId: block.id,
        pattern,
        centreX,
        evidence: [
          `the entire region is "${text}", which matches the ${pattern.name} pattern`,
          `the region sits alone in the page ${inHeader ? 'header' : 'footer'} margin`,
        ],
      });
    }
  }

  // Consistency of horizontal placement across pages is corroborating evidence.
  const mean = positions.length > 0 ? positions.reduce((a, b) => a + b, 0) / positions.length : 0;

  for (const candidate of provisional) {
    const evidence = [...candidate.evidence];
    let confidence = 0.75;
    if (provisional.length >= 2) {
      const drift = Math.abs(candidate.centreX - mean);
      if (drift <= 12) {
        confidence += 0.15;
        evidence.push(`horizontal position matches other page numbers within ${drift.toFixed(0)}pt`);
      } else {
        evidence.push(`horizontal position differs from other page numbers by ${drift.toFixed(0)}pt`);
      }
    } else {
      evidence.push('only one page-number candidate in the document, so cross-page corroboration is unavailable');
      confidence -= 0.05;
    }
    findings.set(candidate.blockId, {
      blockId: candidate.blockId,
      confidence: Math.min(0.96, confidence),
      evidence,
    });
  }

  return findings;
}
