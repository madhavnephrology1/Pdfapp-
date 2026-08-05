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
