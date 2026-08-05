'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { subscribeToVoiceChanges } from '@/lib/browser-tts';
import { savePosition } from '@/lib/persistence';
import { useDocumentStore } from '@/stores/document-store';
import { usePlaybackStore } from '@/stores/playback-store';
import { ContentReviewPanel } from './ContentReviewPanel';
import { LeftPanel } from './LeftPanel';
import { OcrPanel } from './OcrPanel';
import { PdfViewer } from './PdfViewer';
import { PlayerBar } from './PlayerBar';
import { ReaderPanel } from './ReaderPanel';
import { SettingsPanel } from './SettingsPanel';
import { UploadDropzone } from './UploadDropzone';
import styles from './AppShell.module.css';

export function AppShell() {
  const {
    status,
    fileName,
    error,
    setError,
    reset,
    queue,
    documentId,
    fingerprint,
    progress,
    resumePrompt,
    dismissResumePrompt,
    cancelProcessing,
    stopAnalysis,
    analyzing,
    pagesAnalyzed,
    totalPages,
    setCurrentPage,
  } = useDocumentStore();

  const playback = usePlaybackStore();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [ocrOpen, setOcrOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const positionSaveRef = useRef<number>(0);

  useKeyboardShortcuts(status === 'ready' && !settingsOpen && !reviewOpen);

  // Load the voice list, so the player is usable as soon as text is ready — and
  // keep listening, because the platform's list is not final at mount. iOS
  // populates it asynchronously and changes it again when a voice finishes
  // downloading or the system voice is switched while this page is open.
  useEffect(() => {
    void playback.loadVoices();
    const unsubscribe = subscribeToVoiceChanges(() => void playback.loadVoices());
    return () => {
      unsubscribe();
      playback.teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild the synthesis queue whenever the reading selection changes.
  useEffect(() => {
    if (status !== 'ready' || !playback.voicesLoaded) return;
    playback.prepareQueue(queue, documentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, queue, documentId, playback.voicesLoaded, playback.voiceId]);

  // Persist the reading position, at most once a second.
  useEffect(() => {
    if (!fingerprint || !playback.activeSentenceId) return;
    const now = Date.now();
    if (now - positionSaveRef.current < 1000) return;
    positionSaveRef.current = now;
    void savePosition({
      fingerprint,
      fileName,
      lastOpenedAt: now,
      lastPage: playback.activePage ?? 1,
      lastSentenceId: playback.activeSentenceId,
      lastWordIndex: playback.activeWordIndex,
      lastAudioTimestamp: playback.audioTimestamp,
    }).catch(() => {
      // Storage failures are reported through the store, not thrown here.
    });
  }, [
    fingerprint,
    fileName,
    playback.activeSentenceId,
    playback.activePage,
    playback.activeWordIndex,
    playback.audioTimestamp,
  ]);

  // Warn before a refresh discards in-progress extraction.
  useEffect(() => {
    if (!analyzing) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [analyzing]);

  /**
   * The stored sentence may not be in the queue yet while the later pages of a
   * document are still being analysed. Rather than offering a button that would
   * quietly do nothing, the banner waits until there is somewhere real to go:
   * the sentence itself, or — once analysis has finished and the sentence is
   * genuinely gone — the page it was on.
   */
  const resumeSentence = resumePrompt?.lastSentenceId
    ? (queue.entries.find((entry) => entry.sentence.id === resumePrompt.lastSentenceId)?.sentence ??
      null)
    : null;
  const canResume = Boolean(resumePrompt) && (Boolean(resumeSentence) || !analyzing);

  const resume = useCallback(() => {
    if (resumeSentence) void playback.seekToSentence(resumeSentence.id);
    else if (resumePrompt) setCurrentPage(resumePrompt.lastPage);
    dismissResumePrompt();
  }, [resumeSentence, resumePrompt, playback, setCurrentPage, dismissResumePrompt]);

  if (status === 'empty' || (status === 'error' && !fileName)) {
    return (
      <main className={styles.landing}>
        {error && (
          <div className={styles.errorBanner} role="alert">
            <div>
              <strong>{error.title}</strong>
              <p>{error.message}</p>
              <p className={styles.recovery}>{error.recovery}</p>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}
        <UploadDropzone />
        <footer className={styles.landingFooter}>
          <a href="/privacy">Privacy notice</a>
        </footer>
      </main>
    );
  }

  return (
    <div className={styles.shell}>
      <a href="#reading-text" className="skip-link">
        Skip to the reading text
      </a>

      <header className={styles.topBar}>
        <button
          type="button"
          className={`btn btn-sm ${styles.navToggle}`}
          onClick={() => setNavOpen((open) => !open)}
          aria-expanded={navOpen}
          aria-controls="document-nav"
        >
          {navOpen ? 'Hide' : 'Show'} navigation
        </button>

        <h1 className={styles.appTitle}>PDF Human Reader</h1>

        <div className={styles.topActions}>
          <button type="button" className="btn btn-sm" onClick={() => setReviewOpen(true)}>
            Content review
            {queue.excludedRegions.length > 0 && (
              <span className={styles.countBadge}>{queue.excludedRegions.length}</span>
            )}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              playback.teardown();
              playback.stop();
              reset();
            }}
          >
            Close document
          </button>
        </div>
      </header>

      {analyzing && (
        <div className={styles.processing} role="status" aria-live="polite">
          {status === 'ready' ? (
            <span>
              The first {pagesAnalyzed} of {totalPages || '?'} pages can be read now. The rest are
              still being analysed, and what is skipped may change — a running header cannot be
              recognised until it has been seen on several pages.
            </span>
          ) : (
            <span>
              Processing {fileName} — {progress.phase}
              {progress.pagesTotal > 0 &&
                ` ${progress.pagesExtracted} of ${progress.pagesTotal} pages`}
              {/* Anything the worker could not do is said here rather than
                  left in a console the reader cannot open. */}
              {progress.message && ` — ${progress.message}`}
            </span>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={status === 'ready' ? stopAnalysis : cancelProcessing}
          >
            {status === 'ready' ? 'Stop analysing' : 'Cancel'}
          </button>
        </div>
      )}

      {status === 'error' && error && (
        <div className={styles.errorBanner} role="alert">
          <div>
            <strong>{error.title}</strong>
            <p>{error.message}</p>
            <p className={styles.recovery}>{error.recovery}</p>
          </div>
          <button type="button" className="btn btn-sm" onClick={reset}>
            Choose another file
          </button>
        </div>
      )}

      {resumePrompt && canResume && status === 'ready' && (
        <div className={styles.resumeBanner} role="region" aria-label="Resume reading">
          <span>
            You were on page {resumePrompt.lastPage} of this document on{' '}
            {new Date(resumePrompt.lastOpenedAt).toLocaleString()}.
          </span>
          <div className={styles.resumeActions}>
            <button type="button" className="btn btn-sm btn-primary" onClick={resume}>
              Resume reading
            </button>
            <button type="button" className="btn btn-sm" onClick={dismissResumePrompt}>
              Start from the beginning
            </button>
          </div>
        </div>
      )}

      <div className={styles.columns}>
        <div id="document-nav" className={`${styles.left} ${navOpen ? styles.leftOpen : ''}`}>
          <LeftPanel
            onOpenReview={() => setReviewOpen(true)}
            onOpenRecognition={() => setOcrOpen(true)}
          />
        </div>
        <div className={styles.center}>
          <PdfViewer />
        </div>
        <div className={styles.right}>
          <ReaderPanel />
        </div>
      </div>

      <PlayerBar />

      {reviewOpen && <ContentReviewPanel onClose={() => setReviewOpen(false)} />}
      {ocrOpen && <OcrPanel onClose={() => setOcrOpen(false)} />}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
