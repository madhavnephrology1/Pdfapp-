import type { TTSVoice } from '@pdfreader/shared-types';

/**
 * Browser SpeechSynthesis fallback.
 *
 * Always available, needs no credentials, and sends nothing over the network in
 * most browsers — though some platforms use a cloud voice, which the privacy
 * notice states. It exposes `boundary` events, so word highlighting with this
 * engine is exact rather than estimated.
 */

export const BROWSER_PROVIDER = 'browser';

export function isBrowserSpeechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Voices load asynchronously in most browsers, so this waits for the
 * `voiceschanged` event rather than returning an empty list on first call.
 */
export function listBrowserVoices(timeoutMs = 2000): Promise<TTSVoice[]> {
  if (!isBrowserSpeechAvailable()) return Promise.resolve([]);

  const map = (voices: SpeechSynthesisVoice[]): TTSVoice[] =>
    voices.map((voice) => ({
      id: voice.voiceURI,
      name: voice.name,
      language: voice.lang,
      provider: BROWSER_PROVIDER,
      // Platforms name their higher-quality downloads in the voice name —
      // "Zoe (Premium)", "Daniel (Enhanced)". There is no API flag for it, so
      // the name is the only signal there is. A platform that names them
      // differently simply does not match, and nothing is claimed about it.
      neural: /\((?:premium|enhanced|neural)\)/i.test(voice.name),
      // Both come straight from the platform rather than being inferred.
      systemDefault: voice.default,
      onDevice: voice.localService,
    }));

  const existing = window.speechSynthesis.getVoices();
  if (existing.length > 0) return Promise.resolve(map(existing));

  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      window.speechSynthesis.removeEventListener('voiceschanged', onChange);
      resolve(map(window.speechSynthesis.getVoices()));
    }, timeoutMs);

    const onChange = (): void => {
      window.clearTimeout(timer);
      window.speechSynthesis.removeEventListener('voiceschanged', onChange);
      resolve(map(window.speechSynthesis.getVoices()));
    };
    window.speechSynthesis.addEventListener('voiceschanged', onChange);
  });
}

/**
 * Calls back whenever the platform's voice list changes.
 *
 * `listBrowserVoices` resolves once and then stops listening, which is right
 * for a promise and wrong for the platform: iOS in particular populates its
 * list asynchronously and can change it again afterwards — a downloaded voice
 * finishing, or the system voice being switched in Settings while the page is
 * open. Read once at mount and a voice added later is simply never seen.
 *
 * Returns an unsubscribe function.
 */
export function subscribeToVoiceChanges(onChanged: () => void): () => void {
  if (!isBrowserSpeechAvailable()) return () => {};
  window.speechSynthesis.addEventListener('voiceschanged', onChanged);
  return () => window.speechSynthesis.removeEventListener('voiceschanged', onChanged);
}

export interface BrowserSpeakOptions {
  text: string;
  voiceId: string | null;
  rate: number;
  volume: number;
  /** Fires with the character offset of each spoken word: exact, not estimated. */
  onBoundary?: (charIndex: number) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
}

/**
 * Speaks one chunk. Returns a handle so the caller can stop it.
 *
 * Only one utterance is ever queued: the reading queue is managed by the
 * playback store, not by the browser's own queue, so that seeking and speed
 * changes stay under our control.
 */
export function speakWithBrowser(options: BrowserSpeakOptions): {
  cancel: () => void;
} {
  if (!isBrowserSpeechAvailable()) {
    options.onError?.('This browser has no built-in speech engine.');
    return { cancel: () => {} };
  }

  const synth = window.speechSynthesis;
  synth.cancel();

  const utterance = new SpeechSynthesisUtterance(options.text);
  utterance.rate = Math.min(10, Math.max(0.1, options.rate));
  utterance.volume = Math.min(1, Math.max(0, options.volume));

  if (options.voiceId) {
    const voice = synth.getVoices().find((candidate) => candidate.voiceURI === options.voiceId);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
  }

  utterance.onboundary = (event) => {
    if (event.name === 'word' || event.name === undefined) {
      options.onBoundary?.(event.charIndex);
    }
  };
  utterance.onend = () => options.onEnd?.();
  utterance.onerror = (event) => {
    // 'canceled' and 'interrupted' are our own stop/seek calls, not failures.
    if (event.error === 'canceled' || event.error === 'interrupted') return;
    options.onError?.(describeSpeechError(event.error));
  };

  synth.speak(utterance);

  return {
    cancel: () => {
      utterance.onend = null;
      utterance.onerror = null;
      utterance.onboundary = null;
      synth.cancel();
    },
  };
}

export function pauseBrowserSpeech(): void {
  if (isBrowserSpeechAvailable()) window.speechSynthesis.pause();
}

export function resumeBrowserSpeech(): void {
  if (isBrowserSpeechAvailable()) window.speechSynthesis.resume();
}

export function cancelBrowserSpeech(): void {
  if (isBrowserSpeechAvailable()) window.speechSynthesis.cancel();
}

function describeSpeechError(error: string): string {
  switch (error) {
    case 'audio-busy':
      return 'The audio device is busy. Close other audio and try again.';
    case 'audio-hardware':
      return 'No audio output is available.';
    case 'network':
      return 'This voice needs a network connection, which is unavailable.';
    case 'synthesis-unavailable':
    case 'synthesis-failed':
      return 'This browser voice could not speak the passage. Try a different voice.';
    case 'language-unavailable':
    case 'voice-unavailable':
      return 'That voice is no longer available. Choose a different one.';
    default:
      return 'The browser voice stopped unexpectedly.';
  }
}
