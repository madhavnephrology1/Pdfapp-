/// <reference lib="webworker" />

import { partialMilestones } from '@/features/extraction/milestones';
import { extractDocument, type PageExtractionInput } from '@/features/extraction/pipeline';
import { PdfLoadError, toPdfLoadError } from '@/lib/pdf';
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
    console.warn(
      `[extraction] provisional pass over ${pageInputs.length} page(s) failed; ` +
        'continuing to the full pass.',
      error,
    );
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
    // PDF.js needs a worker URL even when it ends up running on this thread.
    // Browsers that support nested workers give PDF.js its own thread; those
    // that do not fall back to a same-thread "fake worker", which is still off
    // the UI thread because we are already inside a worker.
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      '/pdf.worker.min.mjs',
      scope.location.origin,
    ).href;

    const task = pdfjs.getDocument({
      data,
      password,
      // PDF.js 6 no longer uses eval; only font fetching needs restricting.
      useSystemFonts: false,
      standardFontDataUrl: '/pdf-standard-fonts/',
      cMapUrl: '/pdf-cmaps/',
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
        const content = await page.getTextContent();
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

    await task.destroy();
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
