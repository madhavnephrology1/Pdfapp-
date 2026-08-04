'use client';

import { create } from 'zustand';
import type {
  DocumentRegion,
  DocumentSettings,
  ExtractionProgress,
  OCRPageRecord,
  OutlineNode,
  PageRecord,
  ParagraphRecord,
  RawTextItem,
  SentenceRecord,
} from '@pdfreader/shared-types';
import { extractDocument } from '@/features/extraction/pipeline';
import { ocrPageToExtractionInput, summarizeOcrPage } from '@/features/ocr/items';
import { mergeRecognizedPage, type DocumentSlice } from '@/features/ocr/merge';
import { renderPageForOcr } from '@/features/ocr/render';
import { buildReadingQueue, type ReadingQueue } from '@/features/reader/queue';
import { DEFAULT_SETTINGS, mergeSettings } from '@/features/settings/defaults';
import { documentIdFor, fingerprintFile } from '@/lib/fingerprint';
import { OCRClientError, recognizePage as postPageForRecognition } from '@/lib/ocr-client';
import { isPdfFile, openPdf } from '@/lib/pdf';
import { loadPosition, loadSettings, saveSettings, type StorageFullError } from '@/lib/persistence';
import type { ExtractionPayload, WorkerRequest, WorkerResponse } from '@/workers/protocol';

export interface AppError {
  title: string;
  message: string;
  recovery: string;
  /** True when the user can retry the same action. */
  retryable: boolean;
}

export interface ResumePrompt {
  lastPage: number;
  lastSentenceId: string | null;
  lastOpenedAt: number;
}

interface DocumentState {
  status: 'empty' | 'validating' | 'processing' | 'ready' | 'error';
  fileName: string;
  fileSize: number;
  fingerprint: string;
  documentId: string;
  /** Held for the viewer only; never uploaded. */
  fileBytes: ArrayBuffer | null;

  pages: PageRecord[];
  regions: DocumentRegion[];
  paragraphs: ParagraphRecord[];
  sentences: SentenceRecord[];
  rawItems: RawTextItem[];
  outline: OutlineNode[];
  duplicatesRemoved: number;

  /** Pages in the file, known as soon as the PDF header has been read. */
  totalPages: number;
  /**
   * Pages covered by the classification currently on screen. While this is
   * below `totalPages` the reading text is provisional: it is verbatim source
   * text, but which parts are skipped can still change once the rest of the
   * document has been seen.
   */
  pagesAnalyzed: number;
  /** True while the worker is still analysing pages. */
  analyzing: boolean;

  /**
   * Pages whose text was recognised from an image, keyed by page number.
   * Deliberately separate from `rawItems`: those are the PDF's own text layer,
   * and recognised text is not that.
   */
  ocrPages: Record<number, OCRPageRecord>;
  /** Page currently being recognised, so the interface can show it working. */
  ocrPageInFlight: number | null;
  /**
   * The document from the PDF's text layer alone, before recognised pages are
   * merged in. Kept so accepting or discarding a recognised page is exactly
   * reversible.
   */
  baseDocument: DocumentSlice;

  progress: ExtractionProgress;
  settings: DocumentSettings;
  queue: ReadingQueue;
  error: AppError | null;
  resumePrompt: ResumePrompt | null;
  /** Set when a password-protected PDF is waiting for a password. */
  passwordRequired: boolean;

  currentPage: number;

  openFile: (file: File, password?: string) => Promise<void>;
  cancelProcessing: () => void;
  stopAnalysis: () => void;
  reset: () => void;
  setSettings: (update: Partial<DocumentSettings>) => void;
  setRegionOverride: (regionId: string, decision: 'include' | 'exclude' | null) => void;
  restoreAllExclusions: () => void;
  resetOverrides: () => void;
  setCategory: (category: keyof DocumentSettings['categories'], enabled: boolean) => void;
  setCurrentPage: (page: number) => void;
  dismissResumePrompt: () => void;
  setError: (error: AppError | null) => void;

  /** Renders a page and sends the image for recognition. Requires consent. */
  recognizePage: (pageNumber: number) => Promise<void>;
  /** Replaces one recognised word with what the reader typed. */
  correctOcrWord: (pageNumber: number, wordIndex: number, corrected: string) => void;
  /** Adds a recognised page's text to the document, or takes it back out. */
  setOcrPageAccepted: (pageNumber: number, accepted: boolean) => void;
  /** Forgets a recognised page entirely, including its text. */
  discardOcrPage: (pageNumber: number) => void;
  /** Recomposes the document from the text layer plus the recognised pages. */
  applyOcrPages: (ocrPages: Record<number, OCRPageRecord>) => void;
}

