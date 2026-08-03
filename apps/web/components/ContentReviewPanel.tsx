'use client';

import { useMemo, useState } from 'react';
import type { DocumentRegion, RegionType } from '@pdfreader/shared-types';
import { REGION_CATEGORY, summarizeExclusions } from '@/features/classification/modes';
import { useDocumentStore } from '@/stores/document-store';
import { usePlaybackStore } from '@/stores/playback-store';
import styles from './ContentReviewPanel.module.css';

type Filter = 'all' | 'excluded' | 'uncertain' | 'included';

/**
 * Content Review.
 *
 * Every automatic decision is listed with the evidence that produced it and can
 * be reversed individually or by category. Nothing the classifier removed is
 * hidden: excluded regions appear here with their full text.
 */
export function ContentReviewPanel({ onClose }: { onClose: () => void }) {
  const { queue, settings, setRegionOverride, restoreAllExclusions, resetOverrides, setCategory, setCurrentPage } =
    useDocumentStore();
  const seekToSentence = usePlaybackStore((state) => state.seekToSentence);
  const sentences = useDocumentStore((state) => state.sentences);

  const [filter, setFilter] = useState<Filter>('excluded');
  const [expanded, setExpanded] = useState<string | null>(null);

  const summary = useMemo(() => summarizeExclusions(queue.regions), [queue.regions]);
  const uncertainIds = useMemo(
    () => new Set(queue.uncertainRegions.map((region) => region.id)),
    [queue.uncertainRegions],
  );

  const visible = useMemo(() => {
    switch (filter) {
      case 'excluded':
        return queue.regions.filter((region) => !region.included);
      case 'uncertain':
        return queue.uncertainRegions;
      case 'included':
        return queue.regions.filter((region) => region.included);
      default:
        return queue.regions;
    }
  }, [filter, queue]);

  const overrideCount = Object.keys(settings.regionOverrides).length;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Content review">
      <div className={styles.panel}>
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>Content review</h2>
            <p className={styles.subtitle}>
              {summary.excludedRegions} region{summary.excludedRegions === 1 ? '' : 's'} (
              {summary.excludedWords.toLocaleString()} words) are being skipped.{' '}
              {queue.uncertainRegions.length} are uncertain but still being read.
            </p>
          </div>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>

        <div className={styles.actions}>
          <button type="button" className="btn btn-sm btn-primary" onClick={restoreAllExclusions}>
            Restore everything that was skipped
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={resetOverrides}
            disabled={overrideCount === 0}
          >
            Reset my {overrideCount} override{overrideCount === 1 ? '' : 's'}
          </button>
        </div>

        {settings.readingMode === 'custom' && (
          <section className={styles.categories}>
            <h3 className={styles.sectionTitle}>Categories</h3>
            <div className={styles.categoryGrid}>
              {(Object.keys(settings.categories) as (keyof typeof settings.categories)[]).map(
                (category) => (
                  <label key={category} className={styles.categoryToggle}>
                    <input
                      type="checkbox"
                      checked={settings.categories[category]}
                      onChange={(event) => setCategory(category, event.target.checked)}
                    />
                    <span>{category.replace(/-/g, ' ')}</span>
                  </label>
                ),
              )}
            </div>
          </section>
        )}

        <div className={styles.filters} role="tablist" aria-label="Filter regions">
          {(
            [
              ['excluded', `Skipped (${summary.excludedRegions})`],
              ['uncertain', `Uncertain (${queue.uncertainRegions.length})`],
              ['included', `Being read (${summary.includedRegions})`],
              ['all', `All (${queue.regions.length})`],
            ] as [Filter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              className={`${styles.filterTab} ${filter === value ? styles.filterTabActive : ''}`}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <ul className={styles.list}>
          {visible.length === 0 && (
            <li className={styles.emptyState}>Nothing in this category.</li>
          )}
          {visible.map((region) => (
            <RegionRow
              key={region.id}
              region={region}
              uncertain={uncertainIds.has(region.id)}
              expanded={expanded === region.id}
              onToggleExpand={() => setExpanded(expanded === region.id ? null : region.id)}
              onOverride={(decision) => setRegionOverride(region.id, decision)}
              onOpenPage={() => {
                setCurrentPage(region.pageNumber);
                const first = sentences.find((sentence) => sentence.regionId === region.id);
                if (first && region.included) void seekToSentence(first.id);
              }}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

interface RegionRowProps {
  region: DocumentRegion;
  uncertain: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onOverride: (decision: 'include' | 'exclude' | null) => void;
  onOpenPage: () => void;
}

function RegionRow({ region, uncertain, expanded, onToggleExpand, onOverride, onOpenPage }: RegionRowProps) {
  const category = REGION_CATEGORY[region.type as RegionType];
  const words = region.text.trim() === '' ? 0 : region.text.trim().split(/\s+/).length;

  return (
    <li className={styles.row}>
      <div className={styles.rowHeader}>
        <div className={styles.rowMeta}>
          <span
            className={`badge ${
              region.included ? (uncertain ? 'badge-uncertain' : 'badge-included') : 'badge-excluded'
            }`}
          >
            {region.included ? (uncertain ? 'Uncertain' : 'Read') : 'Skipped'}
          </span>
          <span className={styles.regionType}>{region.type}</span>
          <span className={styles.confidence}>{Math.round(region.confidence * 100)}% confidence</span>
          <span className={styles.page}>page {region.pageNumber}</span>
          <span className={styles.words}>{words} words</span>
          {region.userOverride && <span className={styles.override}>your choice</span>}
          {region.orderUncertain && (
            <span className="badge badge-uncertain">reading order uncertain</span>
          )}
        </div>

        <div className={styles.rowActions}>
          <button type="button" className="btn btn-sm" onClick={onOpenPage}>
            Open page
          </button>
          {region.included ? (
            <button type="button" className="btn btn-sm" onClick={() => onOverride('exclude')}>
              Skip this
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => onOverride('include')}>
              Read this
            </button>
          )}
          {region.userOverride && (
            <button type="button" className="btn btn-sm" onClick={() => onOverride(null)}>
              Undo
            </button>
          )}
        </div>
      </div>

      <p className={styles.preview}>
        {region.text.trim().slice(0, 260) || <em>(no text)</em>}
        {region.text.trim().length > 260 && '…'}
      </p>

      <p className={styles.reason}>{region.inclusionReason}</p>

      <button type="button" className={styles.evidenceToggle} onClick={onToggleExpand}>
        {expanded ? 'Hide' : 'Show'} the evidence for this classification (
        {region.classificationEvidence.length})
      </button>

      {expanded && (
        <ul className={styles.evidence}>
          {region.classificationEvidence.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
          {category && <li>Custom Mode category: {category.replace(/-/g, ' ')}</li>}
        </ul>
      )}
    </li>
  );
}
