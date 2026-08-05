import { expect, test, type Page } from '@playwright/test';
import { writeFixture } from './fixtures';

/**
 * End-to-end coverage of the acceptance criteria.
 *
 * These run against a real browser so the extraction worker, PDF rendering,
 * IndexedDB persistence and the playback engine are all genuinely exercised.
 */

async function upload(page: Page, fixture: Parameters<typeof writeFixture>[0]): Promise<void> {
  const path = await writeFixture(fixture);
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', path);
  // Reading text appears as soon as the first pages have been analysed, which
  // is the point of the incremental pipeline. Most tests below assert on
  // classification that only a whole-document view can produce — a running
  // header cannot be recognised from one page — so they wait for the final
  // pass, reported by the extraction progress caption.
  await expect(page.locator('#reading-text')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/\d+ pages extracted/)).toBeVisible({ timeout: 60_000 });
}

test.describe('upload and extraction', () => {
  test('renders pages and shows extracted reading text', async ({ page }) => {
    await upload(page, 'single-page');

    const readingText = page.locator('#reading-text');
    await expect(readingText).toContainText('Renal Physiology Overview');
    await expect(readingText).toContainText('The kidney maintains extracellular fluid volume');

    // The PDF itself is rendered to a canvas.
    await expect(page.locator('canvas').first()).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Document navigation' })).toContainText(
      '1 page',
    );
  });

  test('leaves no provisional state behind once the last page is analysed', async ({ page }) => {
    await upload(page, 'fifty-page');

    const nav = page.getByRole('navigation', { name: 'Document navigation' });
    await expect(nav).toContainText('50 pages');
    // The warnings that qualify a partial classification must be gone: nothing
    // may be left describing the document as provisional once it is not.
    await expect(nav).not.toContainText('provisional');
    await expect(nav).not.toContainText('were analysed');
    await expect(page.getByText(/can be read now/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop analysing' })).toHaveCount(0);
  });

  test('joins a word split across lines and never shows the broken form', async ({ page }) => {
    await upload(page, 'single-page');
    const text = await page.locator('#reading-text').innerText();
    expect(text).toContain('ultrafiltrate of plasma');
    expect(text).not.toContain('ultra- filtrate');
  });

  test('reports a scanned page as unreadable rather than inventing text', async ({ page }) => {
    await upload(page, 'mixed-scanned');
    const nav = page.getByRole('navigation', { name: 'Document navigation' });
    await expect(nav).toContainText('appear to be scans with no text layer');
    await expect(nav).toContainText('no text has been invented');
  });

  test('rejects a file whose bytes are not a PDF', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[type="file"]', {
      name: 'not-really.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('This is plain text pretending to be a PDF.'),
    });
    await expect(page.getByRole('alert').filter({ hasText: 'not a PDF' })).toBeVisible();
  });
});

