import type { DocumentSettings } from '@pdfreader/shared-types';
import { DEFAULT_CATEGORY_SETTINGS } from '@/features/classification/modes';
import { DEFAULT_CITATION_SETTINGS } from '@/features/classification/citations';
import { DEFAULT_OCR_RENDER_SCALE } from '@/features/ocr/render';

export const DEFAULT_SETTINGS: DocumentSettings = {
  readingMode: 'clean',
  categories: { ...DEFAULT_CATEGORY_SETTINGS },
  citations: { ...DEFAULT_CITATION_SETTINGS },
  reader: {
    fontSizePx: 19,
    lineHeight: 1.7,
    textWidthCh: 68,
    theme: 'system',
    focusMode: false,
  },
  playback: {
    voiceId: null,
    provider: 'browser',
    speed: 1,
    volume: 1,
  },
  tables: { mode: 'skip' },
  // On by default. The markers exist so a picture is not passed over in
  // silence, and someone listening with the screen off is exactly the person
  // that silence fails.
  announcements: { speakFigureMarkers: true },
  regionOverrides: {},
  ocrConsent: false,
  ocrRenderScale: DEFAULT_OCR_RENDER_SCALE,
};

export const OCR_RENDER_SCALE_OPTIONS = [1, 1.5, 2, 3];

export const FONT_SIZE_RANGE = { min: 14, max: 32, step: 1 };
export const LINE_HEIGHT_RANGE = { min: 1.3, max: 2.4, step: 0.1 };
export const TEXT_WIDTH_RANGE = { min: 40, max: 100, step: 2 };
export const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** Merges stored settings over the defaults, tolerating an older stored shape. */
export function mergeSettings(stored: Partial<DocumentSettings> | undefined): DocumentSettings {
  if (!stored) return { ...DEFAULT_SETTINGS };
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    categories: { ...DEFAULT_SETTINGS.categories, ...stored.categories },
    citations: { ...DEFAULT_SETTINGS.citations, ...stored.citations },
    reader: { ...DEFAULT_SETTINGS.reader, ...stored.reader },
    playback: { ...DEFAULT_SETTINGS.playback, ...stored.playback },
    tables: { ...DEFAULT_SETTINGS.tables, ...stored.tables },
    announcements: { ...DEFAULT_SETTINGS.announcements, ...stored.announcements },
    regionOverrides: { ...stored.regionOverrides },
  };
}
