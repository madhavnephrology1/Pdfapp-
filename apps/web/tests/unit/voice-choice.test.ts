import { describe, expect, it } from 'vitest';
import { chooseDefaultVoice, type VoiceLike } from '@/features/playback/voice-choice';

const browserVoice = (over: Partial<VoiceLike> & { id: string; name: string }): VoiceLike => ({
  language: 'en-US',
  provider: 'browser',
  source: 'browser',
  ...over,
});

/**
 * The list below is the shape an iPhone actually produces: several English
 * voices, one of which the operating system marks as the reader's own.
 */
const iphoneVoices: VoiceLike[] = [
  browserVoice({ id: 'rishi', name: 'Rishi', language: 'en-IN', onDevice: true }),
  browserVoice({ id: 'daniel', name: 'Daniel', language: 'en-GB', onDevice: true }),
  browserVoice({
    id: 'zoe-premium',
    name: 'Zoe (Premium)',
    language: 'en-US',
    onDevice: true,
    neural: true,
    systemDefault: true,
  }),
  browserVoice({ id: 'karen', name: 'Karen', language: 'en-AU', onDevice: true }),
];

const base = {
  savedVoiceId: null,
  serverDefaultVoiceId: null,
  serverConfigured: false,
};

describe('chooseDefaultVoice', () => {
  it('picks the voice the operating system marks as the default', () => {
    const chosen = chooseDefaultVoice({ ...base, voices: iphoneVoices });
    expect(chosen?.id).toBe('zoe-premium');
  });

  it('does not pick the first English voice just because it is first', () => {
    // The old behaviour returned Rishi here. This is the regression guard.
    const chosen = chooseDefaultVoice({ ...base, voices: iphoneVoices });
    expect(chosen?.id).not.toBe('rishi');
  });

  it('honours a saved choice above the system default', () => {
    const chosen = chooseDefaultVoice({ ...base, voices: iphoneVoices, savedVoiceId: 'daniel' });
    expect(chosen?.id).toBe('daniel');
  });

  it('ignores a saved voice that no longer exists', () => {
    const chosen = chooseDefaultVoice({ ...base, voices: iphoneVoices, savedVoiceId: 'deleted' });
    expect(chosen?.id).toBe('zoe-premium');
  });

  it('prefers a downloaded high-quality voice when nothing is marked default', () => {
    const voices = [
      browserVoice({ id: 'plain', name: 'Zoe', onDevice: true }),
      browserVoice({ id: 'premium', name: 'Zoe (Premium)', onDevice: true, neural: true }),
    ];
    expect(chooseDefaultVoice({ ...base, voices })?.id).toBe('premium');
  });

  it('prefers an on-device voice over one that speaks over the network', () => {
    const voices = [
      browserVoice({ id: 'cloud', name: 'Cloud Voice', onDevice: false }),
      browserVoice({ id: 'local', name: 'Local Voice', onDevice: true }),
    ];
    expect(chooseDefaultVoice({ ...base, voices })?.id).toBe('local');
  });

  it('prefers the requested language over other languages', () => {
    const voices = [
      browserVoice({ id: 'fr', name: 'Amélie', language: 'fr-CA', onDevice: true }),
      browserVoice({ id: 'en', name: 'Samantha', language: 'en-US', onDevice: true }),
    ];
    expect(chooseDefaultVoice({ ...base, voices, preferredLanguage: 'en-GB' })?.id).toBe('en');
    expect(chooseDefaultVoice({ ...base, voices, preferredLanguage: 'fr-FR' })?.id).toBe('fr');
  });

  it('uses the server default when a speech provider is configured', () => {
    const voices: VoiceLike[] = [
      { id: 'srv-a', name: 'A', language: 'en-US', provider: 'elevenlabs', source: 'server' },
      ...iphoneVoices,
    ];
    const chosen = chooseDefaultVoice({
      ...base,
      voices,
      serverConfigured: true,
      serverDefaultVoiceId: 'srv-a',
    });
    expect(chosen?.id).toBe('srv-a');
  });

  it('falls back to a browser voice when the configured server voice is missing', () => {
    const chosen = chooseDefaultVoice({
      ...base,
      voices: iphoneVoices,
      serverConfigured: true,
      serverDefaultVoiceId: 'not-in-list',
    });
    expect(chosen?.id).toBe('zoe-premium');
  });

  it('keeps the platform ordering when nothing distinguishes the voices', () => {
    const voices = [
      browserVoice({ id: 'first', name: 'First', onDevice: true }),
      browserVoice({ id: 'second', name: 'Second', onDevice: true }),
    ];
    expect(chooseDefaultVoice({ ...base, voices })?.id).toBe('first');
  });

  it('returns null when there are no voices at all', () => {
    expect(chooseDefaultVoice({ ...base, voices: [] })).toBeNull();
  });
});
