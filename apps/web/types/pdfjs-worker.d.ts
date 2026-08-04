/**
 * PDF.js ships no type declarations for its worker entry point. It is imported
 * only so its `WorkerMessageHandler` can be handed to PDF.js directly, instead
 * of PDF.js fetching the same file over the network — see
 * workers/extraction.worker.ts for why that fetch is worth avoiding.
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
