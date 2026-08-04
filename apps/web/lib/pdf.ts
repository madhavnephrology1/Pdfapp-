import type { PDFDocumentProxy } from 'pdfjs-dist';
import { asset } from './base-path';

/**
 * PDF.js setup for the browser.
 *
 * The worker file is served from the app's own origin (copied into /public by
 * `scripts/copy-pdf-worker.mjs`) rather than a CDN, so no third party learns
 * that a user opened a document.
 */

/**
 * The PDF.js worker, addressed through the bundler rather than by hand.
 *
 * It used to be a hand-placed copy in /public referenced by an absolute path.
 * That made the URL depend on the deployment's base path AND on the host
 * serving a `.mjs` file with a JavaScript media type — a module worker is
 * refused outright if the type is wrong, and hosts differ on `.mjs`. Letting
 * the bundler emit the file removes both: it fingerprints the asset, applies
 * the base path itself, and serves it as ordinary JavaScript.
 */
export const PDF_WORKER_SRC = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url)
  .href;

type PdfjsModule = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/**
 * Loads the LEGACY PDF.js build.
 *
 * The modern build assumes very recent JavaScript builtins that browsers only
 * a version or two old do not have, and fails at runtime on them. The legacy
 * build is transpiled and behaves identically for our purposes.
 */
export async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
      return pdfjs as unknown as PdfjsModule;
    });
  }
  return pdfjsPromise;
}

export class PdfLoadError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid-pdf'
      | 'password-required'
      | 'wrong-password'
      | 'unsupported-encryption'
      | 'empty'
      | 'unknown',
    readonly recovery: string,
  ) {
    super(message);
    this.name = 'PdfLoadError';
  }
}

export interface OpenPdfOptions {
  data: ArrayBuffer;
  password?: string;
  onPasswordRequired?: (retry: boolean) => void;
}

export interface OpenedPdf {
  doc: PDFDocumentProxy;
  /** Tears down the PDF.js worker and frees the document's memory. */
  destroy: () => Promise<void>;
}

/** Opens a PDF, converting PDF.js failures into plain-language errors. */
export async function openPdf({ data, password }: OpenPdfOptions): Promise<OpenedPdf> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data,
    password,
    // PDF.js 6 no longer uses eval at all, so there is no longer an option to
    // turn it off. What remains to restrict is font loading: no system fonts,
    // and font/CMap data served only from this origin.
    useSystemFonts: false,
    // Rendering still needs standard font metrics; served from our own origin.
    standardFontDataUrl: asset('/pdf-standard-fonts/'),
    cMapUrl: asset('/pdf-cmaps/'),
    cMapPacked: true,
    verbosity: 0,
  });

  try {
    const doc = await task.promise;
    if (doc.numPages === 0) {
      throw new PdfLoadError('This PDF has no pages.', 'empty', 'Choose a different file.');
    }
    return { doc, destroy: () => task.destroy() };
  } catch (error) {
    throw toPdfLoadError(error);
  }
}

export function toPdfLoadError(error: unknown): PdfLoadError {
  if (error instanceof PdfLoadError) return error;

  const name = (error as { name?: string })?.name ?? '';
  const code = (error as { code?: number })?.code;
  const message = (error as { message?: string })?.message ?? '';

  if (name === 'PasswordException') {
    // PDF.js code 1 = password needed, 2 = incorrect password.
    if (code === 2) {
      return new PdfLoadError(
        'That password did not open this PDF.',
        'wrong-password',
        'Check the password and try again.',
      );
    }
    return new PdfLoadError(
      'This PDF is password protected.',
      'password-required',
      'Enter the document password to continue.',
    );
  }

  if (name === 'InvalidPDFException') {
    return new PdfLoadError(
      'This file could not be opened as a PDF. It may be damaged or incomplete.',
      'invalid-pdf',
      'Try re-downloading or re-exporting the file.',
    );
  }

  if (/encrypt/i.test(message)) {
    return new PdfLoadError(
      'This PDF uses an encryption method this reader cannot open.',
      'unsupported-encryption',
      'Open it in another viewer and save an unencrypted copy.',
    );
  }

  return new PdfLoadError(
    'This PDF could not be opened.',
    'unknown',
    'Try a different file. If it opens elsewhere, please report it.',
  );
}

/** Validates the file's own bytes rather than trusting its name or MIME type. */
export async function isPdfFile(file: File): Promise<boolean> {
  const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  return magic.every((byte, index) => header[index] === byte);
}
