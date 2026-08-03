import type { BoundingBox, RegionType } from '@pdfreader/shared-types';
import { regionId } from '@/lib/ids';
import type { LayoutBlock, TextLine } from './types';

/** A vertical gap larger than this multiple of the median gap starts a block. */
const BLOCK_GAP_RATIO = 1.6;
/** Relative font-size change that starts a new block. */
const FONT_SIZE_CHANGE_RATIO = 0.15;
/** Indent, relative to font size, that marks a new first line. */
const INDENT_RATIO = 0.6;
/** Font size relative to body that marks a heading. */
const HEADING_SIZE_RATIO = 1.12;
/** Font size relative to body below which a bottom-of-page block is a footnote. */
const FOOTNOTE_SIZE_RATIO = 0.85;
/** Share of page height, measured from the bottom, in which footnotes live. */
const FOOTNOTE_BAND = 0.22;
/** Baseline difference, relative to font size, below which two lines are level. */
const BASELINE_SAME_LINE_RATIO = 0.35;

const BOLD_FONT = /bold|black|heavy|semibold|demibold/i;
const LIST_PREFIX = /^([•·●▪⁃–—-]|\(?\d{1,2}[.)]|\(?[a-zA-Z][.)])\s+/;
const CAPTION_PREFIX = /^(table|figure|fig\.?|chart|exhibit|scheme|plate)\s*\d/i;
const SENTENCE_END = /[.!?][’"')\]]?\s*$/;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function boundingBoxOf(lines: TextLine[], pageNumber: number): BoundingBox {
  const x = Math.min(...lines.map((line) => line.x));
  const right = Math.max(...lines.map((line) => line.x + line.width));
  const bottom = Math.min(...lines.map((line) => line.baseline));
  const top = Math.max(...lines.map((line) => line.baseline + line.height));
  return { pageNumber, x, y: bottom, width: right - x, height: top - bottom };
}

export interface BlockOptions {
  documentId: string;
  pageNumber: number;
  pageHeight: number;
  /** Median font size across the whole document; the body-text reference. */
  bodyFontSize: number;
}

/**
 * Groups ordered lines into layout blocks.
 *
 * Every break is justified by a concrete, recorded signal so the Content Review
 * panel can show why the document was divided this way.
 */
export function groupBlocks(orderedLines: TextLine[], options: BlockOptions): LayoutBlock[] {
  if (orderedLines.length === 0) return [];

  // Median baseline gap per column gives a per-column notion of "normal leading".
  const gapsByColumn = new Map<number, number[]>();
  for (let i = 1; i < orderedLines.length; i += 1) {
    const previous = orderedLines[i - 1];
    const current = orderedLines[i];
    if (previous.columnIndex !== current.columnIndex) continue;
    const gap = previous.baseline - current.baseline;
    if (gap <= 0) continue;
    const bucket = gapsByColumn.get(current.columnIndex) ?? [];
    bucket.push(gap);
    gapsByColumn.set(current.columnIndex, bucket);
  }
  const medianGapByColumn = new Map<number, number>();
  for (const [column, gaps] of gapsByColumn) medianGapByColumn.set(column, median(gaps));
  const globalMedianGap = median([...gapsByColumn.values()].flat());

  const blocks: LayoutBlock[] = [];
  let currentLines: TextLine[] = [];
  let currentEvidence: string[] = [];
  let orderUncertain = false;

  const flush = (): void => {
    if (currentLines.length === 0) return;
    const classified = classifyBlock(currentLines, options);
    blocks.push({
      id: regionId(options.documentId, options.pageNumber, blocks.length),
      pageNumber: options.pageNumber,
      lines: currentLines,
      type: classified.type,
      columnIndex: currentLines[0].columnIndex,
      confidence: classified.confidence,
      evidence: [...currentEvidence, ...classified.evidence],
      boundingBox: boundingBoxOf(currentLines, options.pageNumber),
      orderUncertain,
    });
    currentLines = [];
    currentEvidence = [];
    orderUncertain = false;
  };

  for (const line of orderedLines) {
    if (currentLines.length === 0) {
      currentLines.push(line);
      continue;
    }
    const previous = currentLines[currentLines.length - 1];
    const reasons: string[] = [];

    if (previous.columnIndex !== line.columnIndex) reasons.push('column changed');
    if (previous.spansColumns !== line.spansColumns) reasons.push('column-spanning status changed');

    const medianGap = medianGapByColumn.get(line.columnIndex) || globalMedianGap;
    const gap = previous.baseline - line.baseline;

    // Two lines on the same baseline sit side by side; they are separate
    // elements (a footer and a page number, say), not a wrapped continuation.
    if (Math.abs(gap) < Math.max(1, line.fontSize * BASELINE_SAME_LINE_RATIO)) {
      reasons.push('shares a baseline with the previous region, so it is a separate element');
    }

    if (medianGap > 0 && gap > medianGap * BLOCK_GAP_RATIO) {
      reasons.push(`vertical gap ${gap.toFixed(1)}pt exceeds ${(medianGap * BLOCK_GAP_RATIO).toFixed(1)}pt`);
    }

    const sizeDelta = Math.abs(previous.fontSize - line.fontSize);
    const sizeBase = Math.max(previous.fontSize, line.fontSize) || 1;
    if (sizeDelta / sizeBase > FONT_SIZE_CHANGE_RATIO) {
      reasons.push(`font size changed ${previous.fontSize.toFixed(1)} -> ${line.fontSize.toFixed(1)}`);
    }

    const blockLeft = Math.min(...currentLines.map((l) => l.x));
    const indent = line.x - blockLeft;
    if (indent > line.fontSize * INDENT_RATIO && SENTENCE_END.test(previous.text)) {
      reasons.push(`first-line indent of ${indent.toFixed(1)}pt after a sentence end`);
    }

    // Lines must descend within a column; anything else means our ordering is
    // not trustworthy for this page.
    if (previous.columnIndex === line.columnIndex && !line.spansColumns && gap < 0) {
      reasons.push('lines are out of vertical order');
      orderUncertain = true;
    }

    if (reasons.length > 0) {
      const carried = orderUncertain;
      flush();
      currentEvidence = [`block started because: ${reasons.join('; ')}`];
      orderUncertain = carried;
    }
    currentLines.push(line);
  }
  flush();

  return blocks;
}

