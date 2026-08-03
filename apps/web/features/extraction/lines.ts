import type { RawTextItem } from '@pdfreader/shared-types';
import { lineId } from '@/lib/ids';
import { normalizeItemText } from './normalize';
import { assignColumn } from './columns';
import type { ColumnBand, TextLine } from './types';

/** Baseline tolerance as a fraction of font size when grouping a line. */
const BASELINE_TOLERANCE_RATIO = 0.35;
const MIN_BASELINE_TOLERANCE = 1.2;
/** Horizontal gap, relative to font size, that implies a word space. */
const SPACE_GAP_RATIO = 0.22;
/**
 * Inside a page margin band, a horizontal gap this many times the font size
 * separates two independent pieces of furniture rather than two words.
 *
 * This is what lets a footer like "Downloaded from example.org" and a centred
 * page number sharing one baseline be recognised as two separate regions. The
 * rule is confined to the margin bands so that wide gaps inside body text and
 * tables are left alone.
 */
const MARGIN_SPLIT_GAP_RATIO = 3;
/** Share of page height at the top and bottom treated as a margin band. */
const MARGIN_BAND = 0.1;

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Groups items into lines using baseline proximity, WITHIN a column.
 *
 * Column assignment happens first so that two-column pages never merge a line
 * from the left column with one from the right column that happens to share a
 * baseline. Items that span columns (headings) form their own group.
 */
export function groupLines(
  items: RawTextItem[],
  columns: ColumnBand[],
  documentId: string,
  pageNumber: number,
  pageHeight = 0,
): TextLine[] {
  const positioned = items.filter((item) => item.text.trim() !== '');
  if (positioned.length === 0) return [];

  const byGroup = new Map<number, RawTextItem[]>();
  for (const item of positioned) {
    const column = assignColumn(item, columns);
    const bucket = byGroup.get(column) ?? [];
    bucket.push(item);
    byGroup.set(column, bucket);
  }

  const lines: TextLine[] = [];
  let counter = 0;

  for (const [columnIndex, groupItems] of [...byGroup.entries()].sort((a, b) => a[0] - b[0])) {
    // Top to bottom (PDF Y grows upward), then left to right.
    const sorted = [...groupItems].sort((a, b) => (b.y !== a.y ? b.y - a.y : a.x - b.x));

    let current: RawTextItem[] = [];
    let currentBaseline = Number.NaN;

    const flush = (): void => {
      if (current.length === 0) return;
      for (const group of splitMarginBandRun(current, pageHeight)) {
        lines.push(buildLine(group, documentId, pageNumber, counter++, columnIndex));
      }
      current = [];
    };

    for (const item of sorted) {
      const fontSize = item.fontSize || item.height || 10;
      const tolerance = Math.max(MIN_BASELINE_TOLERANCE, fontSize * BASELINE_TOLERANCE_RATIO);
      if (current.length === 0 || Math.abs(item.y - currentBaseline) <= tolerance) {
        if (current.length === 0) currentBaseline = item.y;
        current.push(item);
      } else {
        flush();
        currentBaseline = item.y;
        current.push(item);
      }
    }
    flush();
  }

  return lines.sort((a, b) => (b.baseline !== a.baseline ? b.baseline - a.baseline : a.x - b.x));
}

/**
 * Splits a same-baseline run of items into independent lines when it sits in a
 * page margin band and contains a gap far too wide to be a word space.
 * Outside the margin bands the run is returned untouched.
 */
