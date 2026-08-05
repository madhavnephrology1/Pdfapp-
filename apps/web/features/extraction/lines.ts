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

/**
 * Rules for reattaching a raised or dropped item to the line it belongs to.
 *
 * A superscript citation marker is set smaller than the body and lifted above
 * its baseline. Grouping purely by baseline therefore puts it on a line of its
 * own — and when it lands between two body lines, as "3-5" does in a real
 * journal PDF, it becomes its own paragraph and cuts the sentence in half:
 * "…such as small cell" / "3-5" / "carcinoma, breast cancer…".
 *
 * The size ratio is what keeps this from swallowing genuinely separate small
 * text. Footnotes, captions and table cells are uniformly small, so no item in
 * them is materially smaller than its own line and none of them qualify. Only
 * something set smaller than the line it sits against can be reattached to it.
 */
const SUPERSCRIPT_MAX_SIZE_RATIO = 0.8;
/** How far above a baseline a superscript may sit, relative to the host's size. */
const SUPERSCRIPT_MAX_RISE_RATIO = 0.7;
/** How far below a baseline a subscript may sit. Smaller: descenders are shallow. */
const SUBSCRIPT_MAX_DROP_RATIO = 0.35;
/** Horizontal slack, relative to the host's size, for sitting "against" a line. */
const ATTACH_SLACK_RATIO = 1.5;

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
const sizeOf = (item: RawTextItem): number => item.fontSize || item.height || 10;

/**
 * Splits a column's items into those that define lines and those that hang off
 * one.
 *
 * "Floating" means materially smaller than the run of text around it — the only
 * thing that can be a superscript or subscript. Size is judged against the
 * column's median so that a uniformly small block (a footnote, a caption) has no
 * floating items at all and is grouped exactly as it was before.
 */
function partitionFloatingItems(items: RawTextItem[]): {
  body: RawTextItem[];
  floating: RawTextItem[];
} {
  const median = medianOf(items.map(sizeOf));
  if (median <= 0) return { body: items, floating: [] };

  const body: RawTextItem[] = [];
  const floating: RawTextItem[] = [];
  for (const item of items) {
    if (sizeOf(item) <= median * SUPERSCRIPT_MAX_SIZE_RATIO) floating.push(item);
    else body.push(item);
  }
  // Everything being "small" means the column simply is small; nothing floats.
  return body.length === 0 ? { body: items, floating: [] } : { body, floating };
}

/**
 * Finds the line a raised or dropped item is sitting against, if any.
 *
 * All three tests have to hold: the host must be set larger than the item, the
 * item must sit within a superscript's rise or a subscript's drop of the host's
 * baseline, and it must be horizontally within the host's own span. The last is
 * what stops a marker attaching to a line in a different block that happens to
 * be the right distance away.
 */
function findHostRun(item: RawTextItem, runs: RawTextItem[][]): RawTextItem[] | null {
  const size = sizeOf(item);
  let best: RawTextItem[] | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const run of runs) {
    if (run.length === 0) continue;
    const hostSize = medianOf(run.map(sizeOf));
    if (hostSize <= 0 || size > hostSize * SUPERSCRIPT_MAX_SIZE_RATIO) continue;

    const baseline = medianOf(run.map((candidate) => candidate.y));
    const rise = item.y - baseline;
    const withinRise = rise > 0 && rise <= hostSize * SUPERSCRIPT_MAX_RISE_RATIO;
    const withinDrop = rise <= 0 && -rise <= hostSize * SUBSCRIPT_MAX_DROP_RATIO;
    if (!withinRise && !withinDrop) continue;

    const slack = hostSize * ATTACH_SLACK_RATIO;
    const left = Math.min(...run.map((candidate) => candidate.x));
    const right = Math.max(...run.map((candidate) => candidate.x + (candidate.width || 0)));
    if (item.x < left - slack || item.x > right + slack) continue;

    const distance = Math.abs(rise);
    if (distance < bestDistance) {
      best = run;
      bestDistance = distance;
    }
  }
  return best;
}

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

    // Raised and dropped items are set aside first, so the lines they belong to
    // exist before anything is attached to them. Doing it in one pass cannot
    // work: a superscript is read before the line it sits on, because it is
    // higher up the page.
    const { body, floating } = partitionFloatingItems(sorted);

    const runs: RawTextItem[][] = [];
    let current: RawTextItem[] = [];
    let currentBaseline = Number.NaN;

    const flush = (): void => {
      if (current.length === 0) return;
      runs.push(current);
      current = [];
    };

    for (const item of body) {
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

    // Anything with no line to belong to keeps its own, exactly as before. A
    // marker is never dropped, only moved.
    for (const item of floating) {
      const host = findHostRun(item, runs);
      if (host) host.push(item);
      else runs.push([item]);
    }

    for (const run of runs) {
      // Re-sorted because an attached item belongs at its own x, not at the end.
      const ordered = [...run].sort((a, b) => a.x - b.x);
      for (const group of splitMarginBandRun(ordered, pageHeight)) {
        lines.push(buildLine(group, documentId, pageNumber, counter++, columnIndex));
      }
    }
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
  const inMargin =
    baseline <= pageHeight * MARGIN_BAND || baseline >= pageHeight * (1 - MARGIN_BAND);
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
      const gap = rtl ? previous.x - (item.x + item.width) : item.x - (previous.x + previous.width);
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
      .sort((a, b) =>
        a.columnIndex !== b.columnIndex ? a.columnIndex - b.columnIndex : byTop(a, b),
      )
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
