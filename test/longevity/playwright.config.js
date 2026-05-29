// @ts-check
/**
 * Minimal Playwright config for the longevity test suite.
 *
 * Each SUP-* lane drops specs under test/longevity/<lane>/. This config
 * scopes Playwright to test/longevity/browser/ for the browser-side specs
 * (SUP-CLIENT and the browser portions of SUP-SOAK). The Node-only
 * longevity tests under test/longevity/event-loop/, disk/, process/,
 * etc. continue to run under mocha and do not need this config.
 *
 * Run via: npx playwright test --config test/longevity/playwright.config.js
 */
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './browser',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 120000, // longevity tests push large synthetic payloads
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    browserName: 'chromium',
    serviceWorkers: 'block',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'longevity-browser',
      testMatch: /.*\.test\.js$/,
    },
  ],
});
