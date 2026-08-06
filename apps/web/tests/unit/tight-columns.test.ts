import { describe, expect, it } from 'vitest';
import type { RawTextItem } from '@pdfreader/shared-types';
import { detectColumns } from '@/features/extraction/columns';

/**
 * Geometry from a real NEJM paper, where the two columns very nearly touch.
 *
 * At the detector's density threshold the gutter measured **2 points**, so the
 * coverage projection found no strip to split on and thirteen two-column pages
 * were read as one — interleaving the columns line by line:
 *
 *   "antineu- Me thods trophil cytoplasmic autoantibody–associated vas- Trial
 *    Design and Oversight culitis; or had received immunosuppressive therapy"
 *
 * The line starts are unambiguous even when the gutter is not: half the items
 * begin at x=62 and half at x=269, and nothing begins between.
 */
let counter = 0;
const item = (text: string, x: number, width: number, y: number, fontSize = 10): RawTextItem => {
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

/** Two columns whose lines end and begin within a couple of points. */
function tightTwoColumnPage(): RawTextItem[] {
  const items: RawTextItem[] = [];
  for (let row = 0; row < 20; row += 1) {
    const y = 700 - row * 11;
    // Left column runs 62..267; right column starts at 269.
    items.push(item(`left column line number ${row} of text`, 62, 205, y));
    items.push(item(`right column line number ${row} of text`, 269, 205, y));
  }
  return items;
}

describe('columns that nearly touch', () => {
  it('finds the split from line starts when the gutter is too narrow to see', () => {
    const detection = detectColumns(tightTwoColumnPage(), 567);

    expect(detection.columns).toHaveLength(2);
    expect(detection.columns[0].end).toBeGreaterThan(200);
    expect(detection.columns[0].end).toBeLessThan(275);
    expect(detection.evidence.join(' ')).toContain('line starts');
  });

  it('assigns each column its own items rather than interleaving them', () => {
    const items = tightTwoColumnPage();
    const { columns } = detectColumns(items, 567);
    const boundary = columns[0].end;

    const left = items.filter((i) => i.x < boundary).map((i) => i.text);
    const right = items.filter((i) => i.x >= boundary).map((i) => i.text);
    expect(left.every((t) => t.startsWith('left'))).toBe(true);
    expect(right.every((t) => t.startsWith('right'))).toBe(true);
  });

  it('does not split a single column that merely has indented lines', () => {
    // Paragraph indents and a hanging list, all well left of any column split.
    const items: RawTextItem[] = [];
    for (let row = 0; row < 20; row += 1) {
      const y = 700 - row * 11;
      const x = row % 3 === 0 ? 30 : row % 3 === 1 ? 61 : 80;
      items.push(item(`single column line ${row} running the full measure here`, x, 460, y));
    }
    expect(detectColumns(items, 567).columns).toHaveLength(1);
  });

  it('does not split when nearly every row crosses the candidate boundary', () => {
    // Full-width prose that happens to have many lines starting mid-page.
    const items: RawTextItem[] = [];
    for (let row = 0; row < 20; row += 1) {
      const y = 700 - row * 11;
      items.push(item(`full width line ${row} of continuous prose`, 62, 440, y));
      items.push(item(`tail ${row}`, 269, 40, y));
    }
    expect(detectColumns(items, 567).columns).toHaveLength(1);
  });

  it('leaves a page with too few items alone', () => {
    const items = [item('a short line', 62, 100, 700), item('another', 269, 60, 700)];
    expect(detectColumns(items, 567).columns).toHaveLength(1);
  });
});
