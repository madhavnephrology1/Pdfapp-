import { describe, expect, it } from 'vitest';
import { collectFigures, type ImageOps } from '@/features/extraction/figures';

/** Operator codes; the real values come from PDF.js at runtime. */
const OPS: ImageOps = {
  save: 10,
  restore: 11,
  transform: 12,
  paintImageXObject: 85,
  paintImageMaskXObject: 83,
  paintInlineImageXObject: 86,
};

const list = (entries: [number, unknown[]?][]) => ({
  fnArray: entries.map((e) => e[0]),
  argsArray: entries.map((e) => e[1] ?? []),
});

const PAGE = [612, 792] as const;

describe('collectFigures', () => {
  it('places an image using the matrix in force when it is painted', () => {
    // A 200x150 image with its bottom-left corner at (100, 500).
    const figures = collectFigures(
      list([
        [OPS.save],
        [OPS.transform, [200, 0, 0, 150, 100, 500]],
        [OPS.paintImageXObject, ['img1']],
        [OPS.restore],
      ]),
      OPS,
      3,
      PAGE[0],
      PAGE[1],
    );

    expect(figures).toHaveLength(1);
    expect(figures[0]).toMatchObject({ pageNumber: 3, x: 100, y: 500, width: 200, height: 150 });
  });

  it('forgets a transform once its save is restored', () => {
    const figures = collectFigures(
      list([
        [OPS.save],
        [OPS.transform, [200, 0, 0, 150, 400, 100]],
        [OPS.restore],
        // Outside the save, so the first transform must not still apply.
        [OPS.transform, [300, 0, 0, 200, 0, 0]],
        [OPS.paintImageXObject, ['img']],
      ]),
      OPS,
      1,
      PAGE[0],
      PAGE[1],
    );

    expect(figures).toHaveLength(1);
    expect(figures[0]).toMatchObject({ x: 0, y: 0, width: 300, height: 200 });
  });

  it('handles a flipped image without producing a negative size', () => {
    // Negative vertical scale: the common way an image is placed.
    const figures = collectFigures(
      list([
        [OPS.transform, [200, 0, 0, -150, 100, 500]],
        [OPS.paintImageXObject, ['img']],
      ]),
      OPS,
      1,
      PAGE[0],
      PAGE[1],
    );

    expect(figures[0].width).toBe(200);
    expect(figures[0].height).toBe(150);
    expect(figures[0].y).toBe(350);
  });

  it('ignores rules, bullets and spacers', () => {
    const figures = collectFigures(
      list([
        [OPS.transform, [400, 0, 0, 1, 100, 700]], // a hairline rule
        [OPS.paintImageXObject, ['rule']],
        [OPS.transform, [6, 0, 0, 6, 50, 600]], // a bullet
        [OPS.paintImageXObject, ['bullet']],
      ]),
      OPS,
      1,
      PAGE[0],
      PAGE[1],
    );
    expect(figures).toHaveLength(0);
  });

  it('merges the tiles of one chart into a single figure', () => {
    const figures = collectFigures(
      list([
        [OPS.save],
        [OPS.transform, [200, 0, 0, 150, 100, 500]],
        [OPS.paintImageXObject, ['tile-a']],
        [OPS.restore],
        [OPS.save],
        // Overlapping the first by a little, as tiled output does.
        [OPS.transform, [200, 0, 0, 150, 280, 500]],
        [OPS.paintImageXObject, ['tile-b']],
        [OPS.restore],
      ]),
      OPS,
      1,
      PAGE[0],
      PAGE[1],
    );

    expect(figures).toHaveLength(1);
    expect(figures[0].x).toBe(100);
    expect(figures[0].width).toBe(380);
  });

  it('keeps two figures that do not overlap apart', () => {
    const figures = collectFigures(
      list([
        [OPS.save],
        [OPS.transform, [200, 0, 0, 150, 50, 600]],
        [OPS.paintImageXObject, ['a']],
        [OPS.restore],
        [OPS.save],
        [OPS.transform, [200, 0, 0, 150, 50, 200]],
        [OPS.paintImageXObject, ['b']],
        [OPS.restore],
      ]),
      OPS,
      1,
      PAGE[0],
      PAGE[1],
    );
    expect(figures).toHaveLength(2);
  });

  it('counts masks and inline images too', () => {
    const figures = collectFigures(
      list([
        [OPS.transform, [200, 0, 0, 150, 0, 0]],
        [OPS.paintImageMaskXObject, ['mask']],
        [OPS.transform, [1, 0, 0, 1, 0, 400]],
        [OPS.paintInlineImageXObject, ['inline']],
      ]),
      OPS,
      1,
      PAGE[0],
      PAGE[1],
    );
    expect(figures.length).toBeGreaterThan(0);
  });

  it('returns nothing for a page that paints no images', () => {
    expect(collectFigures(list([[OPS.save], [OPS.restore]]), OPS, 1, PAGE[0], PAGE[1])).toEqual([]);
  });

  it('survives a restore with nothing saved', () => {
    expect(() =>
      collectFigures(list([[OPS.restore], [OPS.restore]]), OPS, 1, PAGE[0], PAGE[1]),
    ).not.toThrow();
  });
});
