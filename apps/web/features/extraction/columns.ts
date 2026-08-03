import type { RawTextItem } from '@pdfreader/shared-types';
import type { ColumnBand, ColumnDetection } from './types';

const BIN_SIZE = 2;
const MAX_COLUMNS = 3;
/** A gutter must be at least this wide (points) to count as a column break. */
const MIN_GUTTER_POINTS = 14;
/** Each side of a gutter must hold at least this share of the page's items. */
const MIN_SIDE_SHARE = 0.15;
const MIN_SIDE_ITEMS = 3;
/** Items wider than this share of the content width are treated as spanning. */
const SPANNING_WIDTH_SHARE = 0.55;
/**
 * Share of text rows that may cross a candidate gutter before it is rejected.
 * This is what distinguishes a real column gutter, which runs continuously down
 * the page, from the gaps between table cells, which only exist inside the
 * table's own vertical band with prose crossing them above and below.
 */
const MAX_CROSSING_ROW_SHARE = 0.2;
/** A candidate gutter must have text on both sides on at least this many rows. */
const MIN_TWO_SIDED_ROWS = 3;
/** A column band narrower than this share of the content width is implausible. */
const MIN_BAND_WIDTH_SHARE = 0.2;

interface Interval {
  start: number;
  end: number;
}

/**
 * Buckets items into approximate text rows by baseline, ignoring columns.
 * Used only to test whether a candidate gutter is vertically continuous.
 */
function groupIntoRows(items: RawTextItem[]): RawTextItem[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const rows: RawTextItem[][] = [];
  let current: RawTextItem[] = [];
  let baseline = Number.NaN;

  for (const item of sorted) {
    const tolerance = Math.max(1.5, (item.fontSize || item.height || 10) * 0.4);
    if (current.length === 0 || Math.abs(item.y - baseline) <= tolerance) {
      if (current.length === 0) baseline = item.y;
      current.push(item);
    } else {
      rows.push(current);
      current = [item];
      baseline = item.y;
    }
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

/**
 * Identifies items that belong to aligned tabular rows.
 *
 * The gaps between table cells look exactly like column gutters to a projection
 * profile, so a table would otherwise split the page into fake text columns and
 * the reader would narrate the table vertically, one column at a time. Table
 * interiors are therefore removed from the column vote entirely.
 *
 * A run of two or more adjacent rows, each holding three or more cells at
 * matching x positions, is treated as tabular.
 */
function tabularItemIds(rows: RawTextItem[][]): Set<string> {
  const cellStarts = (row: RawTextItem[]): number[] | null => {
    if (row.length < 3) return null;
    const sorted = [...row].sort((a, b) => a.x - b.x);
    const starts: number[] = [sorted[0].x];
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      const gap = sorted[i].x - (previous.x + previous.width);
      const fontSize = sorted[i].fontSize || sorted[i].height || 10;
      if (gap > fontSize * 2) starts.push(sorted[i].x);
    }
    return starts.length >= 3 ? starts : null;
  };

  const rowStarts = rows.map(cellStarts);
  const aligned = (a: number[], b: number[]): boolean => {
    const matches = a.filter((x) => b.some((y) => Math.abs(x - y) <= 6)).length;
    return matches >= Math.min(3, Math.min(a.length, b.length));
  };

  const tabular = new Set<string>();
  for (let i = 0; i < rows.length - 1; i += 1) {
    const current = rowStarts[i];
    const next = rowStarts[i + 1];
    if (!current || !next || !aligned(current, next)) continue;
    for (const item of rows[i]) tabular.add(item.id);
    for (const item of rows[i + 1]) tabular.add(item.id);
  }
  return tabular;
}

function contentExtent(items: RawTextItem[]): Interval | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if (item.text.trim() === '') continue;
    min = Math.min(min, item.x);
    max = Math.max(max, item.x + item.width);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  return { start: min, end: max };
}

/**
 * Detects column bands from the horizontal distribution of text.
 *
 * The method is a vertical projection profile: every narrow text item marks the
 * horizontal bins it covers, and a run of empty bins wide enough to be a gutter
 * splits the page. Full-width items (headings, rules, running heads) are excluded
 * from the profile, otherwise a single heading would hide every gutter.
 *
 * This is deterministic layout analysis. No model, no heuristic guessing at
 * content meaning.
 */
