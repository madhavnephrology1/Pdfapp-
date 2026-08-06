import { describe, expect, it } from 'vitest';
import type { RawTextItem } from '@pdfreader/shared-types';
import type { FigureRect } from '@/features/extraction/figures';
import {
  markerLabel,
  markerSpeech,
  placeMarkers,
  selectDrawnAreas,
} from '@/features/reader/markers';

const rect = (
  pageNumber: number,
  x: number,
  y: number,
  width: number,
  height: number,
): FigureRect => ({
  pageNumber,
  x,
  y,
  width,
  height,
});

let counter = 0;
const item = (pageNumber: number, text: string, x: number, y: number): RawTextItem => {
  const index = counter++;
  return {
    id: `i${index}`,
    documentId: 'd',
    pageNumber,
    text,
    transform: [10, 0, 0, 10, x, y],
    x,
    y,
    width: text.length * 5,
    height: 10,
    fontSize: 10,
    direction: 'ltr',
    sourceIndex: index,
  };
};

/** A chart's labels: many short runs scattered through the drawn area. */
const chartLabels = (page: number): RawTextItem[] =>
  ['Tumor Cell Lysis', 'Potassium', 'release', 'Uric acid', 'formation', 'Hypocalcemia'].map(
    (text, row) => item(page, text, 150 + row * 10, 400 - row * 20),
  );

/** Boxed prose: full sentences, few of them short. */
const boxedProse = (page: number): RawTextItem[] =>
  [
    'This journal requires that authors provide the equivalent values in accepted units',
    'Tables must be submitted as editable text and not as images wherever that is possible',
    'Reference to a journal publication with an article number and the digital identifier',
    'Include any individuals who provided help during the research such as language editing',
  ].map((text, row) => item(page, text, 150, 400 - row * 20));

describe('selectDrawnAreas', () => {
  it('keeps an area whose text is mostly short runs', () => {
    const area = rect(3, 140, 300, 300, 200);
    expect(selectDrawnAreas([area], [], chartLabels(3))).toHaveLength(1);
  });

  it('drops an area holding running prose', () => {
    const area = rect(3, 140, 300, 400, 200);
    expect(selectDrawnAreas([area], [], boxedProse(3))).toEqual([]);
  });

  it('does not mark an area a figure already covers', () => {
    const area = rect(3, 140, 300, 300, 200);
    const figure = rect(3, 150, 320, 200, 150);
    expect(selectDrawnAreas([area], [figure], chartLabels(3))).toEqual([]);
  });

  it('still marks an area when the page has a figure somewhere else', () => {
    const area = rect(3, 140, 300, 300, 200);
    const elsewhere = rect(3, 40, 60, 80, 80);
    expect(selectDrawnAreas([area], [elsewhere], chartLabels(3))).toHaveLength(1);
  });

  it('ignores an area with too little text inside to judge', () => {
    const area = rect(3, 140, 300, 300, 200);
    expect(selectDrawnAreas([area], [], [item(3, 'A', 150, 400)])).toEqual([]);
  });

  it('only counts the text on the area own page', () => {
    const area = rect(3, 140, 300, 300, 200);
    expect(selectDrawnAreas([area], [], chartLabels(4))).toEqual([]);
  });
});

describe('placeMarkers', () => {
  const paragraphs = [
    { id: 'p1', pageNumber: 6, regionId: 'r1' },
    { id: 'p2', pageNumber: 6, regionId: 'r2' },
    { id: 'p3', pageNumber: 7, regionId: 'r3' },
  ];
  // Region tops, descending down the page.
  const regions = [
    { id: 'r1', boundingBoxes: [{ pageNumber: 6, x: 60, y: 600, width: 400, height: 100 }] },
    { id: 'r2', boundingBoxes: [{ pageNumber: 6, x: 60, y: 200, width: 400, height: 100 }] },
    { id: 'r3', boundingBoxes: [{ pageNumber: 7, x: 60, y: 600, width: 400, height: 100 }] },
  ];

  it('puts a figure before the first paragraph that starts below it', () => {
    // Figure top at 500: below r1 (top 700), above r2 (top 300).
    const markers = placeMarkers([rect(6, 60, 400, 400, 100)], [], paragraphs, regions);
    expect(markers.get('p2')?.[0]).toMatchObject({ kind: 'figure', pageNumber: 6 });
    expect(markers.has('p1')).toBe(false);
  });

  it('attaches a figure below all of a page text to the last paragraph', () => {
    // Figure top at 90, below every region on the page.
    const markers = placeMarkers([rect(6, 60, 40, 400, 50)], [], paragraphs, regions);
    expect(markers.get('p2')?.[0]).toMatchObject({ kind: 'figure' });
  });

  it('puts a drawn area at the top of its page', () => {
    const markers = placeMarkers([], [rect(6, 60, 100, 400, 300)], paragraphs, regions);
    expect(markers.get('p1')?.[0]).toMatchObject({ kind: 'drawn-area', pageNumber: 6 });
  });

  it('drops a marker on a page with no paragraphs rather than misplacing it', () => {
    const markers = placeMarkers([rect(9, 60, 400, 400, 100)], [], paragraphs, regions);
    expect([...markers.values()].flat()).toEqual([]);
  });

  it('gives every marker a distinct id', () => {
    const markers = placeMarkers(
      [rect(6, 60, 400, 400, 100), rect(6, 60, 300, 400, 60)],
      [rect(6, 60, 100, 400, 300)],
      paragraphs,
      regions,
    );
    const ids = [...markers.values()].flat().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('what a marker says', () => {
  it('reports the page and says a figure is not described', () => {
    const label = markerLabel({ kind: 'figure', pageNumber: 6, id: 'm' });
    expect(label).toContain('page 6');
    expect(label).toContain('not described');
  });

  it('never claims to know what a picture shows', () => {
    for (const kind of ['figure', 'drawn-area'] as const) {
      const marker = { kind, pageNumber: 6, id: 'm' };
      for (const text of [markerLabel(marker), markerSpeech(marker)]) {
        expect(text).not.toMatch(/shows|depicts|illustrat|represent/i);
      }
    }
  });

  it('warns that a drawn area is read in page order', () => {
    const marker = { kind: 'drawn-area', pageNumber: 8, id: 'm' } as const;
    expect(markerSpeech(marker)).toContain('page order');
    expect(markerLabel(marker)).toContain('page order');
  });
});
