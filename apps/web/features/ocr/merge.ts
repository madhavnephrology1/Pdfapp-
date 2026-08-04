import type {
  DocumentRegion,
  OutlineNode,
  PageRecord,
  ParagraphRecord,
  SentenceRecord,
} from '@pdfreader/shared-types';
import type { ExtractionResult } from '@/features/extraction/pipeline';
import type { OcrPageSummary } from './items';

/**
 * Splicing a recognised page into the document.
 *
 * Recognition happens one page at a time and long after the document was
 * analysed, so the page is analysed on its own and its regions are inserted in
 * page order. The rest of the document is not re-analysed: re-running the whole
 * pipeline would change region and sentence ids everywhere, moving the reader's
 * place and discarding their include/exclude decisions, which is far worse than
 * classifying one page with only that page in view.
 *
 * That does mean a recognised page is classified with page-local evidence only
 * — the same limitation as the first pass of incremental extraction, and it is
 * reported the same way.
 *
 * Every region that arrives this way is marked, in its own evidence and in the
 * reason shown in Content Review, as having been read from an image.
 */

export interface DocumentSlice {
  pages: PageRecord[];
  regions: DocumentRegion[];
  paragraphs: ParagraphRecord[];
  sentences: SentenceRecord[];
  outline: OutlineNode[];
}

const byPage = <T extends { pageNumber: number }>(items: T[]): T[] =>
  [...items].sort((a, b) => a.pageNumber - b.pageNumber);

export function mergeRecognizedPage(
  base: DocumentSlice,
  pageNumber: number,
  recognized: ExtractionResult,
  summary: OcrPageSummary,
): DocumentSlice {
  const provenance =
    `Read from an image of page ${pageNumber} by "${summary.provider}", not from the ` +
    `PDF's text layer. Average confidence ${(summary.confidence * 100).toFixed(0)}%` +
    (summary.lowConfidence > 0
      ? `, with ${summary.lowConfidence} word(s) the recogniser was unsure of.`
      : '.');

  const markedRegions = recognized.regions.map((region): DocumentRegion => ({
    ...region,
    // Recognition is uncertain by construction, so its confidence caps the
    // classifier's. A page read from an image is never presented as certain.
    confidence: Math.min(region.confidence, summary.confidence),
    inclusionReason: `${region.inclusionReason} ${provenance}`,
    classificationEvidence: [...region.classificationEvidence, provenance],
  }));

  // Anything previously held for this page is replaced, so recognising a page
  // twice does not read it twice.
  const keep = <T extends { pageNumber: number }>(items: T[]): T[] =>
    items.filter((item) => item.pageNumber !== pageNumber);

  const merged: DocumentSlice = {
    pages: base.pages,
    regions: byPage([...keep(base.regions), ...markedRegions]),
    paragraphs: byPage([...keep(base.paragraphs), ...recognized.paragraphs]),
    sentences: byPage([...keep(base.sentences), ...recognized.sentences]),
    outline: byPage([
      ...base.outline.filter((node) => node.pageNumber !== pageNumber),
      ...recognized.outline,
    ]),
  };

  // documentIndex is a position in the whole document, so it has to be
  // renumbered once new sentences sit in the middle of it.
  merged.sentences = merged.sentences.map((sentence, index) => ({
    ...sentence,
    documentIndex: index,
  }));

  return merged;
}
