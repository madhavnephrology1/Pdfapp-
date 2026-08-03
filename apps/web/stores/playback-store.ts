'use client';

import { create } from 'zustand';
import type {
  ChunkRuntimeState,
  PlaybackSnapshot,
  SentenceRecord,
  TimingSource,
  TTSChunk,
  TTSVoice,
} from '@pdfreader/shared-types';
import {
  assertChunkingIsLossless,
  buildChunks,
  findChunkForSentence,
} from '@/features/playback/chunking';
import {
  initialPlaybackSnapshot,
  playbackReducer,
  type PlaybackEvent,
} from '@/features/playback/machine';
import {
  estimateSentenceTimings,
  sentenceAtTime,
  wordProgress,
  wordTimingsForSentence,
} from '@/features/playback/timing';
import type { ReadingQueue } from '@/features/reader/queue';
import {
  BROWSER_PROVIDER,
  cancelBrowserSpeech,
  isBrowserSpeechAvailable,
  listBrowserVoices,
  pauseBrowserSpeech,
  resumeBrowserSpeech,
  speakWithBrowser,
} from '@/lib/browser-tts';
import {
  audioUrlFromBase64,
  fetchServerVoices,
  synthesizeChunk,
  TTSClientError,
} from '@/lib/tts-client';

/**
 * Playback engine.
 *
 * Two audio paths share one state machine and one queue:
 *   - server provider: audio elements fed by generated chunks, with prefetch
 *   - browser speech:  SpeechSynthesis, one sentence at a time, with exact
 *                      word boundaries from the engine's own events
 *
 * Only a few chunks ahead are ever generated, obsolete requests are cancelled
 * on a seek, and a failed chunk surfaces as an error rather than being skipped.
 */

/** How many chunks past the current one to generate ahead of time. */
const PREFETCH_AHEAD = 2;
/** Generated audio URLs kept before the oldest are revoked. */
const MAX_CACHED_AUDIO = 12;
const MAX_ATTEMPTS = 3;

export interface VoiceOption extends TTSVoice {
  source: 'server' | 'browser';
}

interface PlaybackStoreState extends PlaybackSnapshot {
  chunks: TTSChunk[];
  chunkStates: Record<string, ChunkRuntimeState>;
  /** Sentences in queue order, for prev/next navigation. */
  queueSentences: SentenceRecord[];
  voices: VoiceOption[];
  serverConfigured: boolean;
  serverProviderName: string | null;
  /** Provider-reported capability; drives whether word timing can be exact. */
  serverSupportsWordTiming: boolean;
  maxCharsPerChunk: number;
  voicesLoaded: boolean;

  loadVoices: () => Promise<void>;
  prepareQueue: (queue: ReadingQueue, documentId: string) => void;
  play: () => Promise<void>;
  pause: () => void;
  stop: () => void;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  seekToSentence: (sentenceId: string) => Promise<void>;
  restartParagraph: () => Promise<void>;
  skipSeconds: (delta: number) => void;
  setSpeed: (speed: number) => void;
  setVolume: (volume: number) => void;
  setVoice: (voiceId: string) => Promise<void>;
  dismissError: () => void;
  teardown: () => void;
}

/* ---------------------------------------------------------------- */
/* Module-level audio resources, deliberately outside React state    */
/* ---------------------------------------------------------------- */

let audioElement: HTMLAudioElement | null = null;
let browserHandle: { cancel: () => void } | null = null;
let inFlight = new Map<string, AbortController>();
let audioUrlOrder: string[] = [];
let rafId: number | null = null;
/** Word timings for the chunk currently loaded into the audio element. */
let activeChunkTimings: {
  timingSource: TimingSource;
  wordTimings?: TTSResultWordTiming[];
} | null = null;

interface TTSResultWordTiming {
  start: number;
  end: number;
  audioStart: number;
  audioEnd: number;
}

function getAudioElement(): HTMLAudioElement {
  if (!audioElement) {
    audioElement = new Audio();
    audioElement.preload = 'auto';
  }
  return audioElement;
}

