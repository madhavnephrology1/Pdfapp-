/**
 * Where this build is served from.
 *
 * Served from the root of a domain — a local dev server, `next start`, the
 * Docker image — this is empty and every absolute path works as written.
 *
 * On GitHub Pages a project site lives under a subdirectory named after the
 * repository, so `/pdf.worker.min.mjs` would 404. Next rewrites the paths it
 * controls (pages, its own chunks, `next/link`) from `basePath`, but it cannot
 * rewrite a string we hand to PDF.js. Those few paths are built through
 * `asset()` instead.
 *
 * The value is inlined at build time, so it is correct inside the extraction
 * worker as well, where there is no `document` to read a <base> from.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** An absolute path within this deployment, honouring the base path. */
export function asset(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_PATH}${normalized}`;
}
