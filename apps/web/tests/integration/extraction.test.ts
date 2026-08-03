import { beforeAll, describe, expect, it } from 'vitest';
import {
  REPEATED_FOOTER_TEXT,
  REPEATED_HEADER_TEXT,
  fiftyPagePdf,
  frontMatterPdf,
  mixedScannedPdf,
  scannedPdf,
  singlePagePdf,
  tablePdf,
  realisticPaperPdf,
  twoColumnPaperPdf,
  typographyPdf,
} from '@pdfreader/test-fixtures';
import {
  applyReadingMode,
  DEFAULT_CATEGORY_SETTINGS,
  summarizeExclusions,
} from '@/features/classification/modes';
import type { ExtractionResult } from '@/features/extraction/pipeline';
import { extractFixture, spokenText } from '../helpers/extract-fixture';

const includedIds = (
  result: ExtractionResult,
  mode: 'clean' | 'strict-verbatim' | 'custom' = 'clean',
) =>
  new Set(
    applyReadingMode(result.regions, mode, DEFAULT_CATEGORY_SETTINGS)
      .filter((region) => region.included)
      .map((region) => region.id),
  );

describe('single-page extraction', () => {
  let result: ExtractionResult;
  beforeAll(async () => {
    result = await extractFixture(singlePagePdf());
  });

  it('records one page', () => {
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].likelyScanned).toBe(false);
    expect(result.pages[0].columnCount).toBe(1);
  });

  it('reconstructs paragraphs across wrapped lines', () => {
    const text = spokenText(result, includedIds(result));
    expect(text).toContain(
      'The kidney maintains extracellular fluid volume through a set of tightly coupled regulatory mechanisms.',
    );
  });

  it('joins a word split by a line-ending hyphen', () => {
    const text = spokenText(result, includedIds(result));
    expect(text).toContain('an ultrafiltrate of plasma');
    expect(text).not.toContain('ultra- filtrate');
  });

  it('detects the title as a heading', () => {
    const headings = result.regions.filter((region) => region.type === 'heading');
    expect(headings.map((h) => h.text)).toContain('Renal Physiology Overview');
  });

  it('maps every sentence back to source items and bounding boxes', () => {
    expect(result.sentences.length).toBeGreaterThan(3);
    for (const sentence of result.sentences) {
      expect(sentence.sourceTextItemIds.length).toBeGreaterThan(0);
      expect(sentence.boundingBoxes.length).toBeGreaterThan(0);
      for (const box of sentence.boundingBoxes) {
        expect(box.pageNumber).toBe(sentence.pageNumber);
        expect(box.width).toBeGreaterThan(0);
      }
    }
  });

  it('only ever speaks text that exists in the source items', () => {
    const source = result.rawItems
      .map((item) => item.text)
      .join(' ')
      .replace(/\s+/g, ' ');
    for (const sentence of result.sentences) {
      // Every word of every sentence must appear in the raw text layer.
      for (const word of sentence.text.split(/\s+/).filter(Boolean)) {
        const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        if (bare.length < 3) continue;
        // Hyphen-joined words are split across two raw items by construction.
        if (bare === 'ultrafiltrate') continue;
        expect(source, `word "${bare}" is not in the PDF text layer`).toContain(bare);
      }
    }
  });

  it('excludes nothing on a page with no document furniture', () => {
    const applied = applyReadingMode(result.regions, 'clean', DEFAULT_CATEGORY_SETTINGS);
    expect(applied.every((region) => region.included)).toBe(true);
  });
});

