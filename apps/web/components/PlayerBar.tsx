'use client';

import { useMemo } from 'react';
import { isBusy, isPlaying } from '@/features/playback/machine';
import { estimateRemainingSeconds, formatTime } from '@/features/playback/timing';
import { isNoveltyVoice } from '@/features/playback/voice-choice';
import { SPEED_OPTIONS } from '@/features/settings/defaults';
import { useDocumentStore } from '@/stores/document-store';
import { usePlaybackStore } from '@/stores/playback-store';
import styles from './PlayerBar.module.css';

/**
 * The persistent player.
 *
 * Every control here does something real. Controls that a given engine cannot
 * support are disabled with an explanation rather than being shown as working.
 */
export function PlayerBar() {
  const playback = usePlaybackStore();
  const queue = useDocumentStore((state) => state.queue);
  const settings = useDocumentStore((state) => state.settings);
  const setSettings = useDocumentStore((state) => state.setSettings);
  const outline = useDocumentStore((state) => state.outline);

  const {
    state,
    activeSentenceId,
    activePage,
    audioTimestamp,
    speed,
    volume,
    voiceId,
    voices,
    error,
  } = playback;

  const playing = isPlaying(state);
  const busy = isBusy(state);
  const hasQueue = playback.queueSentences.length > 0;

  const position = useMemo(() => {
    const index = playback.queueSentences.findIndex((s) => s.id === activeSentenceId);
    return index < 0 ? 0 : index;
  }, [playback.queueSentences, activeSentenceId]);

  const charactersRemaining = useMemo(
    () => queue.entries.slice(position).reduce((sum, entry) => sum + entry.speechText.length, 0),
    [queue.entries, position],
  );

  const remaining = estimateRemainingSeconds(charactersRemaining, speed);
  const section = useMemo(() => {
    if (activePage === null) return null;
    const candidates = outline.filter((node) => node.pageNumber <= activePage);
    return candidates.length > 0 ? candidates[candidates.length - 1].title : null;
  }, [outline, activePage]);

  // Reading voices in the page's own language first, then other languages, then
  // the joke and legacy voices — labelled, not hidden.
  const browserVoiceGroups = useMemo(() => {
    const browser = voices.filter((voice) => voice.source === 'browser');
    const language = (typeof navigator === 'undefined' ? 'en' : navigator.language)
      .slice(0, 2)
      .toLowerCase();

    const novelty = browser.filter((voice) => isNoveltyVoice(voice));
    const usable = browser.filter((voice) => !isNoveltyVoice(voice));
    const matching = usable.filter((voice) => voice.language.toLowerCase().startsWith(language));
    const others = usable.filter((voice) => !voice.language.toLowerCase().startsWith(language));

    return [
      { label: 'Voices for reading', voices: matching },
      { label: 'Other languages', voices: others },
      { label: 'Novelty and legacy voices', voices: novelty },
    ].filter((group) => group.voices.length > 0);
  }, [voices]);

  const browserEngine = playback.providerName === 'browser';

  return (
    <div className={styles.bar} role="region" aria-label="Playback controls">
      {error && (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={playback.dismissError}>
            Dismiss
          </button>
        </div>
      )}

      <div className={styles.row}>
        <div className={styles.transport}>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => void playback.previous()}
            disabled={!hasQueue || position === 0}
            aria-label="Previous sentence"
            title="Previous sentence (Left arrow)"
          >
            ⏮
          </button>

          <button
            type="button"
            className="btn btn-icon"
            onClick={() => playback.skipSeconds(-10)}
            disabled={!hasQueue}
            aria-label={browserEngine ? 'Back one sentence' : 'Rewind 10 seconds'}
            title={
              browserEngine
                ? 'Back one sentence (the browser voice has no seekable timeline)'
                : 'Rewind 10 seconds (Shift + Left arrow)'
            }
          >
            ↺10
          </button>

          <button
            type="button"
            className={`btn btn-icon ${styles.playButton}`}
            onClick={() => (playing ? playback.pause() : void playback.play())}
            // Enabled in the error state on purpose: a failed start is
            // retryable, and the error text asks the reader to press play again.
            disabled={!hasQueue}
            aria-label={playing ? 'Pause' : 'Play'}
            title={playing ? 'Pause (Space)' : 'Play (Space)'}
          >
            {busy ? '…' : playing ? '⏸' : '▶'}
          </button>

          <button
            type="button"
            className="btn btn-icon"
            onClick={playback.stop}
            disabled={!hasQueue || state === 'idle'}
            aria-label="Stop"
            title="Stop"
          >
            ⏹
          </button>

          <button
            type="button"
            className="btn btn-icon"
            onClick={() => playback.skipSeconds(10)}
            disabled={!hasQueue}
            aria-label={browserEngine ? 'Forward one sentence' : 'Forward 10 seconds'}
            title={
              browserEngine
                ? 'Forward one sentence (the browser voice has no seekable timeline)'
                : 'Forward 10 seconds (Shift + Right arrow)'
            }
          >
            10↻
          </button>

          <button
            type="button"
            className="btn btn-icon"
            onClick={() => void playback.next()}
            disabled={!hasQueue || position >= playback.queueSentences.length - 1}
            aria-label="Next sentence"
            title="Next sentence (Right arrow)"
          >
            ⏭
          </button>

          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void playback.restartParagraph()}
            disabled={!hasQueue || !playback.activeParagraphId}
            title="Start this paragraph again"
          >
            Restart paragraph
          </button>
        </div>

        <div className={styles.progress}>
          <label htmlFor="seek" className="sr-only">
            Position in the document, in sentences
          </label>
          <input
            id="seek"
            type="range"
            className={styles.seek}
            min={0}
            max={Math.max(0, playback.queueSentences.length - 1)}
            value={position}
            disabled={!hasQueue}
            onChange={(event) => {
              const target = playback.queueSentences[Number(event.target.value)];
              if (target) void playback.seekToSentence(target.id);
            }}
            aria-valuetext={`Sentence ${position + 1} of ${playback.queueSentences.length}`}
          />
          <div className={styles.times}>
            <span>{formatTime(audioTimestamp)} elapsed in this passage</span>
            <span>~{formatTime(remaining)} remaining (estimated)</span>
          </div>
        </div>

        <div className={styles.settingsGroup}>
          <label className="sr-only" htmlFor="voice-select">
            Voice
          </label>
          <select
            id="voice-select"
            className={styles.select}
            value={voiceId ?? ''}
            onChange={(event) => void playback.setVoice(event.target.value)}
            title="Voice"
          >
            {playback.voices.length === 0 && <option value="">No voices available</option>}
            {voices.filter((voice) => voice.source === 'server').length > 0 && (
              <optgroup label={`Server voices (${playback.serverProviderName ?? 'provider'})`}>
                {voices
                  .filter((voice) => voice.source === 'server')
                  .map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.name}
                    </option>
                  ))}
              </optgroup>
            )}
            {/* A phone offers 68 of these, nineteen of which are joke voices
                sitting between Samantha and Tessa with nothing to mark them.
                Grouping them keeps the list usable without removing anything:
                every voice the platform offers is still here. */}
            {browserVoiceGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name} ({voice.language})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          <label className="sr-only" htmlFor="speed-select">
            Reading speed
          </label>
          <select
            id="speed-select"
            className={styles.select}
            value={speed}
            onChange={(event) => {
              const next = Number(event.target.value);
              playback.setSpeed(next);
              setSettings({ playback: { ...settings.playback, speed: next } });
            }}
            title="Reading speed"
          >
            {SPEED_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}×
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor="volume">
            Volume
          </label>
          <input
            id="volume"
            type="range"
            className={styles.volume}
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(event) => playback.setVolume(Number(event.target.value))}
            title="Volume"
            aria-valuetext={`${Math.round(volume * 100)} percent`}
          />
        </div>
      </div>

      <p className={styles.status} aria-live="polite">
        {activePage !== null && <>Page {activePage}</>}
        {section && <> · {section}</>}
        {hasQueue && (
          <>
            {' '}
            · Sentence {position + 1} of {playback.queueSentences.length}
          </>
        )}
        {browserEngine && <> · Using your browser’s built-in voice</>}
      </p>
    </div>
  );
}
