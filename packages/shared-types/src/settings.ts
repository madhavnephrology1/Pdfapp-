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

export interface AnnouncementSettings {
  /**
   * Speak the figure and drawn-area markers as well as showing them.
   *
   * These are the only words in the audio that the document does not contain,
   * which is why they are behind a switch that says so. With it off the markers
   * are still on screen, so someone reading loses nothing; with it on, someone
   * listening with the screen off learns that a picture was there at all, which
   * is otherwise indistinguishable from there being nothing to report.
   */
  speakFigureMarkers: boolean;
}

export interface DocumentSettings {
  readingMode: ReadingMode;
  categories: CategorySettings;
  citations: CitationSettings;
  reader: ReaderSettings;
  playback: PlaybackSettings;
  tables: TableSettings;
  announcements: AnnouncementSettings;
  /** Region id -> explicit user decision. Always wins over automatic rules. */
  regionOverrides: Record<string, 'include' | 'exclude'>;
  /**
   * The reader agreed to send images of scanned pages to the third-party
   * recognition service this deployment is configured with. Off until they say
   * otherwise, checked in the browser before a request is built, and enforced
   * again by the API so a client bug cannot bypass it.
   *
   * Consent to send images is not consent to send any particular page: each
   * page is still recognised only when the reader asks for that page.
   */
  ocrConsent: boolean;
  /**
   * Scale a page is rendered at before it is sent for recognition. Higher reads
   * small type more reliably and produces a larger request.
   */
  ocrRenderScale: number;
}
