/** OCR contracts. Implemented behind an explicit user consent gate. */

export interface OCRPageInput {
  /** Base64 PNG/JPEG render of the page. */
  image: string;
  mimeType: string;
  pageNumber: number;
  languageHints?: string[];
  documentId: string;
}

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
