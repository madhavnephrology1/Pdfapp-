import { describe, expect, it } from 'vitest';
import { FIXTURES, singlePagePdf, fiftyPagePdf, twoColumnPaperPdf } from '@pdfreader/test-fixtures';
import { loadPdfInNode } from '../helpers/node-pdf';

/**
 * Guards the fixture generator itself. If these fail, every downstream
 * extraction test is meaningless, so they run first.
 */
describe('fixture PDF writer', () => {
  it('produces a PDF that PDF.js can open', async () => {
    const { doc, close } = await loadPdfInNode(singlePagePdf());
    expect(doc.numPages).toBe(1);
    await close();
  });

  it('round-trips text through the PDF text layer verbatim', async () => {
    const { doc, close } = await loadPdfInNode(singlePagePdf());
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
    expect(text).toContain('Renal Physiology Overview');
    expect(text).toContain('Glomerular filtration produces an ultra-');
    await close();
  });

  it('emits positional transforms for every item', async () => {
    const { doc, close } = await loadPdfInNode(singlePagePdf());
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!('str' in item)) continue;
      expect(item.transform).toHaveLength(6);
      expect(Number.isFinite(item.transform[4])).toBe(true);
      expect(Number.isFinite(item.transform[5])).toBe(true);
    }
    await close();
  });

  it('generates a 50-page document', async () => {
    const { doc, close } = await loadPdfInNode(fiftyPagePdf(50));
    expect(doc.numPages).toBe(50);
    await close();
  });

  it('places two-column runs at distinct x offsets', async () => {
    const { doc, close } = await loadPdfInNode(twoColumnPaperPdf());
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const xs = new Set(
      content.items.filter((i) => 'str' in i).map((i) => Math.round(i.transform[4])),
    );
    expect(xs.has(54)).toBe(true);
    expect(xs.has(320)).toBe(true);
    await close();
  });

  it('opens every registered fixture', async () => {
    for (const [name, build] of Object.entries(FIXTURES)) {
      const { doc, close } = await loadPdfInNode(build());
      expect(doc.numPages, `fixture ${name}`).toBeGreaterThan(0);
      await close();
    }
  });
});
