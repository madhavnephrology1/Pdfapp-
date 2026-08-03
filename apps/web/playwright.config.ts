import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests.
 *
 * Assumes the web app is already running on port 3000 unless PW_START is set,
 * in which case Playwright starts it. Chromium is used because the extraction
 * worker and SpeechSynthesis behaviour need a real browser.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.PW_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Lets the audio path run without a real output device.
          args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
          // Honour a preinstalled Chromium when the environment provides one,
          // so CI images do not have to re-download a browser.
          ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
            : {}),
        },
      },
    },
  ],
  webServer: process.env.PW_START
    ? {
        command: 'npm run start',
        url: 'http://127.0.0.1:3000',
        reuseExistingServer: true,
        timeout: 120_000,
      }
    : undefined,
});
