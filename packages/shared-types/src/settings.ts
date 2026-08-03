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
  /**
   * 'skip' is the default, because a table read as a flat stream of numbers is
   * meaningless. 'read-in-row-order' reads the table's own cell text, row by
   * row, verbatim and with no generated labels.
   */
  mode: 'skip' | 'read-in-row-order';
}

export interface DocumentSettings {
  readingMode: ReadingMode;
  categories: CategorySettings;
  citations: CitationSettings;
  reader: ReaderSettings;
  playback: PlaybackSettings;
  tables: TableSettings;
  /** Region id -> explicit user decision. Always wins over automatic rules. */
  regionOverrides: Record<string, 'include' | 'exclude'>;
  /**
   * User consented to sending page images to a third-party OCR provider.
   * The API enforces this flag; the browser has no OCR flow yet, so nothing
   * sets it today. See LIMITATIONS.md.
   */
  ocrConsent: boolean;
}
