/** OCR contracts. Implemented behind an explicit user consent gate. */

export interface OCRPageInput {
  /** Base64 PNG/JPEG render of the page. */
  image: string;
  mimeType: string;
  pageNumber: number;
  languageHints?: string[];
  documentId: string;
}

/**
 * One recognised word, exactly as the provider returned it.
 *
 * Coordinates are in the PIXELS OF THE IMAGE THAT WAS SENT, origin top-left —
 * the convention every OCR vendor uses. They are not PDF coordinates, whose
 * origin is the bottom-left and whose unit is the point. The client rendered the
 * image and knows the scale, so it converts them.
 */
export interface OCRWord {
  text: string;
  /** 0..1 provider confidence. Never fabricated. */
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OCRPageResult {
  pageNumber: number;
  text: string;
  words: OCRWord[];
  /** Mean word confidence, or the provider's page-level score when supplied. */
  confidence: number;
  language?: string;
  provider: string;
  /**
   * Words below the low-confidence threshold. The UI must mark these visibly and
   * must never substitute a guessed word.
   */
  lowConfidenceWordIndexes: number[];
}

export interface OCRProvider {
  readonly name: string;
  recognizePage(input: OCRPageInput): Promise<OCRPageResult>;
}

export const OCR_LOW_CONFIDENCE_THRESHOLD = 0.75;

/**
 * A word the reader retyped after seeing it marked as uncertain.
 *
 * The provider's word is kept alongside, so a corrected page still says exactly
 * what was recognised and exactly what a person changed it to. The application
 * never corrects a word on its own.
 */
export interface OCRWordCorrection {
  wordIndex: number;
  /** What the provider returned. */
  original: string;
  /** What the reader typed. Their words, not the application's. */
  corrected: string;
  correctedAt: number;
}

/**
 * A recognised page held in the document.
 *
 * This is a TENTH representation alongside the nine in the integrity contract,
 * and it is deliberately separate from `RawTextItem[]`: those are the PDF's own
 * text layer, and recognised text is not that. Keeping them apart is what lets
 * the interface say which pages were read from an image.
 */
export interface OCRPageRecord {
  pageNumber: number;
  /** Exactly what the provider returned, never edited in place. */
  result: OCRPageResult;
  corrections: OCRWordCorrection[];
  /** Scale the page was rendered at, needed to map boxes back to PDF space. */
  renderScale: number;
  /** Page size in PDF points, needed to flip the vertical axis. */
  pageWidth: number;
  pageHeight: number;
  recognizedAt: number;
  /** True once the reader has added this page's text to the document. */
  accepted: boolean;
}

/** The word text to use: the reader's correction when there is one. */
export function effectiveOcrWords(record: OCRPageRecord): string[] {
  const words = record.result.words.map((word) => word.text);
  for (const correction of record.corrections) {
    if (correction.wordIndex >= 0 && correction.wordIndex < words.length) {
      words[correction.wordIndex] = correction.corrected;
    }
  }
  return words;
}
