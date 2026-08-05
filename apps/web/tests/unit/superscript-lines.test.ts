import { describe, expect, it } from 'vitest';
import type { RawTextItem } from '@pdfreader/shared-types';
import { detectColumns } from '@/features/extraction/columns';
import { groupLines } from '@/features/extraction/lines';

/**
 * Geometry taken from a real journal PDF, where a superscript citation marker
 * broke a sentence into three paragraphs on screen:
 *
 *   "…reported in solid tumors as well such as small cell"
 *   "3-5"
 *   "carcinoma, breast cancer, and neuroblastoma. Although…"
 *
 * The marker is set at 6.6pt against a 10pt body and lifted 4.4pt above its
 * baseline, which puts it between two body lines. Grouping by baseline alone
 * therefore gave it a line of its own.
 */
let counter = 0;
const item = (text: string, x: number, width: number, y: number, fontSize: number): RawTextItem => {
  const index = counter++;
  return {
    id: `i${index}`,
    documentId: 'd',
    pageNumber: 1,
    text,
    transform: [fontSize, 0, 0, fontSize, x, y],
    x,
    y,
    width,
    height: fontSize,
    fontSize,
    direction: 'ltr',
    sourceIndex: index,
  };
};

const linesFrom = (items: RawTextItem[]): string[] => {
  const columns = detectColumns(items, 612);
  return groupLines(items, columns.columns, 'd', 1, 792).map((line) => line.text);
};

describe('superscript reattachment', () => {
  it('keeps a raised citation marker on the line it belongs to', () => {
    const lines = linesFrom([
      item('has been reported in solid tumors as well such as small cell', 35, 197, 315.4, 10),
      item('carcinoma, breast cancer, and neuroblastoma.', 35, 197, 304.5, 10),
      item('3-5', 232.2, 8, 308.9, 6.6),
      item('Although', 245.4, 40, 304.5, 10),
    ]);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('small cell');
    // At its own x, so it follows the full stop it cites — not appended at the end.
    expect(lines[1]).toBe('carcinoma, breast cancer, and neuroblastoma.3-5 Although');
  });

  it('never drops a marker that has no line to belong to', () => {
    const lines = linesFrom([
      item('Body text on its own', 35, 120, 700, 10),
      // Far below anything, and too small to be body text.
      item('9', 35, 4, 200, 6),
    ]);
    expect(lines.join(' ')).toContain('9');
  });

  it('leaves a uniformly small block alone', () => {
    // A footnote: every item small, so nothing in it is smaller than its line.
    const lines = linesFrom([
      item('1. Smith J, Jones A. A study of things.', 35, 180, 120, 7),
      item('Journal of Things. 2019;12(3):45-67.', 35, 170, 111, 7),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Smith');
    expect(lines[1]).toContain('Journal of Things');
  });

  it('does not pull a marker onto a line it is nowhere near horizontally', () => {
    const lines = linesFrom([
      item('Left column body text here', 35, 120, 400, 10),
      // Right of the line by far more than the slack allows.
      item('7', 520, 4, 404, 6),
    ]);
    expect(lines).toHaveLength(2);
  });

  it('attaches a dropped subscript to the line above it', () => {
    const lines = linesFrom([
      item('The formula H', 35, 60, 500, 10),
      item('2', 96, 4, 497.5, 6),
      item('O is water', 101, 45, 500, 10),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('The formula H2O is water');
  });
});
