'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { OCRPageRecord, SentenceRecord } from '@pdfreader/shared-types';
import { splitWords } from '@/features/extraction/sentences';
import { remainingLowConfidenceIndexes } from '@/features/ocr/items';
import { isEstimatedTiming, timingSourceLabel } from '@/features/playback/timing';
import { buildReaderParagraphs, type ReaderParagraph } from '@/features/reader/queue';
import { useReducedMotion } from '@/hooks/use-theme';
import { useDocumentStore } from '@/stores/document-store';
import { usePlaybackStore } from '@/stores/playback-store';
import styles from './ReaderPanel.module.css';

/** Region types rendered as headings rather than body paragraphs. */
const HEADING_TYPES = new Set(['heading']);

export function ReaderPanel() {
  const { regions, sentences, settings, queue, ocrPages, analyzing, pagesAnalyzed, totalPages } =
    useDocumentStore();
  const activeSentenceId = usePlaybackStore((state) => state.activeSentenceId);
  const activeWordIndex = usePlaybackStore((state) => state.activeWordIndex);
  const wordTimingSource = usePlaybackStore((state) => state.wordTimingSource);
  const seekToSentence = usePlaybackStore((state) => state.seekToSentence);

  const reducedMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLElement>(null);

  const paragraphs = useMemo(
    () => buildReaderParagraphs(regions, sentences, settings, queue),
    [regions, sentences, settings, queue],
  );

  // Keep the spoken sentence in view without yanking the page around.
  useEffect(() => {
    const element = activeRef.current;
    if (!element || !containerRef.current) return;
    element.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'center',
      inline: 'nearest',
    });
  }, [activeSentenceId, reducedMotion]);

  const { reader } = settings;
  const estimated = isEstimatedTiming(wordTimingSource);

  // Recognised text must never be able to pass as the document's own text, so
  // the pages it came from are marked wherever their paragraphs are shown.
  const recognizedPages = useMemo(
    () =>
      new Map(
        Object.values(ocrPages)
          .filter((record) => record.accepted)
          .map((record) => [record.pageNumber, record]),
      ),
    [ocrPages],
  );

  if (paragraphs.length === 0) {
    // "Nothing to read" is a CONCLUSION, and it must not be stated before the
    // document has actually been read. While pages are still being analysed the
    // panel is empty because the answer is not in yet, which is a different
    // thing entirely and is said differently.
    if (analyzing) {
      return (
        <div className={styles.empty}>
          <p>Reading the document…</p>
          <p className="hint">
            {totalPages > 0
              ? `${pagesAnalyzed} of ${totalPages} pages analysed. Text appears here as soon as the first pages are ready.`
              : 'Text appears here as soon as the first pages are ready.'}
          </p>
        </div>
      );
    }

    return (
      <div className={styles.empty}>
        <p>No readable text was found in this document.</p>
        <p className="hint">
          If the pages are scans, there is no text layer to read. This reader will not guess at
          words it cannot extract.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <h2 className={styles.heading}>Reading text</h2>
        <p className={styles.timingNote}>
          {estimated ? (
            <>
              <span className="badge badge-estimated">Estimated</span>{' '}
              <span>{timingSourceLabel(wordTimingSource)}</span>
            </>
          ) : (
            <span>{timingSourceLabel(wordTimingSource)}</span>
          )}
        </p>
      </div>

      <div
        ref={containerRef}
        className={`${styles.scroll} ${reader.focusMode ? styles.focus : ''}`}
        id="reading-text"
      >
        <article
          className={styles.article}
          style={{
            fontSize: `${reader.fontSizePx}px`,
            lineHeight: reader.lineHeight,
            maxWidth: `${reader.textWidthCh}ch`,
          }}
        >
          {paragraphs.map((paragraph) => (
            <Paragraph
              key={paragraph.paragraphId}
              paragraph={paragraph}
              activeSentenceId={activeSentenceId}
              activeWordIndex={activeWordIndex}
              estimatedWordTiming={estimated}
              recognized={recognizedPages.get(paragraph.pageNumber) ?? null}
              activeRef={activeRef}
              onSelect={(id) => void seekToSentence(id)}
            />
          ))}
        </article>
      </div>
    </div>
  );
}

interface ParagraphProps {
  paragraph: ReaderParagraph;
  activeSentenceId: string | null;
  activeWordIndex: number | null;
  estimatedWordTiming: boolean;
  /** Set when this page's text was recognised from an image, not extracted. */
  recognized: OCRPageRecord | null;
  activeRef: React.RefObject<HTMLElement | null>;
  onSelect: (sentenceId: string) => void;
}

