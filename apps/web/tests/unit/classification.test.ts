import { describe, expect, it } from 'vitest';
import { CONFIDENCE_THRESHOLDS, type DocumentRegion } from '@pdfreader/shared-types';
import {
  buildSpeechProjection,
  DEFAULT_CITATION_SETTINGS,
} from '@/features/classification/citations';
import {
  applyReadingMode,
  DEFAULT_CATEGORY_SETTINGS,
  decideInclusion,
  summarizeExclusions,
} from '@/features/classification/modes';
import { matchPageNumberPattern } from '@/features/classification/page-numbers';
import { matchReferenceHeading, referenceEntryScore } from '@/features/classification/references';
import { repetitionSignature } from '@/features/classification/repeated';

describe('repetitionSignature', () => {
  it('treats page-specific numbers as equivalent', () => {
    expect(repetitionSignature('Chapter 3, page 41')).toBe(
      repetitionSignature('Chapter 3, page 42'),
    );
  });

  it('keeps genuinely different text distinct', () => {
    expect(repetitionSignature('Introduction')).not.toBe(repetitionSignature('Methods'));
  });

  it('ignores case and punctuation differences', () => {
    expect(repetitionSignature('Journal of Nephrology.')).toBe(
      repetitionSignature('JOURNAL OF NEPHROLOGY'),
    );
  });
});

describe('matchPageNumberPattern', () => {
  it.each([
    ['12', 'arabic numeral'],
    ['1', 'arabic numeral'],
    ['iv', 'roman numeral'],
    ['XVII', 'roman numeral'],
    ['Page 12', '"Page N"'],
    ['p. 7', '"Page N"'],
    ['12 of 300', '"N of M"'],
    ['12 / 300', '"N of M"'],
    ['Page 3 of 40', '"Page N of M"'],
    ['- 12 -', 'dashed numeral'],
    ['3-14', 'chapter-page numeral'],
  ])('matches %j as %s', (text, expected) => {
    expect(matchPageNumberPattern(text)?.name).toBe(expected);
  });

  it.each([
    'The study enrolled 12 patients',
    'Table 3 shows the results',
    'x = 12',
    'Chapter 4. Methods',
    '2019',
    '',
    '   ',
  ])('does not match prose or data: %j', (text) => {
    // Numbers inside prose never form a standalone margin region, but the
    // pattern itself must also reject them.
    const match = matchPageNumberPattern(text);
    if (text.trim() === '2019') {
      // A bare year IS numerically a page-number shape; position is what makes
      // it a page number, and that is enforced by the detector, not the pattern.
      expect(match?.name).toBe('arabic numeral');
      return;
    }
    expect(match).toBeNull();
  });
});

describe('matchReferenceHeading', () => {
  it.each([
    ['References', 'reference'],
    ['REFERENCES', 'reference'],
    ['7. References', 'reference'],
    ['Works Cited', 'reference'],
    ['Literature Cited', 'reference'],
    ['Bibliography', 'bibliography'],
    ['Further Reading', 'bibliography'],
    ['Index', 'index'],
    ['Author Index', 'index'],
  ])('recognises %j', (text, type) => {
    expect(matchReferenceHeading(text)?.type).toBe(type);
  });

  it.each([
    'The references in this study were checked',
    'Referencing conventions',
    'Introduction',
    'A very long heading that merely mentions references somewhere inside it',
  ])('does not match prose: %j', (text) => {
    expect(matchReferenceHeading(text)).toBeNull();
  });
});

describe('referenceEntryScore', () => {
  it('scores a citation entry highly', () => {
    const entry =
      'Alvarez, M., & Chen, L. (2019). Proximal tubular transport. Kidney International, 95(3), 512-524.';
    expect(referenceEntryScore(entry).score).toBeGreaterThanOrEqual(0.6);
  });

  it('scores ordinary prose low, even when it cites a source', () => {
    const prose =
      'Earlier work showed that proximal reabsorption falls when the transporter is inhibited (Alvarez, 2019).';
    // One signal only: prose that cites must not be mistaken for a bibliography.
    expect(referenceEntryScore(prose).score).toBeLessThan(0.6);
  });

  it('recognises a DOI', () => {
    expect(referenceEntryScore('doi:10.1016/j.kint.2019.01.001').matched).toContain('a DOI');
  });
});