function releaseOldestAudio(states: Record<string, ChunkRuntimeState>): void {
  while (audioUrlOrder.length > MAX_CACHED_AUDIO) {
    const url = audioUrlOrder.shift();
    if (!url) break;
    URL.revokeObjectURL(url);
    for (const state of Object.values(states)) {
      if (state.audioUrl === url) {
        state.audioUrl = undefined;
        state.status = 'queued';
      }
    }
  }
}

function cancelInFlight(exceptChunkIds: Set<string> = new Set()): void {
  for (const [chunkId, controller] of inFlight) {
    if (!exceptChunkIds.has(chunkId)) {
      controller.abort();
      inFlight.delete(chunkId);
    }
  }
}

export const usePlaybackStore = create<PlaybackStoreState>((set, get) => {
  const dispatch = (event: PlaybackEvent): void => {
    set((state) => {
      const snapshot = playbackReducer(state, event);
      return { ...state, ...snapshot };
    });
  };

  /** Index of the current sentence in the queue, or -1. */
  const currentIndex = (): number => {
    const { queueSentences, activeSentenceId } = get();
    if (!activeSentenceId) return -1;
    return queueSentences.findIndex((sentence) => sentence.id === activeSentenceId);
  };

  const setChunkState = (chunkId: string, update: Partial<ChunkRuntimeState>): void => {
    set((state) => ({
      chunkStates: {
        ...state.chunkStates,
        [chunkId]: {
          ...(state.chunkStates[chunkId] ?? {
            chunkId,
            status: 'queued',
            attempts: 0,
          }),
          ...update,
        },
      },
    }));
  };

  /** Generates one chunk's audio, honouring cancellation and retry limits. */
  const generateChunk = async (chunk: TTSChunk): Promise<ChunkRuntimeState | null> => {
    const existing = get().chunkStates[chunk.id];
    if (existing?.status === 'ready' && existing.audioUrl) return existing;
    if (existing?.status === 'generating') return null;
    if ((existing?.attempts ?? 0) >= MAX_ATTEMPTS) return null;

    const controller = new AbortController();
    inFlight.set(chunk.id, controller);
    setChunkState(chunk.id, {
      status: 'generating',
      attempts: (existing?.attempts ?? 0) + 1,
      error: undefined,
    });

    try {
      const { speed, voiceId } = get();
      const result = await synthesizeChunk({
        text: chunk.text,
        voiceId: voiceId ?? '',
        speed,
        language: 'en-US',
        chunkId: chunk.id,
        cacheKey: chunk.cacheKey,
        signal: controller.signal,
      });

      const url = audioUrlFromBase64(result.audio, result.mimeType);
      audioUrlOrder.push(url);
      const next: ChunkRuntimeState = {
        chunkId: chunk.id,
        status: 'ready',
        audioUrl: url,
        durationSeconds: result.durationSeconds,
        timingSource: result.timingSource,
        attempts: (existing?.attempts ?? 0) + 1,
      };
      set((state) => {
        const states = { ...state.chunkStates, [chunk.id]: next };
        releaseOldestAudio(states);
        return { chunkStates: states };
      });
      // Word timings live outside React state: they are large and change often.
      chunkTimings.set(chunk.id, {
        timingSource: result.timingSource,
        wordTimings: result.wordTimings,
      });
      return next;
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        setChunkState(chunk.id, { status: 'cancelled' });
        return null;
      }
      const message =
        error instanceof TTSClientError
          ? `${error.normalized.message} ${error.normalized.recovery ?? ''}`.trim()
          : 'That passage could not be turned into speech.';
      setChunkState(chunk.id, { status: 'failed', error: message });
      dispatch({ type: 'ERROR', message });
      return null;
    } finally {
      inFlight.delete(chunk.id);
    }
  };

  const prefetchFrom = (index: number): void => {
    const { chunks } = get();
    for (let i = index; i < Math.min(chunks.length, index + 1 + PREFETCH_AHEAD); i += 1) {
      void generateChunk(chunks[i]);
    }
  };

  const stopTicker = (): void => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  /** Drives sentence and word highlighting from the audio element's clock. */
  const startTicker = (): void => {
    stopTicker();
    const tick = (): void => {
      const element = audioElement;
      const state = get();
      if (!element || state.state !== 'playing') {
        rafId = null;
        return;
      }

      const chunk = state.chunks.find((candidate) => candidate.id === state.activeChunkId);
      if (chunk) {
        const duration = Number.isFinite(element.duration) ? element.duration : 0;
        const timings = chunkTimings.get(chunk.id);
        const sentenceTimings = estimateSentenceTimings(chunk, duration);
        const sentenceId = sentenceAtTime(chunk, element.currentTime, duration, sentenceTimings);

        if (sentenceId && sentenceId !== state.activeSentenceId) {
          const sentence = state.queueSentences.find((candidate) => candidate.id === sentenceId);
          if (sentence) {
            dispatch({
              type: 'SENTENCE_ADVANCED',
              sentenceId: sentence.id,
              paragraphId: sentence.paragraphId,
              regionId: sentence.regionId,
              page: sentence.pageNumber,
            });
          }
        }

        const active = state.queueSentences.find((candidate) => candidate.id === sentenceId);
        if (active) {
          const bounds = sentenceTimings.find((entry) => entry.sentenceId === active.id);
          const elapsed = element.currentTime - (bounds?.audioStart ?? 0);
          const sentenceDuration = (bounds?.audioEnd ?? duration) - (bounds?.audioStart ?? 0);
          const narrowed = wordTimingsForSentence(chunk, active.id, timings?.wordTimings);
          const progress = wordProgress({
            sentenceText: active.text,
            elapsedInSentence: elapsed,
            sentenceDuration,
            wordTimings: narrowed ?? undefined,
            timingSource: narrowed ? 'provider-exact' : 'estimated',
          });
          if (progress) {
            dispatch({
              type: 'WORD_BOUNDARY',
              wordIndex: progress.wordIndex,
              source: progress.source,
            });
          }
        }
      }

      dispatch({ type: 'TICK', audioTimestamp: element.currentTime });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  };

  /** Plays one sentence through the browser's speech engine. */
  const speakSentenceWithBrowser = (sentenceId: string): void => {
    const state = get();
    const index = state.queueSentences.findIndex((sentence) => sentence.id === sentenceId);
    if (index < 0) return;
    const sentence = state.queueSentences[index];
    const chunkMatch = findChunkForSentence(state.chunks, sentence.id);
    const text = chunkMatch
      ? chunkMatch.chunk.text.slice(chunkMatch.start, chunkMatch.end)
      : sentence.text;

    dispatch({
      type: 'SENTENCE_ADVANCED',
      sentenceId: sentence.id,
      paragraphId: sentence.paragraphId,
      regionId: sentence.regionId,
      page: sentence.pageNumber,
    });

    browserHandle?.cancel();
    browserHandle = speakWithBrowser({
      text,
      voiceId: state.voiceId,
      rate: state.speed,
      volume: state.volume,
      onBoundary: (charIndex) => {
        const words = text.slice(0, charIndex).split(/\s+/).filter(Boolean).length;
        // Boundary events are real measurements, so this is exact, not estimated.
        dispatch({
          type: 'WORD_BOUNDARY',
          wordIndex: words,
          source: 'browser-boundary',
        });
      },
      onEnd: () => {
        const after = get();
        if (after.state !== 'playing') return;
        const nextIndex = index + 1;
        if (nextIndex >= after.queueSentences.length) {
          dispatch({ type: 'END_OF_QUEUE' });
          return;
        }
        speakSentenceWithBrowser(after.queueSentences[nextIndex].id);
      },
      onError: (message) => dispatch({ type: 'ERROR', message }),
    });
  };

  /** Loads and plays the chunk containing a sentence, from that sentence's offset. */
  const playFromSentence = async (sentenceId: string): Promise<void> => {
    const state = get();
    if (state.providerName === BROWSER_PROVIDER) {
      speakSentenceWithBrowser(sentenceId);
      dispatch({ type: 'SEEK_COMMITTED' });
      dispatch({ type: 'PLAY' });
      return;
    }

    const match = findChunkForSentence(state.chunks, sentenceId);
    if (!match) {
      dispatch({ type: 'END_OF_QUEUE' });
      return;
    }

    // Anything queued for a different part of the document is now obsolete.
    cancelInFlight(new Set([match.chunk.id]));
    dispatch({ type: 'CHUNK_ACTIVE', chunkId: match.chunk.id });
    dispatch({ type: 'BUFFER' });

    const ready = (await generateChunk(match.chunk)) ?? get().chunkStates[match.chunk.id];
    if (!ready?.audioUrl) return;

    const element = getAudioElement();
    if (element.src !== ready.audioUrl) {
      element.src = ready.audioUrl;
      element.load();
    }
    element.playbackRate = get().speed;
    element.volume = get().volume;

    await new Promise<void>((resolve) => {
      if (element.readyState >= 1) return resolve();
      element.addEventListener('loadedmetadata', () => resolve(), {
        once: true,
      });
    });

    // Start at this sentence's share of the chunk. With provider sentence
    // timings this is exact; otherwise it is a character-share estimate.
    const duration = Number.isFinite(element.duration) ? element.duration : 0;
    const timings = estimateSentenceTimings(match.chunk, duration);
    const bounds = timings.find((entry) => entry.sentenceId === sentenceId);
    if (bounds && duration > 0) element.currentTime = bounds.audioStart;

    element.onended = () => {
      const after = get();
      const index = after.chunks.findIndex((chunk) => chunk.id === match.chunk.id);
      const nextChunk = after.chunks[index + 1];
      if (!nextChunk) {
        dispatch({ type: 'END_OF_QUEUE' });
        return;
      }
      void playFromSentence(nextChunk.sentenceIds[0]);
    };
    element.onerror = () => {
      dispatch({
        type: 'ERROR',
        message: 'The generated audio could not be played. Your place has been kept.',
      });
    };

    try {
      await element.play();
    } catch {
      dispatch({
        type: 'ERROR',
        message: 'Playback could not start. Press play again to allow audio in this browser.',
      });
      return;
    }

    dispatch({ type: 'SEEK_COMMITTED' });
    dispatch({ type: 'PLAY' });
    startTicker();

    const index = get().chunks.findIndex((chunk) => chunk.id === match.chunk.id);
    prefetchFrom(index + 1);
  };

  return {
    ...initialPlaybackSnapshot,
    chunks: [],
    chunkStates: {},
    queueSentences: [],
    voices: [],
    serverConfigured: false,
    serverProviderName: null,
    serverSupportsWordTiming: false,
    maxCharsPerChunk: 2500,
    voicesLoaded: false,

    async loadVoices() {
      const [server, browser] = await Promise.all([
        fetchServerVoices().catch(() => null),
        isBrowserSpeechAvailable() ? listBrowserVoices() : Promise.resolve([]),
      ]);

      const options: VoiceOption[] = [
        ...(server?.voices ?? []).map((voice) => ({
          ...voice,
          source: 'server' as const,
        })),
        ...browser.map((voice) => ({ ...voice, source: 'browser' as const })),
      ];

      const preferred =
        server?.configured && server.defaultVoiceId
          ? options.find((voice) => voice.id === server.defaultVoiceId)
          : (options.find(
              (voice) => voice.source === 'browser' && voice.language.startsWith('en'),
            ) ?? options[0]);

      set({
        voices: options,
        voicesLoaded: true,
        serverConfigured: Boolean(server?.configured),
        serverProviderName: server?.provider ?? null,
        serverSupportsWordTiming: Boolean(server?.capabilities?.supportsWordTiming),
        maxCharsPerChunk: server?.capabilities?.maxCharsPerChunk ?? 2500,
        voiceId: get().voiceId ?? preferred?.id ?? null,
        providerName:
          get().providerName ??
          (preferred?.source === 'server' ? (server?.provider ?? null) : BROWSER_PROVIDER),
        wordTimingSource: server?.capabilities?.supportsWordTiming ? 'provider-exact' : 'estimated',
      });
    },

    prepareQueue(queue, documentId) {
      cancelInFlight();
      browserHandle?.cancel();
      stopTicker();
      chunkTimings.clear();

      const state = get();
      const voice = state.voices.find((candidate) => candidate.id === state.voiceId);
      const provider =
        voice?.source === 'server' ? (state.serverProviderName ?? 'server') : BROWSER_PROVIDER;

      const chunks = buildChunks(queue.entries, {
        maxChars: provider === BROWSER_PROVIDER ? 4000 : state.maxCharsPerChunk,
        voiceId: state.voiceId ?? '',
        speed: state.speed,
        language: 'en-US',
        provider,
        documentId,
      });

      // Hard guarantee that queueing did not change the text to be spoken.
      assertChunkingIsLossless(queue.entries, chunks);

      set({
        chunks,
        chunkStates: {},
        queueSentences: queue.entries.map((entry) => entry.sentence),
        providerName: provider,
        activeSentenceId: queue.entries[0]?.sentence.id ?? null,
        activeParagraphId: queue.entries[0]?.sentence.paragraphId ?? null,
        activeRegionId: queue.entries[0]?.sentence.regionId ?? null,
        activePage: queue.entries[0]?.sentence.pageNumber ?? null,
        activeChunkId: null,
        activeWordIndex: null,
        audioTimestamp: 0,
        // Prepared, not playing: audio never starts without a deliberate action.
        state: queue.entries.length > 0 ? 'paused' : 'idle',
        error: null,
      });
    },

    async play() {
      const state = get();
      if (state.state === 'error') return;
      if (state.queueSentences.length === 0) return;

      if (state.providerName === BROWSER_PROVIDER) {
        if (state.state === 'paused' && browserHandle) {
          resumeBrowserSpeech();
          dispatch({ type: 'PLAY' });
          return;
        }
        dispatch({ type: 'PLAY' });
        speakSentenceWithBrowser(state.activeSentenceId ?? state.queueSentences[0].id);
        return;
      }

      const element = getAudioElement();
      if (state.activeChunkId && element.src) {
        element.playbackRate = state.speed;
        element.volume = state.volume;
        await element.play().catch(() => undefined);
        dispatch({ type: 'PLAY' });
        startTicker();
        return;
      }

      dispatch({ type: 'PLAY' });
      await playFromSentence(state.activeSentenceId ?? state.queueSentences[0].id);
    },

    pause() {
      const state = get();
      if (state.providerName === BROWSER_PROVIDER) pauseBrowserSpeech();
      else audioElement?.pause();
      stopTicker();
      dispatch({ type: 'PAUSE' });
    },

    stop() {
      const state = get();
      if (state.providerName === BROWSER_PROVIDER) cancelBrowserSpeech();
      else if (audioElement) {
        audioElement.pause();
        audioElement.currentTime = 0;
      }
      browserHandle?.cancel();
      browserHandle = null;
      stopTicker();
      cancelInFlight();
      dispatch({ type: 'STOP' });
    },

    async next() {
      const index = currentIndex();
      const { queueSentences } = get();
      const target = queueSentences[index + 1];
      if (!target) return;
      await get().seekToSentence(target.id);
    },

    async previous() {
      const index = currentIndex();
      const { queueSentences } = get();
      const target = queueSentences[Math.max(0, index - 1)];
      if (!target) return;
      await get().seekToSentence(target.id);
    },

    async seekToSentence(sentenceId) {
      const state = get();
      const sentence = state.queueSentences.find((candidate) => candidate.id === sentenceId);
      if (!sentence) return;

      const wasPlaying = state.state === 'playing' || state.state === 'buffering';
      dispatch({
        type: 'SEEK_SENTENCE',
        sentenceId: sentence.id,
        paragraphId: sentence.paragraphId,
        regionId: sentence.regionId,
        page: sentence.pageNumber,
      });

      browserHandle?.cancel();
      stopTicker();

      if (wasPlaying) {
        await playFromSentence(sentence.id);
      } else if (audioElement) {
        audioElement.pause();
        dispatch({ type: 'PAUSE' });
      }
    },

    async restartParagraph() {
      const state = get();
      if (!state.activeParagraphId) return;
      const first = state.queueSentences.find(
        (sentence) => sentence.paragraphId === state.activeParagraphId,
      );
      if (first) await get().seekToSentence(first.id);
    },

    skipSeconds(delta) {
      const state = get();
      if (state.providerName === BROWSER_PROVIDER) {
        // SpeechSynthesis has no seekable timeline, so a time skip becomes a
        // sentence step. The control does something real rather than nothing.
        void (delta > 0 ? get().next() : get().previous());
        return;
      }
      const element = audioElement;
      if (!element || !Number.isFinite(element.duration)) return;
      element.currentTime = Math.min(
        Math.max(0, element.currentTime + delta),
        element.duration || 0,
      );
      dispatch({ type: 'SEEK_TIME', audioTimestamp: element.currentTime });
      dispatch({ type: 'SEEK_COMMITTED' });
    },

    setSpeed(speed) {
      const state = get();
      dispatch({ type: 'SET_SPEED', speed });
      const next = get().speed;

      if (state.providerName === BROWSER_PROVIDER) {
        // The engine cannot change rate mid-utterance; restart THIS sentence
        // rather than the document, so the reading position is preserved.
        if (state.state === 'playing' && state.activeSentenceId) {
          speakSentenceWithBrowser(state.activeSentenceId);
        }
        return;
      }
      // Server audio is resampled in place: the playhead does not move.
      if (audioElement) audioElement.playbackRate = next;
    },

    setVolume(volume) {
      dispatch({ type: 'SET_VOLUME', volume });
      if (audioElement) audioElement.volume = get().volume;
    },

    async setVoice(voiceId) {
      const state = get();
      const voice = state.voices.find((candidate) => candidate.id === voiceId);
      if (!voice) return;

      const provider =
        voice.source === 'server' ? (state.serverProviderName ?? 'server') : BROWSER_PROVIDER;
      const wasPlaying = state.state === 'playing';
      const keepSentence = state.activeSentenceId;

      browserHandle?.cancel();
      audioElement?.pause();
      stopTicker();
      cancelInFlight();
      // Existing audio was generated with the old voice, so it is discarded.
      for (const url of audioUrlOrder) URL.revokeObjectURL(url);
      audioUrlOrder = [];
      chunkTimings.clear();

      dispatch({ type: 'SET_VOICE', voiceId, provider });
      set({
        chunkStates: {},
        wordTimingSource:
          provider === BROWSER_PROVIDER
            ? 'browser-boundary'
            : state.serverSupportsWordTiming
              ? 'provider-exact'
              : 'estimated',
      });

      if (keepSentence && wasPlaying) await playFromSentence(keepSentence);
    },

    dismissError() {
      dispatch({ type: 'CLEAR_ERROR' });
    },

    teardown() {
      cancelInFlight();
      browserHandle?.cancel();
      cancelBrowserSpeech();
      stopTicker();
      if (audioElement) {
        audioElement.pause();
        audioElement.src = '';
      }
      for (const url of audioUrlOrder) URL.revokeObjectURL(url);
      audioUrlOrder = [];
      chunkTimings.clear();
    },
  };
});

/** Per-chunk timing metadata, kept out of React state because it is large. */
const chunkTimings = new Map<
  string,
  { timingSource: TimingSource; wordTimings?: TTSResultWordTiming[] }
>();

export const getChunkTimingSource = (chunkId: string | null): TimingSource =>
  (chunkId ? chunkTimings.get(chunkId)?.timingSource : undefined) ?? 'none';
