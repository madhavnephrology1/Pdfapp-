#!/usr/bin/env node
/**
 * Writes every generated test fixture to disk for inspection.
 *
 * The fixtures are produced by the dependency-free PDF writer in
 * packages/test-fixtures, so this repository never redistributes a third-party
 * document. Tests generate them in memory and do not need this script; it
 * exists so you can open them in a PDF viewer and see what the pipeline sees.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'fixtures');

// The fixtures package ships TypeScript source. Vite (already present as a
// Vitest dependency) loads it without adding a build step of its own.
const { createServer } = await import('vite');
const server = await createServer({
  configFile: false,
  root,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
});

try {
  const { FIXTURES } = await server.ssrLoadModule(
    join(root, 'packages/test-fixtures/src/fixtures.ts'),
  );

  await mkdir(outDir, { recursive: true });

  for (const [name, build] of Object.entries(FIXTURES)) {
    const bytes = build();
    const path = join(outDir, `${name}.pdf`);
    await writeFile(path, bytes);
    console.log(
      `${name.padEnd(20)} ${(bytes.length / 1024).toFixed(1).padStart(7)} KB  ->  ${path}`,
    );
  }

  console.log(`\n${Object.keys(FIXTURES).length} fixtures written to ${outDir}`);
} finally {
  await server.close();
}
