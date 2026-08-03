import type {
  BoundingBox,
  DocumentRegion,
  OutlineNode,
  PageRecord,
  ParagraphRecord,
  RawTextItem,
  SentenceRecord,
  TransformationRecord,
} from '@pdfreader/shared-types';
import { paragraphId as makeParagraphId, sentenceId as makeSentenceId } from '@/lib/ids';
import { classifyDocument } from '@/features/classification/classify';
import { estimateBodyFontSize, groupBlocks } from './blocks';
import { detectColumns } from './columns';
import { groupLines, orderLines } from './lines';
import { joinWrappedLines, type OffsetSpan } from './normalize';
import { removeDuplicateItems, toRawTextItems, type PdfTextItemLike } from './raw-items';
import { assertSegmentationIsLossless, segmentSentences } from './sentences';
import { detectTables, type TableRow } from './tables';
import { UNCERTAIN_ORDER_CONFIDENCE, type PageLayout, type TextLine } from './types';

/** Below this many characters a page is treated as having no usable text layer. */
export const SCANNED_PAGE_CHAR_THRESHOLD = 20;

export interface PageExtractionInput {
  pageNumber: number;
  width: number;
  height: number;
  rotation?: number;
  items: PdfTextItemLike[];
}

export interface ExtractionResult {
  pages: PageRecord[];
  rawItems: RawTextItem[];
  removedDuplicates: RawTextItem[];
  regions: DocumentRegion[];
  paragraphs: ParagraphRecord[];
  sentences: SentenceRecord[];
  normalizedText: string;
  outline: OutlineNode[];
  tableRows: Map<string, TableRow[]>;
  bodyFontSize: number;
}

/** Stage 1: raw items and lines for one page. Cheap enough to run per page. */
export function extractPageLines(
  input: PageExtractionInput,
  documentId: string,
): { items: RawTextItem[]; removed: RawTextItem[]; lines: TextLine[]; columns: ReturnType<typeof detectColumns> } {
  const all = toRawTextItems(input.items, documentId, input.pageNumber);
  const { items, removed } = removeDuplicateItems(all);
  const columns = detectColumns(items, input.width);
  const lines = groupLines(items, columns.columns, documentId, input.pageNumber, input.height);
  return { items: all, removed, lines, columns };
}

/**
 * Full extraction.
 *
 * Runs in two passes because block grouping and classification both need
 * document-wide context (the body font size, and which strings repeat across
 * pages). Page-level line extraction is done first so the UI can show a page
 * as soon as it is available.
 */
export function extractDocument(
  documentId: string,
  pageInputs: PageExtractionInput[],
): ExtractionResult {
  const perPage = pageInputs.map((input) => ({ input, ...extractPageLines(input, documentId) }));

  const allLines = perPage.flatMap((page) => page.lines);
  const bodyFontSize = estimateBodyFontSize(allLines);

  const layouts: PageLayout[] = [];
  const tableRows = new Map<string, TableRow[]>();

  for (const page of perPage) {
    const ordered = orderLines(page.lines, page.columns.columns.length);
    // Prefer this page's own body size: a references or index page set in a
    // smaller face must not make ordinary body text elsewhere look oversized.
    const pageBodyFontSize = page.lines.length >= 4 ? estimateBodyFontSize(page.lines) : bodyFontSize;
    const grouped = groupBlocks(ordered, {
      documentId,
      pageNumber: page.input.pageNumber,
      pageHeight: page.input.height,
      bodyFontSize: pageBodyFontSize || bodyFontSize,
    });
    const { blocks, rowsByBlock } = detectTables(grouped);
    for (const [blockId, rows] of rowsByBlock) tableRows.set(blockId, rows);

    const charCount = page.items.reduce((sum, item) => sum + item.text.trim().length, 0);
    const orderUncertain =
      page.columns.confidence < UNCERTAIN_ORDER_CONFIDENCE || blocks.some((block) => block.orderUncertain);

    layouts.push({
      pageNumber: page.input.pageNumber,
      width: page.input.width,
      height: page.input.height,
      lines: ordered,
      blocks,
      columns: page.columns,
      bodyFontSize: pageBodyFontSize || bodyFontSize,
      readingOrderUncertain: orderUncertain,
      textLayerCharCount: charCount,
      likelyScanned: charCount < SCANNED_PAGE_CHAR_THRESHOLD,
    });
  }

  const regions = classifyDocument({ documentId, pages: layouts, bodyFontSize });
  const blocksById = new Map(layouts.flatMap((page) => page.blocks).map((block) => [block.id, block]));

  const paragraphs: ParagraphRecord[] = [];
  const sentences: SentenceRecord[] = [];
  let normalizedText = '';
  let documentIndex = 0;

  for (const region of regions) {
    const block = blocksById.get(region.id);
    if (!block) continue;

    const joined = joinWrappedLines(
      block.lines.map((line) => ({
        text: line.text,
        sourceTextItemIds: line.items.map((item) => item.id),
        spans: line.spans,
      })),
    );

    const paragraphIdValue = makeParagraphId(region.id, 0);
    const paragraphOffset = normalizedText.length;
    normalizedText += joined.text;

    const spans = segmentSentences(joined.text);
    assertSegmentationIsLossless(joined.text, spans);

    const itemsById = new Map(block.lines.flatMap((line) => line.items).map((item) => [item.id, item]));
    const sentenceIds: string[] = [];

    spans.forEach((span, index) => {
      const id = makeSentenceId(paragraphIdValue, index);
      const overlapping = joined.spans.filter((s) => s.end > span.start && s.start < span.end);
      const sourceTextItemIds = [...new Set(overlapping.map((s) => s.itemId))];
      const transformations = joined.transformations.filter(
        (t) => t.offset >= span.start && t.offset <= span.end,
      );

      sentenceIds.push(id);
      sentences.push({
        id,
        documentId,
        pageNumber: region.pageNumber,
        regionId: region.id,
        paragraphId: paragraphIdValue,
        text: span.text,
        normalizedStart: paragraphOffset + span.start,
        normalizedEnd: paragraphOffset + span.end,
        sourceTextItemIds,
        boundingBoxes: boundingBoxesForItems(sourceTextItemIds, itemsById, region.pageNumber),
        inclusionStatus: 'included',
        transformations,
        documentIndex: documentIndex++,
      });
    });

    paragraphs.push({
      id: paragraphIdValue,
      documentId,
      pageNumber: region.pageNumber,
      regionId: region.id,
      text: joined.text,
      sentenceIds,
      boundingBoxes: region.boundingBoxes,
    });

    // Paragraph separator in the normalized document text. It is a separator,
    // not content, and no sentence offset ever points into it.
    normalizedText += '\n\n';
  }

  const pages: PageRecord[] = layouts.map((layout, index) => ({
    pageNumber: layout.pageNumber,
    width: layout.width,
    height: layout.height,
    rotation: pageInputs[index]?.rotation ?? 0,
    textLayerCharCount: layout.textLayerCharCount,
    likelyScanned: layout.likelyScanned,
    readingOrderUncertain: layout.readingOrderUncertain,
    columnCount: layout.columns.columns.length,
  }));

  return {
    pages,
    rawItems: perPage.flatMap((page) => page.items),
    removedDuplicates: perPage.flatMap((page) => page.removed),
    regions,
    paragraphs,
    sentences,
    normalizedText,
    outline: buildOutline(regions),
    tableRows,
    bodyFontSize,
  };
}

