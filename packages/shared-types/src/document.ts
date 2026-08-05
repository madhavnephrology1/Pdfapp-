/**
 * Core document representation types.
 *
 * INTEGRITY CONTRACT
 * ------------------
 * These types deliberately keep *separate* representations at every stage of the
 * pipeline. No stage may overwrite an earlier stage:
 *
 *   1. RawTextItem[]        - verbatim PDF.js text items, never mutated
 *   2. NormalizedText       - technical normalization only, with a transformation log
 *   3. DocumentRegion[]     - layout classification, never deletes text
 *   4. ReadingSelection     - which regions the user/mode approved
 *   5. SentenceRecord[]     - sentences, each mapped back to raw item ids
 *   6. TTSChunk[]           - synthesis units, each mapped back to sentence ids
 *   7. timing metadata      - exact or explicitly-estimated
 *   8. BoundingBox[]        - source coordinate mapping for every sentence
 *   9. TransformationRecord - full transformation history
 */

export interface BoundingBox {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A single text item exactly as produced by the PDF text layer. Never mutated. */
export interface RawTextItem {
  id: string;
  documentId: string;
  pageNumber: number;
  /** Verbatim string from the PDF text layer. */
  text: string;
  /** PDF.js transform matrix [a, b, c, d, e, f]. */
  transform: number[];
  x: number;
  y: number;
  width: number;
  height: number;
  fontName?: string;
  fontSize?: number;
  direction?: 'ltr' | 'rtl' | 'ttb';
  /**
   * True when this item is set smaller than the line it sits on and raised
   * above or dropped below its baseline — a superscript or subscript. Decided
   * from geometry during line grouping, which is the only place that knows both
   * the item and the line it belongs to.
   */
  raised?: boolean;
  hasEOL?: boolean;
  /** Index within the page's text item array; preserves original emission order. */
  sourceIndex: number;
}

export type TransformationKind =
  | 'hyphen-join'
  | 'line-wrap-join'
  | 'whitespace-collapse'
  | 'ligature-expand'
  | 'duplicate-removal'
  | 'soft-hyphen-removal'
  | 'control-char-removal'
  /**
   * An isolated citation marker omitted from the SPOKEN text only. The reader
   * always displays the author's sentence in full with the marker visibly
   * struck through; only the audio skips it, and only when the user's citation
   * settings ask for that. Never applied in Strict Verbatim Mode.
   */
  | 'citation-marker-skip';

/**
 * A record of one permitted, technical-only transformation.
 * Every transformation is reversible in the sense that `before` is retained.
 */
export interface TransformationRecord {
  kind: TransformationKind;
  /** Offset in the normalized string where the transformation applies. */
  offset: number;
  before: string;
  after: string;
  /** Raw text item ids involved. */
  sourceTextItemIds: string[];
}

export type RegionType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'caption'
  | 'footnote'
  | 'endnote'
  | 'header'
  | 'footer'
  | 'page-number'
  | 'sidebar'
  | 'reference'
  | 'bibliography'
  | 'index'
  | 'watermark'
  | 'unknown';

/**
 * Content categories the user can toggle in Custom Mode.
 * Maps many-to-one from RegionType.
 */
export type ContentCategory =
  | 'front-matter'
  | 'headers'
  | 'footers'
  | 'page-numbers'
  | 'footnotes'
  | 'endnotes'
  | 'captions'
  | 'tables'
  | 'citation-markers'
  | 'references'
  | 'bibliography'
  | 'index'
  | 'sidebars';

export interface DocumentRegion {
  id: string;
  documentId: string;
  pageNumber: number;
  type: RegionType;
  /** 0..1. See CONFIDENCE_THRESHOLDS for how this drives inclusion. */
  confidence: number;
  textItemIds: string[];
  boundingBoxes: BoundingBox[];
  /** Effective inclusion after mode rules and user overrides. */
  included: boolean;
  /** Human-readable, shown verbatim in the Content Review panel. */
  inclusionReason: string;
  /** Every signal that contributed to the classification. Never empty. */
  classificationEvidence: string[];
  userOverride?: 'include' | 'exclude';
  /** Column index within the page, when column detection succeeded. */
  columnIndex?: number;
  /** Deterministic reading-order rank within the page. */
  readingOrder: number;
  /** Normalized text of the region (technical normalization only). */
  text: string;
  /** True when reading order for this region could not be determined confidently. */
  orderUncertain?: boolean;
}

export interface ParagraphRecord {
  id: string;
  documentId: string;
  pageNumber: number;
  regionId: string;
  text: string;
  sentenceIds: string[];
  boundingBoxes: BoundingBox[];
}

export type InclusionStatus = 'included' | 'excluded' | 'uncertain';

export interface SentenceRecord {
  id: string;
  documentId: string;
  pageNumber: number;
  regionId: string;
  paragraphId: string;
  /** Verbatim source text after permitted normalization only. */
  text: string;
  /** Offsets into the normalized document text. */
  normalizedStart: number;
  normalizedEnd: number;
  sourceTextItemIds: string[];
  /**
   * Character ranges WITHIN `text` that came from raised or dropped items —
   * superscript citation markers, almost always. Offsets are relative to this
   * sentence, and they exist so a marker can be skipped in speech by position
   * rather than by guessing at the characters: a pattern that matches "3-5"
   * glued to a word also matches the 2 in H2O.
   */
  markerSpans?: { start: number; end: number }[];
  boundingBoxes: BoundingBox[];
  inclusionStatus: InclusionStatus;
  transformations: TransformationRecord[];
  /** Sequential index across the whole document, in reading order. */
  documentIndex: number;
}

export interface PageRecord {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  /** Number of characters in the text layer; used for scanned-page detection. */
  textLayerCharCount: number;
  /** True when the page looks like a scan (empty/near-empty text layer). */
  likelyScanned: boolean;
  /** True when column/reading-order detection was inconclusive. */
  readingOrderUncertain: boolean;
  columnCount: number;
}

export type ReadingMode = 'clean' | 'strict-verbatim' | 'custom';

export interface CategorySettings {
  'front-matter': boolean;
  headers: boolean;
  footers: boolean;
  'page-numbers': boolean;
  footnotes: boolean;
  endnotes: boolean;
  captions: boolean;
  tables: boolean;
  'citation-markers': boolean;
  references: boolean;
  bibliography: boolean;
  index: boolean;
  sidebars: boolean;
}

export interface DocumentModel {
  id: string;
  fingerprint: string;
  fileName: string;
  fileSize: number;
  pageCount: number;
  title?: string;
  pages: PageRecord[];
  rawItems: RawTextItem[];
  regions: DocumentRegion[];
  paragraphs: ParagraphRecord[];
  sentences: SentenceRecord[];
  /** Concatenated normalized document text; sentence offsets index into this. */
  normalizedText: string;
  outline: OutlineNode[];
  createdAt: number;
}

export interface OutlineNode {
  id: string;
  title: string;
  pageNumber: number;
  level: number;
  /** Region id of the heading this node was derived from, when applicable. */
  regionId?: string;
}

export interface ExtractionProgress {
  pagesTotal: number;
  pagesExtracted: number;
  phase: 'idle' | 'loading' | 'extracting' | 'classifying' | 'segmenting' | 'done' | 'error';
  message?: string;
  /** Pages that failed extraction; never silently dropped. */
  failedPages: { pageNumber: number; reason: string }[];
}
