// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 1,
  timeout: 60000,
  expect: {
    timeout: 15000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      threshold: 0.2,
      animations: 'disabled',
    },
  },
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
      name: 'functional-core',
      testMatch: /0[2-5]-.*\.spec\.js/,
    },
    {
      name: 'functional-extended',
      testMatch: /0[6-7]-.*\.spec\.js|09-image-paste\.spec\.js|09-background-.*\.spec\.js/,
    },
    {
      name: 'mobile-iphone',
      testMatch: '08-mobile-portrait.spec.js',
      use: { ...devices['iPhone 14'] },
    },
    {
      name: 'mobile-pixel',
      testMatch: '08-mobile-portrait.spec.js',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'visual-regression',
      testMatch: '09-visual-regression.spec.js',
      use: {
        viewport: { width: 1280, height: 720 },
        launchOptions: {
          args: ['--font-render-hinting=none', '--disable-font-subpixel-positioning'],
        },
      },
    },
    {
      name: 'new-features',
      testMatch: /1[0-4]-.*\.spec\.js/,
    },
  ],
});
