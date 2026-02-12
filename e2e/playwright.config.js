// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 1,
  timeout: 60000,
  updateSnapshots: 'missing',
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
      testMatch: /1[0-5]-.*\.spec\.js/,
    },
    {
      name: 'integrations',
      testMatch: /1[6-9]-.*\.spec\.js/,
    },
    {
      name: 'voice-e2e',
      testMatch: '20-voice-input.spec.js',
      use: {
        permissions: ['clipboard-read', 'clipboard-write', 'microphone'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
          ],
        },
      },
      grep: /@voice/,
    },
    {
      name: 'voice-real-pipeline',
      testMatch: '21-voice-real-pipeline.spec.js',
      use: {
        permissions: ['clipboard-read', 'clipboard-write', 'microphone'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--use-file-for-fake-audio-capture=' + require('path').resolve(__dirname, '..', 'test', 'fixtures', 'hello-world.wav'),
          ],
        },
      },
      grep: /@voice-real/,
    },
    // Power user flow tests — real CLI tools, real workflows
    {
      name: 'power-user-flows',
      testMatch: /3[0-6]-.*\.spec\.js/,
    },
    // Mobile flow tests — device emulation with real terminal interaction
    {
      name: 'mobile-flows',
      testMatch: /3[7-9]-.*\.spec\.js/,
    },
    // UI feature tests — command palette styling, voice settings, mic chimes
    {
      name: 'ui-features',
      testMatch: /4[0-9]-.*\.spec\.js/,
    },
  ],
});
