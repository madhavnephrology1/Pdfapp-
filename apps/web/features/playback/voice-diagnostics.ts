import type { VoiceLike } from './voice-choice';

/**
 * A plain-text account of the voices the platform is offering.
 *
 * The same reason the extraction panel has one: the only device where a voice
 * problem can be reproduced is a phone, whose owner cannot open a developer
 * console. Every line is a fact the platform reported, not an inference — which
 * matters here, because the interesting question is usually whether the browser
 * is exposing a voice at all, and that cannot be guessed at from this end.
 */
export interface VoiceDiagnosticInput {
  voices: VoiceLike[];
  selectedVoiceId: string | null;
  speechAvailable: boolean;
  serverConfigured: boolean;
  serverProviderName: string | null;
  userAgent: string;
}

export function formatVoiceDiagnostics(input: VoiceDiagnosticInput): string {
  const lines: string[] = [];
  lines.push('PDF Human Reader — voice report');
  lines.push(`speech available: ${input.speechAvailable ? 'yes' : 'no'}`);
  lines.push(
    `server provider: ${input.serverConfigured ? (input.serverProviderName ?? 'configured') : 'none — using this browser'}`,
  );
  lines.push(`voices offered: ${input.voices.length}`);

  const selected = input.voices.find((voice) => voice.id === input.selectedVoiceId);
  lines.push(`speaking with: ${selected ? `${selected.name} (${selected.language})` : 'none'}`);

  const systemDefault = input.voices.find((voice) => voice.systemDefault);
  lines.push(
    `this device's own default: ${
      systemDefault ? `${systemDefault.name} (${systemDefault.language})` : 'not reported'
    }`,
  );

  lines.push('');
  for (const voice of input.voices) {
    // A compact set of marks rather than a wide table, so it stays readable on
    // a phone and survives being pasted anywhere.
    const marks = [
      voice.systemDefault ? 'default' : null,
      voice.neural ? 'premium/enhanced' : null,
      voice.onDevice === false ? 'over the network' : null,
      voice.id === input.selectedVoiceId ? 'IN USE' : null,
    ].filter(Boolean);
    lines.push(
      `  ${voice.name} · ${voice.language}${marks.length ? ` · ${marks.join(', ')}` : ''}`,
    );
  }

  lines.push('');
  lines.push(`browser: ${input.userAgent}`);
  return lines.join('\n');
}
