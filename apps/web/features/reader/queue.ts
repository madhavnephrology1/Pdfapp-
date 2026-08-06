import type { DocumentRegion, DocumentSettings, SentenceRecord } from '@pdfreader/shared-types';
import { buildSpeechProjection, type SkippedSpan } from '@/features/classification/citations';
import { applyReadingMode } from '@/features/classification/modes';
import type { QueueItem } from '@/features/playback/chunking';
import { markerSpeech, type PageMarker } from './markers';

/**
 * Builds the reading queue from the document and the current settings.
 *
 * This is the single place where "what gets read" is decided, and it is a pure
 * function of (regions, sentences, settings). Changing a setting rebuilds the
 * queue; it never touches the extraction data, so every exclusion is reversible
 * by flipping the setting back.
 */

export interface ReadingQueueEntry extends QueueItem {
  /** Spans of the displayed sentence that the audio skips, for the strikethrough. */
  skipped: SkippedSpan[];
  regionType: DocumentRegion['type'];
  /**
   * Set when this entry is the application speaking rather than the document.
   *
   * The only entries this is set on are the figure and drawn-area markers, and
   * it exists so nothing downstream can mistake them for source text: they
   * carry no source item ids because they have no source, and the panel marks
   * them as added words wherever they are shown. They do count toward
   * `totalCharacters`, because they are synthesized like anything else.
   */
  announcement?: PageMarker;
}

export interface ReadingQueue {
  entries: ReadingQueueEntry[];
  regions: DocumentRegion[];
  /** Regions the current mode excludes, for the Content Review panel. */
  excludedRegions: DocumentRegion[];
  /** Included regions whose classification was uncertain. */
  uncertainRegions: DocumentRegion[];
  totalCharacters: number;
}

/**
 * Applies the footnote reading preference.
 *
 * `skip` drops footnote regions from the audio. `after-page` and `after-section`
 * move them to the end of their page or section, so a footnote no longer
 * interrupts the sentence that referenced it. Ordering is stable, so the
 * relative order of footnotes and of body text is preserved within each group.
 *
 * This only ever REORDERS or omits whole footnote regions. It never edits a
 * sentence, and the reader panel still shows footnotes where they sit on the page.
 */
export function applyFootnoteOrdering(
  entries: ReadingQueueEntry[],
  mode: DocumentSettings['citations']['footnoteReading'],
): ReadingQueueEntry[] {
  const isFootnote = (entry: ReadingQueueEntry): boolean => entry.regionType === 'footnote';

  if (mode === 'skip') return entries.filter((entry) => !isFootnote(entry));
  if (!entries.some(isFootnote)) return entries;

  // Group key: the page, or the index of the most recent heading.
  const keys: number[] = [];
  let section = 0;
  for (const entry of entries) {
    if (mode === 'after-section' && entry.regionType === 'heading') section += 1;
    keys.push(mode === 'after-page' ? entry.sentence.pageNumber : section);
  }

  const groups = new Map<number, { body: ReadingQueueEntry[]; notes: ReadingQueueEntry[] }>();
  const order: number[] = [];
  entries.forEach((entry, index) => {
    const key = keys[index];
    let group = groups.get(key);
    if (!group) {
      group = { body: [], notes: [] };
      groups.set(key, group);
      order.push(key);
    }
    (isFootnote(entry) ? group.notes : group.body).push(entry);
  });

  return order.flatMap((key) => {
    const group = groups.get(key)!;
    return [...group.body, ...group.notes];
  });
}

/**
 * Builds the synthetic sentence an announcement is carried by.
 *
 * The queue is a list of sentences, and an announcement has to travel through
 * it, so it needs the same shape. Every field that would assert provenance is
 * left empty: no source text item ids, no bounding boxes, a zero-width span in
 * the normalized text, and no transformations. The `announcement` field on the
 * entry is what tells everything downstream that these words came from the
 * application rather than the document.
 *
 * Two fields deliberately do NOT stay empty. The paragraph and region are the
 * ones the marker was placed on, because they are position rather than
 * provenance: with them blank, "restart this paragraph" pressed while a marker
 * was being read jumped to the first marker in the document instead of back to
 * the passage the listener was in.
 *
 * `documentIndex` stays at -1 so that resuming after a reload never lands on an
 * announcement — the fallback looks for the first sentence at or after the old
 * position, and -1 is never at or after it. A reader comes back to the
 * document's own words.
 */
function announcementSentence(marker: PageMarker, host: SentenceRecord): SentenceRecord {
  return {
    id: marker.id,
    documentId: host.documentId,
    pageNumber: marker.pageNumber,
    regionId: host.regionId,
    paragraphId: host.paragraphId,
    text: markerSpeech(marker),
    normalizedStart: 0,
    normalizedEnd: 0,
    sourceTextItemIds: [],
    boundingBoxes: [],
    inclusionStatus: 'included',
    transformations: [],
    documentIndex: -1,
  };
}

