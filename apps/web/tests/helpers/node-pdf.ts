import type { PDFDocumentProxy } from 'pdfjs-dist';

export interface LoadedPdf {
  doc: PDFDocumentProxy;
  /** Tears down the worker and releases document memory. */
  close(): Promise<void>;
}

/**
 * Loads a PDF with the PDF.js legacy build inside Node for tests.
 * This exercises the same extraction code path as the browser worker,
 * minus canvas rendering.
 */
export async function loadPdfInNode(bytes: Uint8Array): Promise<LoadedPdf> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Point PDF.js at its bundled worker file; in Node it falls back to a fake
  // worker on the same thread, which keeps tests deterministic.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    '../../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
    import.meta.url,
  ).href;
  const task = pdfjs.getDocument({
    // PDF.js takes ownership of the buffer, so hand it a private copy.
    data: bytes.slice(),
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = (await task.promise) as PDFDocumentProxy;
  return {
    doc,
    close: async () => {
      await task.destroy();
    },
  };
}
