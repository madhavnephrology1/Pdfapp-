'use client';

import { useEffect } from 'react';
import { FONT_SIZE_RANGE, SPEED_OPTIONS } from '@/features/settings/defaults';
import { isPlaying } from '@/features/playback/machine';
import { useDocumentStore } from '@/stores/document-store';
import { usePlaybackStore } from '@/stores/playback-store';

/** True when the user is typing, so shortcuts must not steal the key. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable ||
    target.getAttribute('role') === 'textbox'
  );
}

/**
 * Global keyboard shortcuts.
 *
 * Browser shortcuts are left alone: Ctrl/Cmd combinations other than the two
 * text-size ones are never intercepted, and nothing fires while a text field
 * has focus.
 */
export function useKeyboardShortcuts(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return;

      const playback = usePlaybackStore.getState();
      const document = useDocumentStore.getState();
      const modifier = event.ctrlKey || event.metaKey;

      // Reader text size. These deliberately shadow the browser's page zoom
      // while the reader has focus, because sizing the reading text is the
      // more useful action here; every other browser shortcut is untouched.
      if (modifier && (event.key === '+' || event.key === '=' || event.key === '-')) {
        event.preventDefault();
        const delta = event.key === '-' ? -1 : 1;
        const next = Math.min(
          FONT_SIZE_RANGE.max,
          Math.max(FONT_SIZE_RANGE.min, document.settings.reader.fontSizePx + delta),
        );
        document.setSettings({
          reader: { ...document.settings.reader, fontSizePx: next },
        });
        return;
      }

      if (modifier) return;

      switch (event.key) {
        case ' ':
        case 'Spacebar': {
          event.preventDefault();
          if (isPlaying(playback.state)) playback.pause();
          else void playback.play();
          break;
        }

        case 'ArrowLeft': {
          event.preventDefault();
          if (event.shiftKey) playback.skipSeconds(-10);
          else void playback.previous();
          break;
        }

        case 'ArrowRight': {
          event.preventDefault();
          if (event.shiftKey) playback.skipSeconds(10);
          else void playback.next();
          break;
        }

        case '+':
        case '=': {
          event.preventDefault();
          const index = SPEED_OPTIONS.indexOf(playback.speed);
          const next =
            SPEED_OPTIONS[Math.min(SPEED_OPTIONS.length - 1, index + 1)] ?? playback.speed;
          playback.setSpeed(next);
          break;
        }

        case '-':
        case '_': {
          event.preventDefault();
          const index = SPEED_OPTIONS.indexOf(playback.speed);
          const next = SPEED_OPTIONS[Math.max(0, index - 1)] ?? playback.speed;
          playback.setSpeed(next);
          break;
        }

        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
