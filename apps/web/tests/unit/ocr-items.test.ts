import { describe, expect, it } from 'vitest';
import type { OCRPageRecord, OCRWord } from '@pdfreader/shared-types';
import { effectiveOcrWords } from '@pdfreader/shared-types';
import {
  ocrPageToExtractionInput,
  remainingLowConfidenceIndexes,
  summarizeOcrPage,
} from '@/features/ocr/items';

/**
 * Recognised words arrive in image pixels with the origin at the top-left; the
 * rest of the application works in PDF points with the origin at the
 * bottom-left. Getting that conversion wrong would put every highlight in the
 * wrong place, silently, so it is pinned here.
 */

const word = (text: string, x: number, y: number, confidence = 0.95): OCRWord => ({
  text,
  confidence,
  x,
  y,
  width: 40,
  height: 20,
});

const record = (words: OCRWord[], overrides: Partial<OCRPageRecord> = {}): OCRPageRecord => ({
  pageNumber: 3,
  result: {
    pageNumber: 3,
    text: words.map((w) => w.text).join(' '),
    words,
    confidence: words.length ? words.reduce((sum, w) => sum + w.confidence, 0) / words.length : 0,
    provider: 'test-provider',
    lowConfidenceWordIndexes: words
      .map((w, index) => (w.confidence < 0.75 ? index : -1))
      .filter((index) => index >= 0),
  },
  corrections: [],
  renderScale: 2,
  pageWidth: 612,
  pageHeight: 792,
  recognizedAt: 0,
  accepted: false,
  ...overrides,
});

describe('recognised words as extraction input', () => {
  it('divides image pixels by the scale the page was rendered at', () => {
    const input = ocrPageToExtractionInput(record([word('Kidney', 200, 100)]));
    const [, , , , x] = input.items[0].transform;
    expect(x).toBe(100);
    expect(input.items[0].width).toBe(20);
    expect(input.items[0].height).toBe(10);
  });

  it('flips the vertical axis, because PDF y grows upward', () => {
    // Top of the word 100px down at 2x is 50pt from the top of a 792pt page;
    // its bottom is 10pt lower again, so the PDF y is 792 - 60.
    const input = ocrPageToExtractionInput(record([word('Kidney', 200, 100)]));
    expect(input.items[0].transform[5]).toBe(732);
  });

  it('puts a word near the top of the image near the top of the page', () => {
    const top = ocrPageToExtractionInput(record([word('header', 0, 0)])).items[0];
    const bottom = ocrPageToExtractionInput(record([word('footer', 0, 1540)])).items[0];
    expect(top.transform[5]).toBeGreaterThan(bottom.transform[5]);
  });

  it('carries the recognised size through as the font size', () => {
    // A recogniser gives no font, so the height of the box is the only size
    // information there is; the layout analysis reads it from the matrix.
    const input = ocrPageToExtractionInput(record([word('Kidney', 0, 0)]));
    expect(input.items[0].transform[0]).toBe(10);
    expect(input.items[0].transform[3]).toBe(10);
  });

  it('reports the page size in PDF points', () => {
    const input = ocrPageToExtractionInput(record([word('a', 0, 0)]));
    expect(input.width).toBe(612);
    expect(input.height).toBe(792);
    expect(input.pageNumber).toBe(3);
  });

  it('survives a nonsensical scale rather than dividing by zero', () => {
    const input = ocrPageToExtractionInput(record([word('a', 40, 40)], { renderScale: 0 }));
    expect(Number.isFinite(input.items[0].transform[4])).toBe(true);
  });

  it('never invents a word the recogniser did not return', () => {
    const input = ocrPageToExtractionInput(record([word('one', 0, 0), word('two', 60, 0)]));
    expect(input.items.map((item) => item.str)).toEqual(['one', 'two']);
  });
});

describe('reader corrections', () => {
  it('uses the reader’s word in place of the recognised one', () => {
    const corrected = record([word('Kldney', 0, 0, 0.4)], {
      corrections: [{ wordIndex: 0, original: 'Kldney', corrected: 'Kidney', correctedAt: 1 }],
    });
    expect(effectiveOcrWords(corrected)).toEqual(['Kidney']);
    expect(ocrPageToExtractionInput(corrected).items[0].str).toBe('Kidney');
  });

  it('keeps what the recogniser returned alongside the correction', () => {
    const corrected = record([word('Kldney', 0, 0, 0.4)], {
      corrections: [{ wordIndex: 0, original: 'Kldney', corrected: 'Kidney', correctedAt: 1 }],
    });
    // The original is still there: a corrected page can still say what was read.
    expect(corrected.result.words[0].text).toBe('Kldney');
    expect(corrected.corrections[0].original).toBe('Kldney');
  });

  it('ignores a correction that points outside the word list', () => {
    const stray = record([word('one', 0, 0)], {
      corrections: [{ wordIndex: 9, original: 'x', corrected: 'y', correctedAt: 1 }],
    });
    expect(effectiveOcrWords(stray)).toEqual(['one']);
  });

  it('stops marking a word as uncertain once the reader has retyped it', () => {
    const words = [word('clear', 0, 0), word('smudge', 60, 0, 0.3)];
    expect(remainingLowConfidenceIndexes(record(words))).toEqual([1]);

    const fixed = record(words, {
      corrections: [{ wordIndex: 1, original: 'smudge', corrected: 'smudged', correctedAt: 1 }],
    });
    expect(remainingLowConfidenceIndexes(fixed)).toEqual([]);
  });
});

describe('summarising a recognised page', () => {
  it('counts words, uncertainty and corrections', () => {
    const summary = summarizeOcrPage(
      record([word('a', 0, 0), word('b', 60, 0, 0.2), word('c', 120, 0, 0.1)], {
        corrections: [{ wordIndex: 1, original: 'b', corrected: 'B', correctedAt: 1 }],
      }),
    );
    expect(summary.words).toBe(3);
    expect(summary.lowConfidence).toBe(1);
    expect(summary.corrected).toBe(1);
    expect(summary.provider).toBe('test-provider');
    expect(summary.empty).toBe(false);
  });

  it('reports an empty page as empty rather than as a successful read', () => {
    const summary = summarizeOcrPage(record([]));
    expect(summary.empty).toBe(true);
    expect(summary.words).toBe(0);
  });
});
