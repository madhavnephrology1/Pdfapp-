import { describe, expect, it } from 'vitest';
import { FLOW_CHART_LABELS, flowChartPdf } from '@pdfreader/test-fixtures';
import { collectDrawings, collectFigures, type ImageOps } from '@/features/extraction/figures';
import { extractDocument, type PageExtractionInput } from '@/features/extraction/pipeline';
import { placeMarkers, selectDrawnAreas } from '@/features/reader/markers';
import { buildReadingQueue } from '@/features/reader/queue';
import { DEFAULT_SETTINGS } from '@/features/settings/defaults';
import { loadPdfInNode } from '../helpers/node-pdf';

/**
 * The whole path for a chart drawn as lines, over a real PDF: operator list to
 * drawn area, drawn area to marker, marker to the words that are spoken.
 *
 * The unit tests cover each hop with constructed input. This is the one that
 * would catch the hops being wired together wrongly — a marker placed on a page
 * that has no paragraph, a drawn area rejected by a cap it should clear, an
 * announcement that never reaches the queue.
 */
async function readFixture(): Promise<{
  inputs: PageExtractionInput[];
  drawings: ReturnType<typeof collectDrawings>;
  figures: ReturnType<typeof collectFigures>;
}> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { doc, close } = await loadPdfInNode(flowChartPdf());
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const operatorList = await page.getOperatorList();
  const ops = pdfjs.OPS as unknown as ImageOps;

  const inputs: PageExtractionInput[] = [
    {
      pageNumber: 1,
      width: viewport.width,
      height: viewport.height,
      rotation: viewport.rotation,
      items: content.items
        .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
        .map((item) => ({
          str: item.str,
          dir: item.dir,
          width: item.width,
          height: item.height,
          transform: item.transform,
          fontName: item.fontName,
          hasEOL: item.hasEOL,
        })),
    },
  ];
  const drawings = collectDrawings(operatorList, ops, 1, viewport.width, viewport.height);
  const figures = collectFigures(operatorList, ops, 1, viewport.width, viewport.height);
  await close();
  return { inputs, drawings, figures };
}

describe('a flow chart drawn as lines', () => {
  it('is found as a drawn area, and its labels are in the text layer', async () => {
    const { inputs, drawings, figures } = await readFixture();
    const result = extractDocument('d', inputs);

    // Both halves of the problem: nothing paints an image here, and the labels
    // are extracted as ordinary text with nothing to say they are labels.
    expect(figures).toEqual([]);
    expect(drawings).toHaveLength(1);
    for (const label of FLOW_CHART_LABELS) {
      expect(result.normalizedText).toContain(label);
    }

    const areas = selectDrawnAreas(drawings, figures, result.rawItems);
    expect(areas).toHaveLength(1);
  });

  it('is announced before the page it is on, in words that claim nothing about it', async () => {
    const { inputs, drawings, figures } = await readFixture();
    const result = extractDocument('d', inputs);
    const markers = placeMarkers(
      figures,
      selectDrawnAreas(drawings, figures, result.rawItems),
      result.paragraphs,
      result.regions,
    );
    const queue = buildReadingQueue(result.regions, result.sentences, DEFAULT_SETTINGS, markers);

    const announced = queue.entries.filter((entry) => entry.announcement);
    expect(announced).toHaveLength(1);
    expect(announced[0].speechText).toContain('page 1');
    expect(announced[0].speechText).toContain('page order');
    expect(announced[0].speechText).not.toMatch(/shows|depicts|illustrat/i);

    // It comes before the document's own words, not after them.
    expect(queue.entries[0].announcement).toBeDefined();
  });

  it('goes silent when the switch is off, and the document text is untouched', async () => {
    const { inputs, drawings, figures } = await readFixture();
    const result = extractDocument('d', inputs);
    const markers = placeMarkers(
      figures,
      selectDrawnAreas(drawings, figures, result.rawItems),
      result.paragraphs,
      result.regions,
    );

    const on = buildReadingQueue(result.regions, result.sentences, DEFAULT_SETTINGS, markers);
    const off = buildReadingQueue(
      result.regions,
      result.sentences,
      { ...DEFAULT_SETTINGS, announcements: { speakFigureMarkers: false } },
      markers,
    );

    expect(off.entries.some((entry) => entry.announcement)).toBe(false);
    // Turning it off changes only the announcements: every word of the document
    // that was read with it on is still read with it off, in the same order.
    expect(off.entries.map((entry) => entry.speechText)).toEqual(
      on.entries.filter((entry) => !entry.announcement).map((entry) => entry.speechText),
    );
  });
});
