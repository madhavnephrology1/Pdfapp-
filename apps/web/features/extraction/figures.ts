/**
 * Where the pictures are.
 *
 * Extraction reads the text layer, so until now an image was invisible to this
 * application: the reader went from the text before a figure to the text after
 * it with nothing said, and could not tell "no figure here" from "a figure you
 * were not told about". This finds the images so the second case can be
 * reported.
 *
 * It reports POSITION AND SIZE ONLY. Nothing here looks at what an image
 * contains, and nothing anywhere describes one — a description would be
 * generated words that are not in the document.
 */

/** A painted image, in PDF user space with the origin at the bottom-left. */
export interface FigureRect {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The operator codes this needs, passed in so the module stays free of PDF.js. */
export interface ImageOps {
  save: number;
  restore: number;
  transform: number;
  paintImageXObject: number;
  paintImageMaskXObject: number;
  paintInlineImageXObject: number;
  paintJpegXObject?: number;
  /** Vector drawing. Its third argument carries the path's own bounding box. */
  constructPath?: number;
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Standard PDF matrix product: `a` applied first, then `b`. */
function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/**
 * An image below this fraction of the page's smaller side is ignored.
 *
 * Rules, bullets, logos and single-pixel spacers are painted as images too, and
 * announcing them as figures would be noise that buries the real ones.
 */
const MIN_SIDE_RATIO = 0.08;

/**
 * Finding drawings made of lines rather than pixels.
 *
 * A flow chart drawn as vector graphics paints no image, so nothing above sees
 * it — but its labels ARE in the text layer, and they are read in page order:
 * top to bottom, left to right. For a branching diagram that is not the order
 * the diagram means, and the result is plausible prose that is not what the
 * page says. Unlike a missing figure, a reader cannot hear that it is wrong.
 *
 * The paths themselves are what give it away. Each `constructPath` reports its
 * own bounding box, so the drawn areas can be found the same way images are.
 */
const MIN_PATH_SIDE_RATIO = 0.06;
/** A rule or a box edge is thin. Only areas with real height and width count. */
const MIN_PATH_AREA_RATIO = 0.01;
/**
 * A path covering most of the page is furniture, not a drawing.
 *
 * Background washes, page frames and the rectangle a web-to-PDF print puts
 * behind the body are all painted as one large path. They enclose the page's
 * ordinary prose, so every test applied to the text inside them is really a
 * test of the whole page — which is why they slipped through: a page of a
 * reference guide is mostly short lines, and scored as high on fragments as a
 * real chart does.
 *
 * Measured across five papers. The drawn areas that are genuinely diagrams or
 * plotted figures cover 0.09–0.58 of their page; the areas that are page
 * furniture cover 0.81–2.23 (over 1.0 where the path runs past the page edge).
 * The cap sits in the empty band between them.
 *
 * This does trade away a diagram that genuinely fills a whole page. That is the
 * right way round: missing one leaves the reader where they were before any of
 * this existed — told nothing — whereas announcing a diagram on every page of a
 * prose document tells them something untrue.
 */
const MAX_PATH_AREA_RATIO = 0.7;
/**
 * A path spanning the sheet from edge to edge is a band, not a drawing.
 *
 * The same furniture in its other shape: the header strip on a reprint, a
 * site's navigation bar, the copyright block at the foot of a printed web page.
 * These are narrow enough to pass the area cap, and their text is short
 * fragments — "Home", "Privacy Policy", "ARTICLES & ISSUES" — so they scored as
 * high on fragments as a chart's labels do.
 *
 * What actually separates them is where their edges fall. Furniture is painted
 * to the printable area's edge because that is how a browser lays a page out,
 * while a figure sits INSIDE the margins because it is placed within the text
 * block. Measured on the same five papers: the bands span 0.93–1.05 of the page
 * width (one of them wider than the page), and every genuine diagram spans
 * 0.42–0.86.
 *
 * Both caps come from the same five documents, so both are honest about a
 * full-bleed figure: it would be missed. That is silence, which is where this
 * started, rather than a marker announcing a diagram that is not there.
 */
const MAX_PATH_WIDTH_RATIO = 0.9;

/**
 * Walks a PDF.js operator list and returns the rectangle each painted image
 * occupies.
 *
 * A PDF image is always drawn into the unit square, positioned entirely by the
 * transformation matrix in force at the time — so the placement is the unit
 * square's corners taken through that matrix. The save/restore stack has to be
 * tracked for the same reason a renderer tracks it: a `transform` applies until
 * the enclosing `save` is restored.
 */
export function collectFigures(
  operatorList: { fnArray: number[]; argsArray: unknown[] },
  ops: ImageOps,
  pageNumber: number,
  pageWidth: number,
  pageHeight: number,
  baseTransform: Matrix = IDENTITY,
): FigureRect[] {
  const paintOps = new Set(
    [
      ops.paintImageXObject,
      ops.paintImageMaskXObject,
      ops.paintInlineImageXObject,
      ops.paintJpegXObject,
    ].filter((op): op is number => typeof op === 'number'),
  );

  const figures: FigureRect[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = baseTransform;
  const minSide = Math.min(pageWidth, pageHeight) * MIN_SIDE_RATIO;

  for (let i = 0; i < operatorList.fnArray.length; i += 1) {
    const fn = operatorList.fnArray[i];

    if (fn === ops.save) {
      stack.push(ctm);
      continue;
    }
    if (fn === ops.restore) {
      ctm = stack.pop() ?? IDENTITY;
      continue;
    }
    if (fn === ops.transform) {
      const args = operatorList.argsArray[i] as number[] | undefined;
      if (args && args.length >= 6) {
        ctm = multiply([args[0], args[1], args[2], args[3], args[4], args[5]] as Matrix, ctm);
      }
      continue;
    }
    if (!paintOps.has(fn)) continue;

    // The unit square through the current matrix. Taking all four corners rather
    // than two handles an image that is rotated or flipped.
    const corners = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(...xs) - x;
    const height = Math.max(...ys) - y;

    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (width < minSide || height < minSide) continue;
    figures.push({ pageNumber, x, y, width, height });
  }

  return mergeOverlapping(figures);
}

/**
 * Returns the areas of the page covered by vector drawing.
 *
 * Same walk as `collectFigures`, reading the bounding box each path reports and
 * carrying it through the transformation matrix in force. Thin paths — rules,
 * underlines, table borders, the edges of a box — are dropped: it is the areas
 * with real width AND height that indicate a drawing rather than a line.
 */
export function collectDrawings(
  operatorList: { fnArray: number[]; argsArray: unknown[] },
  ops: ImageOps,
  pageNumber: number,
  pageWidth: number,
  pageHeight: number,
): FigureRect[] {
  if (typeof ops.constructPath !== 'number') return [];

  const drawings: FigureRect[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  const minSide = Math.min(pageWidth, pageHeight) * MIN_PATH_SIDE_RATIO;
  const minArea = pageWidth * pageHeight * MIN_PATH_AREA_RATIO;
  const maxArea = pageWidth * pageHeight * MAX_PATH_AREA_RATIO;

  for (let i = 0; i < operatorList.fnArray.length; i += 1) {
    const fn = operatorList.fnArray[i];
    if (fn === ops.save) {
      stack.push(ctm);
      continue;
    }
    if (fn === ops.restore) {
      ctm = stack.pop() ?? IDENTITY;
      continue;
    }
    if (fn === ops.transform) {
      const args = operatorList.argsArray[i] as number[] | undefined;
      if (args && args.length >= 6) {
        ctm = multiply([args[0], args[1], args[2], args[3], args[4], args[5]] as Matrix, ctm);
      }
      continue;
    }
    if (fn !== ops.constructPath) continue;

    const args = operatorList.argsArray[i] as unknown[] | undefined;
    const box = args?.[2] as ArrayLike<number> | undefined;
    if (!box || box.length < 4) continue;

    const corners = [
      apply(ctm, box[0], box[1]),
      apply(ctm, box[2], box[1]),
      apply(ctm, box[0], box[3]),
      apply(ctm, box[2], box[3]),
    ];
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(...xs) - x;
    const height = Math.max(...ys) - y;

    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (width < minSide || height < minSide) continue;
    if (width * height < minArea) continue;
    if (width * height > maxArea) continue;
    if (width > pageWidth * MAX_PATH_WIDTH_RATIO) continue;
    drawings.push({ pageNumber, x, y, width, height });
  }

  return mergeOverlapping(drawings);
}

/**
 * Collapses images that overlap into one figure.
 *
 * A single chart is often painted as many tiles, and a scanned page as a strip
 * per band. Reporting eleven figures where a reader sees one would be worse
 * than reporting none.
 */
function mergeOverlapping(figures: FigureRect[]): FigureRect[] {
  const merged: FigureRect[] = [];
  for (const figure of [...figures].sort((a, b) => b.y - a.y)) {
    const overlapping = merged.find(
      (other) =>
        figure.x < other.x + other.width &&
        figure.x + figure.width > other.x &&
        figure.y < other.y + other.height &&
        figure.y + figure.height > other.y,
    );
    if (!overlapping) {
      merged.push({ ...figure });
      continue;
    }
    const right = Math.max(overlapping.x + overlapping.width, figure.x + figure.width);
    const top = Math.max(overlapping.y + overlapping.height, figure.y + figure.height);
    overlapping.x = Math.min(overlapping.x, figure.x);
    overlapping.y = Math.min(overlapping.y, figure.y);
    overlapping.width = right - overlapping.x;
    overlapping.height = top - overlapping.y;
  }
  return merged;
}
