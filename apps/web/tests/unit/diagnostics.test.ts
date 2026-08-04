import { describe, expect, it } from 'vitest';
import type { PageRecord } from '@pdfreader/shared-types';
import { formatDiagnostics } from '@/features/reader/diagnostics';

const page = (pageNumber: number, likelyScanned = false): PageRecord => ({
  pageNumber,
  width: 612,
  height: 792,
  rotation: 0,
  textLayerCharCount: likelyScanned ? 0 : 400,
  likelyScanned,
  readingOrderUncertain: false,
  columnCount: 1,
});

describe('formatDiagnostics', () => {
  it('reports the counts a failure report needs', () => {
    const report = formatDiagnostics({
      fileName: 'paper.pdf',
      totalPages: 10,
      pagesAnalyzed: 0,
      pages: [page(1), page(2, true)],
      failedPages: [],
      rawItemCount: 17,
      userAgent: 'TestAgent/1.0',
    });

    expect(report).toContain('file: paper.pdf');
    expect(report).toContain('pages in document: 10');
    expect(report).toContain('pages read: 2');
    expect(report).toContain('pages analysed: 0');
    expect(report).toContain('text pieces found: 17');
    expect(report).toContain('pages that look like scans: 1');
    expect(report).toContain('browser: TestAgent/1.0');
  });

  it('groups pages that failed for the same reason onto one line', () => {
    const report = formatDiagnostics({
      fileName: 'paper.pdf',
      totalPages: 3,
      pagesAnalyzed: 0,
      pages: [],
      failedPages: [
        { pageNumber: 1, reason: 'worker died' },
        { pageNumber: 2, reason: 'worker died' },
        { pageNumber: 3, reason: 'out of memory' },
      ],
      rawItemCount: 0,
      userAgent: 'TestAgent/1.0',
    });

    expect(report).toContain('pages that failed: 3');
    expect(report).toContain('page 1, 2: worker died');
    expect(report).toContain('page 3: out of memory');
  });

  it('carries no text from the document', () => {
    const report = formatDiagnostics({
      fileName: 'paper.pdf',
      totalPages: 1,
      pagesAnalyzed: 1,
      pages: [page(1)],
      failedPages: [],
      rawItemCount: 900,
      progressMessage: 'a provisional pass could not be completed',
      userAgent: 'TestAgent/1.0',
    });

    // Everything in the report is a count, a file name, a reason string or the
    // browser. Nothing here should ever grow a field carrying page content.
    expect(report).toContain('last message: a provisional pass could not be completed');
    expect(report.split('\n').length).toBeLessThan(14);
  });
});