export function detectColumns(items: RawTextItem[], pageWidth: number): ColumnDetection {
  const textItems = items.filter((item) => item.text.trim() !== '');
  const extent = contentExtent(textItems);
  const singleColumn = (confidence: number, evidence: string[]): ColumnDetection => ({
    columns: [{ index: 0, start: extent?.start ?? 0, end: extent?.end ?? pageWidth }],
    confidence,
    evidence,
  });

  if (!extent) return singleColumn(1, ['page has no positioned text']);
  if (textItems.length < 8) {
    return singleColumn(0.9, [`only ${textItems.length} text items; single column assumed`]);
  }

  const contentWidth = extent.end - extent.start;
  const rows = groupIntoRows(textItems);
  const tabular = tabularItemIds(rows);

  const narrow = textItems.filter(
    (item) => item.width < contentWidth * SPANNING_WIDTH_SHARE && !tabular.has(item.id),
  );
  if (narrow.length < 6) {
    return singleColumn(
      0.85,
      tabular.size > 0
        ? [`${tabular.size} items belong to aligned table rows and do not vote on column structure`]
        : ['most items span the full content width'],
    );
  }

  const binCount = Math.max(1, Math.ceil(contentWidth / BIN_SIZE));
  const coverage = new Uint32Array(binCount);
  for (const item of narrow) {
    const from = Math.max(0, Math.floor((item.x - extent.start) / BIN_SIZE));
    const to = Math.min(binCount - 1, Math.ceil((item.x + item.width - extent.start) / BIN_SIZE));
    for (let bin = from; bin <= to; bin += 1) coverage[bin] += 1;
  }

  // Collect interior runs of empty bins.
  const gutters: Interval[] = [];
  let runStart: number | null = null;
  for (let bin = 0; bin < binCount; bin += 1) {
    if (coverage[bin] === 0) {
      if (runStart === null) runStart = bin;
    } else if (runStart !== null) {
      gutters.push({ start: runStart, end: bin });
      runStart = null;
    }
  }
  // A trailing run touches the right edge, so it is margin, not a gutter.

  const evidence: string[] = [];
  const candidates = gutters
    .filter((run) => run.start > 0)
    .map((run) => ({
      widthPoints: (run.end - run.start) * BIN_SIZE,
      centre: extent.start + ((run.start + run.end) / 2) * BIN_SIZE,
    }))
    .filter((g) => g.widthPoints >= Math.max(MIN_GUTTER_POINTS, pageWidth * 0.02))
    .sort((a, b) => b.widthPoints - a.widthPoints);

  const accepted: number[] = [];

  for (const candidate of candidates) {
    if (accepted.length + 1 >= MAX_COLUMNS) break;
    const left = narrow.filter((item) => item.x + item.width / 2 < candidate.centre).length;
    const right = narrow.length - left;
    const share = Math.min(left, right) / narrow.length;
    if (Math.min(left, right) < MIN_SIDE_ITEMS || share < MIN_SIDE_SHARE) {
      evidence.push(
        `rejected gutter at x=${candidate.centre.toFixed(0)}: sides hold only ${left}/${right} items`,
      );
      continue;
    }

    // Vertical continuity. A genuine gutter is empty for nearly the full height
    // of the page; a gap between table cells has prose crossing it above and
    // below the table.
    const crossing = rows.filter((row) =>
      row.some(
        (item) => item.x < candidate.centre - 2 && item.x + item.width > candidate.centre + 2,
      ),
    ).length;
    const twoSided = rows.filter(
      (row) =>
        row.some((item) => item.x + item.width <= candidate.centre) &&
        row.some((item) => item.x >= candidate.centre),
    ).length;
    const crossingShare = rows.length > 0 ? crossing / rows.length : 1;

    if (crossingShare > MAX_CROSSING_ROW_SHARE) {
      evidence.push(
        `rejected gutter at x=${candidate.centre.toFixed(0)}: text crosses it on ${crossing} of ${rows.length} rows, so it is not a continuous column gutter`,
      );
      continue;
    }
    if (twoSided < MIN_TWO_SIDED_ROWS) {
      evidence.push(
        `rejected gutter at x=${candidate.centre.toFixed(0)}: only ${twoSided} rows have text on both sides`,
      );
      continue;
    }

    const bandWidth = Math.min(candidate.centre - extent.start, extent.end - candidate.centre);
    if (bandWidth < contentWidth * MIN_BAND_WIDTH_SHARE) {
      evidence.push(
        `rejected gutter at x=${candidate.centre.toFixed(0)}: it would create a ${bandWidth.toFixed(0)}pt column, too narrow to be a text column`,
      );
      continue;
    }

    accepted.push(candidate.centre);
    evidence.push(
      `gutter at x=${candidate.centre.toFixed(0)} is ${candidate.widthPoints.toFixed(0)}pt wide, splits ${left}/${right} items, and is crossed on only ${crossing} of ${rows.length} rows`,
    );
  }

  if (accepted.length === 0) {
    return singleColumn(
      0.9,
      evidence.length > 0 ? evidence : ['no gutter wide enough to split the page'],
    );
  }

  accepted.sort((a, b) => a - b);
  const columns: ColumnBand[] = [];
  let start = extent.start;
  accepted.forEach((centre, index) => {
    columns.push({ index, start, end: centre });
    start = centre;
  });
  columns.push({ index: columns.length, start, end: extent.end });

  // Items straddling a gutter weaken the column hypothesis.
  const straddling = textItems.filter((item) =>
    accepted.some((centre) => item.x < centre - 2 && item.x + item.width > centre + 2),
  );
  const straddleRatio = straddling.length / textItems.length;
  evidence.push(`${straddling.length} of ${textItems.length} items span a gutter`);

  const confidence = Math.max(0.3, Math.min(0.95, 0.95 - straddleRatio * 1.5));
  return { columns, confidence, evidence };
}

/**
 * Assigns an item to a column.
 * Returns -1 when the item spans more than one column (a full-width heading).
 */
export function assignColumn(item: RawTextItem, columns: ColumnBand[]): number {
  if (columns.length <= 1) return 0;
  const left = item.x;
  const right = item.x + item.width;
  const touched = columns.filter((column) => right > column.start + 2 && left < column.end - 2);
  if (touched.length > 1) return -1;
  if (touched.length === 1) return touched[0].index;

  // Fall back to the nearest band by centre so nothing is ever dropped.
  const centre = (left + right) / 2;
  let best = columns[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const column of columns) {
    const distance =
      centre < column.start ? column.start - centre : centre > column.end ? centre - column.end : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = column;
    }
  }
  return best.index;
}
