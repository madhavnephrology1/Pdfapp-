import { buildPdf, type PageSpec, type TextRun } from './pdf-writer';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const BODY_SIZE = 11;
const LINE_HEIGHT = 14;

interface ColumnFlow {
  x: number;
  top: number;
  lineHeight?: number;
  size?: number;
  font?: TextRun['font'];
}

/** Lays out pre-wrapped lines down a column and returns the runs plus the next Y. */
function flow(lines: string[], column: ColumnFlow): { runs: TextRun[]; nextY: number } {
  const lineHeight = column.lineHeight ?? LINE_HEIGHT;
  const runs: TextRun[] = [];
  let y = column.top;
  for (const line of lines) {
    if (line !== '') {
      runs.push({
        x: column.x,
        y,
        text: line,
        size: column.size ?? BODY_SIZE,
        font: column.font,
      });
    }
    y -= lineHeight;
  }
  return { runs, nextY: y };
}

function runningHeader(text: string): TextRun {
  return { x: MARGIN, y: PAGE_HEIGHT - 30, text, size: 8, font: 'F1' };
}

function runningFooter(text: string): TextRun {
  return { x: MARGIN, y: 28, text, size: 8, font: 'F1' };
}

function pageNumber(n: number | string, x = PAGE_WIDTH / 2 - 6): TextRun {
  return { x, y: 28, text: String(n), size: 9, font: 'F1' };
}

/* ------------------------------------------------------------------ */
/* Fixture 1: single page, single column, no furniture                 */
/* ------------------------------------------------------------------ */

export const SINGLE_PAGE_BODY_LINES = [
  'Renal Physiology Overview',
  '',
  'The kidney maintains extracellular fluid volume through a set of tightly',
  'coupled regulatory mechanisms. Glomerular filtration produces an ultra-',
  'filtrate of plasma that is subsequently modified along the nephron.',
  '',
  'Tubular reabsorption recovers the majority of filtered sodium. The proximal',
  'tubule accounts for roughly two thirds of this reabsorption, and the loop of',
  'Henle establishes the medullary osmotic gradient.',
];

export function singlePagePdf(): Uint8Array {
  const [title, , ...body] = SINGLE_PAGE_BODY_LINES;
  const heading: TextRun = {
    x: MARGIN,
    y: PAGE_HEIGHT - MARGIN,
    text: title,
    size: 15,
    font: 'F2',
  };
  const { runs } = flow(body, { x: MARGIN, top: PAGE_HEIGHT - MARGIN - 30 });
  return buildPdf([{ width: PAGE_WIDTH, height: PAGE_HEIGHT, runs: [heading, ...runs] }], {
    title: 'Renal Physiology Overview',
  });
}

/* ------------------------------------------------------------------ */
/* Fixture 2: 50 pages with repeated header, footer and page numbers   */
/* ------------------------------------------------------------------ */

export const REPEATED_HEADER_TEXT = 'Journal of Clinical Nephrology';
export const REPEATED_FOOTER_TEXT = 'Downloaded from example.org on 12 March 2024';

export function fiftyPagePdf(pageCount = 50): Uint8Array {
  const pages: PageSpec[] = [];
  for (let p = 1; p <= pageCount; p += 1) {
    const heading: TextRun = {
      x: MARGIN,
      y: PAGE_HEIGHT - MARGIN - 20,
      text: `Section ${p}. Clinical Findings`,
      size: 13,
      font: 'F2',
    };
    const body = [
      `Patients in cohort ${p} demonstrated a measurable change in estimated`,
      'glomerular filtration rate over the twelve month observation window.',
      'The magnitude of the change varied with baseline proteinuria.',
      '',
      'Secondary endpoints included hospitalization for volume overload and the',
      'initiation of renal replacement therapy. Neither endpoint reached the',
      'prespecified threshold for statistical significance.',
    ];
    const { runs } = flow(body, { x: MARGIN, top: PAGE_HEIGHT - MARGIN - 46 });
    pages.push({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      runs: [
        runningHeader(`${REPEATED_HEADER_TEXT}    Vol. 12, No. 4`),
        heading,
        ...runs,
        runningFooter(REPEATED_FOOTER_TEXT),
        pageNumber(p),
      ],
    });
  }
  return buildPdf(pages, { title: 'Journal of Clinical Nephrology, Vol. 12' });
}

/* ------------------------------------------------------------------ */
/* Fixture 3: two-column academic paper with footnotes and references  */
/* ------------------------------------------------------------------ */

const COLUMN_LEFT_X = MARGIN;
const COLUMN_RIGHT_X = 320;

