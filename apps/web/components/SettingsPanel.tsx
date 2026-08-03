'use client';

import { useEffect, useState } from 'react';
import type { ReaderTheme } from '@pdfreader/shared-types';
import { FONT_SIZE_RANGE, LINE_HEIGHT_RANGE, TEXT_WIDTH_RANGE } from '@/features/settings/defaults';
import { useTheme } from '@/hooks/use-theme';
import { deleteAllStoredData, estimateStorageUsage } from '@/lib/persistence';
import { clearServerAudioCache, fetchHealth, type ServerHealth } from '@/lib/tts-client';
import { useDocumentStore } from '@/stores/document-store';
import styles from './SettingsPanel.module.css';

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { settings, setSettings } = useDocumentStore();
  const { theme, setTheme } = useTheme();
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

  const { reader, citations, tables } = settings;
  const strict = settings.readingMode === 'strict-verbatim';

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
                  — such as “(Smith, 2019)”. Keeping them preserves the author&apos;s sentence
                  exactly.
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

            <p className={styles.privacyFact}>
              Sending scanned pages for text recognition is not available in the interface yet, so
              no page image is sent anywhere. Scanned pages are reported as having no readable text
              rather than guessed at.
            </p>

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
