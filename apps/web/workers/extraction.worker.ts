/// <reference lib="webworker" />

import { partialMilestones } from '@/features/extraction/milestones';
import { asset } from '@/lib/base-path';
import { extractDocument, type PageExtractionInput } from '@/features/extraction/pipeline';
import { PDF_WORKER_SRC, PdfLoadError, readTextContent, toPdfLoadError } from '@/lib/pdf';
import type { ExtractionPayload, WorkerRequest, WorkerResponse } from './protocol';

/**
 * Extraction worker.
 *
 * All layout analysis, classification and sentence segmentation run here so the
 * interface stays responsive while a large document is processed. The UI thread
 * keeps its own copy of the file for rendering; this worker receives a copy and
 * releases it as soon as extraction finishes.
 *
 * Results are sent in two kinds of message. `partial` carries a complete pass
 * over the pages read so far, so a long document becomes readable and playable
 * long before the last page is reached; `done` carries the final pass over the
 * whole document. Each pass replaces the previous one, and the UI marks a
 * partial pass as provisional because document-wide evidence — repeated
 * headers, where the reference list starts — is not available yet.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** How long to wait for PDF.js to release the document before moving on. */
const DESTROY_TIMEOUT_MS = 5000;

let cancelled = false;

const post = (message: WorkerResponse, transfer?: Transferable[]): void => {
  scope.postMessage(message, transfer ?? []);
};

type PipelineResult = ReturnType<typeof extractDocument>;

const payloadOf = (result: PipelineResult): ExtractionPayload => ({
  pages: result.pages,
  regions: result.regions,
  paragraphs: result.paragraphs,
  sentences: result.sentences,
  outline: result.outline,
  normalizedText: result.normalizedText,
  rawItemCount: result.rawItems.length,
  duplicatesRemoved: result.removedDuplicates.length,
  tableRows: [...result.tableRows.entries()],
  rawItems: result.rawItems,
  bodyFontSize: result.bodyFontSize,
});

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (request.type === 'extract') {
    cancelled = false;
    void runExtraction(request.documentId, request.data, request.password);
  }
});

/**
 * Runs the pipeline over the pages read so far and sends the result.
 *
 * A provisional pass must never be able to lose the document. If the pipeline
 * throws on a prefix, the pass is skipped and extraction carries on: the final
 * pass covers the same pages, so a genuine defect still surfaces as an error
 * rather than being swallowed here.
 */
function postPartialPass(
  documentId: string,
  pageInputs: PageExtractionInput[],
  pageCount: number,
): void {
  try {
    const result = extractDocument(documentId, pageInputs);
    post({
      type: 'partial',
      ...payloadOf(result),
      pagesAnalyzed: pageInputs.length,
      pagesTotal: pageCount,
    });
  } catch (error) {
    // A console warning is invisible to someone holding a phone. Say it where
    // it can be read: silently skipping every pass looks identical to being
    // stuck, which is exactly the confusion this caused in the field.
    const reason = (error as Error)?.message?.slice(0, 120) ?? 'unknown error';
    console.warn(`[extraction] provisional pass over ${pageInputs.length} page(s) failed`, error);
    post({
      type: 'progress',
      phase: 'extracting',
      pagesExtracted: pageInputs.length,
      pagesTotal: pageCount,
      message: `a provisional pass could not be completed (${reason})`,
    });
  }
}

