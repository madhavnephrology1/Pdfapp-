/**
 * A tiny, dependency-free PDF writer used ONLY to generate test fixtures.
 *
 * It emits PDF 1.4 with the base-14 fonts (Helvetica / Helvetica-Bold /
 * Times-Roman), which require no embedded font programs and are legally
 * unencumbered. This exists so the test suite never redistributes third-party
 * PDF documents.
 *
 * It is not a general-purpose PDF library and is not used by the application.
 */

export type FixtureFont = 'F1' | 'F2' | 'F3';

export interface TextRun {
  x: number;
  /** PDF user-space Y, measured from the bottom of the page. */
  y: number;
  text: string;
  size?: number;
  font?: FixtureFont;
  /** Renders the run in "invisible" text mode (Tr 3) to emulate an OCR layer. */
  invisible?: boolean;
}

export interface PageSpec {
  width?: number;
  height?: number;
  runs: TextRun[];
  /** Draws a filled rectangle, used to emulate image-heavy / scanned pages. */
  rects?: { x: number; y: number; width: number; height: number; gray?: number }[];
}

export interface PdfMeta {
  title?: string;
  author?: string;
  producer?: string;
}

const FONT_RESOURCES: Record<FixtureFont, string> = {
  F1: 'Helvetica',
  F2: 'Helvetica-Bold',
  F3: 'Times-Roman',
};

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r/g, '');
}

/**
 * Encodes a string for a base-14 font using WinAnsi. Characters outside Latin-1
 * are dropped rather than guessed, so a fixture never silently changes text.
 */
function encodeWinAnsi(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code <= 0xff) out += ch;
    else if (ch === '’') out += "'";
    else if (ch === '‘') out += "'";
    else if (ch === '“' || ch === '”') out += '"';
    else if (ch === '–' || ch === '—') out += '-';
    else if (ch === '…') out += '...';
  }
  return out;
}

function buildContentStream(page: PageSpec): string {
  const parts: string[] = [];
  for (const rect of page.rects ?? []) {
    const gray = rect.gray ?? 0.8;
    parts.push(`q ${gray} g ${rect.x} ${rect.y} ${rect.width} ${rect.height} re f Q`);
  }
  for (const run of page.runs) {
    const size = run.size ?? 11;
    const font = run.font ?? 'F1';
    const text = escapePdfString(encodeWinAnsi(run.text));
    parts.push('BT');
    if (run.invisible) parts.push('3 Tr');
    parts.push(`/${font} ${size} Tf`);
    parts.push(`1 0 0 1 ${run.x} ${run.y} Tm`);
    parts.push(`(${text}) Tj`);
    parts.push('ET');
  }
  return parts.join('\n');
}

/** Serializes pages into a valid single-xref-table PDF file. */
export function buildPdf(pages: PageSpec[], meta: PdfMeta = {}): Uint8Array {
  if (pages.length === 0) throw new Error('buildPdf requires at least one page');

  const objects: string[] = [];
  /** Reserves an object slot and returns its 1-based id. */
  const reserve = (): number => {
    objects.push('');
    return objects.length;
  };
  const write = (id: number, body: string): void => {
    objects[id - 1] = body;
  };

  const catalogId = reserve();
  const pagesId = reserve();
  const fontIds: Record<FixtureFont, number> = {
    F1: reserve(),
    F2: reserve(),
    F3: reserve(),
  };
  for (const key of Object.keys(fontIds) as FixtureFont[]) {
    write(
      fontIds[key],
      `<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_RESOURCES[key]} /Encoding /WinAnsiEncoding >>`,
    );
  }

  const pageIds: number[] = [];
  for (const page of pages) {
    const pageId = reserve();
    const contentId = reserve();
    const width = page.width ?? 612;
    const height = page.height ?? 792;
    const content = buildContentStream(page);
    write(contentId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    write(
      pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /Font << /F1 ${fontIds.F1} 0 R /F2 ${fontIds.F2} 0 R /F3 ${fontIds.F3} 0 R >> >> ` +
        `/Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }

  write(pagesId, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  write(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  const infoId = reserve();
  const infoParts = [
    `/Producer (${escapePdfString(meta.producer ?? 'pdf-human-reader test fixtures')})`,
    meta.title ? `/Title (${escapePdfString(encodeWinAnsi(meta.title))})` : '',
    meta.author ? `/Author (${escapePdfString(encodeWinAnsi(meta.author))})` : '',
  ].filter(Boolean);
  write(infoId, `<< ${infoParts.join(' ')} >>`);

  const chunks: string[] = ['%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    const serialized = `${index + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(offset);
    offset += serialized.length;
    chunks.push(serialized);
  });

  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const objOffset of offsets) {
    xref += `${objOffset.toString().padStart(10, '0')} 00000 n \n`;
  }
  chunks.push(xref);
  chunks.push(
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  const full = chunks.join('');
  const bytes = new Uint8Array(full.length);
  for (let i = 0; i < full.length; i += 1) bytes[i] = full.charCodeAt(i) & 0xff;
  return bytes;
}
