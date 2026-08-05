import { describe, expect, it } from 'vitest';
import { pauseBeforeNextSentence } from '@/features/playback/pacing';

const inParagraph = (id: string) => ({ paragraphId: id, regionId: `r-${id}` });

describe('pauseBeforeNextSentence', () => {
  it('leaves a gap between two sentences of the same paragraph', () => {
    const wait = pauseBeforeNextSentence({
      finished: inParagraph('p1'),
      next: inParagraph('p1'),
      speed: 1,
    });
    expect(wait).toBeGreaterThan(0);
  });

  it('waits longer between paragraphs than within one', () => {
    const within = pauseBeforeNextSentence({
      finished: inParagraph('p1'),
      next: inParagraph('p1'),
      speed: 1,
    });
    const between = pauseBeforeNextSentence({
      finished: inParagraph('p1'),
      next: inParagraph('p2'),
      speed: 1,
    });
    // A heading is its own region, so this is also the heading-to-body gap —
    // the case a reader described as "doesn't indicate sentence ends".
    expect(between).toBeGreaterThan(within);
  });

  it('treats a new region as a paragraph break even if ids collide', () => {
    const wait = pauseBeforeNextSentence({
      finished: { paragraphId: 'p1', regionId: 'heading' },
      next: { paragraphId: 'p1', regionId: 'body' },
      speed: 1,
    });
    const within = pauseBeforeNextSentence({
      finished: inParagraph('p1'),
      next: inParagraph('p1'),
      speed: 1,
    });
    expect(wait).toBeGreaterThan(within);
  });

  it('shortens the pause as the reading speeds up', () => {
    const atOne = pauseBeforeNextSentence({
      finished: inParagraph('p1'),
      next: inParagraph('p2'),
      speed: 1,
    });
    const atTwo = pauseBeforeNextSentence({
      finished: inParagraph('p1'),
      next: inParagraph('p2'),
      speed: 2,
    });
    expect(atTwo).toBeLessThan(atOne);
    expect(atTwo).toBeGreaterThan(0);
  });

  it('never waits absurdly long at very slow speeds', () => {
    const wait = pauseBeforeNextSentence({
      finished: inParagraph('p1'),
      next: inParagraph('p2'),
      speed: 0.05,
    });
    expect(wait).toBeLessThanOrEqual(900);
  });

  it('survives a nonsense speed rather than returning NaN', () => {
    for (const speed of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const wait = pauseBeforeNextSentence({
        finished: inParagraph('p1'),
        next: inParagraph('p2'),
        speed,
      });
      expect(Number.isFinite(wait)).toBe(true);
      expect(wait).toBeGreaterThanOrEqual(0);
    }
  });

  it('does not pause at the end of the document', () => {
    expect(pauseBeforeNextSentence({ finished: inParagraph('p1'), next: null, speed: 1 })).toBe(0);
    expect(pauseBeforeNextSentence({ finished: null, next: inParagraph('p1'), speed: 1 })).toBe(0);
  });
});
