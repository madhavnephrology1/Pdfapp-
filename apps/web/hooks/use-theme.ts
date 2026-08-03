'use client';

import { useCallback, useSyncExternalStore } from 'react';
import type { ReaderTheme } from '@pdfreader/shared-types';

const STORAGE_KEY = 'pdf-reader-theme';

/**
 * Theme and motion preferences.
 *
 * Both are external browser state (localStorage and a media query), so they are
 * read through useSyncExternalStore rather than mirrored into React state in an
 * effect. That keeps the server and client renders consistent and avoids the
 * flash of a wrong theme on hydration.
 */

function resolve(theme: ReaderTheme): 'light' | 'dark' | 'sepia' {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/* ------------------------------ theme ------------------------------ */

const themeListeners = new Set<() => void>();

function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  // Another tab changing the preference must update this one too.
  window.addEventListener('storage', listener);
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  query.addEventListener('change', listener);
  return () => {
    themeListeners.delete(listener);
    window.removeEventListener('storage', listener);
    query.removeEventListener('change', listener);
  };
}

function getStoredTheme(): ReaderTheme {
  try {
    return (window.localStorage.getItem(STORAGE_KEY) as ReaderTheme | null) ?? 'system';
  } catch {
    return 'system';
  }
}

/** The server has no preference to read, so it renders the default. */
const getServerTheme = (): ReaderTheme => 'system';

export function useTheme(): { theme: ReaderTheme; setTheme: (theme: ReaderTheme) => void } {
  const theme = useSyncExternalStore(subscribeTheme, getStoredTheme, getServerTheme);

  const setTheme = useCallback((next: ReaderTheme) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A browser with storage disabled still gets the theme for this session.
    }
    document.documentElement.setAttribute('data-theme', resolve(next));
    for (const listener of themeListeners) listener();
  }, []);

  return { theme, setTheme };
}

/* -------------------------- reduced motion ------------------------- */

function subscribeMotion(listener: () => void): () => void {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

const getMotionSnapshot = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Assume motion is allowed on the server; the client corrects on hydration. */
const getServerMotion = (): boolean => false;

/** True when the user asked the system to minimise motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, getMotionSnapshot, getServerMotion);
}
