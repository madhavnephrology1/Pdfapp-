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

/** Everything the pipeline produces for a set of pages. */
export interface ExtractionPayload {
  pages: PageRecord[];
  regions: DocumentRegion[];
  paragraphs: ParagraphRecord[];
  sentences: SentenceRecord[];
  outline: OutlineNode[];
  normalizedText: string;
  rawItemCount: number;
  duplicatesRemoved: number;
  /** Region id -> rows, for tables offered as row-by-row reading. */
  tableRows: [
    string,
    {
      lineId: string;
      cells: { text: string; x: number; itemIds: string[] }[];
    }[],
  ][];
  /** Kept so the reader can show raw extraction beside normalized text. */
  rawItems: RawTextItem[];
  bodyFontSize: number;
}

/**
 * A pass over the pages read so far, sent so reading can begin before the whole
 * document has been seen.
 *
 * Classification of a prefix is genuinely provisional, not merely incomplete:
 * evidence such as "this line repeats on every page" cannot exist yet, so a
 * running header will be read aloud until enough pages have been analysed to
 * recognise it. Each pass replaces the previous one wholesale, and callers must
 * tell the reader that what is skipped may still change.
 */
export interface PartialMessage extends ExtractionPayload {
  type: 'partial';
  /** Pages covered by this pass. */
  pagesAnalyzed: number;
  pagesTotal: number;
}

/** The final pass, over every page that could be read. */
export interface DoneMessage extends ExtractionPayload {
  type: 'done';
  pagesAnalyzed: number;
  pagesTotal: number;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
  recovery: string;
}

export type WorkerResponse =
  ProgressMessage | PageFailureMessage | PartialMessage | DoneMessage | ErrorMessage;
