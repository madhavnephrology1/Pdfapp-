import {
  CONFIDENCE_THRESHOLDS,
  type CategorySettings,
  type ContentCategory,
  type DocumentRegion,
  type ReadingMode,
  type RegionType,
} from '@pdfreader/shared-types';

/** Maps a detected region type to the user-facing category it belongs to. */
export const REGION_CATEGORY: Partial<Record<RegionType, ContentCategory>> = {
  header: 'headers',
  footer: 'footers',
  'page-number': 'page-numbers',
  footnote: 'footnotes',
  endnote: 'endnotes',
  caption: 'captions',
  table: 'tables',
  reference: 'references',
  bibliography: 'bibliography',
  index: 'index',
  sidebar: 'sidebars',
};

/** Region types Clean Mode may exclude automatically, and only at high confidence. */
export const CLEAN_MODE_EXCLUDABLE: RegionType[] = [
  'header',
  'footer',
  'page-number',
  'watermark',
  'reference',
  'bibliography',
  'index',
];

export const DEFAULT_CATEGORY_SETTINGS: CategorySettings = {
  'front-matter': true,
  headers: false,
  footers: false,
  'page-numbers': false,
  footnotes: true,
  endnotes: true,
  captions: true,
  tables: false,
  'citation-markers': false,
  references: false,
  bibliography: false,
  index: false,
  sidebars: true,
};

export interface InclusionDecision {
  included: boolean;
  reason: string;
  /** True when the region is included but the classifier was unsure. */
  uncertain: boolean;
}

/**
 * Decides whether a region is read, for one reading mode.
 *
 * Guarantees:
 *   - Strict Verbatim Mode includes everything extractable.
 *   - Clean Mode excludes only high-confidence furniture from a fixed list.
 *   - Medium-confidence detections stay INCLUDED and are flagged for review.
 *   - A user override always wins.
 */
export function decideInclusion(
  region: Pick<DocumentRegion, 'type' | 'confidence' | 'userOverride'>,
  mode: ReadingMode,
  categories: CategorySettings,
): InclusionDecision {
  if (region.userOverride === 'include') {
    return {
      included: true,
      reason: 'You chose to include this region.',
      uncertain: false,
    };
  }
  if (region.userOverride === 'exclude') {
    return {
      included: false,
      reason: 'You chose to exclude this region.',
      uncertain: false,
    };
  }

  if (mode === 'strict-verbatim') {
    return {
      included: true,
      reason:
        'Strict Verbatim Mode reads all extractable text, including headers, footers and references.',
      uncertain: false,
    };
  }

  const category = REGION_CATEGORY[region.type];
  const percent = Math.round(region.confidence * 100);

  if (mode === 'custom') {
    if (!category) {
      return {
        included: true,
        reason: 'Body content is always read in Custom Mode.',
        uncertain: false,
      };
    }
    const enabled = categories[category];
    return {
      included: enabled,
      reason: enabled
        ? `Custom Mode: the "${category}" category is switched on.`
        : `Custom Mode: the "${category}" category is switched off.`,
      uncertain: false,
    };
  }

  // Clean Mode.
  if (!CLEAN_MODE_EXCLUDABLE.includes(region.type)) {
    return {
      included: true,
      reason: `Classified as ${region.type}, which Clean Mode always reads.`,
      uncertain: region.confidence < CONFIDENCE_THRESHOLDS.MEDIUM,
    };
  }

  if (region.confidence >= CONFIDENCE_THRESHOLDS.HIGH) {
    return {
      included: false,
      reason: `Detected as ${region.type} with ${percent}% confidence, above the ${Math.round(
        CONFIDENCE_THRESHOLDS.HIGH * 100,
      )}% threshold for automatic exclusion. You can restore it at any time.`,
      uncertain: false,
    };
  }

  if (region.confidence >= CONFIDENCE_THRESHOLDS.MEDIUM) {
    return {
      included: true,
      reason: `Possibly ${region.type} (${percent}% confidence), which is below the automatic-exclusion threshold. It is still being read and has been flagged for your review.`,
      uncertain: true,
    };
  }

  return {
    included: true,
    reason: `Weak ${region.type} signal (${percent}% confidence). Treated as body content and read.`,
    uncertain: false,
  };
}

/** Applies inclusion rules to a whole document. Returns new region objects. */
export function applyReadingMode(
  regions: DocumentRegion[],
  mode: ReadingMode,
  categories: CategorySettings,
  overrides: Record<string, 'include' | 'exclude'> = {},
): DocumentRegion[] {
  return regions.map((region) => {
    const userOverride = overrides[region.id];
    const decision = decideInclusion({ ...region, userOverride }, mode, categories);
    return {
      ...region,
      userOverride,
      included: decision.included,
      inclusionReason: decision.reason,
    };
  });
}

/** Counts what a mode is skipping, for the "words skipped" disclosure. */
export function summarizeExclusions(regions: DocumentRegion[]): {
  includedRegions: number;
  excludedRegions: number;
  includedWords: number;
  excludedWords: number;
  byType: Record<string, { regions: number; words: number }>;
} {
  const byType: Record<string, { regions: number; words: number }> = {};
  let includedRegions = 0;
  let excludedRegions = 0;
  let includedWords = 0;
  let excludedWords = 0;

  for (const region of regions) {
    const words = region.text.trim() === '' ? 0 : region.text.trim().split(/\s+/).length;
    if (region.included) {
      includedRegions += 1;
      includedWords += words;
    } else {
      excludedRegions += 1;
      excludedWords += words;
      const bucket = byType[region.type] ?? { regions: 0, words: 0 };
      bucket.regions += 1;
      bucket.words += words;
      byType[region.type] = bucket;
    }
  }

  return {
    includedRegions,
    excludedRegions,
    includedWords,
    excludedWords,
    byType,
  };
}
