'use client';

import { useMemo, useState } from 'react';
import type { ReadingMode } from '@pdfreader/shared-types';
import { summarizeExclusions } from '@/features/classification/modes';
import { useDocumentStore } from '@/stores/document-store';
import { usePlaybackStore } from '@/stores/playback-store';
import styles from './LeftPanel.module.css';

const MODES: { value: ReadingMode; label: string; description: string }[] = [
  {
    value: 'clean',
    label: 'Clean Reading',
    description:
      'Reads the body text and skips only high-confidence running headers, footers, page numbers and reference lists.',
  },
  {
    value: 'strict-verbatim',
    label: 'Strict Verbatim',
    description:
      'Reads everything that could be extracted, including headers, footers, footnotes and references, with only technical normalisation.',
  },
  {
    value: 'custom',
    label: 'Custom',
    description: 'Choose exactly which kinds of content are read.',
  },
];

export function LeftPanel({ onOpenReview }: { onOpenReview: () => void }) {
  const {
    fileName,
    fileSize,
    pages,
    outline,
    progress,
    settings,
    queue,
    setSettings,
    currentPage,
    setCurrentPage,
    sentences,
  } = useDocumentStore();
  const seekToSentence = usePlaybackStore((state) => state.seekToSentence);
  const chunkStates = usePlaybackStore((state) => state.chunkStates);
  const chunks = usePlaybackStore((state) => state.chunks);

  const [search, setSearch] = useState('');

  const summary = useMemo(() => summarizeExclusions(queue.regions), [queue.regions]);

  const audioReady = useMemo(
    () => Object.values(chunkStates).filter((state) => state.status === 'ready').length,
    [chunkStates],
  );

  const searchResults = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (term.length < 3) return [];
    return sentences.filter((sentence) => sentence.text.toLowerCase().includes(term)).slice(0, 40);
  }, [search, sentences]);

  const scannedPages = pages.filter((page) => page.likelyScanned);
  const uncertainPages = pages.filter((page) => page.readingOrderUncertain);

  return (
    <nav className={styles.panel} aria-label="Document navigation">
      <section className={styles.section}>
        <h2 className={styles.docTitle} title={fileName}>
          {fileName || 'No document'}
        </h2>
        <p className={styles.meta}>
          {pages.length} page{pages.length === 1 ? '' : 's'} · {(fileSize / 1_048_576).toFixed(1)}{' '}
          MB
        </p>

        <div className={styles.progressBlock} aria-live="polite">
          <ProgressRow
            label="Text extraction"
            value={progress.pagesTotal > 0 ? progress.pagesExtracted / progress.pagesTotal : 0}
            caption={
              progress.phase === 'done'
                ? `${progress.pagesExtracted} pages extracted`
                : `${progress.phase}… ${progress.pagesExtracted}/${progress.pagesTotal || '?'}`
            }
          />
          <ProgressRow
            label="Audio generated"
            value={chunks.length > 0 ? audioReady / chunks.length : 0}
            caption={
              chunks.length === 0
                ? 'Not started'
                : `${audioReady} of ${chunks.length} passages ready`
            }
          />
        </div>

        {progress.failedPages.length > 0 && (
          <p className={styles.warning}>
            {progress.failedPages.length} page(s) could not be read:{' '}
            {progress.failedPages.map((page) => page.pageNumber).join(', ')}. Their text is missing
            rather than guessed at.
          </p>
        )}
        {scannedPages.length > 0 && (
          <p className={styles.warning}>
            {scannedPages.length} page(s) appear to be scans with no text layer. There is nothing to
            read on them and no text has been invented.
          </p>
        )}
        {uncertainPages.length > 0 && (
          <p className={styles.warning}>
            Reading order is uncertain on {uncertainPages.length} page(s):{' '}
            {uncertainPages
              .slice(0, 6)
              .map((page) => page.pageNumber)
              .join(', ')}
            {uncertainPages.length > 6 ? '…' : ''}. Check them in Content Review.
          </p>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Reading mode</h3>
        <div role="radiogroup" aria-label="Reading mode" className={styles.modes}>
          {MODES.map((mode) => (
            <label key={mode.value} className={styles.modeOption}>
              <input
                type="radio"
                name="reading-mode"
                value={mode.value}
                checked={settings.readingMode === mode.value}
                onChange={() => setSettings({ readingMode: mode.value })}
              />
              <span>
                <strong>{mode.label}</strong>
                <span className={styles.modeDescription}>{mode.description}</span>
              </span>
            </label>
          ))}
        </div>

        <div className={styles.exclusionSummary}>
          <p>
            <strong>{summary.includedWords.toLocaleString()}</strong> words will be read.{' '}
            {summary.excludedWords > 0 ? (
              <>
                <strong>{summary.excludedWords.toLocaleString()}</strong> words in{' '}
                {summary.excludedRegions} region(s) are being skipped.
              </>
            ) : (
              'Nothing is being skipped.'
            )}
          </p>
          <button type="button" className="btn btn-sm" onClick={onOpenReview}>
            Review what is skipped
          </button>
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Search</h3>
        <label className="sr-only" htmlFor="doc-search">
          Search the reading text
        </label>
        <input
          id="doc-search"
          type="search"
          className={styles.search}
          placeholder="Find in document…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {search.trim().length >= 3 && (
          <p className={styles.searchCount} aria-live="polite">
            {searchResults.length} match{searchResults.length === 1 ? '' : 'es'}
            {searchResults.length === 40 ? ' (showing the first 40)' : ''}
          </p>
        )}
        <ul className={styles.results}>
          {searchResults.map((sentence) => (
            <li key={sentence.id}>
              <button
                type="button"
                className={styles.resultButton}
                onClick={() => void seekToSentence(sentence.id)}
              >
                <span className={styles.resultPage}>p.{sentence.pageNumber}</span>
                <span className={styles.resultText}>{sentence.text.trim().slice(0, 110)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {outline.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Sections</h3>
          <ul className={styles.outline}>
            {outline.map((node) => (
              <li key={node.id} data-level={node.level}>
                <button
                  type="button"
                  className={styles.outlineButton}
                  onClick={() => {
                    setCurrentPage(node.pageNumber);
                    const first = sentences.find((sentence) => sentence.regionId === node.regionId);
                    if (first) void seekToSentence(first.id);
                  }}
                >
                  <span className={styles.outlineTitle}>{node.title}</span>
                  <span className={styles.outlinePage}>{node.pageNumber}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Pages</h3>
        <div className={styles.pageGrid}>
          {pages.map((page) => (
            <button
              key={page.pageNumber}
              type="button"
              className={`${styles.pageButton} ${
                page.pageNumber === currentPage ? styles.pageButtonActive : ''
              }`}
              onClick={() => setCurrentPage(page.pageNumber)}
              aria-current={page.pageNumber === currentPage ? 'page' : undefined}
              title={
                page.likelyScanned
                  ? `Page ${page.pageNumber} — appears to be a scan with no text layer`
                  : `Page ${page.pageNumber}`
              }
            >
              {page.pageNumber}
              {page.likelyScanned && <span className={styles.scanDot} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </section>
    </nav>
  );
}

function ProgressRow({ label, value, caption }: { label: string; value: number; caption: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={styles.progressRow}>
      <div className={styles.progressLabel}>
        <span>{label}</span>
        <span>{percent}%</span>
      </div>
      <div
        className={styles.progressTrack}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className={styles.progressFill} style={{ width: `${percent}%` }} />
      </div>
      <p className={styles.progressCaption}>{caption}</p>
    </div>
  );
}
