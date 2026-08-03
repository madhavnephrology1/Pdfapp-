import { describe, expect, it } from 'vitest';
import type { RawTextItem } from '@pdfreader/shared-types';
import { groupLines, orderLines } from '@/features/extraction/lines';
import { detectColumns } from '@/features/extraction/columns';
import { groupBlocks } from '@/features/extraction/blocks';

/**
 * Geometry taken from a real PDF, where a page number sitting on the same
 * baseline as a long footer was merged into it and read aloud.
 */
const item = (
  index: number,
  text: string,
  x: number,
  width: number,
  y: number,
  fontSize: number,
): RawTextItem => ({
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
});

const PAGE_HEIGHT = 792;

describe('margin-band line splitting', () => {
  const footerRun = [
    item(0, 'Best for:', 50, 42.4, 50, 10),
    item(
      1,
      'Corporate presentations, financial reports, professional consulting',
      108,
      331.7,
      50,
      10,
    ),
    item(2, '1 of 10', 532, 31.6, 50, 9),
  ];

  it('separates a right-aligned page number from a long footer on the same baseline', () => {
    const columns = detectColumns(footerRun, 612);
    const lines = groupLines(footerRun, columns.columns, 'd', 1, PAGE_HEIGHT);
    expect(lines).toHaveLength(2);
    expect(lines[1].text).toBe('1 of 10');
    expect(lines[0].text).not.toContain('1 of 10');
  });

  it('leaves an ordinary footer with only word gaps as one line', () => {
    const ordinary = [
      item(0, 'Downloaded from', 54, 70, 28, 8),
      item(1, 'example.org', 126, 52, 28, 8),
    ];
    const columns = detectColumns(ordinary, 612);
    expect(groupLines(ordinary, columns.columns, 'd', 1, PAGE_HEIGHT)).toHaveLength(1);
  });

  it('does not split body text, whatever the gaps', () => {
    // Same wide gap, but in the middle of the page rather than a margin band.
    const body = [
      item(0, 'Left side of a sparse body line', 54, 200, 400, 11),
      item(1, 'right side', 450, 60, 400, 11),
    ];
    const columns = detectColumns(body, 612);
    expect(groupLines(body, columns.columns, 'd', 1, PAGE_HEIGHT)).toHaveLength(1);
  });

  it('splits a header with a chapter title and a page number', () => {
    const header = [item(0, 'Chapter 3', 54, 48, 760, 9), item(1, '41', 545, 10, 760, 9)];
    const columns = detectColumns(header, 612);
    const lines = groupLines(header, columns.columns, 'd', 1, PAGE_HEIGHT);
    expect(lines.map((l) => l.text)).toEqual(['Chapter 3', '41']);
  });
});

describe('separate-element block splitting', () => {
  /**
   * The same real PDF put the page number on its OWN baseline, 20pt below the
   * footer, so the line-level split never applied and the two merged into one
   * block. Only a rule about horizontal offset catches this.
   */
  const footer = item(
    0,
    'Best for: Corporate presentations, professional consulting',
    50,
    389,
    50,
    10,
  );
  const pageNumber = item(1, '1 of 10', 532, 31.6, 30, 9);

  const blocksFor = (items: RawTextItem[]) => {
    const columns = detectColumns(items, 612);
    const lines = groupLines(items, columns.columns, 'd', 1, PAGE_HEIGHT);
    return groupBlocks(orderLines(lines, columns.columns.length), {
      documentId: 'd',
      pageNumber: 1,
      pageHeight: PAGE_HEIGHT,
      pageWidth: 612,
      bodyFontSize: 12,
      columnWidth: 504,
    });
  };

  it('keeps a far-right page number out of the footer block', () => {
    const blocks = blocksFor([footer, pageNumber]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].lines[0].text).toBe('1 of 10');
    expect(blocks[1].evidence.join(' ')).toContain('of the page width');
  });

  it('does not split an ordinary paragraph indent', () => {
    const blocks = blocksFor([
      item(0, 'The kidney maintains extracellular fluid volume through a set of', 54, 330, 700, 11),
      // A conventional first-line indent of about two em.
      item(1, 'tightly coupled regulatory mechanisms that operate together.', 76, 320, 686, 11),
    ]);
    expect(blocks).toHaveLength(1);
  });

  it('does not split a reference hanging indent', () => {
    const blocks = blocksFor([
      item(0, 'Alvarez, M., & Chen, L. (2019). Proximal tubular transport in', 54, 300, 400, 9),
      item(1, 'health and disease. Kidney International, 95(3), 512-524.', 76, 280, 388, 9),
    ]);
    expect(blocks).toHaveLength(1);
  });
});
