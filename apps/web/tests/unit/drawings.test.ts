import { describe, expect, it } from 'vitest';
import { collectDrawings, type ImageOps } from '@/features/extraction/figures';

/** Operator codes; the real values come from PDF.js at runtime. */
const OPS: ImageOps = {
  save: 10,
  restore: 11,
  transform: 12,
  paintImageXObject: 85,
  paintImageMaskXObject: 83,
  paintInlineImageXObject: 86,
  constructPath: 91,
};

const list = (entries: [number, unknown[]?][]) => ({
  fnArray: entries.map((e) => e[0]),
  argsArray: entries.map((e) => e[1] ?? []),
});

const PAGE_W = 612;
const PAGE_H = 792;

/**
 * A `constructPath` operation. PDF.js passes `[ops, coords, minMax]`, and it is
 * the third argument — the path's own bounding box — that this reads.
 */
const path = (x0: number, y0: number, x1: number, y1: number): [number, unknown[]] => [
  OPS.constructPath as number,
  [[], [], [x0, y0, x1, y1]],
];

describe('collectDrawings', () => {
  it('reports the area a path covers', () => {
    const drawings = collectDrawings(list([path(100, 200, 400, 500)]), OPS, 4, PAGE_W, PAGE_H);

    expect(drawings).toHaveLength(1);
    expect(drawings[0]).toMatchObject({ pageNumber: 4, x: 100, y: 200, width: 300, height: 300 });
  });

  it('carries the path through the matrix in force', () => {
    const drawings = collectDrawings(
      list([
        [OPS.save],
        [OPS.transform, [2, 0, 0, 2, 50, 100]],
        path(0, 0, 150, 200),
        [OPS.restore],
      ]),
      OPS,
      1,
      PAGE_W,
      PAGE_H,
    );

    expect(drawings[0]).toMatchObject({ x: 50, y: 100, width: 300, height: 400 });
  });

  it('ignores rules, underlines and table borders', () => {
    const drawings = collectDrawings(
      list([
        path(72, 700, 540, 701), // a horizontal rule
        path(72, 100, 73, 600), // a vertical column divider
      ]),
      OPS,
      1,
      PAGE_W,
      PAGE_H,
    );
    expect(drawings).toEqual([]);
  });

  it('ignores a box too small to be a drawing', () => {
    // Comfortably above the thin-line test, still far too small to be a chart.
    expect(collectDrawings(list([path(100, 100, 160, 160)]), OPS, 1, PAGE_W, PAGE_H)).toEqual([]);
  });

  /**
   * The page-furniture case. A web-to-PDF print paints one rectangle behind the
   * whole body, and a journal template paints a page frame. Reported as
   * drawings, these put a marker on every page of a document that has no charts
   * or diagrams at all — measured on two real papers before this cap existed.
   */
  it('ignores a background that covers the page', () => {
    expect(collectDrawings(list([path(20, 20, 592, 772)]), OPS, 1, PAGE_W, PAGE_H)).toEqual([]);
  });

  it('ignores a path that runs past the page edge', () => {
    // Seen on a long web page printed to PDF: the box is taller than the sheet.
    expect(collectDrawings(list([path(0, -900, 612, 800)]), OPS, 1, PAGE_W, PAGE_H)).toEqual([]);
  });

  /**
   * The other shape furniture takes: a header strip, a site navigation bar, the
   * copyright block at the foot of a printed web page. Small enough to pass the
   * area cap, and made of short fragments, so only its edges give it away.
   */
  it('ignores a band running the full width of the sheet', () => {
    const drawings = collectDrawings(
      list([
        path(18, 749, 577, 802), // a header strip
        path(18, 40, 577, 222), // a navigation bar
      ]),
      OPS,
      1,
      PAGE_W,
      PAGE_H,
    );
    expect(drawings).toEqual([]);
  });

  it('ignores a band drawn wider than the page', () => {
    expect(collectDrawings(list([path(-14, 100, 620, 320)]), OPS, 1, PAGE_W, PAGE_H)).toEqual([]);
  });

  it('keeps a figure that spans the text block but respects the margins', () => {
    // The widest real diagram measured: 0.86 of its page width.
    const drawings = collectDrawings(list([path(31, 277, 557, 617)]), OPS, 1, PAGE_W, PAGE_H);
    expect(drawings).toHaveLength(1);
  });

  it('keeps a chart that takes up much of the page but not all of it', () => {
    // The largest real diagram measured: 0.58 of its page.
    const drawings = collectDrawings(list([path(90, 90, 495, 708)]), OPS, 1, PAGE_W, PAGE_H);
    expect(drawings).toHaveLength(1);
  });

  it('forgets a transform once its save is restored', () => {
    const drawings = collectDrawings(
      list([
        [OPS.save],
        [OPS.transform, [4, 0, 0, 4, 300, 300]],
        [OPS.restore],
        path(100, 200, 400, 500),
      ]),
      OPS,
      1,
      PAGE_W,
      PAGE_H,
    );
    expect(drawings[0]).toMatchObject({ x: 100, y: 200 });
  });

  it('merges the parts of one chart into a single area', () => {
    const drawings = collectDrawings(
      list([path(100, 200, 400, 500), path(350, 250, 560, 560)]),
      OPS,
      1,
      PAGE_W,
      PAGE_H,
    );
    expect(drawings).toHaveLength(1);
    expect(drawings[0]).toMatchObject({ x: 100, y: 200, width: 460, height: 360 });
  });

  it('keeps two charts that do not overlap apart', () => {
    const drawings = collectDrawings(
      list([path(60, 460, 340, 740), path(60, 60, 340, 340)]),
      OPS,
      1,
      PAGE_W,
      PAGE_H,
    );
    expect(drawings).toHaveLength(2);
  });

  it('skips a path whose bounding box is missing', () => {
    expect(
      collectDrawings(
        list([[OPS.constructPath as number, [[], []]], path(100, 200, 400, 500)]),
        OPS,
        1,
        PAGE_W,
        PAGE_H,
      ),
    ).toHaveLength(1);
  });

  it('returns nothing when the build has no constructPath operator', () => {
    const { constructPath: _omitted, ...withoutPath } = OPS;
    expect(
      collectDrawings(list([path(100, 200, 400, 500)]), withoutPath, 1, PAGE_W, PAGE_H),
    ).toEqual([]);
  });

  it('survives a restore with nothing saved', () => {
    expect(() =>
      collectDrawings(list([[OPS.restore], [OPS.restore]]), OPS, 1, PAGE_W, PAGE_H),
    ).not.toThrow();
  });
});