function splitMarginBandRun(items: RawTextItem[], pageHeight: number): RawTextItem[][] {
  if (pageHeight <= 0 || items.length < 2) return [items];
  const baseline = items[0].y;
  const inMargin = baseline <= pageHeight * MARGIN_BAND || baseline >= pageHeight * (1 - MARGIN_BAND);
  if (!inMargin) return [items];

  const sorted = [...items].sort((a, b) => a.x - b.x);
  const groups: RawTextItem[][] = [];
  let current: RawTextItem[] = [];
  // PDF.js synthesises whitespace items that span the gap between two pieces of
  // furniture, so gaps must be measured between items that carry actual glyphs.
  let lastGlyphItem: RawTextItem | null = null;

  for (const item of sorted) {
    const isGlyph = item.text.trim() !== '';
    if (isGlyph && lastGlyphItem) {
      const gap = item.x - (lastGlyphItem.x + lastGlyphItem.width);
      const fontSize = item.fontSize || item.height || 10;
      if (gap > fontSize * MARGIN_SPLIT_GAP_RATIO) {
        groups.push(current);
        current = [];
      }
    }
    current.push(item);
    if (isGlyph) lastGlyphItem = item;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function buildLine(
  items: RawTextItem[],
  documentId: string,
  pageNumber: number,
  index: number,
  columnIndex: number,
): TextLine {
  const rtl = items.some((item) => item.direction === 'rtl');
  const ordered = [...items].sort((a, b) => (rtl ? b.x - a.x : a.x - b.x));

  let text = '';
  const spans: TextLine['spans'] = [];

  ordered.forEach((item, position) => {
    const normalized = normalizeItemText(item.text, item.id);
    const previous = ordered[position - 1];
    if (previous && text.length > 0) {
      const gap = rtl
        ? previous.x - (item.x + item.width)
        : item.x - (previous.x + previous.width);
      const fontSize = item.fontSize || item.height || 10;
      const needsSpace =
        gap > fontSize * SPACE_GAP_RATIO && !/\s$/.test(text) && !/^\s/.test(normalized.text);
      if (needsSpace) text += ' ';
    }
    const start = text.length;
    text += normalized.text;
    spans.push({ start, end: text.length, itemId: item.id });
  });

  const minX = Math.min(...ordered.map((item) => item.x));
  const maxX = Math.max(...ordered.map((item) => item.x + item.width));
  const baseline = medianOf(ordered.map((item) => item.y));
  const fontSize = medianOf(ordered.map((item) => item.fontSize || item.height || 10));
  const height = Math.max(...ordered.map((item) => item.height || fontSize));

  // Font names are per-item; the modal name describes the line.
  const nameCounts = new Map<string, number>();
  for (const item of ordered) {
    if (!item.fontName) continue;
    nameCounts.set(item.fontName, (nameCounts.get(item.fontName) ?? 0) + 1);
  }
  const fontName = [...nameCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  return {
    id: lineId(documentId, pageNumber, index),
    pageNumber,
    items: ordered,
    text,
    spans,
    x: minX,
    y: baseline,
    width: maxX - minX,
    height,
    baseline,
    fontSize,
    fontName,
    columnIndex: columnIndex < 0 ? -1 : columnIndex,
    spansColumns: columnIndex < 0,
  };
}

/**
 * Orders lines into a single reading sequence.
 *
 * Column-spanning lines (headings, running heads) act as band separators: the
 * page is split at each spanning line, and within a band columns are read left
 * to right, top to bottom. This prevents the classic failure where a two-column
 * page is read straight across.
 */
export function orderLines(lines: TextLine[], columnCount: number): TextLine[] {
  if (lines.length === 0) return [];
  const byTop = (a: TextLine, b: TextLine): number =>
    b.baseline !== a.baseline ? b.baseline - a.baseline : a.x - b.x;

  if (columnCount <= 1) return [...lines].sort(byTop);

  const spanning = lines.filter((line) => line.spansColumns).sort(byTop);
  const columnLines = lines.filter((line) => !line.spansColumns);

  const boundaries = spanning.map((line) => line.baseline);
  const ordered: TextLine[] = [];

  /** Emits every column line whose baseline sits in (lowerY, upperY]. */
  const emitBand = (upperY: number, lowerY: number): void => {
    const band = columnLines.filter((line) => line.baseline <= upperY && line.baseline > lowerY);
    band
      .sort((a, b) => (a.columnIndex !== b.columnIndex ? a.columnIndex - b.columnIndex : byTop(a, b)))
      .forEach((line) => ordered.push(line));
  };

  let upper = Number.POSITIVE_INFINITY;
  spanning.forEach((line, index) => {
    emitBand(upper, line.baseline);
    ordered.push(line);
    upper = line.baseline;
    if (index === spanning.length - 1) emitBand(upper, Number.NEGATIVE_INFINITY);
  });

  if (boundaries.length === 0) emitBand(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);

  // Safety net: nothing may be dropped by the banding logic.
  if (ordered.length !== lines.length) {
    const seen = new Set(ordered.map((line) => line.id));
    for (const line of lines) if (!seen.has(line.id)) ordered.push(line);
  }
  return ordered;
}
