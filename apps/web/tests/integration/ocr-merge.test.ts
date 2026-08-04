import { beforeAll, describe, expect, it } from 'vitest';
import type { OCRPageRecord, OCRWord } from '@pdfreader/shared-types';
import { mixedScannedPdf } from '@pdfreader/test-fixtures';
import { DEFAULT_SETTINGS } from '@/features/settings/defaults';
import { extractDocument, type ExtractionResult } from '@/features/extraction/pipeline';
import { ocrPageToExtractionInput, summarizeOcrPage } from '@/features/ocr/items';
import { mergeRecognizedPage, type DocumentSlice } from '@/features/ocr/merge';
import { buildReadingQueue } from '@/features/reader/queue';
import { extractFixture } from '../helpers/extract-fixture';

/**
 * Adding a recognised page to a document.
 *
 * A scanned page has no text layer, so the pipeline correctly reports nothing
 * to read on it. Recognition puts text there — and that text must arrive marked
 * as recognised, in the right place in the reading order, without disturbing
 * any page that was extracted normally.
 */

/** Two lines of plausible body text, laid out as a recogniser would report it. */
function scannedLines(pageNumber: number, lines: string[][], confidence = 0.95): OCRPageRecord {
  const words: OCRWord[] = [];
  lines.forEach((line, lineIndex) => {
    let x = 144;
    for (const text of line) {
      const width = text.length * 22;
      words.push({
        text,
        confidence,
        x,
        y: 160 + lineIndex * 44,
        width,
        height: 24,
      });
      x += width + 12;
    }
  });

  return {
    pageNumber,
    result: {
      pageNumber,
      text: lines.map((line) => line.join(' ')).join('\n'),
      words,
      confidence,
      provider: 'test-provider',
      lowConfidenceWordIndexes: words
        .map((word, index) => (word.confidence < 0.75 ? index : -1))
        .filter((index) => index >= 0),
    },
    corrections: [],
    renderScale: 2,
    pageWidth: 612,
    pageHeight: 792,
    recognizedAt: 0,
    accepted: true,
  };
}

const sliceOf = (result: ExtractionResult): DocumentSlice => ({
  pages: result.pages,
  regions: result.regions,
  paragraphs: result.paragraphs,
  sentences: result.sentences,
  outline: result.outline,
});

const merge = (base: DocumentSlice, record: OCRPageRecord): DocumentSlice =>
  mergeRecognizedPage(
    base,
    record.pageNumber,
    extractDocument('doc:ocr', [ocrPageToExtractionInput(record)]),
    summarizeOcrPage(record),
  );

describe('merging a recognised page into a document', () => {
  let base: DocumentSlice;
  let scannedPage: number;

  beforeAll(async () => {
    const result = await extractFixture(mixedScannedPdf());
    base = sliceOf(result);
    const scanned = result.pages.find((page) => page.likelyScanned);
    expect(scanned, 'the fixture must contain a scanned page').toBeDefined();
    scannedPage = scanned!.pageNumber;
  }, 60_000);

  it('has nothing to read on the scanned page before recognition', () => {
    expect(base.sentences.filter((s) => s.pageNumber === scannedPage)).toHaveLength(0);
  });

  it('puts the recognised text into the reading queue', () => {
    const merged = merge(
      base,
      scannedLines(scannedPage, [
        ['Glomerular', 'filtration', 'rate', 'falls', 'with', 'age.'],
        ['This', 'is', 'expected', 'and', 'is', 'not', 'disease.'],
      ]),
    );
    const queue = buildReadingQueue(merged.regions, merged.sentences, DEFAULT_SETTINGS);
    const spoken = queue.entries.map((entry) => entry.speechText).join(' ');
    expect(spoken).toContain('Glomerular filtration rate falls with age.');
  });

  it('marks every recognised region as read from an image, with the provider named', () => {
    const merged = merge(base, scannedLines(scannedPage, [['Recognised', 'text', 'here.']]));
    const added = merged.regions.filter((region) => region.pageNumber === scannedPage);
    expect(added.length).toBeGreaterThan(0);
    for (const region of added) {
      expect(region.classificationEvidence.join(' ')).toContain('Read from an image');
      expect(region.classificationEvidence.join(' ')).toContain('test-provider');
      expect(region.inclusionReason).toContain('Read from an image');
    }
  });

  it('never presents a recognised region as more certain than the recognition', () => {
    const shaky = scannedLines(scannedPage, [['Blurred', 'page', 'text.']], 0.55);
    const merged = merge(base, shaky);
    for (const region of merged.regions.filter((r) => r.pageNumber === scannedPage)) {
      expect(region.confidence).toBeLessThanOrEqual(0.55);
    }
  });

  it('keeps the recognised page in page order', () => {
    const merged = merge(base, scannedLines(scannedPage, [['Recognised', 'text.']]));
    const pageNumbers = merged.sentences.map((sentence) => sentence.pageNumber);
    expect([...pageNumbers].sort((a, b) => a - b)).toEqual(pageNumbers);
  });

  it('renumbers documentIndex so it stays a position in the whole document', () => {
    const merged = merge(base, scannedLines(scannedPage, [['Recognised', 'text.']]));
    expect(merged.sentences.map((sentence) => sentence.documentIndex)).toEqual(
      merged.sentences.map((_, index) => index),
    );
  });

  it('leaves every extracted page exactly as it was', () => {
    const merged = merge(base, scannedLines(scannedPage, [['Recognised', 'text.']]));
    const before = base.sentences.filter((s) => s.pageNumber !== scannedPage);
    const after = merged.sentences.filter((s) => s.pageNumber !== scannedPage);
    // Ids in particular: changing them would move the reader's place and
    // discard their include/exclude decisions.
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect(after.map((s) => s.text)).toEqual(before.map((s) => s.text));
  });

  it('replaces rather than duplicates when a page is recognised twice', () => {
    const once = merge(base, scannedLines(scannedPage, [['First', 'attempt.']]));
    const twice = merge(once, scannedLines(scannedPage, [['Second', 'attempt.']]));
    const text = twice.sentences
      .filter((s) => s.pageNumber === scannedPage)
      .map((s) => s.text)
      .join(' ');
    expect(text).toContain('Second attempt.');
    expect(text).not.toContain('First attempt.');
  });

  it('carries a reader’s correction into the reading text', () => {
    const record = scannedLines(scannedPage, [['Glomerular', 'fiItration', 'rate.']]);
    const corrected: OCRPageRecord = {
      ...record,
      corrections: [
        { wordIndex: 1, original: 'fiItration', corrected: 'filtration', correctedAt: 1 },
      ],
    };
    const merged = merge(base, corrected);
    const text = merged.sentences
      .filter((s) => s.pageNumber === scannedPage)
      .map((s) => s.text)
      .join(' ');
    expect(text).toContain('filtration');
    expect(text).not.toContain('fiItration');
  });

  it('adds nothing at all when the recogniser found nothing', () => {
    const empty = scannedLines(scannedPage, []);
    const merged = merge(base, empty);
    expect(merged.sentences.filter((s) => s.pageNumber === scannedPage)).toHaveLength(0);
  });
});
