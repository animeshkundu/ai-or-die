// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    browserName: 'chromium',
    serviceWorkers: 'block',
    permissions: ['clipboard-read', 'clipboard-write'],
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: process.env.CI ? 'on-first-retry' : 'off',
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'golden-path',
      testMatch: '01-golden-path.spec.js',
    },
    {
      name: 'functional',
      testMatch: /0[2-7]-.*\.spec\.js/,
    },
  ],
});
