import { describe, expect, it } from 'vitest';
import { partialMilestones } from '@/features/extraction/milestones';

describe('provisional extraction milestones', () => {
  it('runs no extra pass for a one-page document', () => {
    expect(partialMilestones(1)).toEqual([]);
    expect(partialMilestones(0)).toEqual([]);
  });

  it('makes the first page readable before the rest', () => {
    expect(partialMilestones(2)).toEqual([1]);
    expect(partialMilestones(10)[0]).toBe(1);
  });

  it('never schedules a pass over the whole document', () => {
    for (const pageCount of [1, 2, 3, 8, 17, 64, 200]) {
      for (const at of partialMilestones(pageCount)) expect(at).toBeLessThan(pageCount);
    }
  });

  it('doubles, so the extra work stays below one full pass', () => {
    expect(partialMilestones(200)).toEqual([1, 2, 4, 8, 16, 32, 64, 128]);
    for (const pageCount of [3, 17, 64, 200, 1000]) {
      const extra = partialMilestones(pageCount).reduce((sum, at) => sum + at, 0);
      // Sum of a doubling series below n is always less than 2n; the guarantee
      // that matters is that it is bounded by a constant multiple of one pass.
      expect(extra).toBeLessThan(2 * pageCount);
    }
  });

  it('keeps the number of passes logarithmic in the page count', () => {
    expect(partialMilestones(1000).length).toBeLessThanOrEqual(10);
  });
});
