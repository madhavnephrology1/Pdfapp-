/**
 * The chosen voice, remembered across reloads.
 *
 * It was not remembered at all before, so every reload silently reset to
 * whatever the enumeration happened to yield first — a person could pick a
 * voice, come back, and find a different one speaking with no explanation.
 *
 * This is an app-wide preference rather than a per-document one, so it lives in
 * localStorage beside the theme rather than in IndexedDB with a document's
 * settings. Storage can be unavailable (private browsing, a blocked origin);
 * that is not an error worth surfacing, it just means the preference does not
 * survive, so every access is guarded.
 */

const STORAGE_KEY = 'pdf-reader-voice';

export function loadVoicePreference(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveVoicePreference(voiceId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (voiceId === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, voiceId);
  } catch {
    // A preference that cannot be stored is not worth interrupting anyone over.
  }
}
