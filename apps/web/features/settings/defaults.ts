import type { DocumentSettings } from '@pdfreader/shared-types';
import { DEFAULT_CATEGORY_SETTINGS } from '@/features/classification/modes';
import { DEFAULT_CITATION_SETTINGS } from '@/features/classification/citations';

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
  equations: { mode: 'skip' },
  images: { readAltText: true, readCaptions: true, allowGeneratedDescriptions: false },
  regionOverrides: {},
  ocrConsent: false,
  ttsConsent: false,
};

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
    equations: { ...DEFAULT_SETTINGS.equations, ...stored.equations },
    images: { ...DEFAULT_SETTINGS.images, ...stored.images },
    regionOverrides: { ...stored.regionOverrides },
  };
}