export const TWO_COLUMN_LEFT_LINES = [
  'Sodium handling in the proximal',
  'tubule is mediated primarily by',
  'the sodium-hydrogen exchanger.',
  'Inhibition of this transporter',
  'reduces bicarbonate reabsorption',
  'and produces a mild acidosis.',
];

export const TWO_COLUMN_RIGHT_LINES = [
  'Distal delivery of sodium rises',
  'when proximal reabsorption falls.',
  'This increased delivery activates',
  'tubuloglomerular feedback and',
  'lowers single nephron glomerular',
  'filtration rate.',
];

export function twoColumnPaperPdf(): Uint8Array {
  const heading: TextRun = {
    x: MARGIN,
    y: PAGE_HEIGHT - MARGIN,
    text: 'Tubular Sodium Transport and Feedback Regulation in the Nephron',
    size: 15,
    font: 'F2',
  };

  const left = flow(TWO_COLUMN_LEFT_LINES, {
    x: COLUMN_LEFT_X,
    top: PAGE_HEIGHT - MARGIN - 34,
  });
  const right = flow(TWO_COLUMN_RIGHT_LINES, {
    x: COLUMN_RIGHT_X,
    top: PAGE_HEIGHT - MARGIN - 34,
  });

  const footnotes = flow(
    [
      '1. Corresponding author. Department of Nephrology.',
      '2. Funding provided by an institutional grant.',
    ],
    { x: COLUMN_LEFT_X, top: 120, size: 7, lineHeight: 10 },
  );

  const page1: PageSpec = {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    runs: [
      runningHeader(`${REPEATED_HEADER_TEXT}    Vol. 12, No. 4`),
      heading,
      ...left.runs,
      ...right.runs,
      ...footnotes.runs,
      runningFooter(REPEATED_FOOTER_TEXT),
      pageNumber(1),
    ],
  };

  const referenceHeading: TextRun = {
    x: COLUMN_LEFT_X,
    y: PAGE_HEIGHT - MARGIN - 20,
    text: 'References',
    size: 13,
    font: 'F2',
  };
  const referenceLines = [
    'Alvarez, M., & Chen, L. (2019). Proximal tubular transport in health and',
    '    disease. Kidney International, 95(3), 512-524.',
    'Baptiste, R. (2020). Tubuloglomerular feedback revisited. Journal of the',
    '    American Society of Nephrology, 31(7), 1441-1450.',
    'Cho, S., Duarte, P., & Ferreira, N. (2021). Sodium-hydrogen exchange',
    '    inhibition. Nature Reviews Nephrology, 17, 88-101.',
    'Delgado, A. (2018). Medullary osmotic gradients. American Journal of',
    '    Physiology, 314(2), F220-F231.',
  ];
  const refs = flow(referenceLines, {
    x: COLUMN_LEFT_X,
    top: PAGE_HEIGHT - MARGIN - 48,
    size: 9,
    lineHeight: 12,
  });

  const page2: PageSpec = {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    runs: [
      runningHeader(`${REPEATED_HEADER_TEXT}    Vol. 12, No. 4`),
      referenceHeading,
      ...refs.runs,
      runningFooter(REPEATED_FOOTER_TEXT),
      pageNumber(2),
    ],
  };

  return buildPdf([page1, page2], {
    title: 'Tubular Sodium Transport and Feedback Regulation',
  });
}

/* ------------------------------------------------------------------ */
/* Fixture 4: hyphenation, ligatures and duplicated text layer         */
/* ------------------------------------------------------------------ */

export function typographyPdf(): Uint8Array {
  const runs: TextRun[] = [
    {
      x: MARGIN,
      y: 700,
      text: 'The glomerular filtration bar-',
      size: BODY_SIZE,
    },
    {
      x: MARGIN,
      y: 686,
      text: 'rier restricts albumin passage.',
      size: BODY_SIZE,
    },
    {
      x: MARGIN,
      y: 660,
      text: 'Efficient workflow benefits.',
      size: BODY_SIZE,
    },
    // Duplicated overlapping text layer (simulates a fake-bold double draw).
    {
      x: MARGIN + 0.3,
      y: 660,
      text: 'Efficient workflow benefits.',
      size: BODY_SIZE,
    },
  ];
  return buildPdf([{ width: PAGE_WIDTH, height: PAGE_HEIGHT, runs }], {
    title: 'Typography Fixture',
  });
}

/* ------------------------------------------------------------------ */
/* Fixture 5: table and caption                                        */
/* ------------------------------------------------------------------ */

