import type { ExtractionProgress, PageRecord } from '@pdfreader/shared-types';

/**
 * A short, plain-text account of why nothing could be read.
 *
 * This exists because the only reproduction available for some failures is a
 * phone belonging to someone who cannot open a developer console. It reports
 * facts the application already holds — nothing is inferred, and no text from
 * the document is included, so pasting it discloses no reading material.
 */
export interface DiagnosticInput {
  fileName: string;
  totalPages: number;
  pagesAnalyzed: number;
  pages: PageRecord[];
  failedPages: ExtractionProgress['failedPages'];
  rawItemCount: number;
  progressMessage?: string;
  userAgent: string;
}

export function formatDiagnostics(input: DiagnosticInput): string {
  const lines: string[] = [];
  lines.push('PDF Human Reader — diagnostic report');
  lines.push(`file: ${input.fileName || '(none)'}`);
  lines.push(`pages in document: ${input.totalPages}`);
  lines.push(`pages read: ${input.pages.length}`);
  lines.push(`pages analysed: ${input.pagesAnalyzed}`);
  lines.push(`text pieces found: ${input.rawItemCount}`);
  lines.push(
    `pages that look like scans: ${input.pages.filter((page) => page.likelyScanned).length}`,
  );
  lines.push(`pages that failed: ${input.failedPages.length}`);

  // Several pages usually fail for one reason. List the distinct reasons rather
  // than one line per page, so the report stays short enough to paste.
  const reasons = new Map<string, number[]>();
  for (const failure of input.failedPages) {
    const existing = reasons.get(failure.reason);
    if (existing) existing.push(failure.pageNumber);
    else reasons.set(failure.reason, [failure.pageNumber]);
  }
  for (const [reason, pageNumbers] of reasons) {
    lines.push(`  page ${pageNumbers.join(', ')}: ${reason}`);
  }

  if (input.progressMessage) lines.push(`last message: ${input.progressMessage}`);
  lines.push(`browser: ${input.userAgent}`);
  return lines.join('\n');
}