async function runExtraction(
  documentId: string,
  data: ArrayBuffer,
  password?: string,
): Promise<void> {
  try {
    post({
      type: 'progress',
      phase: 'loading',
      pagesExtracted: 0,
      pagesTotal: 0,
    });

    // Legacy build: see lib/pdf.ts for why.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

    // Bundle PDF.js's worker code rather than leaving it to be fetched.
    //
    // PDF.js first tries a nested `new Worker(workerSrc)`. When that cannot
    // start — the host 404s the file, or serves it with a media type a module
    // worker refuses — it falls back to running the worker's code on this
    // thread, and it obtains that code with `await import(workerSrc)`: the same
    // network fetch that just failed. So a single unfetchable file takes the
    // fallback down with it, and every page then fails.
    //
    // Evaluating the module here removes that. `pdf.worker.mjs` assigns
    // `globalThis.pdfjsWorker` as its last statement, and `PDFWorker` checks
    // that global before it fetches anything, so the fallback finds the handler
    // already in memory. The import is bundled with this worker, so it either
    // loads with it or fails loudly at startup.
    //
    // Verified: with the emitted `pdf.worker.*.mjs` deleted from the served
    // directory the document still reads (7,512 words); with this import
    // removed and the same file deleted, the document fails to open at all.
    await import('pdfjs-dist/legacy/build/pdf.worker.mjs');

    // Still required: `PDFWorker.workerSrc` throws when unset, and it is what
    // the nested-worker attempt uses on hosts where that attempt succeeds.
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;

    // If a future PDF.js stops self-registering, the line above goes quiet
    // rather than wrong — the fetch comes back and takes the host's behaviour
    // with it. Say so where it can be read instead of finding out in the field.
    const registered = (globalThis as { pdfjsWorker?: { WorkerMessageHandler?: unknown } })
      .pdfjsWorker?.WorkerMessageHandler;
    if (!registered) {
      post({
        type: 'progress',
        phase: 'loading',
        pagesExtracted: 0,
        pagesTotal: 0,
        message: 'the PDF engine could not be loaded from this app and will be fetched instead',
      });
    }

    const task = pdfjs.getDocument({
      data,
      password,
      // PDF.js 6 no longer uses eval; only font fetching needs restricting.
      useSystemFonts: false,
      standardFontDataUrl: asset('/pdf-standard-fonts/'),
      cMapUrl: asset('/pdf-cmaps/'),
      cMapPacked: true,
      verbosity: 0,
    });

    let doc;
    try {
      doc = await task.promise;
    } catch (error) {
      throw toPdfLoadError(error);
    }

    const pageCount = doc.numPages;
    post({
      type: 'progress',
      phase: 'extracting',
      pagesExtracted: 0,
      pagesTotal: pageCount,
    });

    const pageInputs: PageExtractionInput[] = [];
    const milestones = new Set(partialMilestones(pageCount));

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      if (cancelled) {
        await task.destroy();
        return;
      }
      try {
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        // Not `page.getTextContent()` — see readTextContent for why that call
        // cannot complete in Safari.
        const content = (await readTextContent(page)) as Awaited<
          ReturnType<typeof page.getTextContent>
        >;
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
      } catch (error) {
        // One bad page must not lose the rest of the document, and it is
        // reported rather than silently skipped.
        post({
          type: 'page-failed',
          pageNumber,
          reason: (error as Error)?.message?.slice(0, 200) ?? 'This page could not be read.',
        });
      }

      post({
        type: 'progress',
        phase: 'extracting',
        pagesExtracted: pageNumber,
        pagesTotal: pageCount,
      });

      if (milestones.has(pageInputs.length) && !cancelled) {
        postPartialPass(documentId, pageInputs, pageCount);
      }

      // Yield so cancellation and progress messages are processed promptly.
      if (pageNumber % 5 === 0) await Promise.resolve();
    }

    // Releasing the PDF is a courtesy, not a step the result depends on. It has
    // been seen to never settle, which strands the run between the last page and
    // the first result with nothing on screen to explain it — so it is bounded
    // and the analysis proceeds either way.
    await Promise.race([
      task.destroy().catch(() => undefined),
      new Promise((resolve) => scope.setTimeout(resolve, DESTROY_TIMEOUT_MS)),
    ]);
    if (cancelled) return;

    post({
      type: 'progress',
      phase: 'classifying',
      pagesExtracted: pageCount,
      pagesTotal: pageCount,
    });
    const result = extractDocument(documentId, pageInputs);

    if (cancelled) return;
    post({
      type: 'progress',
      phase: 'segmenting',
      pagesExtracted: pageCount,
      pagesTotal: pageCount,
    });

    post({
      type: 'done',
      ...payloadOf(result),
      pagesAnalyzed: pageInputs.length,
      pagesTotal: pageCount,
    });
  } catch (error) {
    if (error instanceof PdfLoadError) {
      post({
        type: 'error',
        code: error.code,
        message: error.message,
        recovery: error.recovery,
      });
      return;
    }
    // The detail goes to the worker console for debugging; the user-facing
    // message stays plain and carries no stack trace.
    console.error('[extraction] failed:', error);
    post({
      type: 'error',
      code: 'extraction-failed',
      message: 'This document could not be processed.',
      recovery: 'Try a different file. If it opens in another reader, please report it.',
    });
  }
}
