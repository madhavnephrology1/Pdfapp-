import type { PageBlocks } from './repeated';
import type { OrderedBlock } from './references';
import { matchPageNumberPattern } from './page-numbers';

/**
 * Front-matter detection.
 *
 * Front matter is a Custom Mode CATEGORY, not an automatic exclusion: Clean Mode
 * reads it. This detector only annotates regions so the user can switch the
 * category off deliberately.
 *
 * Signals: roman-numeral page numbering, and conventional front-matter headings
 * appearing before the first arabic-numbered page.
 */

const FRONT_MATTER_HEADINGS =
  /^(preface|foreword|contents|table of contents|acknowledge?ments?|dedication|copyright|about the authors?|list of (figures|tables|abbreviations)|abstract|title page)\s*:?$/i;

const ROMAN = /^[ivxlcdm]{1,7}$/i;

/** Returns blockId -> reason for every region judged to be front matter. */
export function detectFrontMatter(
  ordered: OrderedBlock[],
  pages: PageBlocks[],
): Map<string, string> {
  const result = new Map<string, string>();
  if (pages.length === 0) return result;

  // Pages whose standalone page number is a roman numeral.
  const romanPages = new Set<number>();
  const arabicPages = new Set<number>();
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.lines.length !== 1) continue;
      const text = block.lines[0].text.trim();
      if (!matchPageNumberPattern(text)) continue;
      const bottom = block.boundingBox.y;
      const top = bottom + block.boundingBox.height;
      const inMargin = bottom >= page.pageHeight * 0.9 || top <= page.pageHeight * 0.1;
      if (!inMargin) continue;
      if (ROMAN.test(text)) romanPages.add(page.pageNumber);
      else if (/^\d+$/.test(text)) arabicPages.add(page.pageNumber);
    }
  }

  const firstArabicPage = arabicPages.size > 0 ? Math.min(...arabicPages) : null;

  for (const entry of ordered) {
    const text = entry.block.lines
      .map((line) => line.text)
      .join(' ')
      .trim();
    const reasons: string[] = [];

    if (romanPages.has(entry.pageNumber)) {
      reasons.push(`page ${entry.pageNumber} is numbered with a roman numeral`);
    }
    if (FRONT_MATTER_HEADINGS.test(text)) {
      reasons.push(`the region is a conventional front-matter heading ("${text}")`);
    }
    if (firstArabicPage !== null && entry.pageNumber < firstArabicPage && reasons.length > 0) {
      reasons.push(`it precedes page ${firstArabicPage}, the first arabic-numbered page`);
    }

    if (reasons.length > 0)
      result.set(entry.block.id, `front matter because ${reasons.join(' and ')}`);
  }

  // Propagate the heading's judgement to the rest of its page, so a "Contents"
  // page is treated as one unit.
  const frontMatterPages = new Set(
    ordered.filter((entry) => result.has(entry.block.id)).map((entry) => entry.pageNumber),
  );
  for (const entry of ordered) {
    if (result.has(entry.block.id)) continue;
    if (frontMatterPages.has(entry.pageNumber)) {
      result.set(
        entry.block.id,
        `on page ${entry.pageNumber}, which was identified as front matter`,
      );
    }
  }

  return result;
}
