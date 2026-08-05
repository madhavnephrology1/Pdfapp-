import type { TTSVoice } from '@pdfreader/shared-types';

/**
 * Choosing which voice speaks by default.
 *
 * This used to be "the first browser voice whose language starts with en",
 * which is an accident of enumeration order, not a preference — on an iPhone it
 * produced a voice the reader had never asked for while their own chosen system
 * voice sat further down the list.
 *
 * The order below is a ranking of evidence about what the person actually
 * wants, strongest first. Nothing here guesses at quality beyond what the
 * platform itself reports.
 */

export interface VoiceLike extends TTSVoice {
  source: 'server' | 'browser';
}

export interface ChooseVoiceInput {
  voices: VoiceLike[];
  /** A voice the reader picked before, from storage. Honoured above all else. */
  savedVoiceId: string | null;
  /** The server's configured default, when a speech provider is set up. */
  serverDefaultVoiceId: string | null;
  serverConfigured: boolean;
  /** BCP-47 tag to prefer, e.g. "en-GB". Matched on the primary subtag. */
  preferredLanguage?: string;
}

/** Higher is better. Only used to break ties between browser voices. */
function score(voice: VoiceLike, language: string): number {
  let value = 0;
  // The reader set this in their operating system. That is a stated preference,
  // not an inference, so it outranks everything else here.
  if (voice.systemDefault) value += 1000;
  if (voice.language.toLowerCase().startsWith(language)) value += 100;
  // A downloaded high-quality voice is why someone downloaded it.
  if (voice.neural) value += 10;
  // Speaking on the device sends nothing anywhere.
  if (voice.onDevice) value += 5;
  return value;
}

/**
 * Returns the voice to speak with, or null when there are none at all.
 *
 * A saved choice is only honoured while that voice still exists — voices come
 * and go as platform downloads are added and removed, and silently falling back
 * is better than selecting an id that cannot speak.
 */
export function chooseDefaultVoice(input: ChooseVoiceInput): VoiceLike | null {
  const { voices, savedVoiceId, serverDefaultVoiceId, serverConfigured } = input;
  if (voices.length === 0) return null;

  const saved = savedVoiceId ? voices.find((voice) => voice.id === savedVoiceId) : undefined;
  if (saved) return saved;

  if (serverConfigured && serverDefaultVoiceId) {
    const configured = voices.find((voice) => voice.id === serverDefaultVoiceId);
    if (configured) return configured;
  }

  const language = (input.preferredLanguage ?? 'en').slice(0, 2).toLowerCase();
  const browser = voices.filter((voice) => voice.source === 'browser');
  const pool = browser.length > 0 ? browser : voices;

  let best = pool[0];
  let bestScore = score(best, language);
  for (const voice of pool.slice(1)) {
    const next = score(voice, language);
    // Strictly greater, so an equal score keeps the platform's own ordering
    // rather than shuffling the list for no reason.
    if (next > bestScore) {
      best = voice;
      bestScore = next;
    }
  }
  return best;
}