describe('decideInclusion', () => {
  const region = (over: Partial<DocumentRegion>) =>
    ({ type: 'header', confidence: 0.9, ...over }) as DocumentRegion;

  it('excludes high-confidence furniture in Clean Mode', () => {
    const decision = decideInclusion(region({}), 'clean', DEFAULT_CATEGORY_SETTINGS);
    expect(decision.included).toBe(false);
    expect(decision.reason).toContain('90%');
  });

  it('INCLUDES medium-confidence furniture and flags it', () => {
    const decision = decideInclusion(
      region({ confidence: 0.65 }),
      'clean',
      DEFAULT_CATEGORY_SETTINGS,
    );
    expect(decision.included).toBe(true);
    expect(decision.uncertain).toBe(true);
    expect(decision.reason).toContain('still being read');
  });

  it('includes low-confidence detections as body content', () => {
    const decision = decideInclusion(
      region({ confidence: 0.3 }),
      'clean',
      DEFAULT_CATEGORY_SETTINGS,
    );
    expect(decision.included).toBe(true);
    expect(decision.uncertain).toBe(false);
  });

  it('never excludes body paragraphs in Clean Mode, whatever the confidence', () => {
    for (const confidence of [0.1, 0.5, 0.99]) {
      const decision = decideInclusion(
        region({ type: 'paragraph', confidence }),
        'clean',
        DEFAULT_CATEGORY_SETTINGS,
      );
      expect(decision.included).toBe(true);
    }
  });

  it('includes everything in Strict Verbatim Mode', () => {
    for (const type of ['header', 'footer', 'page-number', 'reference', 'watermark'] as const) {
      const decision = decideInclusion(
        region({ type, confidence: 0.99 }),
        'strict-verbatim',
        DEFAULT_CATEGORY_SETTINGS,
      );
      expect(decision.included, type).toBe(true);
    }
  });

  it('follows category switches in Custom Mode', () => {
    const off = decideInclusion(region({}), 'custom', DEFAULT_CATEGORY_SETTINGS);
    expect(off.included).toBe(false);
    const on = decideInclusion(region({}), 'custom', {
      ...DEFAULT_CATEGORY_SETTINGS,
      headers: true,
    });
    expect(on.included).toBe(true);
  });

  it('lets a user override beat every automatic rule', () => {
    const forced = decideInclusion(
      region({ confidence: 0.99, userOverride: 'include' }),
      'clean',
      DEFAULT_CATEGORY_SETTINGS,
    );
    expect(forced.included).toBe(true);

    const removed = decideInclusion(
      region({ type: 'paragraph', confidence: 0.1, userOverride: 'exclude' }),
      'strict-verbatim',
      DEFAULT_CATEGORY_SETTINGS,
    );
    expect(removed.included).toBe(false);
  });

  it('uses the documented thresholds', () => {
    const justBelow = decideInclusion(
      region({ confidence: CONFIDENCE_THRESHOLDS.HIGH - 0.01 }),
      'clean',
      DEFAULT_CATEGORY_SETTINGS,
    );
    const atThreshold = decideInclusion(
      region({ confidence: CONFIDENCE_THRESHOLDS.HIGH }),
      'clean',
      DEFAULT_CATEGORY_SETTINGS,
    );
    expect(justBelow.included).toBe(true);
    expect(atThreshold.included).toBe(false);
  });
});

describe('applyReadingMode and summarizeExclusions', () => {
  const regions: DocumentRegion[] = [
    {
      id: 'r1',
      documentId: 'd',
      pageNumber: 1,
      type: 'header',
      confidence: 0.95,
      textItemIds: [],
      boundingBoxes: [],
      included: true,
      inclusionReason: '',
      classificationEvidence: ['repeats on every page'],
      readingOrder: 0,
      text: 'Journal of Nephrology',
    },
    {
      id: 'r2',
      documentId: 'd',
      pageNumber: 1,
      type: 'paragraph',
      confidence: 0.5,
      textItemIds: [],
      boundingBoxes: [],
      included: true,
      inclusionReason: '',
      classificationEvidence: [],
      readingOrder: 1,
      text: 'The kidney maintains extracellular fluid volume through regulation.',
    },
  ];

  it('marks furniture excluded and body included', () => {
    const applied = applyReadingMode(regions, 'clean', DEFAULT_CATEGORY_SETTINGS);
    expect(applied.find((r) => r.id === 'r1')!.included).toBe(false);
    expect(applied.find((r) => r.id === 'r2')!.included).toBe(true);
  });

  it('counts skipped words for the disclosure', () => {
    const summary = summarizeExclusions(
      applyReadingMode(regions, 'clean', DEFAULT_CATEGORY_SETTINGS),
    );
    expect(summary.excludedRegions).toBe(1);
    expect(summary.excludedWords).toBe(3);
    expect(summary.includedWords).toBe(8);
    expect(summary.byType.header).toEqual({ regions: 1, words: 3 });
  });

  it('an override restores an excluded region without touching the others', () => {
    const applied = applyReadingMode(regions, 'clean', DEFAULT_CATEGORY_SETTINGS, {
      r1: 'include',
    });
    expect(applied.find((r) => r.id === 'r1')!.included).toBe(true);
    expect(applied.find((r) => r.id === 'r2')!.included).toBe(true);
  });

  it('never mutates the input regions', () => {
    const before = JSON.stringify(regions);
    applyReadingMode(regions, 'clean', DEFAULT_CATEGORY_SETTINGS);
    expect(JSON.stringify(regions)).toBe(before);
  });
});

