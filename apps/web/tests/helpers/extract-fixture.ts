import { extractDocument, type PageExtractionInput } from '@/features/extraction/pipeline';
import type { ExtractionResult } from '@/features/extraction/pipeline';
import { loadPdfInNode } from './node-pdf';

/**
 * Runs the real extraction pipeline over a fixture PDF using PDF.js in Node.
 * This is the same code path the browser worker uses.
 */
export async function extractFixture(
  bytes: Uint8Array,
  documentId = 'doc',
): Promise<ExtractionResult> {
  const { doc, close } = await loadPdfInNode(bytes);
  try {
    const pageInputs: PageExtractionInput[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pageInputs.push({
        pageNumber,
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
      });
      page.cleanup();
    }
    return extractDocument(documentId, pageInputs);
  } finally {
    await close();
  }
}

/** Concatenated text of every region the pipeline produced. */
export const allRegionText = (result: ExtractionResult): string =>
  result.regions.map((region) => region.text).join(' ');

/** Concatenated text of the sentences a reading mode would speak. */
export const spokenText = (result: ExtractionResult, includedRegionIds: Set<string>): string =>
  result.sentences
    .filter((sentence) => includedRegionIds.has(sentence.regionId))
    .map((sentence) => sentence.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
