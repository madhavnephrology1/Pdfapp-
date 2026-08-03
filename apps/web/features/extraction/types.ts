import type {
  BoundingBox,
  RawTextItem,
  RegionType,
  TransformationRecord,
} from '@pdfreader/shared-types';

/** A run of items sharing a baseline within one column. */
export interface TextLine {
  id: string;
  pageNumber: number;
  items: RawTextItem[];
  /** Normalized text of the line, items joined with inferred spaces. */
  text: string;
  /** Per-item id for each character range in `text`, for traceability. */
  spans: { start: number; end: number; itemId: string }[];
  x: number;
  y: number;
  width: number;
  height: number;
  /** PDF baseline (transform[5]). */
  baseline: number;
  fontSize: number;
  fontName?: string;
  columnIndex: number;
  /** True when the line spans more than one detected column (e.g. a heading). */
  spansColumns: boolean;
}

/** A group of lines that will become one DocumentRegion. */
export interface LayoutBlock {
  id: string;
  pageNumber: number;
  lines: TextLine[];
  type: RegionType;
  columnIndex: number;
  confidence: number;
  evidence: string[];
  boundingBox: BoundingBox;
  /** Set when block ordering could not be resolved deterministically. */
  orderUncertain: boolean;
}

export interface ColumnBand {
  index: number;
  start: number;
  end: number;
}

export interface ColumnDetection {
  columns: ColumnBand[];
  /** 0..1. Below UNCERTAIN_ORDER_CONFIDENCE the page is flagged for review. */
  confidence: number;
  evidence: string[];
}

export interface PageLayout {
  pageNumber: number;
  width: number;
  height: number;
  lines: TextLine[];
  blocks: LayoutBlock[];
  columns: ColumnDetection;
  /** Modal body font size on this page. */
  bodyFontSize: number;
  readingOrderUncertain: boolean;
  textLayerCharCount: number;
  likelyScanned: boolean;
}

export interface ParagraphBuild {
  text: string;
  transformations: TransformationRecord[];
  spans: { start: number; end: number; itemId: string }[];
}

/** Reading order below this confidence is surfaced to the user as uncertain. */
export const UNCERTAIN_ORDER_CONFIDENCE = 0.6;
