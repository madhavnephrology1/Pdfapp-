import type { LayoutBlock, TextLine } from './types';

/** A row must have at least this many cells to be tabular. */
const MIN_CELLS = 3;
/** Cell separation, relative to font size, that distinguishes columns from words. */
const CELL_GAP_RATIO = 2.0;
/** Column x positions must align within this many points across rows. */
const ALIGNMENT_TOLERANCE = 6;
/** A table needs at least this many aligned rows. */
const MIN_ROWS = 2;

export interface TableCell {
  text: string;
  x: number;
  itemIds: string[];
}

export interface TableRow {
  lineId: string;
  cells: TableCell[];
}

/**
 * Splits a line into cells at gaps that are far too wide to be word spaces.
 * Returns null when the line is ordinary prose.
 */
export function splitLineIntoCells(line: TextLine): TableCell[] | null {
  // PDF.js emits whitespace-only items that span inter-cell gaps; they must not
  // count as cells nor mask the gap between the glyphs on either side.
  const glyphItems = line.items.filter((item) => item.text.trim() !== '');
  if (glyphItems.length < MIN_CELLS) return null;
  const threshold = Math.max(line.fontSize * CELL_GAP_RATIO, 8);

  const cells: TableCell[] = [];
  let currentText = '';
  let currentX = glyphItems[0].x;
  let currentIds: string[] = [];

  glyphItems.forEach((item, index) => {
    const previous = glyphItems[index - 1];
    const gap = previous ? item.x - (previous.x + previous.width) : 0;
    if (previous && gap > threshold) {
      cells.push({
        text: currentText.trim(),
        x: currentX,
        itemIds: currentIds,
      });
      currentText = '';
      currentX = item.x;
      currentIds = [];
    }
    currentText += (currentText === '' ? '' : ' ') + item.text.trim();
    currentIds.push(item.id);
  });
  cells.push({ text: currentText.trim(), x: currentX, itemIds: currentIds });

  const populated = cells.filter((cell) => cell.text !== '');
  return populated.length >= MIN_CELLS ? populated : null;
}

/**
 * Detects tables by column alignment across consecutive candidate rows.
 *
 * Tables are kept as their own region because reading a table as a flat stream
 * of words produces meaningless narration. The default behaviour is to skip
 * them and offer structured row-by-row reading instead.
 */
export function detectTables(blocks: LayoutBlock[]): {
  blocks: LayoutBlock[];
  rowsByBlock: Map<string, TableRow[]>;
} {
  const rowsByBlock = new Map<string, TableRow[]>();
  const output: LayoutBlock[] = [];

  for (const block of blocks) {
    if (block.type === 'heading') {
      output.push(block);
      continue;
    }

    const candidates = block.lines.map((line) => ({
      line,
      cells: splitLineIntoCells(line),
    }));
    const rowLines = candidates.filter((candidate) => candidate.cells !== null);
    if (rowLines.length < MIN_ROWS) {
      output.push(block);
      continue;
    }

    const reference = rowLines[0].cells!.map((cell) => cell.x);
    const aligned = rowLines.filter((candidate) =>
      candidate.cells!.every((cell) =>
        reference.some((x) => Math.abs(x - cell.x) <= ALIGNMENT_TOLERANCE),
      ),
    );
    if (aligned.length < MIN_ROWS) {
      output.push(block);
      continue;
    }

    // The tabular rows form a contiguous run; anything before or after it (a
    // caption, a lead-in sentence) stays its own region rather than being
    // swallowed by the table.
    const isRow = candidates.map((candidate) => candidate.cells !== null);
    const first = isRow.indexOf(true);
    const last = isRow.lastIndexOf(true);
    const before = block.lines.slice(0, first);
    const tableLines = block.lines.slice(first, last + 1);
    const after = block.lines.slice(last + 1);

    // A single tabular line inside a run of prose is not a table.
    if (tableLines.length < MIN_ROWS || rowLines.length < tableLines.length * 0.6) {
      output.push(block);
      continue;
    }

    const boundsOf = (lines: typeof block.lines) => ({
      x: Math.min(...lines.map((line) => line.x)),
      y: Math.min(...lines.map((line) => line.baseline)),
      width:
        Math.max(...lines.map((line) => line.x + line.width)) -
        Math.min(...lines.map((line) => line.x)),
      height:
        Math.max(...lines.map((line) => line.baseline + line.height)) -
        Math.min(...lines.map((line) => line.baseline)),
      pageNumber: block.pageNumber,
    });

    if (before.length > 0) {
      output.push({
        ...block,
        id: `${block.id}:pre`,
        lines: before,
        boundingBox: boundsOf(before),
      });
    }

    const tableId = before.length > 0 || after.length > 0 ? `${block.id}:table` : block.id;
    rowsByBlock.set(
      tableId,
      rowLines.map((candidate) => ({
        lineId: candidate.line.id,
        cells: candidate.cells!,
      })),
    );
    output.push({
      ...block,
      id: tableId,
      lines: tableLines,
      boundingBox: boundsOf(tableLines),
      type: 'table',
      confidence: Math.min(0.9, 0.55 + aligned.length * 0.08),
      evidence: [
        ...block.evidence,
        `${rowLines.length} lines split into ${reference.length}+ cells at gaps wider than ${CELL_GAP_RATIO}x the font size`,
        `${aligned.length} rows share column positions within ${ALIGNMENT_TOLERANCE}pt`,
      ],
    });

    if (after.length > 0) {
      output.push({
        ...block,
        id: `${block.id}:post`,
        lines: after,
        boundingBox: boundsOf(after),
      });
    }
  }

  return { blocks: output, rowsByBlock };
}
