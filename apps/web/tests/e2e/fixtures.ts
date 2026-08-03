import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURES, type FixtureName } from '@pdfreader/test-fixtures';

// Playwright transpiles specs to CommonJS, so `import.meta` is unavailable here.
// Playwright always runs from the config's directory, which is apps/web.
export const FIXTURE_DIR = join(process.cwd(), 'tests', 'e2e', '.generated');

/** Writes a generated fixture to disk so the browser can upload it. */
export async function writeFixture(name: FixtureName): Promise<string> {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const path = join(FIXTURE_DIR, `${name}.pdf`);
  await writeFile(path, FIXTURES[name]());
  return path;
}