export function tablePdf(): Uint8Array {
  const runs: TextRun[] = [
    {
      x: MARGIN,
      y: 720,
      text: 'Baseline characteristics are summarized below.',
      size: BODY_SIZE,
    },
    {
      x: MARGIN,
      y: 690,
      text: 'Table 1. Baseline characteristics of the study cohort.',
      size: 9,
      font: 'F2',
    },
  ];
  const columns = [MARGIN, 200, 320, 440];
  const rows = [
    ['Variable', 'Group A', 'Group B', 'p value'],
    ['Age, years', '54.2', '55.8', '0.41'],
    ['eGFR', '48.1', '47.3', '0.62'],
    ['Proteinuria', '1.2', '1.4', '0.08'],
  ];
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      runs.push({
        x: columns[colIndex],
        y: 668 - rowIndex * 16,
        text: cell,
        size: 9,
      });
    });
  });
  runs.push({
    x: MARGIN,
    y: 580,
    text: 'The groups were well matched at baseline.',
    size: BODY_SIZE,
  });
  return buildPdf([{ width: PAGE_WIDTH, height: PAGE_HEIGHT, runs }], {
    title: 'Table Fixture',
  });
}

/* ------------------------------------------------------------------ */
/* Fixture 6: image-only (scanned) and mixed scanned/digital           */
/* ------------------------------------------------------------------ */

export function scannedPdf(): Uint8Array {
  return buildPdf(
    [
      {
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        runs: [],
        rects: [
          {
            x: 40,
            y: 40,
            width: PAGE_WIDTH - 80,
            height: PAGE_HEIGHT - 80,
            gray: 0.85,
          },
        ],
      },
    ],
    { title: 'Scanned Fixture' },
  );
}

export function mixedScannedPdf(): Uint8Array {
  const digital = flow(SINGLE_PAGE_BODY_LINES, {
    x: MARGIN,
    top: PAGE_HEIGHT - MARGIN,
  });
  return buildPdf(
    [
      { width: PAGE_WIDTH, height: PAGE_HEIGHT, runs: digital.runs },
      {
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        runs: [],
        rects: [
          {
            x: 40,
            y: 40,
            width: PAGE_WIDTH - 80,
            height: PAGE_HEIGHT - 80,
            gray: 0.85,
          },
        ],
      },
    ],
    { title: 'Mixed Fixture' },
  );
}

/* ------------------------------------------------------------------ */
/* Fixture 7: front matter with roman numeral page numbers             */
/* ------------------------------------------------------------------ */

export function frontMatterPdf(): Uint8Array {
  const pages: PageSpec[] = [];
  const romans = ['i', 'ii', 'iii'];
  romans.forEach((roman, index) => {
    const title: TextRun = {
      x: MARGIN,
      y: PAGE_HEIGHT - MARGIN,
      text: index === 0 ? 'Preface' : 'Contents',
      size: 15,
      font: 'F2',
    };
    const { runs } = flow(
      index === 0
        ? ['This volume collects lectures delivered between 2018 and 2022.']
        : [
            `Chapter ${index}. Fluid and Electrolyte Balance`,
            `Chapter ${index + 1}. Acid Base Disorders`,
          ],
      { x: MARGIN, top: PAGE_HEIGHT - MARGIN - 30 },
    );
    pages.push({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      runs: [title, ...runs, pageNumber(roman)],
    });
  });
  const chapterTitle: TextRun = {
    x: MARGIN,
    y: PAGE_HEIGHT - MARGIN,
    text: 'Chapter 1. Fluid and Electrolyte Balance',
    size: 15,
    font: 'F2',
  };
  const body = flow(['Total body water is distributed between two major compartments.'], {
    x: MARGIN,
    top: PAGE_HEIGHT - MARGIN - 30,
  });
  pages.push({
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    runs: [chapterTitle, ...body.runs, pageNumber(1)],
  });
  return buildPdf(pages, { title: 'Lectures in Nephrology' });
}

/** Every fixture, addressable by name for scripts and tests. */
export const FIXTURES = {
  'single-page': singlePagePdf,
  'fifty-page': () => fiftyPagePdf(50),
  'two-column-paper': twoColumnPaperPdf,
  typography: typographyPdf,
  table: tablePdf,
  scanned: scannedPdf,
  'mixed-scanned': mixedScannedPdf,
  'front-matter': frontMatterPdf,
  'realistic-paper': realisticPaperPdf,
} as const;

export type FixtureName = keyof typeof FIXTURES;

/* ------------------------------------------------------------------ */
/* Fixture 8: the conditions that real producers create                */
/* ------------------------------------------------------------------ */