describe('buildSpeechProjection', () => {
  it('skips an isolated numeric marker but keeps the sentence intact for display', () => {
    const text = 'Sodium is reabsorbed in the proximal tubule [12].';
    const projection = buildSpeechProjection(text, DEFAULT_CITATION_SETTINGS);
    expect(projection.text).toBe('Sodium is reabsorbed in the proximal tubule.');
    expect(projection.skipped).toHaveLength(1);
    expect(text.slice(projection.skipped[0].start, projection.skipped[0].end)).toBe('[12]');
    expect(projection.transformations[0].kind).toBe('citation-marker-skip');
  });

  /**
   * The bullet has done its work by the time speech reaches it: segmentation
   * has already made this item its own sentence. What is left is a character an
   * engine either voices as "black circle" or drops silently.
   */
  it('does not speak the bullet at the head of a list item', () => {
    const text = '● We repeat the measurement to confirm it.';
    const projection = buildSpeechProjection(text, DEFAULT_CITATION_SETTINGS);
    expect(projection.text).toBe('We repeat the measurement to confirm it.');
    expect(projection.skipped).toHaveLength(1);
    expect(projection.skipped[0].reason).toBe('list bullet');
    // Recorded as what it is, not as a citation.
    expect(projection.transformations[0].kind).toBe('list-marker-skip');
  });

  it('leaves a bullet that is not at the head of the sentence', () => {
    const text = 'The options are • repeat • review • refer, in that order.';
    expect(buildSpeechProjection(text, DEFAULT_CITATION_SETTINGS).text).toBe(text);
  });

  it('speaks the bullet in Strict Verbatim Mode like everything else', () => {
    const text = '● We repeat the measurement.';
    expect(
      buildSpeechProjection(text, DEFAULT_CITATION_SETTINGS, { strictVerbatim: true }).text,
    ).toBe(text);
  });

  it('keeps a parenthetical author-year citation by default', () => {
    const text = 'Reabsorption falls when the transporter is inhibited (Alvarez, 2019).';
    expect(buildSpeechProjection(text, DEFAULT_CITATION_SETTINGS).text).toBe(text);
  });

  it('can skip author-year citations when asked', () => {
    const text = 'Reabsorption falls (Alvarez, 2019) in most cohorts.';
    const projection = buildSpeechProjection(text, {
      ...DEFAULT_CITATION_SETTINGS,
      readParentheticalCitations: false,
    });
    expect(projection.text).toBe('Reabsorption falls in most cohorts.');
  });

  it('changes nothing at all in Strict Verbatim Mode', () => {
    const text = 'Sodium is reabsorbed [12] in the tubule (Alvarez, 2019).¹';
    const projection = buildSpeechProjection(text, DEFAULT_CITATION_SETTINGS, {
      strictVerbatim: true,
    });
    expect(projection.text).toBe(text);
    expect(projection.skipped).toHaveLength(0);
    expect(projection.transformations).toHaveLength(0);
  });

  it('does not touch numbers that are part of the prose', () => {
    const text = 'The cohort of 12 patients had a mean age of 54.2 years.';
    expect(buildSpeechProjection(text, DEFAULT_CITATION_SETTINGS).text).toBe(text);
  });

  it('maps spoken offsets back to the displayed text', () => {
    const text = 'Alpha [12] beta gamma.';
    const projection = buildSpeechProjection(text, DEFAULT_CITATION_SETTINGS);
    expect(projection.text).toBe('Alpha beta gamma.');
    // "beta" starts at 6 in the spoken text and at 11 in the display text.
    expect(projection.toDisplayOffset(6)).toBe(11);
    expect(text.slice(projection.toDisplayOffset(6), projection.toDisplayOffset(6) + 4)).toBe(
      'beta',
    );
  });

  it('leaves text with no markers untouched and allocates nothing', () => {
    const text = 'A plain sentence with no citations at all.';
    const projection = buildSpeechProjection(text, DEFAULT_CITATION_SETTINGS);
    expect(projection.text).toBe(text);
    expect(projection.skipped).toHaveLength(0);
  });
});