export function buildReadingQueue(
  regions: DocumentRegion[],
  sentences: SentenceRecord[],
  settings: DocumentSettings,
  markers?: Map<string, PageMarker[]>,
): ReadingQueue {
  const applied = applyReadingMode(
    regions,
    settings.readingMode,
    settings.categories,
    settings.regionOverrides,
  );
  const byId = new Map(applied.map((region) => [region.id, region]));
  const strictVerbatim = settings.readingMode === 'strict-verbatim';

  const entries: ReadingQueueEntry[] = [];

  // Announcements are placed before the first sentence of the paragraph they
  // were attached to, and only when that paragraph actually reaches the audio.
  // A marker on a paragraph the current mode skips is not announced, so the
  // audio never mentions a page the listener is not being read.
  const speakMarkers = settings.announcements.speakFigureMarkers && markers && markers.size > 0;
  const announced = new Set<string>();

  for (const sentence of sentences) {
    const region = byId.get(sentence.regionId);
    if (!region || !region.included) continue;

    // Tables are their own regions; reading one as a stream of numbers is
    // meaningless, so the default is to skip them. Strict Verbatim Mode reads
    // everything extractable, so the preference does not apply there.
    if (!strictVerbatim && region.type === 'table' && settings.tables.mode === 'skip') continue;

    const projection = buildSpeechProjection(sentence.text, settings.citations, {
      strictVerbatim,
      sourceTextItemIds: sentence.sourceTextItemIds,
      markerSpans: sentence.markerSpans,
    });

    if (projection.text.trim() === '') continue;

    if (speakMarkers && !announced.has(sentence.paragraphId)) {
      announced.add(sentence.paragraphId);
      for (const marker of markers.get(sentence.paragraphId) ?? []) {
        entries.push({
          sentence: announcementSentence(marker, sentence),
          speechText: markerSpeech(marker),
          skipped: [],
          regionType: region.type,
          announcement: marker,
        });
      }
    }

    entries.push({
      sentence,
      speechText: projection.text,
      skipped: projection.skipped,
      regionType: region.type,
    });
  }

  // Strict Verbatim Mode reads everything in document order, so the footnote
  // preference does not apply there.
  const ordered = strictVerbatim
    ? entries
    : applyFootnoteOrdering(entries, settings.citations.footnoteReading);
  const totalCharacters = ordered.reduce((sum, entry) => sum + entry.speechText.length, 0);

  return {
    entries: ordered,
    regions: applied,
    excludedRegions: applied.filter((region) => !region.included),
    uncertainRegions: applied.filter(
      (region) =>
        region.included &&
        !region.userOverride &&
        region.confidence >= 0.5 &&
        region.confidence < 0.8 &&
        region.type !== 'paragraph' &&
        region.type !== 'heading',
    ),
    totalCharacters,
  };
}

/** Sentences grouped into paragraphs for the reader panel, in reading order. */
export interface ReaderParagraph {
  paragraphId: string;
  regionId: string;
  regionType: DocumentRegion['type'];
  pageNumber: number;
  included: boolean;
  /** True when the region was included but its classification was uncertain. */
  uncertain: boolean;
  sentences: {
    sentence: SentenceRecord;
    skipped: SkippedSpan[];
    spoken: boolean;
  }[];
}

export function buildReaderParagraphs(
  regions: DocumentRegion[],
  sentences: SentenceRecord[],
  settings: DocumentSettings,
  queue: ReadingQueue,
): ReaderParagraph[] {
  const byId = new Map(queue.regions.map((region) => [region.id, region]));
  const spokenIds = new Set(queue.entries.map((entry) => entry.sentence.id));
  const skippedById = new Map(queue.entries.map((entry) => [entry.sentence.id, entry.skipped]));
  const uncertainIds = new Set(queue.uncertainRegions.map((region) => region.id));

  const paragraphs = new Map<string, ReaderParagraph>();
  for (const sentence of sentences) {
    const region = byId.get(sentence.regionId);
    if (!region) continue;

    let paragraph = paragraphs.get(sentence.paragraphId);
    if (!paragraph) {
      paragraph = {
        paragraphId: sentence.paragraphId,
        regionId: region.id,
        regionType: region.type,
        pageNumber: sentence.pageNumber,
        included: region.included,
        uncertain: uncertainIds.has(region.id),
        sentences: [],
      };
      paragraphs.set(sentence.paragraphId, paragraph);
    }
    paragraph.sentences.push({
      sentence,
      skipped: skippedById.get(sentence.id) ?? [],
      spoken: spokenIds.has(sentence.id),
    });
  }

  return [...paragraphs.values()];
}