/**
 * Reproduces four structural traps found by running the pipeline over PDFs
 * produced by a real layout engine rather than by this writer:
 *
 *  1. Headings are only ~1.1x body size and share the BODY font, because real
 *     PDFs embed subset fonts whose names carry no "Bold" to match on.
 *  2. A centred byline crosses the column gutter, so the gutter is a
 *     low-density corridor rather than an empty one.
 *  3. Section headings are numbered ("1. Introduction"), which also matches the
 *     numbered-list pattern.
 *  4. Body content continues AFTER a reference section, so the reference run
 *     must be contained rather than swallowing the rest of the document.
 */
export const REALISTIC_BODY_SIZE = 10.5;
export const REALISTIC_HEADING_SIZE = 11.5;

export function realisticPaperPdf(): Uint8Array {
  const width = 595;
  const height = 842;
  const leftX = 51;
  const rightX = 307;
  const columnTop = height - 150;
  const lineHeight = 13;

  const column = (x: number, top: number, lines: string[], size = REALISTIC_BODY_SIZE): TextRun[] =>
    lines.map((text, index) => ({
      x,
      y: top - index * lineHeight,
      text,
      size,
      font: 'F1' as const,
    }));

  const page1: PageSpec = {
    width,
    height,
    runs: [
      // Running header: two elements on one baseline, far apart.
      { x: leftX, y: height - 34, text: REPEATED_HEADER_TEXT, size: 8, font: 'F1' },
      { x: 430, y: height - 34, text: 'Vol. 12, No. 4', size: 8, font: 'F1' },

      // Full-width title, then a centred byline that CROSSES the gutter.
      {
        x: 120,
        y: height - 84,
        text: 'Tubular Sodium Transport and Feedback',
        size: 15,
        font: 'F1',
      },
      { x: 205, y: height - 112, text: 'M. Alvarez and L. Chen', size: 10, font: 'F1' },

      // Numbered headings at only 1.1x body size, in the SAME face as body.
      ...column(leftX, columnTop, ['1. Introduction'], REALISTIC_HEADING_SIZE),
      ...column(leftX, columnTop - 18, [
        'Sodium handling in the proximal',
        'tubule is mediated primarily by',
        'the exchanger described below.',
      ]),
      ...column(leftX, columnTop - 76, ['2. Methods'], REALISTIC_HEADING_SIZE),
      ...column(leftX, columnTop - 94, [
        'Micropuncture was performed in',
        'anaesthetised animals over one',
        'hundred separate collections.',
      ]),

      ...column(rightX, columnTop, ['3. Results'], REALISTIC_HEADING_SIZE),
      ...column(rightX, columnTop - 18, [
        'Fractional excretion of sodium',
        'rose after transporter blockade',
        'and reversed within an hour.',
      ]),
      ...column(rightX, columnTop - 76, ['References'], REALISTIC_HEADING_SIZE),
      ...column(
        rightX,
        columnTop - 94,
        ['Alvarez, M. (2019). Proximal', '   transport. Kidney Int, 95(3),', '   512-524.'],
        9,
      ),

      // Body content AFTER the references: must not be swallowed.
      ...column(rightX, columnTop - 146, ['4. Discussion'], REALISTIC_HEADING_SIZE),
      ...column(rightX, columnTop - 164, [
        'These findings are consistent',
        'with earlier reports of distal',
        'sodium delivery in the nephron.',
      ]),

      // Footer and page number on DIFFERENT baselines, far apart horizontally.
      { x: leftX, y: 44, text: REPEATED_FOOTER_TEXT, size: 7.5, font: 'F1' },
      { x: 520, y: 28, text: '1 of 2', size: 9, font: 'F1' },
    ],
  };

  const page2: PageSpec = {
    ...page1,
    runs: [
      { x: leftX, y: height - 34, text: REPEATED_HEADER_TEXT, size: 8, font: 'F1' },
      { x: 430, y: height - 34, text: 'Vol. 12, No. 4', size: 8, font: 'F1' },
      { x: 205, y: height - 112, text: 'M. Alvarez and L. Chen', size: 10, font: 'F1' },
      ...column(leftX, columnTop, ['5. Limitations'], REALISTIC_HEADING_SIZE),
      ...column(leftX, columnTop - 18, [
        'The preparation used here does',
        'not model chronic disease well.',
      ]),
      ...column(rightX, columnTop, ['6. Conclusion'], REALISTIC_HEADING_SIZE),
      ...column(rightX, columnTop - 18, [
        'Proximal transport determines',
        'the load reaching the distal',
        'nephron under these conditions.',
      ]),
      { x: leftX, y: 44, text: REPEATED_FOOTER_TEXT, size: 7.5, font: 'F1' },
      { x: 520, y: 28, text: '2 of 2', size: 9, font: 'F1' },
    ],
  };

  return buildPdf([page1, page2], { title: 'Realistic Paper Fixture' });
}
