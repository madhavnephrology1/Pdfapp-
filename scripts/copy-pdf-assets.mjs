#!/usr/bin/env node
/**
 * Copies PDF.js runtime assets into apps/web/public.
 *
 * These are served from this app's own origin rather than a CDN, so opening a
 * document never tells a third party that you did. Run automatically before
 * `dev` and `build`.
 */

import { cp, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const source = join(root, 'node_modules', 'pdfjs-dist');
const target = join(root, 'apps', 'web', 'public');

const assets = [
  // The LEGACY worker, to match the legacy main build the app imports.
  ['legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['standard_fonts', 'pdf-standard-fonts'],
  ['cmaps', 'pdf-cmaps'],
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

await mkdir(target, { recursive: true });

for (const [from, to] of assets) {
  const src = join(source, from);
  if (!(await exists(src))) {
    console.warn(`[copy-pdf-assets] skipped missing ${from}`);
    continue;
  }
  await cp(src, join(target, to), { recursive: true, force: true });
  console.log(`[copy-pdf-assets] ${from} -> public/${to}`);
}
