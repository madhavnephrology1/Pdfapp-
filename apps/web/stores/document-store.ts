'use client';

import { create } from 'zustand';
import type {
  DocumentRegion,
  DocumentSettings,
  ExtractionProgress,
  OutlineNode,
  PageRecord,
  ParagraphRecord,
  RawTextItem,
  SentenceRecord,
} from '@pdfreader/shared-types';
import { buildReadingQueue, type ReadingQueue } from '@/features/reader/queue';
import { DEFAULT_SETTINGS, mergeSettings } from '@/features/settings/defaults';
import { documentIdFor, fingerprintFile } from '@/lib/fingerprint';
import { isPdfFile } from '@/lib/pdf';
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

/** The extraction fields a pass carries, shared by partial and final results. */
function documentFieldsFrom(
  payload: ExtractionPayload,
): Pick<
  DocumentState,
  'pages' | 'regions' | 'paragraphs' | 'sentences' | 'rawItems' | 'outline' | 'duplicatesRemoved'
> {
  return {
    pages: payload.pages,
    regions: payload.regions,
    paragraphs: payload.paragraphs,
    sentences: payload.sentences,
    rawItems: payload.rawItems,
    outline: payload.outline,
    duplicatesRemoved: payload.duplicatesRemoved,
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
        case 'partial': {
          const queue = buildReadingQueue(message.regions, message.sentences, get().settings);
          set((state) => ({
            status: 'ready',
            ...documentFieldsFrom(message),
            queue,
            totalPages: message.pagesTotal || state.totalPages,
            pagesAnalyzed: message.pagesAnalyzed,
          }));
          break;
        }

        case 'done': {
          const queue = buildReadingQueue(message.regions, message.sentences, get().settings);
          set((state) => ({
            status: 'ready',
            ...documentFieldsFrom(message),
            queue,
            totalPages: message.pagesTotal || state.totalPages,
            pagesAnalyzed: message.pagesAnalyzed,
            analyzing: false,
            progress: { ...state.progress, phase: 'done' },
          }));
          terminateWorker();
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
}));

/** Narrowed extract request type so the transfer list type-checks. */
interface ExtractRequestMessage {
  type: 'extract';
  documentId: string;
  data: ArrayBuffer;
  password?: string;
}
