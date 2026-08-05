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
import { pauseBeforeNextSentence } from '@/features/playback/pacing';
import { remapSentence } from '@/features/playback/resume';
import { chooseDefaultVoice } from '@/features/playback/voice-choice';
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
import { loadVoicePreference, saveVoicePreference } from '@/lib/voice-preference';

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
  /**
   * A rebuilt queue that arrived mid-utterance. Applying it immediately would
   * cut the audio off, so it waits for a pause or for the end of what is
   * already prepared. Null when the prepared queue is up to date.
   */
  pendingQueue: { queue: ReadingQueue; documentId: string } | null;
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
/** Timer for the silence between two sentences; see features/playback/pacing. */
let pauseTimer: number | null = null;
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

/**
 * Cancels a pending inter-sentence pause.
 *
 * Every path that stops or redirects playback must call this. A pause is a
 * scheduled call to speak the NEXT sentence, so leaving one armed means audio
 * starting again a moment after the reader pressed stop.
 */
function clearPendingPause(): void {
  if (pauseTimer !== null) {
    window.clearTimeout(pauseTimer);
    pauseTimer = null;
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

    clearPendingPause();
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
        if (get().state !== 'playing') return;
        // The gap between two sentences is a seam where a newly analysed queue
        // can be taken on without interrupting anything, so it is checked here
        // rather than only at the end of the document.
        void continueIntoPendingQueue(sentence.id).then((continued) => {
          if (continued) return;
          // Re-read the queue: a pass may have landed and been applied even
          // when playback did not continue into it.
          const now = get();
          const resumeAt = now.queueSentences.findIndex((s) => s.id === sentence.id) + 1;
          if (resumeAt <= 0 || resumeAt >= now.queueSentences.length) {
            dispatch({ type: 'END_OF_QUEUE' });
            return;
          }
          const nextSentence = now.queueSentences[resumeAt];
          const wait = pauseBeforeNextSentence({
            finished: sentence,
            next: nextSentence,
            speed: now.speed,
          });
          if (wait <= 0) {
            speakSentenceWithBrowser(nextSentence.id);
            return;
          }
          clearPendingPause();
          pauseTimer = window.setTimeout(() => {
            pauseTimer = null;
            // The reader may have paused, stopped or seeked during the silence.
            if (get().state !== 'playing') return;
            speakSentenceWithBrowser(nextSentence.id);
          }, wait);
        });
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
      // A chunk boundary is the natural seam for taking on a queue rebuilt by a
      // later analysis pass: nothing is playing, and the next chunk has not
      // started. Waiting for the end of the whole queue instead would mean
      // reading a long provisional prefix that is already known to be stale.
      const lastSpoken = match.chunk.sentenceIds.at(-1) ?? null;
      void continueIntoPendingQueue(lastSpoken).then((continued) => {
        if (continued) return;
        const after = get();
        const index = after.chunks.findIndex((chunk) => chunk.id === match.chunk.id);
        // The chunk that just finished is gone from a rebuilt queue, and there
        // was nowhere to carry on from. Stop here rather than falling back to
        // index 0, which would silently restart the document.
        const nextChunk = index < 0 ? undefined : after.chunks[index + 1];
        if (!nextChunk) {
          dispatch({ type: 'END_OF_QUEUE' });
          return;
        }
        void playFromSentence(nextChunk.sentenceIds[0]);
      });
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

  /**
   * Rebuilds the synthesis chunks for a queue, keeping the reader's place.
   *
   * The queue is rebuilt whenever a setting changes and, while a document is
   * still being analysed, each time another pass covers more pages. Both can
   * change which sentences exist and what their ids are, so the active sentence
   * is carried across by matching rather than by index.
   */
  const applyQueue = (queue: ReadingQueue, documentId: string): void => {
    cancelInFlight();
    clearPendingPause();
    browserHandle?.cancel();
    stopTicker();
    chunkTimings.clear();

    // The rebuilt chunks get new ids, so nothing can reach the audio generated
    // for the old ones. It is released here rather than left to accumulate: a
    // long document rebuilds its queue once per analysis pass.
    if (audioElement) {
      audioElement.pause();
      audioElement.onended = null;
      audioElement.onerror = null;
    }
    for (const url of audioUrlOrder) URL.revokeObjectURL(url);
    audioUrlOrder = [];

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

    const sentences = queue.entries.map((entry) => entry.sentence);
    const match = remapSentence(state.activeSentenceId, state.queueSentences, sentences);
    const active = sentences[match?.index ?? 0] ?? null;

    set({
      chunks,
      chunkStates: {},
      queueSentences: sentences,
      pendingQueue: null,
      providerName: provider,
      activeSentenceId: active?.id ?? null,
      activeParagraphId: active?.paragraphId ?? null,
      activeRegionId: active?.regionId ?? null,
      activePage: active?.pageNumber ?? null,
      // The audio for the old chunks is gone, so nothing is loaded any more.
      activeChunkId: null,
      activeWordIndex: null,
      audioTimestamp: 0,
      // Prepared, not playing: audio never starts without a deliberate action.
      state: queue.entries.length > 0 ? 'paused' : 'idle',
      error: null,
    });
  };

  /** Applies a queue that was held back during playback. */
  const flushPendingQueue = (): boolean => {
    const pending = get().pendingQueue;
    if (!pending) return false;
    applyQueue(pending.queue, pending.documentId);
    return true;
  };

  /**
   * Called when playback runs out of prepared audio.
   *
   * While a document is still being analysed, "the end of the queue" usually
   * only means the end of the pages analysed so far. If more text has arrived
   * in the meantime, carry on into it instead of stopping.
   *
   * Returns true when playback continued.
   */
  const continueIntoPendingQueue = async (lastSpokenId: string | null): Promise<boolean> => {
    const before = get();
    if (!before.pendingQueue) return false;
    const wasPlaying = before.state === 'playing';
    const previousSentences = before.queueSentences;

    if (!flushPendingQueue()) return false;
    if (!wasPlaying) return false;

    const { queueSentences } = get();
    const match = remapSentence(lastSpokenId, previousSentences, queueSentences);
    if (!match) return false;
    // An exact match is the sentence that just finished, so move past it. An
    // approximate one already points at the next sentence still in the queue.
    const target = queueSentences[match.exact ? match.index + 1 : match.index];
    if (!target) return false;

    dispatch({
      type: 'SEEK_SENTENCE',
      sentenceId: target.id,
      paragraphId: target.paragraphId,
      regionId: target.regionId,
      page: target.pageNumber,
    });
    await playFromSentence(target.id);
    return true;
  };

  return {
    ...initialPlaybackSnapshot,
    chunks: [],
    chunkStates: {},
    queueSentences: [],
    pendingQueue: null,
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

      const preferred = chooseDefaultVoice({
        voices: options,
        savedVoiceId: get().voiceId ?? loadVoicePreference(),
        serverDefaultVoiceId: server?.defaultVoiceId ?? null,
        serverConfigured: Boolean(server?.configured),
        preferredLanguage:
          typeof navigator === 'undefined' ? undefined : (navigator.language ?? undefined),
      });

      set({
        voices: options,
        voicesLoaded: true,
        serverConfigured: Boolean(server?.configured),
        serverProviderName: server?.provider ?? null,
        serverSupportsWordTiming: Boolean(server?.capabilities?.supportsWordTiming),
        maxCharsPerChunk: server?.capabilities?.maxCharsPerChunk ?? 2500,
        voiceId: preferred?.id ?? null,
        providerName:
          preferred?.source === 'server' ? (server?.provider ?? null) : BROWSER_PROVIDER,
        wordTimingSource: server?.capabilities?.supportsWordTiming ? 'provider-exact' : 'estimated',
      });
    },

    prepareQueue(queue, documentId) {
      const { state } = get();
      if (state === 'playing' || state === 'buffering') {
        // Rebuilding the chunks would discard the audio that is playing right
        // now. Hold the new queue instead; `pause`, `stop` and the end of the
        // prepared audio all pick it up.
        set({ pendingQueue: { queue, documentId } });
        return;
      }
      applyQueue(queue, documentId);
    },

    async play() {
      if (get().queueSentences.length === 0) return;
      // A playback error is recoverable and its message says to press play
      // again — so pressing play has to actually try again. Returning early
      // here would leave a control that cannot do what it tells you to.
      if (get().state === 'error') dispatch({ type: 'CLEAR_ERROR' });
      const state = get();

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
      // Disarm before pausing: a pause pressed during the silence between two
      // sentences must not leave a timer that speaks the next one anyway.
      clearPendingPause();
      if (state.providerName === BROWSER_PROVIDER) pauseBrowserSpeech();
      else audioElement?.pause();
      stopTicker();
      dispatch({ type: 'PAUSE' });
      // Now that nothing is being spoken, take on any queue that was held back
      // while it was. Playback resumes from the start of the current sentence
      // rather than the exact millisecond, because the chunk it sat in has been
      // rebuilt.
      flushPendingQueue();
    },

    stop() {
      const state = get();
      if (state.providerName === BROWSER_PROVIDER) cancelBrowserSpeech();
      else if (audioElement) {
        audioElement.pause();
        audioElement.currentTime = 0;
      }
      clearPendingPause();
      browserHandle?.cancel();
      browserHandle = null;
      stopTicker();
      cancelInFlight();
      dispatch({ type: 'STOP' });
      flushPendingQueue();
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

      clearPendingPause();
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

      // Remember it, so the next visit speaks in the voice that was chosen
      // rather than resetting to whichever voice the platform lists first.
      saveVoicePreference(voiceId);

      const provider =
        voice.source === 'server' ? (state.serverProviderName ?? 'server') : BROWSER_PROVIDER;
      const wasPlaying = state.state === 'playing';
      const keepSentence = state.activeSentenceId;

      clearPendingPause();
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
      clearPendingPause();
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
      set({ pendingQueue: null });
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
