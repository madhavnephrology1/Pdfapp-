'use client';

import { useEffect, useState } from 'react';
import type { ReaderTheme } from '@pdfreader/shared-types';
import { DEFAULT_OCR_RENDER_SCALE } from '@/features/ocr/render';
import {
  FONT_SIZE_RANGE,
  LINE_HEIGHT_RANGE,
  OCR_RENDER_SCALE_OPTIONS,
  TEXT_WIDTH_RANGE,
} from '@/features/settings/defaults';
import { formatVoiceDiagnostics } from '@/features/playback/voice-diagnostics';
import { useTheme } from '@/hooks/use-theme';
import { deleteAllStoredData, estimateStorageUsage } from '@/lib/persistence';
import { clearServerAudioCache, fetchHealth, type ServerHealth } from '@/lib/tts-client';
import { useDocumentStore } from '@/stores/document-store';
import { usePlaybackStore } from '@/stores/playback-store';
import styles from './SettingsPanel.module.css';

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { settings, setSettings } = useDocumentStore();
  const { theme, setTheme } = useTheme();
  const playback = usePlaybackStore();
  const [voiceReportOpen, setVoiceReportOpen] = useState(false);
  const [voiceCopied, setVoiceCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const [health, setHealth] = useState<ServerHealth | null>(null);
  const [storage, setStorage] = useState<{
    usedBytes: number;
    quotaBytes: number;
  } | null>(null);
  const [deleted, setDeleted] = useState(false);

  useEffect(() => {
    void fetchHealth().then(setHealth);
    void estimateStorageUsage().then(setStorage);
  }, []);

  const { reader, citations, tables, announcements } = settings;
  const strict = settings.readingMode === 'strict-verbatim';

  const voiceReport = formatVoiceDiagnostics({
    voices: playback.voices,
    selectedVoiceId: playback.voiceId,
    speechAvailable: typeof window !== 'undefined' && 'speechSynthesis' in window,
    serverConfigured: playback.serverConfigured,
    serverProviderName: playback.serverProviderName,
    userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
  });

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Settings">
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2 className={styles.title}>Settings</h2>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </header>

        <div className={styles.body}>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Reader appearance</h3>

            <Slider
              label="Text size"
              value={reader.fontSizePx}
              {...FONT_SIZE_RANGE}
              suffix="px"
              onChange={(value) => setSettings({ reader: { ...reader, fontSizePx: value } })}
            />
            <Slider
              label="Line spacing"
              value={reader.lineHeight}
              {...LINE_HEIGHT_RANGE}
              onChange={(value) => setSettings({ reader: { ...reader, lineHeight: value } })}
            />
            <Slider
              label="Text width"
              value={reader.textWidthCh}
              {...TEXT_WIDTH_RANGE}
              suffix=" characters"
              onChange={(value) => setSettings({ reader: { ...reader, textWidthCh: value } })}
            />

            <div className={styles.field}>
              <label className="field-label" htmlFor="theme-select">
                Theme
              </label>
              <select
                id="theme-select"
                className={styles.select}
                value={theme}
                onChange={(event) => {
                  const next = event.target.value as ReaderTheme;
                  setTheme(next);
                  setSettings({ reader: { ...reader, theme: next } });
                }}
              >
                <option value="system">Match my system</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="sepia">Sepia</option>
              </select>
            </div>

            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={reader.focusMode}
                onChange={(event) =>
                  setSettings({
                    reader: { ...reader, focusMode: event.target.checked },
                  })
                }
              />
              <span>
                Focus mode
                <span className="hint"> — dim everything except the sentence being read</span>
              </span>
            </label>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Citations and notes</h3>
            {strict && (
              <p className={styles.notice}>
                Strict Verbatim Mode is on, so every one of these is read regardless of the settings
                below. Switch to Clean or Custom Mode to change what is skipped.
              </p>
            )}

            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={citations.readParentheticalCitations}
                disabled={strict}
                onChange={(event) =>
                  setSettings({
                    citations: {
                      ...citations,
                      readParentheticalCitations: event.target.checked,
                    },
                  })
                }
              />
              <span>
                Read parenthetical citations
                <span className="hint">
                  {' '}
                  — such as “(Smith, 2019)”. Keeping them preserves the author’s sentence exactly.
                </span>
              </span>
            </label>

            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={citations.skipIsolatedNumericMarkers}
                disabled={strict}
                onChange={(event) =>
                  setSettings({
                    citations: {
                      ...citations,
                      skipIsolatedNumericMarkers: event.target.checked,
                    },
                  })
                }
              />
              <span>
                Skip isolated numeric markers
                <span className="hint">
                  {' '}
                  — such as “[12]”. The sentence is still shown in full with the marker struck
                  through.
                </span>
              </span>
            </label>

            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={citations.skipSuperscriptMarkers}
                disabled={strict}
                onChange={(event) =>
                  setSettings({
                    citations: {
                      ...citations,
                      skipSuperscriptMarkers: event.target.checked,
                    },
                  })
                }
              />
              <span>Skip superscript citation markers</span>
            </label>

            <div className={styles.field}>
              <label className="field-label" htmlFor="footnote-select">
                Footnotes
              </label>
              <select
                id="footnote-select"
                className={styles.select}
                value={citations.footnoteReading}
                disabled={strict}
                onChange={(event) =>
                  setSettings({
                    citations: {
                      ...citations,
                      footnoteReading: event.target.value as typeof citations.footnoteReading,
                    },
                  })
                }
              >
                <option value="after-page">Read after each page</option>
                <option value="after-section">Read after each section</option>
                <option value="skip">Skip footnotes</option>
              </select>
            </div>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Tables</h3>

            <div className={styles.field}>
              <label className="field-label" htmlFor="table-select">
                How tables are read
              </label>
              <select
                id="table-select"
                className={styles.select}
                value={tables.mode}
                onChange={(event) =>
                  setSettings({
                    tables: { mode: event.target.value as typeof tables.mode },
                  })
                }
              >
                <option value="skip">Skip tables</option>
                <option value="read-in-row-order">Read the cells in row order</option>
              </select>
              <p className="hint">
                Tables are skipped by default because a table read as a stream of numbers is
                meaningless. Reading them aloud reproduces the cell text exactly, row by row, with
                no added labels. Table captions are controlled by the “captions” category in Custom
                Mode.
              </p>
            </div>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Figures and drawn areas</h3>

            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={announcements.speakFigureMarkers}
                onChange={(event) =>
                  setSettings({
                    announcements: { ...announcements, speakFigureMarkers: event.target.checked },
                  })
                }
              />
              <span>
                Say where the pictures are
                <span className="hint">
                  {' '}
                  — announce each figure and drawn area in the audio as well as on screen
                </span>
              </span>
            </label>
            <p className="hint">
              These announcements are the only words in the audio that the document does not
              contain, and they are marked as added wherever they appear on screen. They say a
              picture is there and nothing about what it shows: this application does not read
              images, so any description would be invented. Turn this off and the markers stay on
              screen but the audio passes over them in silence.
            </p>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Voices</h3>

            <p className="hint">
              {playback.voices.length === 0
                ? 'This browser is offering no voices at all yet. On some phones the list arrives a moment after the page loads.'
                : `${playback.voices.length} voice(s) available. The voice is chosen in the player bar, and your choice is remembered.`}
            </p>
            {/* Which voice a browser exposes, and whether it marks one as the
                device's own, differs between platforms and cannot be checked
                from the other end. This says exactly what this device reports,
                so a voice that is missing can be seen to be missing. */}
            <div className={styles.voiceActions}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setVoiceReportOpen((open) => !open)}
              >
                {voiceReportOpen ? 'Hide voice details' : 'Show voice details'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(voiceReport)
                    .then(() => setVoiceCopied('done'))
                    .catch(() => setVoiceCopied('failed'));
                }}
              >
                Copy voice details
              </button>
              {voiceCopied === 'done' && <span className="hint">Copied.</span>}
              {voiceCopied === 'failed' && (
                <span className="hint">
                  This browser refused the clipboard — read the details below instead.
                </span>
              )}
            </div>
            {voiceReportOpen && <pre className={styles.voiceReport}>{voiceReport}</pre>}
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Privacy and stored data</h3>

            <p className={styles.privacyFact}>
              {health?.ttsProvider
                ? `Speech is generated by "${health.ttsProvider}" through this app's own server. The text of the passage being spoken is sent there; your PDF file is not.`
                : 'No server speech provider is configured, so speech uses your browser’s own engine and no text leaves this device for synthesis.'}
            </p>
            <p className={styles.privacyFact}>
              {health?.ocrProvider
                ? `Text recognition is available through "${health.ocrProvider}", and page images are only sent there if you turn it on below.`
                : 'Text recognition is not configured. Scanned pages are reported as unreadable rather than guessed at.'}
            </p>
            {storage && (
              <p className={styles.privacyFact}>
                This app is using about {(storage.usedBytes / 1_048_576).toFixed(1)} MB of local
                browser storage for reading positions and settings.
              </p>
            )}

            {health?.ocrProvider ? (
              <div className={styles.field}>
                <label className={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={settings.ocrConsent}
                    onChange={(event) => setSettings({ ocrConsent: event.target.checked })}
                  />
                  Send images of scanned pages to “{health.ocrProvider}” for text recognition
                </label>
                <p className={styles.privacyFact}>
                  Off by default, and nothing is sent until you ask for a specific page in the Text
                  recognition panel. Recognised text is shown to you with uncertain words marked
                  before it becomes part of the reading text, and it is never mixed in with the
                  document&rsquo;s own text without being labelled.
                </p>

                <label className="field-label" htmlFor="ocr-scale">
                  Page image detail
                </label>
                <select
                  id="ocr-scale"
                  className={styles.select}
                  value={settings.ocrRenderScale}
                  onChange={(event) => setSettings({ ocrRenderScale: Number(event.target.value) })}
                >
                  {OCR_RENDER_SCALE_OPTIONS.map((scale) => (
                    <option key={scale} value={scale}>
                      {scale}× {scale === DEFAULT_OCR_RENDER_SCALE ? '(recommended)' : ''}
                    </option>
                  ))}
                </select>
                <p className={styles.privacyFact}>
                  Higher detail reads small type more reliably and sends a larger image.
                </p>
              </div>
            ) : (
              <p className={styles.privacyFact}>
                No text-recognition service is configured, so no page image can be sent anywhere.
                Scanned pages are reported as having no readable text rather than guessed at.
              </p>
            )}

            <div className={styles.dangerZone}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  await deleteAllStoredData();
                  await clearServerAudioCache();
                  setDeleted(true);
                  setStorage(await estimateStorageUsage());
                }}
              >
                Delete everything this app has stored
              </button>
              {deleted && (
                <p className={styles.deleted} role="status">
                  Reading positions, settings and cached audio have been deleted.
                </p>
              )}
            </div>

            <p className="hint">
              <a href="/privacy" target="_blank" rel="noreferrer">
                Read the full privacy notice
              </a>
            </p>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Keyboard shortcuts</h3>
            <dl className={styles.shortcuts}>
              <div>
                <dt>Space</dt>
                <dd>Play or pause (when not typing in a field)</dd>
              </div>
              <div>
                <dt>Left / Right arrow</dt>
                <dd>Previous / next sentence</dd>
              </div>
              <div>
                <dt>Shift + Left / Right</dt>
                <dd>Rewind / forward</dd>
              </div>
              <div>
                <dt>Plus / Minus</dt>
                <dd>Increase / decrease reading speed</dd>
              </div>
              <div>
                <dt>Ctrl or ⌘ + Plus / Minus</dt>
                <dd>Increase / decrease reader text size</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix = '',
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  const id = `slider-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className={styles.field}>
      <label className="field-label" htmlFor={id}>
        {label}: {value}
        {suffix}
      </label>
      <input
        id={id}
        type="range"
        className={styles.slider}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
