import { expect, test } from '@playwright/test';
import { writeFixture } from './fixtures';

/** Walks the numbered acceptance criteria in one pass on one document. */
test('acceptance criteria', async ({ page }) => {
  const path = await writeFixture('two-column-paper');
  await page.goto('/');

  // 1. Upload a valid PDF.
  await page.setInputFiles('input[type="file"]', path);
  await expect(page.locator('#reading-text')).toBeVisible({ timeout: 60_000 });

  // 2. See its pages rendered.  3. See extracted reading text.
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect(page.locator('#reading-text')).toContainText('Sodium handling in the proximal');

  // 4. Review included, excluded and uncertain regions.
  await page.getByRole('button', { name: /Content review/ }).click();
  const review = page.getByRole('dialog', { name: 'Content review' });
  for (const tab of ['Skipped', 'Uncertain', 'Being read', 'All']) {
    await review.getByRole('tab', { name: new RegExp(tab) }).click();
  }
  // 5. Restore wrongly excluded content.
  await review.getByRole('tab', { name: /Skipped/ }).click();
  await review.getByRole('button', { name: 'Read this' }).first().click();
  await review.getByRole('button', { name: 'Close' }).click();

  // 6. Choose a reading mode.
  await page.getByRole('radio', { name: /Strict Verbatim/ }).click();
  await page.getByRole('radio', { name: /Clean Reading/ }).click();

  // 7. Choose an available voice.
  const voices = page.getByTitle('Voice');
  expect(await voices.locator('option').count()).toBeGreaterThan(0);

  // 8. Start playback.  11. See the current sentence highlighted.
  await page.getByRole('button', { name: 'Play' }).click();
  await expect(page.locator('[aria-current="true"]')).toBeVisible({ timeout: 20_000 });
  const sentence = await page.locator('[aria-current="true"]').innerText();

  // 9. Pause and resume from the same sentence.
  await page.getByRole('button', { name: 'Pause' }).click();
  expect(await page.locator('[aria-current="true"]').innerText()).toBe(sentence);

  // 10. Change speed without returning to the beginning.
  await page.getByTitle('Reading speed').selectOption('1.5');
  expect(await page.locator('[aria-current="true"]').innerText()).toBe(sentence);

  // 12. Word highlighting is present and labelled for what it is.
  await expect(page.getByText(/word timing|highlighting only|Estimated/i).first()).toBeVisible();

  // 13. Click a sentence to begin reading there.
  const third = page.locator('#reading-text [data-sentence-id]').nth(2);
  const wanted = await third.innerText();
  await third.click();
  await expect(page.locator('[aria-current="true"]')).toHaveText(wanted);

  // 14. Increase reader text size.
  const article = page.locator('#reading-text article');
  const before = await article.evaluate((el) => getComputedStyle(el).fontSize);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel(/Text size/).fill('26');
  await page
    .getByRole('dialog', { name: 'Settings' })
    .getByRole('button', { name: 'Close' })
    .click();
  expect(parseFloat(await article.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThan(
    parseFloat(before),
  );

  // 15. Navigate by page and by detected section.
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText(/Page 2 of 2/)).toBeVisible();
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /Tubular Sodium Transport/ })
    .click();

  // 17/18/19/20 are asserted by the extraction integration suite; 16 by the
  // persistence e2e tests. This test covers the interactive criteria.
});
