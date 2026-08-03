import type {
  DocumentRegion,
  DocumentSettings,
  SentenceRecord,
} from '@pdfreader/shared-types';
import { buildSpeechProjection, type SkippedSpan } from '@/features/classification/citations';
import { applyReadingMode } from '@/features/classification/modes';
import type { QueueItem } from '@/features/playback/chunking';

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

export function buildReadingQueue(
  regions: DocumentRegion[],
  sentences: SentenceRecord[],
  settings: DocumentSettings,
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
  let totalCharacters = 0;

  for (const sentence of sentences) {
    const region = byId.get(sentence.regionId);
    if (!region || !region.included) continue;

    // Tables are their own regions; reading one as a flat stream of numbers is
    // meaningless, so the default is to skip them entirely.
    if (region.type === 'table' && settings.tables.mode === 'skip') continue;

    const projection = buildSpeechProjection(sentence.text, settings.citations, {
      strictVerbatim,
      sourceTextItemIds: sentence.sourceTextItemIds,
    });

    if (projection.text.trim() === '') continue;

    entries.push({
      sentence,
      speechText: projection.text,
      skipped: projection.skipped,
      regionType: region.type,
    });
    totalCharacters += projection.text.length;
  }

  return {
    entries,
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
  sentences: { sentence: SentenceRecord; skipped: SkippedSpan[]; spoken: boolean }[];
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
