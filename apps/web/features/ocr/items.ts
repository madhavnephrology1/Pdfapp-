import type { OCRPageRecord } from '@pdfreader/shared-types';
import { effectiveOcrWords } from '@pdfreader/shared-types';
import type { PageExtractionInput } from '@/features/extraction/pipeline';
import type { PdfTextItemLike } from '@/features/extraction/raw-items';

/**
 * Turns a recognised page into the same shape the PDF text layer produces, so
 * the ordinary extraction pipeline can analyse it.
 *
 * This is worth doing rather than writing a second, simpler path: line
 * grouping, column detection, paragraph reconstruction, hyphen joining and
 * sentence segmentation are all already tested, and a recognised page needs
 * every one of them. What it must NOT do is make recognised text look like
 * extracted text — that distinction is carried by the page's OCR record and is
 * shown wherever the page appears.
 *
 * Two conversions happen here and nowhere else:
 *
 *   - image pixels to PDF points: divide by the scale the page was rendered at
 *   - top-left origin to bottom-left origin: flip against the page height
 *
 * Getting either wrong would put every bounding box in the wrong place, so both
 * are covered by unit tests.
 */

export function ocrPageToExtractionInput(record: OCRPageRecord): PageExtractionInput {
  const scale = record.renderScale > 0 ? record.renderScale : 1;
  const words = effectiveOcrWords(record);

  const items: PdfTextItemLike[] = record.result.words.map((word, index) => {
    const width = word.width / scale;
    const height = word.height / scale;
    const x = word.x / scale;
    // OCR y is the TOP of the word measured downward; PDF y is the BASELINE
    // measured upward. The bottom of the box is the closest available stand-in
    // for the baseline, and it is what the layout analysis compares.
    const y = record.pageHeight - (word.y + word.height) / scale;

    return {
      // A space after each word is what the PDF text layer would emit between
      // separate glyph runs, and line grouping relies on the gap rather than on
      // this character, so no text is invented by it.
      str: words[index] ?? word.text,
      dir: 'ltr',
      width,
      height,
      // The layout analysis reads the font size out of the matrix; the height of
      // the recognised box is the only size information a recogniser gives.
      transform: [height, 0, 0, height, x, y],
    };
  });

  return {
    pageNumber: record.pageNumber,
    width: record.pageWidth,
    height: record.pageHeight,
    rotation: 0,
    items,
  };
}

/** Words the provider was not confident about, after any reader corrections. */
export function remainingLowConfidenceIndexes(record: OCRPageRecord): number[] {
  const corrected = new Set(record.corrections.map((correction) => correction.wordIndex));
  return record.result.lowConfidenceWordIndexes.filter((index) => !corrected.has(index));
}

/** How the recognition went, in the terms the interface reports it. */
export interface OcrPageSummary {
  words: number;
  lowConfidence: number;
  corrected: number;
  /** Mean provider confidence for the page, 0..1. */
  confidence: number;
  provider: string;
  empty: boolean;
}

export function summarizeOcrPage(record: OCRPageRecord): OcrPageSummary {
  return {
    words: record.result.words.length,
    lowConfidence: remainingLowConfidenceIndexes(record).length,
    corrected: record.corrections.length,
    confidence: record.result.confidence,
    provider: record.result.provider,
    empty: record.result.words.length === 0,
  };
}
