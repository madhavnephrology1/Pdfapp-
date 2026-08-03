/**
 * Deterministic identifiers.
 *
 * Ids are derived from structural position rather than randomness so that
 * re-extracting the same document produces the same ids. That is what makes a
 * persisted reading position (which stores a sentence id) survive a reload.
 */

export const itemId = (documentId: string, page: number, sourceIndex: number): string =>
  `${documentId}:p${page}:i${sourceIndex}`;

export const lineId = (documentId: string, page: number, index: number): string =>
  `${documentId}:p${page}:l${index}`;

export const regionId = (documentId: string, page: number, index: number): string =>
  `${documentId}:p${page}:r${index}`;

export const paragraphId = (regionIdValue: string, index: number): string => `${regionIdValue}:para${index}`;

export const sentenceId = (paragraphIdValue: string, index: number): string => `${paragraphIdValue}:s${index}`;

export const chunkId = (documentId: string, index: number): string => `${documentId}:chunk${index}`;
