import { join } from 'node:path';
const root = '/home/user/Pdfapp-';
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
const { extractDocument } = await server.ssrLoadModule(
  join(root, 'apps/web/features/extraction/pipeline.ts'),
);
const { twoColumnPaperPdf } = await server.ssrLoadModule(
  join(root, 'packages/test-fixtures/src/fixtures.ts'),
);
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = join(
  root,
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
);
const task = pdfjs.getDocument({
  data: twoColumnPaperPdf(),
  useSystemFonts: false,
  disableFontFace: true,
  verbosity: 0,
});
const doc = await task.promise;
const inputs = [];
for (let n = 1; n <= doc.numPages; n++) {
  const p = await doc.getPage(n);
  const vp = p.getViewport({ scale: 1 });
  const c = await p.getTextContent();
  inputs.push({
    pageNumber: n,
    width: vp.width,
    height: vp.height,
    rotation: vp.rotation,
    items: c.items
      .filter((i) => 'str' in i)
      .map((i) => ({
        str: i.str,
        dir: i.dir,
        width: i.width,
        height: i.height,
        transform: i.transform,
        fontName: i.fontName,
        hasEOL: i.hasEOL,
      })),
  });
}
const r = extractDocument('d', inputs);
console.log('--- OUTLINE ---');
for (const o of r.outline) console.log(`  p${o.pageNumber} L${o.level} ${JSON.stringify(o.title)}`);
console.log('--- columns:', r.pages.map((p) => p.columnCount).join(','));
await task.destroy();
await server.close();
