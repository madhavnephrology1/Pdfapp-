import type { DocumentRegion, ParagraphRecord, RawTextItem } from '@pdfreader/shared-types';
import type { FigureRect } from '@/features/extraction/figures';

/**
 * Where the pictures go, and what is said about them.
 *
 * A figure has a position on the page but no place in the reading order, so it
 * has to be attached to one — and the attachment has to be decided ONCE. The
 * reader panel shows the marker and the audio announces it, and if those two
 * placed it separately they could drift apart, so a listener and a reader would
 * be told different things about the same page. Both use this.
 *
 * Nothing here looks at what a picture contains, and nothing describes one. A
 * description would be generated words standing in for content this application
 * has not read.
 */

export type MarkerKind = 'figure' | 'drawn-area';

export interface PageMarker {
  kind: MarkerKind;
  pageNumber: number;
  /** Stable within a document, so a spoken marker can be highlighted. */
  id: string;
}

/** The text shown on screen. The audio says the same thing — see `markerSpeech`. */
export function markerLabel(marker: PageMarker): string {
  if (marker.kind === 'figure') {
    return `Figure on page ${marker.pageNumber} — not described`;
  }
  return (
    `Drawn area on page ${marker.pageNumber} — a chart, table or box; the text inside is ` +
    `read in page order, which may not be the order it is meant to be read in`
  );
}

/**
 * What is spoken when marker announcements are on.
 *
 * These are the application's words, not the document's. They are kept short
 * because they interrupt the reading, and they are kept the same as what is on
 * screen so that hearing one and seeing one are the same report.
 */
export function markerSpeech(marker: PageMarker): string {
  if (marker.kind === 'figure') {
    return `Figure on page ${marker.pageNumber}, not described.`;
  }
  return `Drawn area on page ${marker.pageNumber}. The text inside is read in page order.`;
}

/**
 * Drawn areas whose text sits in short runs rather than running prose.
 *
 * A chart or table drawn as lines paints no image, so the figure marker never
 * appears for it — but its labels are in the text layer and are read in page
 * order, which for a branching diagram or a grid of cells is not the order it
 * is meant to be read in. That produces plausible prose that is not what the
 * page says, and unlike a missing figure a listener cannot hear that it is
 * wrong. On the trial paper measured here, five such pages carry no image at
 * all, so nothing else in this application finds them.
 *
 * Being inside a drawn box is not enough on its own: what is looked for is that
 * the text inside is mostly SHORT RUNS — labels and cells, not sentences. The
 * threshold is measured, not guessed. Across five real papers the areas that
 * are charts, tables and figure panels run 80–99% short runs, and the areas
 * that are title blocks and boxed prose run 39–60%. A count of separately drawn
 * parts was tried first and discarded: it does not separate them, since a whole
 * chart is often one merged path.
 *
 * It is not a clean cut, and the marker's wording is held to what the measure
 * actually supports. A boxed "Key Points" summary scores as high as a flow
 * chart does, because the text layer splits its justified lines into one item
 * per word; nothing measured here separates the two. So the marker says a drawn
 * area is there and that its contents are read in page order — true of the
 * chart, the table and the summary box alike — rather than asserting a diagram.
 */
const MIN_ITEMS_INSIDE = 3;
const MAX_WORDS_PER_RUN = 3;
const MIN_SHORT_RUN_SHARE = 0.7;

export function selectDrawnAreas(
  drawings: FigureRect[],
  figures: FigureRect[],
  rawItems: RawTextItem[],
): FigureRect[] {
  if (drawings.length === 0 || rawItems.length === 0) return [];
  return drawings.filter((area) => {
    // An area already covered by a figure marker is not marked twice. Three of
    // the pages measured carry a picture AND the paths that draw its axes and
    // panel frames, and two markers for one picture is noise that buries the
    // pages where the drawing is all there is.
    if (figures.some((figure) => figure.pageNumber === area.pageNumber && overlaps(figure, area))) {
      return false;
    }

    const inside = rawItems.filter(
      (item) =>
        item.pageNumber === area.pageNumber &&
        item.x + item.width > area.x &&
        item.x < area.x + area.width &&
        item.y + item.height > area.y &&
        item.y < area.y + area.height,
    );
    if (inside.length < MIN_ITEMS_INSIDE) return false;
    const shortRuns = inside.filter(
      (item) => item.text.trim().split(/\s+/).filter(Boolean).length <= MAX_WORDS_PER_RUN,
    ).length;
    return shortRuns / inside.length >= MIN_SHORT_RUN_SHARE;
  });
}

function overlaps(a: FigureRect, b: FigureRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Attaches each marker to the paragraph it should be announced before.
 *
 * A figure goes before the first paragraph whose region starts below it on the
 * same page — where a reader's eye would meet it. A figure below all of a
 * page's text attaches to that page's last paragraph instead, so it is never
 * silently dropped. A drawn area goes at the top of its page: its own text is
 * scattered through that page, so there is no single point it precedes.
 */
export function placeMarkers(
  figures: FigureRect[],
  drawnAreas: FigureRect[],
  paragraphs: Pick<ParagraphRecord, 'id' | 'pageNumber' | 'regionId'>[],
  regions: Pick<DocumentRegion, 'id' | 'boundingBoxes'>[],
): Map<string, PageMarker[]> {
  const byParagraph = new Map<string, PageMarker[]>();
  if (paragraphs.length === 0) return byParagraph;

  const topOf = (regionId: string): number | null => {
    const region = regions.find((candidate) => candidate.id === regionId);
    const box = region?.boundingBoxes?.[0];
    return box ? box.y + box.height : null;
  };

  const add = (paragraphId: string, marker: PageMarker): void => {
    const existing = byParagraph.get(paragraphId);
    if (existing) existing.push(marker);
    else byParagraph.set(paragraphId, [marker]);
  };

  drawnAreas.forEach((area, index) => {
    const onPage = paragraphs.filter((p) => p.pageNumber === area.pageNumber);
    if (onPage.length === 0) return;
    add(onPage[0].id, {
      kind: 'drawn-area',
      pageNumber: area.pageNumber,
      id: `marker-drawn-${area.pageNumber}-${index}`,
    });
  });

  figures.forEach((figure, index) => {
    const onPage = paragraphs.filter((p) => p.pageNumber === figure.pageNumber);
    if (onPage.length === 0) return;
    const figureTop = figure.y + figure.height;
    const host =
      onPage.find((p) => {
        const top = topOf(p.regionId);
        return top !== null && top < figureTop;
      }) ?? onPage[onPage.length - 1];
    add(host.id, {
      kind: 'figure',
      pageNumber: figure.pageNumber,
      id: `marker-figure-${figure.pageNumber}-${index}`,
    });
  });

  return byParagraph;
}
