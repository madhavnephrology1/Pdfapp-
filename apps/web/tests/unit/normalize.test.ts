import { describe, expect, it } from 'vitest';
import {
  isWordSplittingHyphen,
  joinWrappedLines,
  normalizeItemText,
} from '@/features/extraction/normalize';

describe('normalizeItemText', () => {
  it('expands ligatures to equivalent characters', () => {
    const result = normalizeItemText('Eﬃcient workﬂow', 'item-1');
    expect(result.text).toBe('Efficient workflow');
    expect(result.transformations.map((t) => t.kind)).toEqual(['ligature-expand', 'ligature-expand']);
    expect(result.transformations[0]).toMatchObject({ before: 'ﬃ', after: 'ffi' });
  });

  it('collapses runs of whitespace to a single space', () => {
    const result = normalizeItemText('a    b', 'item-1');
    expect(result.text).toBe('a b');
    expect(result.transformations[0]).toMatchObject({ kind: 'whitespace-collapse', after: ' ' });
  });

  it('normalizes non-breaking spaces without recording a content change', () => {
    const result = normalizeItemText('10 mg', 'item-1');
    expect(result.text).toBe('10 mg');
  });

  it('removes soft hyphens and zero-width characters', () => {
    const result = normalizeItemText('hy­phen​ated', 'item-1');
    expect(result.text).toBe('hyphenated');
    expect(result.transformations.some((t) => t.kind === 'soft-hyphen-removal')).toBe(true);
  });

  it('leaves ordinary prose completely untouched', () => {
    const source = 'The kidney maintains extracellular fluid volume.';
    const result = normalizeItemText(source, 'item-1');
    expect(result.text).toBe(source);
    expect(result.transformations).toHaveLength(0);
  });

  it('never corrects spelling or grammar', () => {
    const source = 'The kidnye maintian volume,and pressure';
    expect(normalizeItemText(source, 'item-1').text).toBe(source);
  });

  it('records the source item id on every transformation', () => {
    const result = normalizeItemText('a  b ﬁn', 'item-42');
    expect(result.transformations.length).toBeGreaterThan(0);
    for (const transformation of result.transformations) {
      expect(transformation.sourceTextItemIds).toEqual(['item-42']);
    }
  });
});

describe('isWordSplittingHyphen', () => {
  it('joins a word split across lines', () => {
    expect(isWordSplittingHyphen('the glomerular bar-', 'rier restricts')).toBe(true);
  });

  it('keeps a genuine compound hyphen when the next line is capitalised', () => {
    expect(isWordSplittingHyphen('anti-', 'Inflammatory agents')).toBe(false);
  });

  it('keeps a hyphen before a digit', () => {
    expect(isWordSplittingHyphen('COVID-', '19 infection')).toBe(false);
  });

  it('ignores a list leader dash', () => {
    expect(isWordSplittingHyphen('-', 'first item')).toBe(false);
  });

  it('requires a trailing hyphen', () => {
    expect(isWordSplittingHyphen('no hyphen here', 'continues')).toBe(false);
  });

  it('recognises the unicode hyphen characters', () => {
    expect(isWordSplittingHyphen('bar‐', 'rier')).toBe(true);
    expect(isWordSplittingHyphen('bar‑', 'rier')).toBe(true);
  });
});

describe('joinWrappedLines', () => {
  const line = (text: string, id: string) => ({ text, sourceTextItemIds: [id] });

  it('reconstructs a hyphenated word without a space', () => {
    const result = joinWrappedLines([line('The filtration bar-', 'a'), line('rier is selective.', 'b')]);
    expect(result.text).toBe('The filtration barrier is selective.');
    expect(result.transformations.map((t) => t.kind)).toEqual(['hyphen-join']);
    expect(result.transformations[0].sourceTextItemIds).toEqual(['a', 'b']);
  });

  it('joins ordinary wrapped lines with a single space', () => {
    const result = joinWrappedLines([line('Tubular reabsorption recovers', 'a'), line('filtered sodium.', 'b')]);
    expect(result.text).toBe('Tubular reabsorption recovers filtered sodium.');
    expect(result.transformations.map((t) => t.kind)).toEqual(['line-wrap-join']);
  });

  it('preserves a compound hyphen across a wrap', () => {
    const result = joinWrappedLines([line('a state-of-the-', 'a'), line('Art device', 'b')]);
    expect(result.text).toBe('a state-of-the- Art device');
  });

  it('returns a single line unchanged', () => {
    const result = joinWrappedLines([line('One line only.', 'a')]);
    expect(result.text).toBe('One line only.');
    expect(result.transformations).toHaveLength(0);
  });

  it('handles the empty case', () => {
    expect(joinWrappedLines([]).text).toBe('');
  });
});
