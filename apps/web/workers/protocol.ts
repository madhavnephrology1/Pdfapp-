import type {
  DocumentRegion,
  OutlineNode,
  PageRecord,
  ParagraphRecord,
  RawTextItem,
  SentenceRecord,
} from '@pdfreader/shared-types';

/** Messages between the UI thread and the extraction worker. */

export interface ExtractRequest {
  type: 'extract';
  documentId: string;
  /** A copy of the file bytes; the UI thread keeps its own for rendering. */
  data: ArrayBuffer;
  password?: string;
}

export interface CancelRequest {
  type: 'cancel';
}

export type WorkerRequest = ExtractRequest | CancelRequest;

export interface ProgressMessage {
  type: 'progress';
  phase: 'loading' | 'extracting' | 'classifying' | 'segmenting';
  pagesExtracted: number;
  pagesTotal: number;
  /** Sent as soon as a page's own text is available, before classification. */
  message?: string;
}

export interface PageFailureMessage {
  type: 'page-failed';
  pageNumber: number;
  reason: string;
}

export interface DoneMessage {
  type: 'done';
  pages: PageRecord[];
  regions: DocumentRegion[];
  paragraphs: ParagraphRecord[];
  sentences: SentenceRecord[];
  outline: OutlineNode[];
  normalizedText: string;
  rawItemCount: number;
  duplicatesRemoved: number;
  /** Region id -> rows, for tables offered as row-by-row reading. */
  tableRows: [string, { lineId: string; cells: { text: string; x: number; itemIds: string[] }[] }[]][];
  /** Kept so the reader can show raw extraction beside normalized text. */
  rawItems: RawTextItem[];
  bodyFontSize: number;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
  recovery: string;
}

export type WorkerResponse = ProgressMessage | PageFailureMessage | DoneMessage | ErrorMessage;
