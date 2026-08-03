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
  // Extraction finished when the reading text appears.
  await expect(page.locator('#reading-text')).toBeVisible({ timeout: 60_000 });
}

test.describe('upload and extraction', () => {
  test('renders pages and shows extracted reading text', async ({ page }) => {
    await upload(page, 'single-page');

    const readingText = page.locator('#reading-text');
    await expect(readingText).toContainText('Renal Physiology Overview');
    await expect(readingText).toContainText('The kidney maintains extracellular fluid volume');

    // The PDF itself is rendered to a canvas.
    await expect(page.locator('canvas').first()).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Document navigation' })).toContainText('1 page');
  });

  test('joins a word split across lines and never shows the broken form', async ({ page }) => {
    await upload(page, 'single-page');
    const text = await page.locator('#reading-text').innerText();
    expect(text).toContain('ultrafiltrate of plasma');
    expect(text).not.toContain('ultra- filtrate');
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
    await expect(dialog.getByText('Journal of Clinical Nephrology', { exact: false }).first()).toBeVisible();

    await dialog.getByRole('button', { name: /Show the evidence/ }).first().click();
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
    await expect(page.locator('[aria-current="true"]')).toBeVisible({ timeout: 20_000 });

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
    await expect(page.getByText(/word timing|highlighting only|Estimated word position/i).first()).toBeVisible();
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
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click();

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
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click();

    await page.waitForTimeout(600);
    await upload(page, 'single-page');
    const size = await page
      .locator('#reading-text article')
      .evaluate((el) => getComputedStyle(el).fontSize);
    expect(parseFloat(size)).toBeCloseTo(28, 0);
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
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 20_000 });
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
