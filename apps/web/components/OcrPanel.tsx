'use client';

import { useEffect, useMemo, useState } from 'react';
import { OCR_LOW_CONFIDENCE_THRESHOLD, type OCRPageRecord } from '@pdfreader/shared-types';
import { remainingLowConfidenceIndexes, summarizeOcrPage } from '@/features/ocr/items';
import { fetchHealth, type ServerHealth } from '@/lib/tts-client';
import { useDocumentStore } from '@/stores/document-store';
import styles from './OcrPanel.module.css';

/**
 * Text recognition for scanned pages.
 *
 * Three things this panel must never do, and does not:
 *
 *   - send a page image without the reader having agreed, having been told
 *     which service receives it
 *   - present recognised text as if it were the document's own text
 *   - hide or silently replace a word the recogniser was unsure of
 *
 * Recognised text therefore arrives here first, with uncertain words marked and
 * editable, and only enters the reading text when the reader adds it.
 */
export function OcrPanel({ onClose }: { onClose: () => void }) {
  const {
    pages,
    totalPages,
    ocrPages,
    ocrPageInFlight,
    settings,
    setSettings,
    recognizePage,
    setOcrPageAccepted,
    discardOcrPage,
    setCurrentPage,
  } = useDocumentStore();

  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    void fetchHealth().then(setHealth);
  }, []);

  const scannedPages = useMemo(
    () => pages.filter((page) => page.likelyScanned).map((page) => page.pageNumber),
    [pages],
  );

  const provider = health?.ocrProvider ?? null;
  const active = selected !== null ? (ocrPages[selected] ?? null) : null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Text recognition">
      <div className={styles.panel}>
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>Text recognition</h2>
            <p className={styles.subtitle}>
              {scannedPages.length === 0
                ? 'No page in this document looks like a scan without a text layer.'
                : `${scannedPages.length} of ${totalPages || pages.length} page(s) look like scans with no text layer.`}
            </p>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </header>

        <div className={styles.body}>
          {!provider ? (
            <p className={styles.notice}>
              This deployment has no text-recognition service configured, so scanned pages cannot be
              read. They are listed as having no readable text rather than guessed at.
            </p>
          ) : (
            <>
              <section className={styles.consent}>
                <h3 className={styles.sectionTitle}>Before anything is sent</h3>
                <p className={styles.consentText}>
                  Recognising a page means sending a picture of that page to{' '}
                  <strong>{provider}</strong>, a service outside this application. The picture
                  contains whatever is on the page. Nothing is sent until you turn this on, and then
                  only for the pages you ask for.
                </p>
                <label className={styles.consentToggle}>
                  <input
                    type="checkbox"
                    checked={settings.ocrConsent}
                    onChange={(event) => setSettings({ ocrConsent: event.target.checked })}
                  />
                  <span>Send page images to “{provider}” when I ask for a page</span>
                </label>
              </section>

              <section className={styles.pagesSection}>
                <h3 className={styles.sectionTitle}>Scanned pages</h3>
                {scannedPages.length === 0 ? (
                  <p className={styles.notice}>
                    There is nothing here to recognise. Every page has a text layer, which is read
                    directly and is more accurate than any recognition.
                  </p>
                ) : (
                  <ul className={styles.pageList}>
                    {scannedPages.map((pageNumber) => {
                      const record = ocrPages[pageNumber];
                      const busy = ocrPageInFlight === pageNumber;
                      return (
                        <li key={pageNumber} className={styles.pageRow}>
                          <button
                            type="button"
                            className={styles.pageLabel}
                            onClick={() => setCurrentPage(pageNumber)}
                          >
                            Page {pageNumber}
                          </button>
                          <span className={styles.pageState}>
                            {busy ? 'Sending…' : record ? describeRecord(record) : 'Not recognised'}
                          </span>
                          <span className={styles.pageActions}>
                            {record && (
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => setSelected(pageNumber)}
                              >
                                Review text
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={!settings.ocrConsent || ocrPageInFlight !== null}
                              onClick={() => void recognizePage(pageNumber)}
                            >
                              {record ? 'Recognise again' : 'Recognise this page'}
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {!settings.ocrConsent && scannedPages.length > 0 && (
                  <p className={styles.notice}>
                    Recognition is switched off, so those buttons will not send anything until you
                    agree above.
                  </p>
                )}
              </section>
            </>
          )}

          {active && (
            <RecognizedPage
              record={active}
              onAccept={(accepted) => setOcrPageAccepted(active.pageNumber, accepted)}
              onDiscard={() => {
                discardOcrPage(active.pageNumber);
                setSelected(null);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function describeRecord(record: OCRPageRecord): string {
  const summary = summarizeOcrPage(record);
  if (summary.empty) return 'Nothing was recognised on this page';
  const state = record.accepted ? 'Added to the reading text' : 'Recognised, not yet added';
  return `${state} · ${summary.words} words · ${summary.lowConfidence} uncertain`;
}

/** The recognised text of one page, with uncertain words marked and editable. */
function RecognizedPage({
  record,
  onAccept,
  onDiscard,
}: {
  record: OCRPageRecord;
  onAccept: (accepted: boolean) => void;
  onDiscard: () => void;
}) {
  const correctOcrWord = useDocumentStore((state) => state.correctOcrWord);
  const summary = summarizeOcrPage(record);
  const uncertain = new Set(remainingLowConfidenceIndexes(record));
  const corrections = new Map(record.corrections.map((c) => [c.wordIndex, c]));

  return (
    <section className={styles.recognized}>
      <h3 className={styles.sectionTitle}>Recognised text from page {record.pageNumber}</h3>

      <p className={styles.provenance}>
        Read from an image by <strong>{summary.provider}</strong>, not from the PDF. Average
        confidence {(summary.confidence * 100).toFixed(0)}%.{' '}
        {summary.empty
          ? 'Nothing was recognised on this page, and nothing has been invented to fill the gap.'
          : `${summary.words} word(s), of which ${summary.lowConfidence} are marked below as uncertain. Words under ${Math.round(OCR_LOW_CONFIDENCE_THRESHOLD * 100)}% confidence are marked; none has been guessed at or corrected automatically.`}
      </p>

      {!summary.empty && (
        <>
          <p className={styles.wordHelp}>
            Click a marked word to retype it. Your correction replaces it in the reading text; what
            the recogniser returned is kept alongside.
          </p>
          <div className={styles.words}>
            {record.result.words.map((word, index) => (
              <RecognizedWord
                key={index}
                index={index}
                text={corrections.get(index)?.corrected ?? word.text}
                original={word.text}
                confidence={word.confidence}
                uncertain={uncertain.has(index)}
                corrected={corrections.has(index)}
                onCorrect={(value) => correctOcrWord(record.pageNumber, index, value)}
              />
            ))}
          </div>
        </>
      )}

      <div className={styles.recognizedActions}>
        {!summary.empty && (
          <button
            type="button"
            className={`btn btn-sm ${record.accepted ? '' : 'btn-primary'}`}
            onClick={() => onAccept(!record.accepted)}
          >
            {record.accepted
              ? 'Take this page back out of the reading text'
              : 'Add this page to the reading text'}
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={onDiscard}>
          Discard this recognition
        </button>
      </div>
    </section>
  );
}

function RecognizedWord({
  index,
  text,
  original,
  confidence,
  uncertain,
  corrected,
  onCorrect,
}: {
  index: number;
  text: string;
  original: string;
  confidence: number;
  uncertain: boolean;
  corrected: boolean;
  onCorrect: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  if (editing) {
    return (
      <span className={styles.wordEditor}>
        <label className="sr-only" htmlFor={`ocr-word-${index}`}>
          Correct the recognised word “{original}”
        </label>
        <input
          id={`ocr-word-${index}`}
          className={styles.wordInput}
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            onCorrect(draft);
            setEditing(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onCorrect(draft);
              setEditing(false);
            }
            if (event.key === 'Escape') {
              setDraft(text);
              setEditing(false);
            }
          }}
        />
      </span>
    );
  }

  const title = corrected
    ? `You changed this from “${original}”. The recogniser was ${Math.round(confidence * 100)}% confident.`
    : `${Math.round(confidence * 100)}% confident`;

  return (
    <button
      type="button"
      className={`${styles.word} ${uncertain ? styles.wordUncertain : ''} ${
        corrected ? styles.wordCorrected : ''
      }`}
      title={title}
      onClick={() => {
        setDraft(text);
        setEditing(true);
      }}
    >
      {text}
      {uncertain && <span className="sr-only"> (uncertain)</span>}
      {corrected && <span className="sr-only"> (corrected by you)</span>}
    </button>
  );
}
