export * from './document';
export * from './tts';
export * from './ocr';
export * from './playback';
export * from './settings';

/**
 * Confidence thresholds that drive automatic exclusion.
 *
 * - >= HIGH   : automatically excluded in Clean Mode (still fully reversible)
 * - >= MEDIUM : INCLUDED but flagged for review
 * - <  MEDIUM : treated as body/unknown content and included
 *
 * Uncertain subject matter is never silently discarded.
 */
export const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.8,
  MEDIUM: 0.5,
} as const;
