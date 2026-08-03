import { beforeAll, describe, expect, it } from 'vitest';
import { REPEATED_HEADER_TEXT, fiftyPagePdf } from '@pdfreader/test-fixtures';
import { applyReadingMode, DEFAULT_CATEGORY_SETTINGS } from '@/features/classification/modes';
import { partialMilestones } from '@/features/extraction/milestones';
import {
  extractDocument,
  type ExtractionResult,
  type PageExtractionInput,
} from '@/features/extraction/pipeline';
import { readPageInputs } from '../helpers/extract-fixture';

/**
 * Reading before the whole document has been analysed.
 *
 * The worker runs the pipeline over a growing prefix so audio can start after
 * the first page. That is only acceptable if a provisional pass obeys the same
 * rules as the final one: it may read MORE than the final pass will, because it
 * has less evidence for excluding anything, but it must never speak text that
 * is not in the document, and it must never quietly become the final answer.
 */

const clean = (result: ExtractionResult) =>
  applyReadingMode(result.regions, 'clean', DEFAULT_CATEGORY_SETTINGS);

const spoken = (result: ExtractionResult): string => {
  const included = new Set(
    clean(result)
      .filter((region) => region.included)
      .map((region) => region.id),
  );
  return result.sentences
    .filter((sentence) => included.has(sentence.regionId))
    .map((sentence) => sentence.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

describe('provisional extraction over a growing prefix', () => {
  let pageInputs: PageExtractionInput[];
  let full: ExtractionResult;

  beforeAll(async () => {
    pageInputs = await readPageInputs(fiftyPagePdf());
    full = extractDocument('doc', pageInputs);
  }, 60_000);

  it('produces readable text from the first page alone', () => {
    const firstPage = extractDocument('doc', pageInputs.slice(0, 1));
    expect(firstPage.pages).toHaveLength(1);
    expect(spoken(firstPage).length).toBeGreaterThan(0);
  });

  it('never speaks text that is not in the document', () => {
    // The strongest guarantee available: every sentence a provisional pass
    // would read is present, verbatim, in the text extracted from the whole
    // document. Nothing is generated, completed or reconstructed.
    const wholeDocument = normalize(full.normalizedText);
    for (const at of partialMilestones(pageInputs.length)) {
      const prefix = extractDocument('doc', pageInputs.slice(0, at));
      for (const sentence of prefix.sentences) {
        expect(wholeDocument).toContain(normalize(sentence.text));
      }
    }
  });

  it('reads the running header until enough pages have been seen to recognise it', () => {
    // This is the honest cost of starting early, and the reason the interface
    // labels a partial pass as provisional rather than presenting it as final.
    const firstPage = extractDocument('doc', pageInputs.slice(0, 1));
    expect(spoken(firstPage)).toContain(REPEATED_HEADER_TEXT);
    expect(spoken(full)).not.toContain(REPEATED_HEADER_TEXT);
  });

  it('errs towards reading more, never towards silently dropping subject matter', () => {
    const excludedWords = (result: ExtractionResult): number =>
      clean(result)
        .filter((region) => !region.included)
        .reduce((sum, region) => sum + region.text.split(/\s+/).filter(Boolean).length, 0);

    const perPage = (result: ExtractionResult): number =>
      excludedWords(result) / Math.max(1, result.pages.length);

    // With one page there is no repetition to detect, so almost nothing can be
    // excluded; a fuller view finds more furniture per page, not less.
    expect(perPage(extractDocument('doc', pageInputs.slice(0, 1)))).toBeLessThan(perPage(full));
  });

  it('gives the same final result whether or not provisional passes ran', () => {
    // The pipeline must be pure over the pages it is given. If a provisional
    // pass could leave state behind, the document a reader ends up with would
    // depend on how fast their machine happened to be.
    for (const at of partialMilestones(pageInputs.length)) {
      extractDocument('doc', pageInputs.slice(0, at));
    }
    const again = extractDocument('doc', pageInputs);
    expect(again.sentences.map((sentence) => sentence.id)).toEqual(
      full.sentences.map((sentence) => sentence.id),
    );
    expect(again.normalizedText).toBe(full.normalizedText);
  });

  it('covers every page once the final pass has run', () => {
    expect(full.pages.map((page) => page.pageNumber)).toEqual(
      pageInputs.map((page) => page.pageNumber),
    );
  });
});