interface BlockClassification {
  type: RegionType;
  confidence: number;
  evidence: string[];
}

/**
 * Assigns a page-local region type. Cross-page types (running headers, footers,
 * reference sections) are decided later by the classification pipeline, which
 * can compare pages against each other.
 */
function classifyBlock(lines: TextLine[], options: BlockOptions): BlockClassification {
  const text = lines.map((line) => line.text).join(' ').trim();
  const evidence: string[] = [];
  const fontSize = median(lines.map((line) => line.fontSize));
  const body = options.bodyFontSize || fontSize || 10;
  const bottomY = Math.min(...lines.map((line) => line.baseline));
  const isBold = lines.some((line) => line.fontName !== undefined && BOLD_FONT.test(line.fontName));

  if (CAPTION_PREFIX.test(text)) {
    evidence.push('block begins with a figure/table caption label');
    return { type: 'caption', confidence: 0.75, evidence };
  }

  // Checked before the list rule: numbered footnotes ("1. Corresponding author")
  // look exactly like a numbered list, and position plus size settles it.
  const inFootnoteBand = bottomY < options.pageHeight * FOOTNOTE_BAND;
  if (inFootnoteBand && body > 0 && fontSize < body * FOOTNOTE_SIZE_RATIO) {
    evidence.push(
      `font size ${fontSize.toFixed(1)}pt is below ${(body * FOOTNOTE_SIZE_RATIO).toFixed(1)}pt and the block sits in the bottom ${Math.round(FOOTNOTE_BAND * 100)}% of the page`,
    );
    return { type: 'footnote', confidence: 0.7, evidence };
  }

  if (LIST_PREFIX.test(lines[0].text)) {
    evidence.push(`first line starts with a list marker: ${JSON.stringify(lines[0].text.slice(0, 8))}`);
    return { type: 'list', confidence: 0.7, evidence };
  }

  const looksLikeHeading =
    lines.length <= 3 &&
    text.length <= 120 &&
    (fontSize > body * HEADING_SIZE_RATIO || (isBold && !SENTENCE_END.test(text)));
  if (looksLikeHeading) {
    if (fontSize > body * HEADING_SIZE_RATIO) {
      evidence.push(`font size ${fontSize.toFixed(1)}pt exceeds body size ${body.toFixed(1)}pt`);
    }
    if (isBold) evidence.push('bold font');
    evidence.push(`${lines.length} line(s), ${text.length} characters`);
    return { type: 'heading', confidence: fontSize > body * HEADING_SIZE_RATIO ? 0.8 : 0.6, evidence };
  }

  evidence.push('default body classification');
  return { type: 'paragraph', confidence: 0.5, evidence };
}

/**
 * Body font size: the modal size weighted by character count.
 *
 * Computed PER PAGE where possible, because a document whose later pages are set
 * in a smaller face (references, index, appendices) would otherwise drag the
 * document-wide estimate down and make ordinary body text look like a heading.
 */
export function estimateBodyFontSize(lines: TextLine[]): number {
  const weights = new Map<number, number>();
  for (const line of lines) {
    const bucket = Math.round(line.fontSize * 2) / 2;
    weights.set(bucket, (weights.get(bucket) ?? 0) + line.text.length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      bestWeight = weight;
      best = size;
    }
  }
  return best || median(lines.map((line) => line.fontSize));
}