/**
 * Groups the items backing a sentence into one bounding box per line, so the
 * PDF viewer can highlight exactly the source of the spoken text.
 */
function boundingBoxesForItems(
  itemIds: string[],
  itemsById: Map<string, RawTextItem>,
  pageNumber: number,
): BoundingBox[] {
  const byBaseline = new Map<number, RawTextItem[]>();
  for (const id of itemIds) {
    const item = itemsById.get(id);
    if (!item) continue;
    const key = Math.round(item.y * 2) / 2;
    const bucket = byBaseline.get(key) ?? [];
    bucket.push(item);
    byBaseline.set(key, bucket);
  }

  const boxes: BoundingBox[] = [];
  for (const [, items] of [...byBaseline.entries()].sort((a, b) => b[0] - a[0])) {
    const x = Math.min(...items.map((item) => item.x));
    const right = Math.max(...items.map((item) => item.x + item.width));
    const y = Math.min(...items.map((item) => item.y));
    const height = Math.max(...items.map((item) => item.height || item.fontSize || 10));
    boxes.push({ pageNumber, x, y, width: right - x, height });
  }
  return boxes;
}

/** Builds a navigable outline from detected headings. */
export function buildOutline(regions: DocumentRegion[]): OutlineNode[] {
  const headings = regions.filter((region) => region.type === 'heading' && region.text.trim() !== '');
  if (headings.length === 0) return [];

  // Heading level from classification confidence: a strongly-signalled heading
  // (larger font, bold) sits higher than a weakly-signalled one. Deterministic,
  // and used only for indentation in the navigation panel.
  return headings.map((region) => ({
    id: `${region.id}:outline`,
    title: region.text.length > 90 ? `${region.text.slice(0, 87)}...` : region.text,
    pageNumber: region.pageNumber,
    level: region.confidence >= 0.75 ? 1 : 2,
    regionId: region.id,
  }));
}

/** Re-derives sentence inclusion from region inclusion. */
export function applyInclusionToSentences(
  sentences: SentenceRecord[],
  regions: DocumentRegion[],
): SentenceRecord[] {
  const byId = new Map(regions.map((region) => [region.id, region]));
  return sentences.map((sentence) => {
    const region = byId.get(sentence.regionId);
    if (!region) return sentence;
    const uncertain = region.confidence >= 0.5 && region.confidence < 0.8 && !region.userOverride;
    return {
      ...sentence,
      inclusionStatus: region.included ? (uncertain ? 'uncertain' : 'included') : 'excluded',
    };
  });
}

/** Collects every transformation applied to a document, for the history view. */
export function collectTransformations(sentences: SentenceRecord[]): TransformationRecord[] {
  return sentences.flatMap((sentence) => sentence.transformations);
}
