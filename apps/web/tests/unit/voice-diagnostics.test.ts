import { describe, expect, it } from 'vitest';
import type { VoiceLike } from '@/features/playback/voice-choice';
import { formatVoiceDiagnostics } from '@/features/playback/voice-diagnostics';

const voice = (over: Partial<VoiceLike> & { id: string; name: string }): VoiceLike => ({
  language: 'en-US',
  provider: 'browser',
  source: 'browser',
  ...over,
});

const base = {
  speechAvailable: true,
  serverConfigured: false,
  serverProviderName: null,
  userAgent: 'TestAgent/1.0',
};

describe('formatVoiceDiagnostics', () => {
  it('names every voice the platform offered', () => {
    const report = formatVoiceDiagnostics({
      ...base,
      voices: [
        voice({ id: 'a', name: 'Zoe (Premium)', neural: true, systemDefault: true }),
        voice({ id: 'b', name: 'Rishi', language: 'en-IN' }),
      ],
      selectedVoiceId: 'a',
    });

    expect(report).toContain('voices offered: 2');
    expect(report).toContain('Zoe (Premium)');
    expect(report).toContain('Rishi · en-IN');
  });

  it('says which voice is speaking and which the device calls its own', () => {
    const report = formatVoiceDiagnostics({
      ...base,
      voices: [
        voice({ id: 'a', name: 'Zoe', systemDefault: true }),
        voice({ id: 'b', name: 'Daniel' }),
      ],
      selectedVoiceId: 'b',
    });

    expect(report).toContain('speaking with: Daniel (en-US)');
    expect(report).toContain("this device's own default: Zoe (en-US)");
    expect(report).toContain('Daniel · en-US · IN USE');
  });

  it('does not invent a default when the platform reports none', () => {
    const report = formatVoiceDiagnostics({
      ...base,
      voices: [voice({ id: 'a', name: 'Zoe' })],
      selectedVoiceId: 'a',
    });
    expect(report).toContain("this device's own default: not reported");
  });

  it('marks a voice that speaks over the network', () => {
    const report = formatVoiceDiagnostics({
      ...base,
      voices: [voice({ id: 'a', name: 'Cloud', onDevice: false })],
      selectedVoiceId: null,
    });
    expect(report).toContain('over the network');
    expect(report).toContain('speaking with: none');
  });

  it('reports an empty list plainly rather than as an error', () => {
    const report = formatVoiceDiagnostics({ ...base, voices: [], selectedVoiceId: null });
    expect(report).toContain('voices offered: 0');
    expect(report).toContain('speech available: yes');
  });

  it('names the server provider when one is configured', () => {
    const report = formatVoiceDiagnostics({
      ...base,
      serverConfigured: true,
      serverProviderName: 'elevenlabs',
      voices: [],
      selectedVoiceId: null,
    });
    expect(report).toContain('server provider: elevenlabs');
  });
});
