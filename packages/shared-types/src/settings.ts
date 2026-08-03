import type { CategorySettings, ReadingMode } from './document';

export type ReaderTheme = 'light' | 'dark' | 'sepia' | 'system';

export interface CitationSettings {
  /** Read inline parenthetical citations such as "(Smith, 2019)". */
  readParentheticalCitations: boolean;
  /** Skip isolated numeric markers such as "[12]" standing alone. */
  skipIsolatedNumericMarkers: boolean;
  /** Skip superscript citation markers. */
  skipSuperscriptMarkers: boolean;
  footnoteReading: 'after-page' | 'after-section' | 'skip';
  includeReferenceLists: boolean;
}

export interface ReaderSettings {
  fontSizePx: number;
  lineHeight: number;
  textWidthCh: number;
  theme: ReaderTheme;
  focusMode: boolean;
}

export interface PlaybackSettings {
  voiceId: string | null;
  provider: 'server' | 'browser';
  speed: number;
  volume: number;
}

export interface TableSettings {
  /** 'skip' is the default: a flattened table read as prose is meaningless. */
  mode: 'skip' | 'row-by-row';
}

export interface EquationSettings {
  mode: 'skip' | 'literal-source' | 'accessible-narration';
}

export interface ImageSettings {
  readAltText: boolean;
  readCaptions: boolean;
  /** Generated descriptions are opt-in, always labelled, never in strict mode. */
  allowGeneratedDescriptions: boolean;
}

export interface DocumentSettings {
  readingMode: ReadingMode;
  categories: CategorySettings;
  citations: CitationSettings;
  reader: ReaderSettings;
  playback: PlaybackSettings;
  tables: TableSettings;
  equations: EquationSettings;
  images: ImageSettings;
  /** Region id -> explicit user decision. Always wins over automatic rules. */
  regionOverrides: Record<string, 'include' | 'exclude'>;
  /** User consented to sending page images to a third-party OCR provider. */
  ocrConsent: boolean;
  /** User consented to sending extracted text to a third-party TTS provider. */
  ttsConsent: boolean;
}