describe('repeated header and footer detection', () => {
  let result: ExtractionResult;
  beforeAll(async () => {
    result = await extractFixture(fiftyPagePdf(50));
  }, 120_000);

  it('extracts all 50 pages', () => {
    expect(result.pages).toHaveLength(50);
  });

  it('classifies the running header', () => {
    const headers = result.regions.filter((region) => region.type === 'header');
    expect(headers.length).toBeGreaterThanOrEqual(45);
    expect(headers[0].text).toContain(REPEATED_HEADER_TEXT);
    expect(headers[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('classifies the running footer', () => {
    const footers = result.regions.filter((region) => region.type === 'footer');
    expect(footers.length).toBeGreaterThanOrEqual(45);
    expect(footers[0].text).toContain('Downloaded from example.org');
  });

  it('classifies standalone page numbers', () => {
    const pageNumbers = result.regions.filter((region) => region.type === 'page-number');
    expect(pageNumbers.length).toBeGreaterThanOrEqual(45);
    expect(pageNumbers.every((region) => /^\d+$/.test(region.text))).toBe(true);
  });

  it('records evidence for every automatic exclusion', () => {
    const applied = applyReadingMode(result.regions, 'clean', DEFAULT_CATEGORY_SETTINGS);
    for (const region of applied.filter((r) => !r.included)) {
      expect(region.classificationEvidence.length).toBeGreaterThan(0);
      expect(region.inclusionReason).not.toBe('');
    }
  });

  it('keeps furniture out of Clean Mode but reads it in Strict Verbatim Mode', () => {
    const clean = spokenText(result, includedIds(result, 'clean'));
    expect(clean).not.toContain(REPEATED_HEADER_TEXT);
    expect(clean).not.toContain(REPEATED_FOOTER_TEXT);
    expect(clean).toContain('Patients in cohort 1 demonstrated');

    const strict = spokenText(result, includedIds(result, 'strict-verbatim'));
    expect(strict).toContain(REPEATED_HEADER_TEXT);
    expect(strict).toContain(REPEATED_FOOTER_TEXT);
  });

  it('never removes numbers that occur inside body prose', () => {
    const clean = spokenText(result, includedIds(result, 'clean'));
    expect(clean).toContain('cohort 12');
    expect(clean).toContain('twelve month observation window');
  });
});

describe('two-column paper', () => {
  let result: ExtractionResult;
  beforeAll(async () => {
    result = await extractFixture(twoColumnPaperPdf());
  });

  it('detects two columns on the body page', () => {
    expect(result.pages[0].columnCount).toBe(2);
  });

  it('does not merge lines across the column gutter', () => {
    const text = result.regions.map((region) => region.text).join(' ');
    expect(text).toContain(
      'Sodium handling in the proximal tubule is mediated primarily by the sodium-hydrogen exchanger.',
    );
    // The left column's first line must not run into the right column's.
    expect(text).not.toContain('primarily by Distal delivery');
    expect(text).not.toContain('exchanger. when proximal');
  });

  it('reads the left column fully before the right column', () => {
    const text = spokenText(result, includedIds(result));
    const left = text.indexOf('Inhibition of this transporter');
    const right = text.indexOf('Distal delivery of sodium rises');
    expect(left).toBeGreaterThan(-1);
    expect(right).toBeGreaterThan(-1);
    expect(left).toBeLessThan(right);
  });

  it('places the full-width heading before both columns', () => {
    const text = spokenText(result, includedIds(result));
    const heading = text.indexOf('Tubular Sodium Transport and Feedback Regulation in the Nephron');
    const body = text.indexOf('Sodium handling in the proximal tubule');
    expect(heading).toBeGreaterThan(-1);
    expect(heading).toBeLessThan(body);
  });

  it('classifies the small-font bottom-of-page block as a footnote', () => {
    const footnotes = result.regions.filter((region) => region.type === 'footnote');
    expect(footnotes.length).toBeGreaterThan(0);
    expect(footnotes.map((f) => f.text).join(' ')).toContain('Corresponding author');
  });

  it('classifies the reference section from its heading', () => {
    const references = result.regions.filter(
      (region) => region.type === 'reference' || region.type === 'bibliography',
    );
    expect(references.length).toBeGreaterThan(1);
    expect(references.some((r) => r.text.toLowerCase() === 'references')).toBe(true);
    expect(references.some((r) => r.text.includes('Kidney International'))).toBe(true);
  });

  it('skips the bibliography in Clean Mode and reads it in Strict Verbatim Mode', () => {
    const clean = spokenText(result, includedIds(result, 'clean'));
    expect(clean).not.toContain('Kidney International');
    expect(clean).toContain('Sodium handling in the proximal tubule');

    const strict = spokenText(result, includedIds(result, 'strict-verbatim'));
    expect(strict).toContain('Kidney International');
  });

  it('does not classify body prose as a reference just because it cites work', () => {
    const bodyRegion = result.regions.find((region) =>
      region.text.startsWith('Sodium handling in the proximal tubule'),
    );
    expect(bodyRegion).toBeDefined();
    expect(bodyRegion!.type).toBe('paragraph');
  });
});

describe('typography handling', () => {
  let result: ExtractionResult;
  beforeAll(async () => {
    result = await extractFixture(typographyPdf());
  });

  it('removes a duplicated overlapping text layer', () => {
    expect(result.removedDuplicates.length).toBe(1);
    expect(result.removedDuplicates[0].text).toBe('Efficient workflow benefits.');
    const text = result.regions.map((r) => r.text).join(' ');
    expect(text.match(/Efficient workflow benefits/g)).toHaveLength(1);
  });

  it('joins the hyphenated word across lines', () => {
    const text = result.regions.map((r) => r.text).join(' ');
    expect(text).toContain('filtration barrier restricts albumin');
  });
});

describe('tables', () => {
  let result: ExtractionResult;
  beforeAll(async () => {
    result = await extractFixture(tablePdf());
  });

  it('detects the table as its own region', () => {
    const tables = result.regions.filter((region) => region.type === 'table');
    expect(tables).toHaveLength(1);
    expect(result.tableRows.get(tables[0].id)!.length).toBeGreaterThanOrEqual(3);
  });

  it('detects the caption', () => {
    const captions = result.regions.filter((region) => region.type === 'caption');
    expect(captions.map((c) => c.text).join(' ')).toContain('Table 1.');
  });

  it('skips the table by default but keeps the surrounding prose', () => {
    const text = spokenText(result, includedIds(result, 'custom'));
    expect(text).toContain('Baseline characteristics are summarized below.');
    expect(text).toContain('The groups were well matched at baseline.');
    expect(text).not.toContain('0.41');
  });
});

describe('scanned pages', () => {
  it('flags an image-only page as likely scanned', async () => {
    const result = await extractFixture(scannedPdf());
    expect(result.pages[0].likelyScanned).toBe(true);
    expect(result.pages[0].textLayerCharCount).toBe(0);
    expect(result.sentences).toHaveLength(0);
  });

  it('flags only the scanned page of a mixed document', async () => {
    const result = await extractFixture(mixedScannedPdf());
    expect(result.pages[0].likelyScanned).toBe(false);
    expect(result.pages[1].likelyScanned).toBe(true);
    expect(result.sentences.length).toBeGreaterThan(0);
  });
});

describe('front matter', () => {
  it('annotates roman-numeral pages as front matter', async () => {
    const result = await extractFixture(frontMatterPdf());
    const preface = result.regions.find((region) => region.text.startsWith('This volume collects'));
    expect(preface).toBeDefined();
    expect(preface!.classificationEvidence.join(' ')).toContain('front matter');
  });

  it('detects roman numerals as page numbers', async () => {
    const result = await extractFixture(frontMatterPdf());
    const pageNumbers = result.regions.filter((region) => region.type === 'page-number');
    expect(pageNumbers.map((p) => p.text)).toEqual(expect.arrayContaining(['i', 'ii', 'iii']));
  });
});

describe('conditions created by real PDF producers', () => {
  let result: ExtractionResult;
  beforeAll(async () => {
    result = await extractFixture(realisticPaperPdf());
  });

  it('detects headings that are only 1.1x body size and share the body font', () => {
    // Real PDFs embed subset fonts whose names carry no "Bold", so size and
    // structure are the only signals available.
    const headings = result.regions.filter((region) => region.type === 'heading');
    const titles = headings.map((h) => h.text);
    for (const expected of ['1. Introduction', '2. Methods', '3. Results', '4. Discussion']) {
      expect(titles, `missing heading ${expected}`).toContain(expected);
    }
  });

  it('does not mistake a numbered heading for a list item', () => {
    const intro = result.regions.find((region) => region.text === '1. Introduction');
    expect(intro).toBeDefined();
    expect(intro!.type).toBe('heading');
  });

  it('finds the column gutter even though a centred byline crosses it', () => {
    expect(result.pages[0].columnCount).toBe(2);
  });

  it('reads each column in order rather than straight across the page', () => {
    const text = spokenText(result, includedIds(result));
    const methods = text.indexOf('Micropuncture was performed');
    const results = text.indexOf('Fractional excretion of sodium');
    expect(methods).toBeGreaterThan(-1);
    expect(results).toBeGreaterThan(-1);
    expect(methods).toBeLessThan(results);
  });

  it('contains the reference section instead of swallowing the rest of the document', () => {
    const discussion = result.regions.find((region) =>
      region.text.startsWith('These findings are consistent'),
    );
    expect(discussion).toBeDefined();
    expect(discussion!.type).not.toBe('reference');

    const text = spokenText(result, includedIds(result));
    expect(text).toContain('These findings are consistent with earlier reports');
    expect(text).toContain('Proximal transport determines');
  });

  it('separates a page number from a footer on a different baseline', () => {
    const pageNumbers = result.regions.filter((region) => region.type === 'page-number');
    expect(pageNumbers.map((p) => p.text)).toEqual(expect.arrayContaining(['1 of 2', '2 of 2']));
    const footers = result.regions.filter((region) => region.type === 'footer');
    expect(footers.every((f) => !f.text.includes('of 2'))).toBe(true);
  });

  it('reads the overwhelming majority of the body text', () => {
    // The regression this guards: a runaway reference section once dropped
    // nearly 90% of a document's words without saying so.
    const applied = applyReadingMode(result.regions, 'clean', DEFAULT_CATEGORY_SETTINGS);
    const summary = summarizeExclusions(applied);
    const skippedShare = summary.excludedWords / (summary.includedWords + summary.excludedWords);
    expect(skippedShare).toBeLessThan(0.35);
  });
});
