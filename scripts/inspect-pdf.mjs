#!/usr/bin/env node
/**
 * Runs the extraction pipeline over real PDFs and prints a diagnostic report.
 *
 * The automated tests use PDFs this repository generates itself, which cannot
 * exercise embedded font subsetting, ToUnicode CMaps, or the text-item emission
 * patterns of real producers. This tool points the same pipeline at arbitrary
 * files so those cases can be inspected by eye.
 *
 *   node scripts/inspect-pdf.mjs <file-or-directory>... [--text] [--pages N]
 *
 *   --text     print the reading text Clean Mode would speak
 *   --pages N  limit extraction to the first N pages
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const showText = args.includes('--text');
const pageLimitIndex = args.indexOf('--pages');
const pageLimit = pageLimitIndex >= 0 ? Number(args[pageLimitIndex + 1]) : Infinity;
const inputs = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--pages');

if (inputs.length === 0) {
  console.error('usage: node scripts/inspect-pdf.mjs <file-or-directory>... [--text] [--pages N]');
  process.exit(1);
}

async function collectPdfs(target) {
  const info = await stat(target);
  if (info.isFile()) return extname(target).toLowerCase() === '.pdf' ? [target] : [];
  const entries = await readdir(target);
  const found = [];
  for (const entry of entries) found.push(...(await collectPdfs(join(target, entry))));
  return found;
}

const { createServer } = await import('vite');
const server = await createServer({
  configFile: false,
  root,
  logLevel: 'error',
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  resolve: {
    alias: {
      '@': join(root, 'apps/web'),
      '@pdfreader/shared-types': join(root, 'packages/shared-types/src/index.ts'),
    },
  },
});

try {
  const { extractDocument } = await server.ssrLoadModule(
    join(root, 'apps/web/features/extraction/pipeline.ts'),
  );
  const { applyReadingMode, DEFAULT_CATEGORY_SETTINGS, summarizeExclusions } =
    await server.ssrLoadModule(join(root, 'apps/web/features/classification/modes.ts'));
  // Use the real queue builder so what is reported matches what the app speaks:
  // reading modes alone do not account for table and citation handling.
  const { buildReadingQueue } = await server.ssrLoadModule(
    join(root, 'apps/web/features/reader/queue.ts'),
  );
  const { DEFAULT_SETTINGS } = await server.ssrLoadModule(
    join(root, 'apps/web/features/settings/defaults.ts'),
  );

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = join(
    root,
    'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  );

  const files = (await Promise.all(inputs.map((i) => collectPdfs(resolve(i))))).flat();
  if (files.length === 0) console.error('No PDF files found.');

  for (const file of files) {
    console.log(`\n${'='.repeat(78)}\n${file}\n${'='.repeat(78)}`);
    const started = Date.now();

    let task;
    try {
      const bytes = new Uint8Array(await readFile(file));
      task = pdfjs.getDocument({
        data: bytes,
        useSystemFonts: false,
        disableFontFace: true,
        verbosity: 0,
      });
      const doc = await task.promise;

      const pageInputs = [];
      const pageCount = Math.min(doc.numPages, pageLimit);
      for (let n = 1; n <= pageCount; n += 1) {
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        pageInputs.push({
          pageNumber: n,
          width: viewport.width,
          height: viewport.height,
          rotation: viewport.rotation,
          items: content.items
            .filter((item) => 'str' in item)
            .map((item) => ({
              str: item.str,
              dir: item.dir,
              width: item.width,
              height: item.height,
              transform: item.transform,
              fontName: item.fontName,
              hasEOL: item.hasEOL,
            })),
        });
        page.cleanup();
      }

      const result = extractDocument('inspect', pageInputs);
      const applied = applyReadingMode(result.regions, 'clean', DEFAULT_CATEGORY_SETTINGS);
      const summary = summarizeExclusions(applied);
      const queue = buildReadingQueue(result.regions, result.sentences, DEFAULT_SETTINGS);
      const elapsed = Date.now() - started;

      console.log(
        `pages ${doc.numPages}${pageCount < doc.numPages ? ` (first ${pageCount} examined)` : ''}` +
          `  items ${result.rawItems.length}  duplicates removed ${result.removedDuplicates.length}` +
          `  body font ${result.bodyFontSize}pt  ${elapsed}ms`,
      );

      const columns = {};
      const scanned = [];
      const uncertain = [];
      for (const page of result.pages) {
        columns[page.columnCount] = (columns[page.columnCount] ?? 0) + 1;
        if (page.likelyScanned) scanned.push(page.pageNumber);
        if (page.readingOrderUncertain) uncertain.push(page.pageNumber);
      }
      console.log(
        `columns  ${Object.entries(columns)
          .map(([n, count]) => `${n}-col: ${count} page(s)`)
          .join('   ')}`,
      );
      if (scanned.length) console.log(`scanned pages  ${scanned.slice(0, 12).join(', ')}`);
      if (uncertain.length)
        console.log(
          `uncertain reading order  ${uncertain.length} page(s): ${uncertain.slice(0, 12).join(', ')}`,
        );

      const byType = {};
      for (const region of applied) byType[region.type] = (byType[region.type] ?? 0) + 1;
      console.log(
        `regions  ${Object.entries(byType)
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => `${type}:${count}`)
          .join('  ')}`,
      );
      console.log(
        `Clean Mode  reads ${summary.includedWords} words, skips ${summary.excludedWords} ` +
          `(${((summary.excludedWords / Math.max(1, summary.includedWords + summary.excludedWords)) * 100).toFixed(1)}%) ` +
          `in ${summary.excludedRegions} region(s)`,
      );
      for (const [type, stats] of Object.entries(summary.byType)) {
        console.log(
          `    skipped ${type.padEnd(14)} ${stats.regions} region(s), ${stats.words} words`,
        );
      }

      const excluded = applied.filter((r) => !r.included);
      if (excluded.length > 0) {
        console.log('  sample exclusions:');
        for (const region of excluded.slice(0, 6)) {
          console.log(
            `    [${region.type} ${Math.round(region.confidence * 100)}% p${region.pageNumber}] ` +
              JSON.stringify(region.text.slice(0, 88)),
          );
        }
      }

      console.log(
        `queue  ${queue.entries.length} sentence(s), ${queue.totalCharacters} chars to speak`,
      );

      if (showText) {
        const text = queue.entries
          .map((entry) => entry.speechText)
          .join(' ')
          .replace(/\s+/g, ' ');
        console.log(`\n--- spoken text (${text.length} chars) ---\n${text.slice(0, 2500)}`);
      }
    } catch (error) {
      console.log(`FAILED: ${error?.message ?? error}`);
    } finally {
      await task?.destroy().catch(() => {});
    }
  }
} finally {
  await server.close();
}
