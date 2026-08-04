import { describe, expect, it } from 'vitest';
import type { SentenceRecord } from '@pdfreader/shared-types';
import { remapSentence } from '@/features/playback/resume';

const sentence = (
  id: string,
  text: string,
  pageNumber: number,
  documentIndex: number,
): SentenceRecord => ({
  id,
  documentId: 'd',
  pageNumber,
  regionId: `${id}-region`,
  paragraphId: `${id}-para`,
  text,
  normalizedStart: 0,
  normalizedEnd: text.length,
  sourceTextItemIds: [],
  boundingBoxes: [],
  inclusionStatus: 'included',
  transformations: [],
  documentIndex,
});

describe('remapping the reading position across a rebuilt queue', () => {
  const before = [
    sentence('d:p1:r0:para0:s0', 'The kidney maintains extracellular fluid volume.', 1, 0),
    sentence('d:p1:r1:para0:s0', 'Filtration begins at the glomerulus.', 1, 1),
    sentence('d:p2:r0:para0:s0', 'Reabsorption occurs along the proximal tubule.', 2, 2),
  ];

  it('finds the sentence again when its id is unchanged', () => {
    expect(remapSentence('d:p1:r1:para0:s0', before, before)).toEqual({ index: 1, exact: true });
  });

  it('finds the same passage when a later pass changed its id', () => {
    // Block indices shift when a wider view of the document changes the
    // estimated body font size, so the very same sentence gets a new id.
    const after = [
      sentence('d:p1:r0:para0:s0', 'The kidney maintains extracellular fluid volume.', 1, 0),
      sentence('d:p1:r4:para0:s0', 'Filtration begins at the glomerulus.', 1, 1),
      sentence('d:p2:r0:para0:s0', 'Reabsorption occurs along the proximal tubule.', 2, 2),
    ];
    expect(remapSentence('d:p1:r1:para0:s0', before, after)).toEqual({ index: 1, exact: true });
  });

  it('ignores whitespace differences when matching the text', () => {
    const after = [sentence('x', 'Filtration begins   at the\nglomerulus.', 1, 0)];
    expect(remapSentence('d:p1:r1:para0:s0', before, after)).toEqual({ index: 0, exact: true });
  });

  it('does not match identical text on a different page', () => {
    const after = [sentence('x', 'Filtration begins at the glomerulus.', 9, 0)];
    const match = remapSentence('d:p1:r1:para0:s0', before, after);
    expect(match?.exact).toBe(false);
  });

  it('falls back to the nearest following sentence, and says it is not exact', () => {
    // The passage was recognised as a running header on a later pass and is no
    // longer read, so there is no sentence to return — only a place.
    const after = [
      sentence('d:p1:r0:para0:s0', 'The kidney maintains extracellular fluid volume.', 1, 0),
      sentence('d:p2:r0:para0:s0', 'Reabsorption occurs along the proximal tubule.', 2, 1),
    ];
    expect(remapSentence('d:p1:r1:para0:s0', before, after)).toEqual({ index: 1, exact: false });
  });

  it('points at the last sentence when everything after the position is gone', () => {
    const after = [sentence('a', 'Something else entirely.', 1, 0)];
    expect(remapSentence('d:p2:r0:para0:s0', before, after)).toEqual({ index: 0, exact: false });
  });

  it('returns nothing to point at when there is no queue or no position', () => {
    expect(remapSentence('d:p1:r1:para0:s0', before, [])).toBeNull();
    expect(remapSentence(null, before, before)).toBeNull();
  });

  it('returns nothing when the previous sentence is unknown', () => {
    // Without the old record there is no page or index to reason from, so the
    // caller starts at the beginning rather than guessing.
    expect(remapSentence('never-seen', [], before)).toBeNull();
  });
});