function Paragraph({
  paragraph,
  activeSentenceId,
  activeWordIndex,
  estimatedWordTiming,
  recognized,
  activeRef,
  onSelect,
}: ParagraphProps) {
  const isHeading = HEADING_TYPES.has(paragraph.regionType);
  const Tag = isHeading ? 'h3' : 'p';

  return (
    <div
      className={`${styles.block} ${paragraph.included ? '' : styles.excludedBlock}`}
      data-region-type={paragraph.regionType}
      data-page={paragraph.pageNumber}
      data-text-source={recognized ? 'ocr' : undefined}
    >
      {recognized && (
        <p className={styles.blockNotice}>
          <span className="badge badge-uncertain">Recognised</span> Read from an image of page{' '}
          {paragraph.pageNumber} by {recognized.result.provider}, not from the PDF&rsquo;s own text.
          {remainingLowConfidenceIndexes(recognized).length > 0 &&
            ` ${remainingLowConfidenceIndexes(recognized).length} word(s) on this page are still marked uncertain.`}
        </p>
      )}
      {!paragraph.included && (
        <p className={styles.blockNotice}>
          <span className="badge badge-excluded">Not read</span> Classified as{' '}
          {paragraph.regionType}. Shown here so nothing is hidden from you.
        </p>
      )}
      {paragraph.uncertain && paragraph.included && (
        <p className={styles.blockNotice}>
          <span className="badge badge-uncertain">Uncertain</span> This may be{' '}
          {paragraph.regionType}, but the signal was not strong enough to exclude it, so it is being
          read.
        </p>
      )}

      <Tag className={isHeading ? styles.headingText : styles.paragraphText}>
        {paragraph.sentences.map(({ sentence, skipped, spoken }) => (
          <Sentence
            key={sentence.id}
            sentence={sentence}
            skipped={skipped}
            spoken={spoken}
            active={sentence.id === activeSentenceId}
            activeWordIndex={activeWordIndex}
            estimatedWordTiming={estimatedWordTiming}
            activeRef={activeRef}
            onSelect={onSelect}
          />
        ))}
      </Tag>
    </div>
  );
}

interface SentenceProps {
  sentence: SentenceRecord;
  skipped: { start: number; end: number; reason: string }[];
  spoken: boolean;
  active: boolean;
  activeWordIndex: number | null;
  estimatedWordTiming: boolean;
  activeRef: React.RefObject<HTMLElement | null>;
  onSelect: (sentenceId: string) => void;
}

function Sentence({
  sentence,
  skipped,
  spoken,
  active,
  activeWordIndex,
  estimatedWordTiming,
  activeRef,
  onSelect,
}: SentenceProps) {
  // The full sentence is always displayed. Skipped citation markers are struck
  // through rather than removed, so the author's text is never altered on screen.
  const segments = useMemo(() => buildSegments(sentence.text, skipped), [sentence.text, skipped]);

  const className = [
    styles.sentence,
    active ? styles.activeSentence : '',
    spoken ? '' : styles.notSpoken,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      ref={active ? (activeRef as React.RefObject<HTMLSpanElement>) : undefined}
      className={className}
      data-sentence-id={sentence.id}
      role="button"
      tabIndex={spoken ? 0 : -1}
      aria-current={active ? 'true' : undefined}
      aria-label={spoken ? undefined : 'Not read aloud'}
      title={spoken ? 'Read from here' : 'This text is not being read aloud'}
      onClick={() => spoken && onSelect(sentence.id)}
      onKeyDown={(event) => {
        if (!spoken) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(sentence.id);
        }
      }}
    >
      {segments.map((segment, index) =>
        segment.skipped ? (
          <span
            key={index}
            className={styles.skippedMarker}
            title={`Not spoken: ${segment.reason ?? 'citation marker'}`}
          >
            {segment.text}
          </span>
        ) : active && activeWordIndex !== null ? (
          <WordHighlight
            key={index}
            text={segment.text}
            wordOffset={segment.wordOffset}
            activeWordIndex={activeWordIndex}
            estimated={estimatedWordTiming}
          />
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

function WordHighlight({
  text,
  wordOffset,
  activeWordIndex,
  estimated,
}: {
  text: string;
  wordOffset: number;
  activeWordIndex: number;
  estimated: boolean;
}) {
  const words = splitWords(text);
  if (words.length === 0) return <span>{text}</span>;

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  words.forEach((word, index) => {
    if (word.start > cursor) nodes.push(text.slice(cursor, word.start));
    const isActive = wordOffset + index === activeWordIndex;
    nodes.push(
      isActive ? (
        <mark
          key={`w${index}`}
          className={`${styles.word} ${estimated ? styles.wordEstimated : ''}`}
          // Announced so a screen-reader user is told the position is an estimate.
          aria-label={estimated ? `${word.text}, estimated position` : undefined}
        >
          {word.text}
        </mark>
      ) : (
        <span key={`w${index}`}>{word.text}</span>
      ),
    );
    cursor = word.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));

  return <>{nodes}</>;
}

interface Segment {
  text: string;
  skipped: boolean;
  reason?: string;
  /** Index of this segment's first word within the whole sentence. */
  wordOffset: number;
}

/** Splits a sentence into spoken and skipped segments, preserving every character. */
function buildSegments(
  text: string,
  skipped: { start: number; end: number; reason: string }[],
): Segment[] {
  if (skipped.length === 0) return [{ text, skipped: false, wordOffset: 0 }];

  const ordered = [...skipped].sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  let cursor = 0;
  let wordOffset = 0;

  for (const span of ordered) {
    if (span.start > cursor) {
      const chunk = text.slice(cursor, span.start);
      segments.push({ text: chunk, skipped: false, wordOffset });
      wordOffset += splitWords(chunk).length;
    }
    segments.push({
      text: text.slice(span.start, span.end),
      skipped: true,
      reason: span.reason,
      wordOffset,
    });
    cursor = span.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), skipped: false, wordOffset });
  }
  return segments;
}
