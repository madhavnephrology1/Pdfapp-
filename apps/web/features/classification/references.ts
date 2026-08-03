import type { RegionType } from '@pdfreader/shared-types';
import type { LayoutBlock } from '@/features/extraction/types';

/**
 * Reference / bibliography / index section detection.
 *
 * Two independent paths:
 *
 *   1. HEADING-DRIVEN (high confidence): an explicit "References" style heading
 *      starts a section that continues, across pages, until the next heading of
 *      comparable or larger prominence.
 *
 *   2. DENSITY-DRIVEN (medium confidence): a run of consecutive blocks that all
 *      look like citation entries. Medium confidence means INCLUDED but flagged,
 *      never silently dropped, because prose that merely cites sources must keep
 *      being read.
 */

const HEADING_PATTERNS: { type: RegionType; regex: RegExp; label: string }[] = [
  {
    type: 'reference',
    regex: /^(?:\d+\.?\s*|[ivxlcdm]+\.?\s*)?(references|reference list|works cited|literature cited|citations)\s*:?$/i,
    label: 'references heading',
  },
  {
    type: 'bibliography',
    regex: /^(?:\d+\.?\s*|[ivxlcdm]+\.?\s*)?(bibliography|selected bibliography|further reading|suggested reading)\s*:?$/i,
    label: 'bibliography heading',
  },
  {
    type: 'index',
    regex: /^(?:\d+\.?\s*|[ivxlcdm]+\.?\s*)?(index|subject index|author index|name index)\s*:?$/i,
    label: 'index heading',
  },
];

/** Signals that an individual block is a citation entry rather than prose. */
const ENTRY_SIGNALS: { name: string; regex: RegExp }[] = [
  { name: 'a year in parentheses', regex: /\(\s*(?:19|20)\d{2}[a-z]?\s*\)/ },
  { name: 'a DOI', regex: /\b(?:doi:\s*)?10\.\d{4,9}\/\S+/i },
  { name: 'a volume(issue), pages pattern', regex: /\b\d{1,4}\s*\(\s*\d{1,3}\s*\)\s*,?\s*\d{1,5}\s*[-–]\s*\d{1,5}/ },
  { name: 'a page range', regex: /\bpp?\.\s*\d{1,5}\s*[-–]\s*\d{1,5}/i },
  { name: 'an "Author, A." name form', regex: /\b\p{Lu}\p{Ll}+,\s+\p{Lu}\.(?:\s*\p{Lu}\.)?/u },
  { name: 'an editor or edition marker', regex: /\b(eds?\.|vol\.|no\.|edition|in press|retrieved from)\b/i },
  { name: 'a bracketed entry number', regex: /^\s*\[\d{1,3}\]\s/ },
];

/** 0..1 score for how much a block looks like a bibliography entry. */
export function referenceEntryScore(text: string): { score: number; matched: string[] } {
  const matched = ENTRY_SIGNALS.filter((signal) => signal.regex.test(text)).map((s) => s.name);
  return { score: Math.min(1, matched.length / 3), matched };
}

export function matchReferenceHeading(text: string): { type: RegionType; label: string } | null {
  const trimmed = text.trim();
  if (trimmed.length > 40) return null;
  for (const pattern of HEADING_PATTERNS) {
    if (pattern.regex.test(trimmed)) return { type: pattern.type, label: pattern.label };
  }
  return null;
}

export interface ReferenceFinding {
  blockId: string;
  type: RegionType;
  confidence: number;
  evidence: string[];
}

export interface OrderedBlock {
  block: LayoutBlock;
  pageNumber: number;
  /** Position in whole-document reading order. */
  order: number;
}

/** Blocks whose left edge alternates between two values, i.e. hanging indent. */
function hasHangingIndent(blocks: LayoutBlock[]): boolean {
  const lines = blocks.flatMap((block) => block.lines);
  if (lines.length < 3) return false;
  const lefts = lines.map((line) => Math.round(line.x));
  const distinct = [...new Set(lefts)].sort((a, b) => a - b);
  if (distinct.length !== 2) return false;
  const [first, second] = distinct;
  return second - first >= 6 && second - first <= 48;
}

/**
 * Classifies reference-like sections across the whole document.
 * `ordered` must be in document reading order.
 */
export function detectReferenceSections(
  ordered: OrderedBlock[],
  bodyFontSize: number,
): Map<string, ReferenceFinding> {
  const findings = new Map<string, ReferenceFinding>();
  if (ordered.length === 0) return findings;

  let activeType: RegionType | null = null;
  let activeLabel = '';
  let headingFontSize = 0;

  for (const entry of ordered) {
    const { block } = entry;
    const text = block.lines.map((line) => line.text).join(' ').trim();
    const blockFontSize = block.lines[0]?.fontSize ?? bodyFontSize;

    const heading = matchReferenceHeading(text);
    if (heading && (block.type === 'heading' || blockFontSize >= bodyFontSize)) {
      activeType = heading.type;
      activeLabel = heading.label;
      headingFontSize = blockFontSize;
      findings.set(block.id, {
        blockId: block.id,
        type: heading.type,
        confidence: 0.92,
        evidence: [`the region is an explicit ${heading.label}: "${text}"`],
      });
      continue;
    }

    if (activeType) {
      // A new heading of comparable prominence ends the section.
      const isNewHeading =
        block.type === 'heading' && blockFontSize >= headingFontSize - 0.5 && !matchReferenceHeading(text);
      if (isNewHeading) {
        activeType = null;
        activeLabel = '';
      } else {
        const { score, matched } = referenceEntryScore(text);
        const evidence = [`follows the ${activeLabel} on page ${entry.pageNumber}`];
        if (matched.length > 0) evidence.push(`entry contains ${matched.join(', ')}`);
        findings.set(block.id, {
          blockId: block.id,
          type: activeType,
          // Entries that also look like citations get the strongest score.
          confidence: Math.min(0.95, 0.82 + score * 0.13),
          evidence,
        });
        continue;
      }
    }
  }

  // Density-driven pass over runs of consecutive un-classified blocks.
  let run: OrderedBlock[] = [];
  const flushRun = (): void => {
    if (run.length >= 3) {
      const scores = run.map((entry) => referenceEntryScore(entry.block.lines.map((l) => l.text).join(' ')));
      const mean = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
      const hanging = hasHangingIndent(run.map((entry) => entry.block));
      if (mean >= 0.6) {
        for (const [index, entry] of run.entries()) {
          if (findings.has(entry.block.id)) continue;
          const evidence = [
            `${run.length} consecutive regions score ${(mean * 100).toFixed(0)}% on citation-entry signals`,
            `this entry contains ${scores[index].matched.join(', ') || 'no direct signal, but its neighbours do'}`,
          ];
          if (hanging) evidence.push('the run uses a consistent hanging indent');
          findings.set(entry.block.id, {
            blockId: entry.block.id,
            type: 'reference',
            // Deliberately below the automatic-exclusion threshold: without an
            // explicit heading this stays included and flagged for review.
            confidence: hanging ? 0.72 : 0.6,
            evidence,
          });
        }
      }
    }
    run = [];
  };

  for (const entry of ordered) {
    if (findings.has(entry.block.id) || entry.block.type === 'heading') {
      flushRun();
      continue;
    }
    run.push(entry);
  }
  flushRun();

  return findings;
}