test.describe('content review', () => {
  test('lists skipped regions with evidence and restores them', async ({ page }) => {
    await upload(page, 'two-column-paper');

    await page.getByRole('button', { name: /Content review/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Content review' });
    await expect(dialog).toBeVisible();

    // Furniture is excluded, listed, and explained.
    await expect(dialog.getByText(/regions? .* are being skipped/)).toBeVisible();
    await expect(
      dialog.getByText('Journal of Clinical Nephrology', { exact: false }).first(),
    ).toBeVisible();

    await dialog
      .getByRole('button', { name: /Show the evidence/ })
      .first()
      .click();
    await expect(dialog.getByText(/appears on \d+ of \d+ pages/).first()).toBeVisible();

    // Everything skipped can be brought back.
    await dialog.getByRole('button', { name: 'Restore everything that was skipped' }).click();
    await expect(dialog.getByText('0 regions')).toBeVisible();

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#reading-text')).toContainText('Journal of Clinical Nephrology');
  });

  test('excluded content is shown in the reader, never hidden', async ({ page }) => {
    await upload(page, 'two-column-paper');
    // Skipped regions still appear, marked "Not read".
    await expect(page.locator('#reading-text').getByText('Not read').first()).toBeVisible();
  });
});

test.describe('text recognition', () => {
  /**
   * Runs against the mock provider, which returns two obviously-placeholder
   * words at low confidence. That is deliberate: it exercises the consent gate,
   * the uncertain-word marking and the correction flow without any real text
   * that could mask a mistake, and without contacting a vendor.
   */
  const openPanel = async (page: Page) => {
    await upload(page, 'mixed-scanned');
    await page.getByRole('button', { name: 'Text recognition' }).click();
    return page.getByRole('dialog', { name: 'Text recognition' });
  };

  test('will not send a page image until the reader agrees', async ({ page }) => {
    const panel = await openPanel(page);
    await expect(panel).toContainText('sending a picture of that page');
    // The action is visible but inert: nothing can be sent while consent is off.
    await expect(panel.getByRole('button', { name: 'Recognise this page' }).first()).toBeDisabled();
    await expect(panel).toContainText('will not send anything until you agree');
  });

  test('recognises a page, marks uncertain words, and keeps them out of the reader until added', async ({
    page,
  }) => {
    const panel = await openPanel(page);
    await panel.getByRole('checkbox').first().check();

    const recognise = panel.getByRole('button', { name: 'Recognise this page' }).first();
    await expect(recognise).toBeEnabled();
    await recognise.click();

    await panel.getByRole('button', { name: 'Review text' }).first().click();
    await expect(panel).toContainText('Read from an image');
    await expect(panel).toContainText('marked below as uncertain');
    // The mock returns placeholders at 40% confidence; both must be marked.
    await expect(panel.getByRole('button', { name: /unrecognized/ }).first()).toBeVisible();

    // Nothing has entered the reading text yet.
    await expect(page.locator('#reading-text')).not.toContainText('[unrecognized]');
  });

  test('adds recognised text to the reader only when asked, and marks it there', async ({
    page,
  }) => {
    const panel = await openPanel(page);
    await panel.getByRole('checkbox').first().check();
    await panel.getByRole('button', { name: 'Recognise this page' }).first().click();
    await panel.getByRole('button', { name: 'Review text' }).first().click();
    await panel.getByRole('button', { name: /Add this page to the reading text/ }).click();
    await panel.getByRole('button', { name: 'Close' }).click();

    const reader = page.locator('#reading-text');
    await expect(reader).toContainText('[unrecognized]');
    // It must never be able to pass as the document's own text.
    await expect(reader).toContainText('Read from an image of page');
    await expect(reader.locator('[data-text-source="ocr"]').first()).toBeVisible();
  });

  test('a correction replaces the recognised word in the reading text', async ({ page }) => {
    const panel = await openPanel(page);
    await panel.getByRole('checkbox').first().check();
    await panel.getByRole('button', { name: 'Recognise this page' }).first().click();
    await panel.getByRole('button', { name: 'Review text' }).first().click();

    await panel
      .getByRole('button', { name: /unrecognized/ })
      .first()
      .click();
    const input = panel.getByRole('textbox').first();
    await input.fill('Glomerulus');
    await input.press('Enter');

    await panel.getByRole('button', { name: /Add this page to the reading text/ }).click();
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#reading-text')).toContainText('Glomerulus');
  });

  test('taking a recognised page back out restores the document', async ({ page }) => {
    const panel = await openPanel(page);
    await panel.getByRole('checkbox').first().check();
    await panel.getByRole('button', { name: 'Recognise this page' }).first().click();
    await panel.getByRole('button', { name: 'Review text' }).first().click();
    await panel.getByRole('button', { name: /Add this page to the reading text/ }).click();
    await panel.getByRole('button', { name: /Take this page back out/ }).click();
    await panel.getByRole('button', { name: 'Close' }).click();

    await expect(page.locator('#reading-text')).not.toContainText('[unrecognized]');
  });
});

test.describe('reading modes', () => {
  test('Strict Verbatim reads the furniture that Clean Mode skips', async ({ page }) => {
    await upload(page, 'two-column-paper');

    const readingText = page.locator('#reading-text');
    await expect(readingText.getByText('Not read').first()).toBeVisible();

    await page.getByRole('radio', { name: /Strict Verbatim/ }).click();
    // In Strict Verbatim Mode nothing is marked as skipped.
    await expect(readingText.getByText('Not read')).toHaveCount(0);
  });

  test('Custom Mode categories change what is read', async ({ page }) => {
    await upload(page, 'fifty-page');
    await page.getByRole('radio', { name: 'Custom' }).click();
    await page.getByRole('button', { name: /Content review/ }).click();

    const dialog = page.getByRole('dialog', { name: 'Content review' });
    const headersToggle = dialog.getByRole('checkbox', { name: 'headers' });
    await expect(headersToggle).not.toBeChecked();
    await headersToggle.check();
    await expect(headersToggle).toBeChecked();
  });
});

test.describe('playback', () => {
  test('does not autoplay after upload', async ({ page }) => {
    await upload(page, 'single-page');
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0);
  });

  test('plays, highlights a sentence, pauses and resumes at the same place', async ({ page }) => {
    await upload(page, 'single-page');

    await page.getByRole('button', { name: 'Play' }).click();
    const active = page.locator('[aria-current="true"]');
    await expect(active).toBeVisible({ timeout: 20_000 });
    const before = await active.innerText();

    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
    // The same sentence is still the active one after pausing.
    expect(await page.locator('[aria-current="true"]').innerText()).toBe(before);

    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  });

  test('changing speed keeps the current sentence', async ({ page }) => {
    await upload(page, 'single-page');
    await page.getByRole('button', { name: 'Play' }).click();
    await expect(page.locator('[aria-current="true"]')).toBeVisible({
      timeout: 20_000,
    });

    const before = await page.locator('[aria-current="true"]').innerText();
    await page.getByTitle('Reading speed').selectOption('1.5');
    expect(await page.locator('[aria-current="true"]').innerText()).toBe(before);
  });

  test('clicking a sentence starts reading from there', async ({ page }) => {
    await upload(page, 'single-page');
    const sentences = page.locator('#reading-text [data-sentence-id]');
    const target = sentences.nth(2);
    const wanted = await target.innerText();
    await target.click();
    await expect(page.locator('[aria-current="true"]')).toHaveText(wanted);
  });

  test('next and previous sentence move the highlight', async ({ page }) => {
    await upload(page, 'single-page');
    await page.locator('#reading-text [data-sentence-id]').first().click();
    const first = await page.locator('[aria-current="true"]').innerText();

    await page.getByRole('button', { name: 'Next sentence' }).click();
    const second = await page.locator('[aria-current="true"]').innerText();
    expect(second).not.toBe(first);

    await page.getByRole('button', { name: 'Previous sentence' }).click();
    expect(await page.locator('[aria-current="true"]').innerText()).toBe(first);
  });

  test('labels word timing as estimated when it is not exact', async ({ page }) => {
    await upload(page, 'single-page');
    // With no server provider configured the browser voice is used; the panel
    // must say which kind of timing is in play rather than implying precision.
    await expect(
      page.getByText(/word timing|highlighting only|Estimated word position/i).first(),
    ).toBeVisible();
  });
});

test.describe('reader controls', () => {
  test('text size control changes the rendered size', async ({ page }) => {
    await upload(page, 'single-page');
    const article = page.locator('#reading-text article');
    const before = await article.evaluate((el) => getComputedStyle(el).fontSize);

    await page.getByRole('button', { name: 'Settings' }).click();
    const slider = page.getByLabel(/Text size/);
    await slider.fill('26');
    await page
      .getByRole('dialog', { name: 'Settings' })
      .getByRole('button', { name: 'Close' })
      .click();

    const after = await article.evaluate((el) => getComputedStyle(el).fontSize);
    expect(parseFloat(after)).toBeGreaterThan(parseFloat(before));
  });

  test('theme switches between light and dark', async ({ page }) => {
    await upload(page, 'single-page');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Theme').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('navigation', () => {
  test('page navigation moves the viewer', async ({ page }) => {
    await upload(page, 'fifty-page');
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText(/Page 2 of 50/)).toBeVisible();
  });

  test('search finds sentences and jumps to them', async ({ page }) => {
    await upload(page, 'fifty-page');
    await page.getByLabel('Search the reading text').fill('proteinuria');
    await expect(page.getByText(/\d+ matches/)).toBeVisible();
    await page.locator('nav button', { hasText: 'proteinuria' }).first().click();
    await expect(page.locator('[aria-current="true"]')).toContainText('proteinuria');
  });
});

test.describe('persistence', () => {
  test('offers to resume after a reload', async ({ page }) => {
    await upload(page, 'single-page');
    await page.locator('#reading-text [data-sentence-id]').nth(1).click();
    await expect(page.locator('[aria-current="true"]')).toBeVisible();

    // Give the position write time to land in IndexedDB.
    await page.waitForTimeout(1500);
    await upload(page, 'single-page');

    await expect(page.getByRole('button', { name: 'Resume reading' })).toBeVisible();
    await page.getByRole('button', { name: 'Resume reading' }).click();
    await expect(page.locator('[aria-current="true"]')).toBeVisible();
  });

  test('reader settings survive a reload', async ({ page }) => {
    await upload(page, 'single-page');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel(/Text size/).fill('28');
    await page
      .getByRole('dialog', { name: 'Settings' })
      .getByRole('button', { name: 'Close' })
      .click();

    await page.waitForTimeout(600);
    await upload(page, 'single-page');
    const size = await page
      .locator('#reading-text article')
      .evaluate((el) => getComputedStyle(el).fontSize);
    expect(parseFloat(size)).toBeCloseTo(28, 0);
  });

  test('the chosen voice survives a reload', async ({ page }) => {
    await upload(page, 'single-page');
    const voice = page.getByTitle('Voice');
    const options = await voice.locator('option').all();
    const values = (await Promise.all(options.map((o) => o.getAttribute('value')))).filter(
      (v): v is string => Boolean(v),
    );
    // Needs a second voice to switch to; with only one there is nothing to prove.
    test.skip(values.length < 2, 'only one voice available in this environment');

    const current = await voice.inputValue();
    const other = values.find((value) => value !== current);
    await voice.selectOption(other!);
    await expect(voice).toHaveValue(other!);

    // The voice was not remembered at all before; a reload silently reset it to
    // whichever voice the platform happened to enumerate first.
    await page.reload();
    await upload(page, 'single-page');
    await expect(page.getByTitle('Voice')).toHaveValue(other!);
  });
});

test.describe('accessibility', () => {
  test('has a skip link and a labelled main region', async ({ page }) => {
    await upload(page, 'single-page');
    await expect(page.getByRole('link', { name: 'Skip to the reading text' })).toBeAttached();
    await expect(page.getByRole('region', { name: 'Playback controls' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Document navigation' })).toBeVisible();
  });

  test('space toggles playback when focus is not in a field', async ({ page }) => {
    await upload(page, 'single-page');
    await page.locator('#reading-text').click();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible({
      timeout: 20_000,
    });
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  });

  test('space does not toggle playback while typing in search', async ({ page }) => {
    await upload(page, 'single-page');
    const search = page.getByLabel('Search the reading text');
    await search.click();
    await search.press('Space');
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  });
});
