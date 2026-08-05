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

/**
 * Voices no one wants a medical paper read in.
 *
 * Apple ships these alongside the real ones and the Web Speech API offers no
 * way to tell them apart — they carry the same language tag and the same flags
 * as Samantha or Daniel. On an iPhone they are 19 of the 68 voices on offer,
 * so without this list an automatic choice can land on "Bahh" or "Zarvox".
 *
 * Matching by name is a heuristic and is used for ONE thing: never choosing one
 * of these automatically. Every voice stays in the picker and any of them can
 * still be selected deliberately.
 */
const NOVELTY_VOICE_NAMES = new Set(
  [
    'Albert',
    'Bad News',
    'Bahh',
    'Bells',
    'Boing',
    'Bubbles',
    'Cellos',
    'Deranged',
    'Fred',
    'Good News',
    'Hysterical',
    'Jester',
    'Junior',
    'Kathy',
    'Organ',
    'Pipe Organ',
    'Princess',
    'Ralph',
    'Superstar',
    'Trinoids',
    'Whisper',
    'Wobble',
    'Zarvox',
  ].map((name) => name.toLowerCase()),
);

/** True for a joke or legacy voice that should never be chosen automatically. */
export function isNoveltyVoice(voice: { name: string; source?: string }): boolean {
  if (voice.source === 'server') return false;
  return NOVELTY_VOICE_NAMES.has(voice.name.trim().toLowerCase());
}

/** Higher is better. Only used to break ties between browser voices. */
function score(voice: VoiceLike, language: string, region: string, trustDefault: boolean): number {
  let value = 0;
  // The reader set this in their operating system. That is a stated preference,
  // not an inference, so it outranks everything else here — but only where the
  // platform actually reports one; see `trustDefault`.
  if (trustDefault && voice.systemDefault) value += 1000;

  const tag = voice.language.toLowerCase();
  // An exact locale match beats the language alone, so a reader on en-GB gets
  // the British voice rather than whichever English voice is listed first.
  if (region && tag === region) value += 200;
  else if (tag.startsWith(language)) value += 100;

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

  const preferred = (input.preferredLanguage ?? 'en').toLowerCase();
  const language = preferred.slice(0, 2);
  const region = preferred.includes('-') ? preferred : '';

  const browser = voices.filter((voice) => voice.source === 'browser');
  const usable = browser.filter((voice) => !isNoveltyVoice(voice));
  // Novelty voices are excluded from the automatic choice, but never from the
  // application: if they were somehow all there is, one of them still speaks.
  const pool = usable.length > 0 ? usable : browser.length > 0 ? browser : voices;

  // iOS Safari marks EVERY voice as the system default — all 68 of them. A flag
  // that is true for everything says nothing about anything, so it is ignored
  // rather than allowed to swamp the ranking with a constant.
  const defaults = pool.filter((voice) => voice.systemDefault).length;
  const trustDefault = defaults > 0 && defaults < pool.length;

  let best = pool[0];
  let bestScore = score(best, language, region, trustDefault);
  for (const voice of pool.slice(1)) {
    const next = score(voice, language, region, trustDefault);
    // Strictly greater, so an equal score keeps the platform's own ordering
    // rather than shuffling the list for no reason.
    if (next > bestScore) {
      best = voice;
      bestScore = next;
    }
  }
  return best;
}