const emptyQueue: ReadingQueue = {
  entries: [],
  regions: [],
  excludedRegions: [],
  uncertainRegions: [],
  totalCharacters: 0,
};

const initialProgress: ExtractionProgress = {
  pagesTotal: 0,
  pagesExtracted: 0,
  phase: 'idle',
  failedPages: [],
};

const emptySlice: DocumentSlice = {
  pages: [],
  regions: [],
  paragraphs: [],
  sentences: [],
  outline: [],
};

/**
 * What the reader sees, from the PDF's own text layer plus any pages whose text
 * was recognised from an image and accepted.
 *
 * Recomputing rather than mutating keeps recognition reversible: taking a
 * recognised page back out restores exactly the document that was there before
 * it, and correcting a word simply re-derives that page.
 */
function composeDocument(
  base: DocumentSlice,
  ocrPages: Record<number, OCRPageRecord>,
  documentId: string,
): DocumentSlice {
  const accepted = Object.values(ocrPages)
    .filter((record) => record.accepted && record.result.words.length > 0)
    .sort((a, b) => a.pageNumber - b.pageNumber);
  if (accepted.length === 0) return base;

  let slice = base;
  for (const record of accepted) {
    const recognized = extractDocument(`${documentId}:ocr`, [ocrPageToExtractionInput(record)]);
    slice = mergeRecognizedPage(slice, record.pageNumber, recognized, summarizeOcrPage(record));
  }
  return slice;
}

/** The extraction fields a pass carries, shared by partial and final results. */
function baseSliceFrom(payload: ExtractionPayload): DocumentSlice {
  return {
    pages: payload.pages,
    regions: payload.regions,
    paragraphs: payload.paragraphs,
    sentences: payload.sentences,
    outline: payload.outline,
  };
}

let worker: Worker | null = null;

function terminateWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  status: 'empty',
  fileName: '',
  fileSize: 0,
  fingerprint: '',
  documentId: '',
  fileBytes: null,
  pages: [],
  regions: [],
  paragraphs: [],
  sentences: [],
  rawItems: [],
  outline: [],
  duplicatesRemoved: 0,
  totalPages: 0,
  pagesAnalyzed: 0,
  analyzing: false,
  ocrPages: {},
  ocrPageInFlight: null,
  baseDocument: emptySlice,
  progress: initialProgress,
  settings: { ...DEFAULT_SETTINGS },
  queue: emptyQueue,
  error: null,
  resumePrompt: null,
  passwordRequired: false,
  currentPage: 1,

  async openFile(file, password) {
    terminateWorker();
    set({
      status: 'validating',
      error: null,
      passwordRequired: false,
      resumePrompt: null,
      progress: { ...initialProgress, phase: 'loading' },
    });

    if (!(await isPdfFile(file))) {
      set({
        status: 'error',
        error: {
          title: 'That file is not a PDF',
          message: `"${file.name}" does not start with a PDF header, whatever its name says.`,
          recovery: 'Choose a PDF file and try again.',
          retryable: true,
        },
      });
      return;
    }

    const fingerprint = await fingerprintFile(file);
    const documentId = documentIdFor(fingerprint);
    const storedSettings = await loadSettings(fingerprint).catch(() => undefined);
    const storedPosition = await loadPosition(fingerprint).catch(() => undefined);

    const bytes = await file.arrayBuffer();

    set({
      status: 'processing',
      fileName: file.name,
      fileSize: file.size,
      fingerprint,
      documentId,
      fileBytes: bytes,
      settings: mergeSettings(storedSettings),
      currentPage: 1,
      pages: [],
      regions: [],
      sentences: [],
      paragraphs: [],
      rawItems: [],
      outline: [],
      totalPages: 0,
      pagesAnalyzed: 0,
      analyzing: true,
      ocrPages: {},
      ocrPageInFlight: null,
      baseDocument: emptySlice,
      queue: emptyQueue,
      progress: { ...initialProgress, phase: 'loading' },
      resumePrompt: storedPosition
        ? {
            lastPage: storedPosition.lastPage,
            lastSentenceId: storedPosition.lastSentenceId,
            lastOpenedAt: storedPosition.lastOpenedAt,
          }
        : null,
    });

    worker = new Worker(new URL('../workers/extraction.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      switch (message.type) {
        case 'progress':
          set((state) => ({
            totalPages: message.pagesTotal || state.totalPages,
            progress: {
              ...state.progress,
              phase: message.phase,
              pagesExtracted: message.pagesExtracted,
              pagesTotal: message.pagesTotal,
              message: message.message,
            },
          }));
          break;

        case 'page-failed':
          // Recorded and shown, never silently dropped.
          set((state) => ({
            progress: {
              ...state.progress,
              failedPages: [
                ...state.progress.failedPages,
                { pageNumber: message.pageNumber, reason: message.reason },
              ],
            },
          }));
          break;

        // A pass over the pages read so far. The reader becomes usable here, and
        // each later pass replaces this one wholesale.
        case 'partial':
        case 'done': {
          const state = get();
          const base = baseSliceFrom(message);
          // Recognised pages survive a later analysis pass: they were not
          // produced by the pipeline and must not be thrown away by it.
          const composed = composeDocument(base, state.ocrPages, state.documentId);
          set({
            status: 'ready',
            baseDocument: base,
            ...composed,
            rawItems: message.rawItems,
            duplicatesRemoved: message.duplicatesRemoved,
            queue: buildReadingQueue(composed.regions, composed.sentences, state.settings),
            totalPages: message.pagesTotal || state.totalPages,
            pagesAnalyzed: message.pagesAnalyzed,
            ...(message.type === 'done'
              ? { analyzing: false, progress: { ...state.progress, phase: 'done' as const } }
              : {}),
          });
          if (message.type === 'done') terminateWorker();
          break;
        }

        case 'error':
          set({
            status: 'error',
            analyzing: false,
            passwordRequired:
              message.code === 'password-required' || message.code === 'wrong-password',
            error: {
              title:
                message.code === 'password-required'
                  ? 'This PDF needs a password'
                  : 'This PDF could not be opened',
              message: message.message,
              recovery: message.recovery,
              retryable: true,
            },
            progress: { ...get().progress, phase: 'error' },
          });
          terminateWorker();
          break;
      }
    };

    worker.onerror = () => {
      set({
        status: 'error',
        analyzing: false,
        error: {
          title: 'Processing failed',
          message: 'The document processor stopped unexpectedly.',
          recovery: 'Reload the page and try the file again.',
          retryable: true,
        },
      });
      terminateWorker();
    };

    // The worker gets its own copy; the UI thread keeps `bytes` for rendering.
    const request: ExtractRequestMessage = {
      type: 'extract',
      documentId,
      data: bytes.slice(0),
      password,
    };
    worker.postMessage(request, [request.data]);
  },

  cancelProcessing() {
    if (worker) worker.postMessage({ type: 'cancel' } satisfies WorkerRequest);
    terminateWorker();
    set({ status: 'empty', analyzing: false, progress: initialProgress });
  },

  /**
   * Stops analysing further pages but keeps what has already been read.
   *
   * Unlike cancelling, this leaves a usable document behind. `pagesAnalyzed`
   * stays below `totalPages`, so the interface goes on saying which pages were
   * never examined rather than presenting a partial document as a whole one.
   */
  stopAnalysis() {
    if (worker) worker.postMessage({ type: 'cancel' } satisfies WorkerRequest);
    terminateWorker();
    set((state) => ({
      analyzing: false,
      progress: { ...state.progress, phase: 'done' },
    }));
  },

  reset() {
    terminateWorker();
    set({
      status: 'empty',
      fileName: '',
      fileSize: 0,
      fingerprint: '',
      documentId: '',
      fileBytes: null,
      pages: [],
      regions: [],
      paragraphs: [],
      sentences: [],
      rawItems: [],
      outline: [],
      duplicatesRemoved: 0,
      totalPages: 0,
      pagesAnalyzed: 0,
      analyzing: false,
      ocrPages: {},
      ocrPageInFlight: null,
      baseDocument: emptySlice,
      progress: initialProgress,
      queue: emptyQueue,
      error: null,
      resumePrompt: null,
      passwordRequired: false,
      currentPage: 1,
    });
  },

  setSettings(update) {
    const settings = { ...get().settings, ...update };
    const { regions, sentences, fingerprint } = get();
    set({ settings, queue: buildReadingQueue(regions, sentences, settings) });
    if (fingerprint) {
      void saveSettings(fingerprint, settings).catch((error: StorageFullError) => {
        set({
          error: {
            title: 'Settings could not be saved',
            message: error.message,
            recovery: 'Delete stored document data in Settings to free space.',
            retryable: false,
          },
        });
      });
    }
  },

  setRegionOverride(regionId, decision) {
    const overrides = { ...get().settings.regionOverrides };
    if (decision === null) delete overrides[regionId];
    else overrides[regionId] = decision;
    get().setSettings({ regionOverrides: overrides });
  },

  restoreAllExclusions() {
    // Explicitly includes every currently-excluded region, rather than merely
    // clearing overrides, so the user gets the whole document back.
    const overrides = { ...get().settings.regionOverrides };
    for (const region of get().queue.excludedRegions) overrides[region.id] = 'include';
    get().setSettings({ regionOverrides: overrides });
  },

  resetOverrides() {
    get().setSettings({ regionOverrides: {} });
  },

  setCategory(category, enabled) {
    get().setSettings({
      categories: { ...get().settings.categories, [category]: enabled },
    });
  },

  setCurrentPage(page) {
    // Clamped to the pages in the FILE, not to the pages analysed so far: the
    // viewer can render a page long before its text has been classified.
    const { pages, totalPages } = get();
    const last = Math.max(1, totalPages, pages.length);
    set({ currentPage: Math.min(Math.max(1, page), last) });
  },

  dismissResumePrompt() {
    set({ resumePrompt: null });
  },

  setError(error) {
    set({ error });
  },

  async recognizePage(pageNumber) {
    const { settings, fileBytes, documentId, ocrPageInFlight } = get();

    // The consent gate. The server refuses without it too, so a mistake here
    // cannot put a page image on the wire — but nothing should get that far.
    if (!settings.ocrConsent) {
      set({
        error: {
          title: 'Text recognition is turned off',
          message:
            'Recognising this page means sending an image of it to a third-party service. ' +
            'That has not been agreed to, so nothing was sent.',
          recovery: 'Turn on text recognition in Settings if you want scanned pages processed.',
          retryable: false,
        },
      });
      return;
    }
    if (!fileBytes || ocrPageInFlight !== null) return;

    set({ ocrPageInFlight: pageNumber, error: null });
    let close: (() => Promise<void>) | null = null;
    try {
      // PDF.js takes ownership of the buffer it is given, so hand it a copy.
      const opened = await openPdf({ data: fileBytes.slice(0) });
      close = opened.destroy;
      const rendered = await renderPageForOcr(
        opened.doc,
        pageNumber,
        settings.ocrRenderScale ?? undefined,
      );

      const result = await postPageForRecognition({
        image: rendered.image,
        mimeType: rendered.mimeType,
        pageNumber,
        documentId,
        languageHints: ['en'],
        consent: true,
      });

      const record: OCRPageRecord = {
        pageNumber,
        result,
        corrections: [],
        renderScale: rendered.renderScale,
        pageWidth: rendered.pageWidth,
        pageHeight: rendered.pageHeight,
        recognizedAt: Date.now(),
        // Never added to the reading text without the reader looking at it
        // first: recognition is uncertain, and this is where they see that.
        accepted: false,
      };
      set((state) => ({
        ocrPages: { ...state.ocrPages, [pageNumber]: record },
        ocrPageInFlight: null,
      }));
    } catch (error) {
      const normalized =
        error instanceof OCRClientError
          ? error.normalized
          : {
              code: 'internal_error',
              message: `Page ${pageNumber} could not be prepared for text recognition.`,
              recovery: 'Try the page again.',
            };
      set({
        ocrPageInFlight: null,
        error: {
          title: `Page ${pageNumber} could not be recognised`,
          message: normalized.message,
          recovery: normalized.recovery ?? 'Try the page again.',
          retryable: true,
        },
      });
    } finally {
      await close?.().catch(() => undefined);
    }
  },

  correctOcrWord(pageNumber, wordIndex, corrected) {
    const record = get().ocrPages[pageNumber];
    const word = record?.result.words[wordIndex];
    if (!record || !word) return;

    const trimmed = corrected.trim();
    // Clearing the box means "I have nothing to add", which restores what the
    // recogniser said rather than deleting the word.
    const corrections = record.corrections.filter(
      (correction) => correction.wordIndex !== wordIndex,
    );
    if (trimmed !== '' && trimmed !== word.text) {
      corrections.push({
        wordIndex,
        original: word.text,
        corrected: trimmed,
        correctedAt: Date.now(),
      });
    }
    get().applyOcrPages({
      ...get().ocrPages,
      [pageNumber]: { ...record, corrections },
    });
  },

  setOcrPageAccepted(pageNumber, accepted) {
    const record = get().ocrPages[pageNumber];
    if (!record) return;
    get().applyOcrPages({ ...get().ocrPages, [pageNumber]: { ...record, accepted } });
  },

  discardOcrPage(pageNumber) {
    const ocrPages = { ...get().ocrPages };
    delete ocrPages[pageNumber];
    get().applyOcrPages(ocrPages);
  },

  applyOcrPages(ocrPages) {
    const { baseDocument, documentId, settings } = get();
    const composed = composeDocument(baseDocument, ocrPages, documentId);
    set({
      ocrPages,
      ...composed,
      queue: buildReadingQueue(composed.regions, composed.sentences, settings),
    });
  },
}));

/** Narrowed extract request type so the transfer list type-checks. */
interface ExtractRequestMessage {
  type: 'extract';
  documentId: string;
  data: ArrayBuffer;
  password?: string;
}
