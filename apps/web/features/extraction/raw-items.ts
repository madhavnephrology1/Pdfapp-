import type { RawTextItem } from '@pdfreader/shared-types';
import { itemId } from '@/lib/ids';

/** The subset of PDF.js's TextItem this pipeline consumes. */
export interface PdfTextItemLike {
  str: string;
  dir?: string;
  width: number;
  height: number;
  transform: number[];
  fontName?: string;
  hasEOL?: boolean;
}

function toDirection(dir: string | undefined): RawTextItem['direction'] {
  if (dir === 'rtl') return 'rtl';
  if (dir === 'ttb') return 'ttb';
  return 'ltr';
}

/**
 * Converts PDF.js text items into RawTextItem records.
 *
 * The `text` field is the VERBATIM string from the text layer. Normalization
 * happens later and never overwrites this value.
 */
export function toRawTextItems(
  items: PdfTextItemLike[],
  documentId: string,
  pageNumber: number,
): RawTextItem[] {
  const raw: RawTextItem[] = [];
  items.forEach((item, index) => {
    if (typeof item.str !== 'string') return;
    const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
    // The vertical scale of the text matrix is the rendered font size.
    const fontSize = Math.hypot(transform[1] ?? 0, transform[3] ?? 0) || item.height || 0;
    raw.push({
      id: itemId(documentId, pageNumber, index),
      documentId,
      pageNumber,
      text: item.str,
      transform: [...transform],
      x: transform[4] ?? 0,
      y: transform[5] ?? 0,
      width: item.width ?? 0,
      height: item.height ?? fontSize,
      fontName: item.fontName,
      fontSize,
      direction: toDirection(item.dir),
      hasEOL: item.hasEOL,
      sourceIndex: index,
    });
  });
  return raw;
}

/**
 * Removes duplicate overlapping text-layer content.
 *
 * Some producers draw the same string twice at a sub-point offset to fake bold,
 * or stack an OCR layer on top of a native one. Reading it twice is a fidelity
 * bug, so exact-text items at effectively identical positions collapse to one.
 *
 * Deliberately strict: the text must match EXACTLY and the positions must be
 * within `tolerance` points. Near-duplicates are kept, because discarding
 * genuinely distinct text would silently drop subject matter.
 */
export function removeDuplicateItems(
  items: RawTextItem[],
  tolerance = 1.0,
): { items: RawTextItem[]; removed: RawTextItem[] } {
  const kept: RawTextItem[] = [];
  const removed: RawTextItem[] = [];

  for (const item of items) {
    if (item.text.trim() === '') {
      kept.push(item);
      continue;
    }
    const duplicate = kept.find(
      (other) =>
        other.text === item.text &&
        Math.abs(other.x - item.x) <= tolerance &&
        Math.abs(other.y - item.y) <= tolerance &&
        Math.abs((other.fontSize ?? 0) - (item.fontSize ?? 0)) <= 0.5,
    );
    if (duplicate) removed.push(item);
    else kept.push(item);
  }

  return { items: kept, removed };
}
