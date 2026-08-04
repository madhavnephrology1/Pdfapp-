import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * Renders one page to an image for text recognition.
 *
 * The scale is a real trade-off and is therefore a setting rather than a
 * constant: too low and small type is unrecognisable, too high and the request
 * exceeds what the deployment accepts. 2x is a reasonable default for a 300 DPI
 * scan downsampled into a PDF at 72 points per inch.
 */

export const DEFAULT_OCR_RENDER_SCALE = 2;

export interface RenderedPage {
  /** Base64 of the PNG, with no data: prefix — what the API expects. */
  image: string;
  mimeType: 'image/png';
  /** Scale actually used, needed to map recognised boxes back to PDF points. */
  renderScale: number;
  /** Page size in PDF points. */
  pageWidth: number;
  pageHeight: number;
  byteLength: number;
}

export async function renderPageForOcr(
  doc: PDFDocumentProxy,
  pageNumber: number,
  scale: number = DEFAULT_OCR_RENDER_SCALE,
): Promise<RenderedPage> {
  const page = await doc.getPage(pageNumber);
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not render the page to an image.');

    // A scan is drawn onto a transparent canvas by default, which some
    // recognisers read as black. White matches what the page looks like.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvas, canvasContext: context, viewport }).promise;

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('This browser could not encode the page image.');

    const bytes = new Uint8Array(await blob.arrayBuffer());
    // Free the bitmap straight away: a page at 2x is several megabytes.
    canvas.width = 0;
    canvas.height = 0;

    return {
      image: base64FromBytes(bytes),
      mimeType: 'image/png',
      renderScale: scale,
      pageWidth: base.width,
      pageHeight: base.height,
      byteLength: bytes.byteLength,
    };
  } finally {
    page.cleanup();
  }
}

/** Chunked so a multi-megabyte image does not blow the argument limit. */
function base64FromBytes(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
