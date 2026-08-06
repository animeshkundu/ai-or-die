// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// iOS device profiles for the mobile input / flicker work (ADR-0037). Edge on
// iOS is WebKit (not Chromium), so these run under Playwright's WebKit engine —
// the closest automated approximation to the real target. iPhone 16 is NOT in
// the Playwright device registry, so it is an explicit descriptor; iPad (gen 11)
// is built-in. Both need `npx playwright install webkit`.
//   Verify keys: node -e "console.log(Object.keys(require('@playwright/test').devices).filter(k=>/iphone|ipad/i.test(k)).join('\n'))"
const iPhone16 = {
  browserName: 'webkit',
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
const iPhone16Landscape = { ...iPhone16, viewport: { width: 852, height: 393 } };
const iPad11 = { ...devices['iPad (gen 11)'], browserName: 'webkit' };
const iPad11Landscape = { ...devices['iPad (gen 11) landscape'], browserName: 'webkit' };

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Retry-free everywhere except Windows CI, where ONE retry contains a
  // third-party native crash we do not own: `@lydell/node-pty-win32-x64`'s
  // `WindowsPtyAgent.kill()` forks `conpty_console_list_agent` without awaiting
  // it, the agent's `AttachConsole` fails against the just-killed shell, and the
  // teardown race can take the whole Playwright worker down with an access
  // violation (`code=3221225477`). `createServer()` hosts the server — and so
  // node-pty — inside the worker, which is why a native crash is fatal here.
  // The agent ships only in the win32 binary package, so POSIX cannot reach the
  // code path and stays at 0. This is CONTAINMENT, NOT a licence for flaky
  // tests: one retry cannot rescue a deterministic failure, and Playwright still
  // reports a retried-then-passed test as `flaky`, not `passed`. Full diagnosis
  // and the exit criteria that force escalation live in
  // docs/history/windows-conpty-worker-crash-2026.md.
  retries: process.env.CI && process.platform === 'win32' ? 1 : 0,
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
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
    video: process.env.CI ? 'retain-on-failure' : 'off',
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'golden-path',
      testMatch: '01-golden-path.spec.js',
    },
    {
      name: 'functional-core',
      testMatch: /(?:^|[\\/])0[2-5]-.*\.spec\.js$/,
    },
    {
      name: 'functional-extended',
      testMatch: /(?:^|[\\/])(?:0[6-7]-.*|09-image-paste|09-background-.*)\.spec\.js$/,
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
      testMatch: /(?:^|[\\/])1[0-5]-.*\.spec\.js$/,
    },
    {
      name: 'integrations',
      testMatch: /(?:^|[\\/])1[6-9]-.*\.spec\.js$/,
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
    // Sticky-note (per-tab local-LLM summary) UI. Deterministic: the server runs
    // with both native engines off (no model download) and the spec injects the
    // server->client messages the engine would emit. See 22-sticky-notes.spec.js.
    {
      name: 'sticky-notes',
      testMatch: '22-sticky-notes.spec.js',
    },
    // Power user flow tests — real CLI tools, real workflows
    {
      name: 'power-user-flows',
      testMatch: /(?:^|[\\/])3[0-6]-.*\.spec\.js$/,
    },
    // Mobile flow tests — device emulation with real terminal interaction
    {
      name: 'mobile-flows',
      testMatch: /(?:^|[\\/])3[7-9]-.*\.spec\.js$/,
    },
    // UI feature tests — command palette styling, voice settings, mic chimes
    {
      name: 'ui-features',
      testMatch: /(?:^|[\\/])4[0-7]-.*\.spec\.js$/,
    },
    // Mobile Sprint 1 fix validation
    {
      name: 'mobile-sprint1',
      testMatch: '48-mobile-sprint1-fixes.spec.js',
    },
    // Mobile Sprint 2+3 fix validation
    {
      name: 'mobile-sprint23',
      testMatch: '49-mobile-sprint23-fixes.spec.js',
    },
    // Mobile user journey tests — real behavior validation
    {
      name: 'mobile-journeys',
      testMatch: '50-mobile-user-journeys.spec.js',
    },
    // UX features: feedback system, input overlay, plan viewer
    {
      name: 'ux-features',
      testMatch: /(?:^|[\\/])5[1-5]-.*\.spec\.js$/,
    },
    // File browser v2: OSC 7 CWD tracking, Cmd-P fuzzy find, terminal-path
    // click resolution, generic file drop. Specs 56–69.
    {
      name: 'file-browser-v2',
      testMatch: /(?:^|[\\/])(?:5[6-9]-.*|6[0-9]-.*)\.spec\.js$/,
      timeout: 90000,
    },
    {
      name: 'client-redesign',
      testMatch: /(?:^|[\\/])(?:7[4-6]-.*|8[1-5]-.*)\.spec\.js$/,
      timeout: 90000,
    },
    {
      name: 'client-redesign-webkit',
      testMatch: /(?:^|[\\/])(?:7[4-6]-.*|8[1-5]-.*)\.spec\.js$/,
      // Split view is desktop-only: the client refuses it below 700px of
      // available width. Under WebKit's phone device profile `setViewportSize`
      // does not reliably yield a desktop-class layout (`width=device-width`
      // governs the layout viewport), so this one case exercises a feature the
      // profile cannot reach. It keeps running on `client-redesign` and
      // `client-redesign-mobile` across ubuntu and windows. See ADR-0049.
      grepInvert: /never send tiny PTY geometry/,
      timeout: 120000,
      use: { ...iPhone16, serviceWorkers: 'allow', permissions: [] },
    },
    {
      name: 'client-redesign-mobile',
      testMatch: /(?:^|[\\/])7[4-6]-.*\.spec\.js$/,
      timeout: 90000,
      use: { ...devices['Pixel 7'], serviceWorkers: 'allow' },
    },
    // Exploratory user-journey suite. Drives the live dev server at
    // http://127.0.0.1:11500 — start it BEFORE running:
    //   node bin/ai-or-die.js --port 11500 --no-open --disable-auth
    // Default headless; pass --headed via the CLI for human observation.
    // (See e2e/tests/journey/journey.spec.js for the 12-step plan.)
    {
      name: 'journey',
      testMatch: /(?:^|[\\/])journey[\\/]journey\.spec\.js$/,
      timeout: 120000,
      use: {
        viewport: { width: 1280, height: 800 },
      },
    },
    // Auth-on rerun. Drives a SEPARATE dev server with --auth foo:
    //   node bin/ai-or-die.js --port 11501 --no-open --auth foo
    {
      name: 'journey-auth',
      testMatch: /(?:^|[\\/])journey[\\/]journey-auth\.spec\.js$/,
      timeout: 120000,
      use: {
        viewport: { width: 1280, height: 800 },
      },
    },
    // CI-friendly regression assertions for QA #13's auth findings.
    // Uses createServer({ auth: 'qa13regr' }) so it self-hosts — no
    // separate process required (unlike journey-auth which targets a
    // pre-running 11501 dev server).
    {
      name: 'journey-auth-regressions',
      testMatch: /(?:^|[\\/])journey[\\/]journey-auth-regressions\.spec\.js$/,
      timeout: 60000,
      use: {
        viewport: { width: 1280, height: 800 },
      },
    },
    // Server restart feature tests
    {
      name: 'restart',
      testMatch: '20-server-restart.spec.js',
      timeout: 120000,
    },
    // iOS mobile-input suite on WebKit (approximates Edge-on-iOS), specs 77-79.
    // CI runs these on Ubuntu only, per ADR-0049 (which amends ADR-0037 on this
    // point): Playwright-WebKit on the Windows runner wedges inbound WebSocket
    // frame delivery and its workers have to be force-killed at teardown. A
    // stalled engine is a failed gate rather than a reason to substitute
    // Chromium.
    // serviceWorkers:'allow' so the PWA/offline paths can run; the SW was
    // investigated and ruled out (blocking it did NOT change the failure).
    // 120s budget is modest headroom for the heavier 6.0 page on WebKit.
    {
      name: 'ios-iphone16',
      testMatch: /(?:^|[\\/])7[7-9]-.*\.spec\.js$/,
      timeout: 120000,
      use: { ...iPhone16, serviceWorkers: 'allow', permissions: [] },
    },
    {
      name: 'ios-iphone16-landscape',
      testMatch: /(?:^|[\\/])79-.*\.spec\.js$/,
      timeout: 120000,
      use: { ...iPhone16Landscape, serviceWorkers: 'allow', permissions: [] },
    },
    {
      name: 'ios-ipad11',
      testMatch: /(?:^|[\\/])7[7-9]-.*\.spec\.js$/,
      timeout: 120000,
      use: { ...iPad11, serviceWorkers: 'allow', permissions: [] },
    },
    {
      name: 'ios-ipad11-landscape',
      testMatch: /(?:^|[\\/])79-.*\.spec\.js$/,
      timeout: 120000,
      use: { ...iPad11Landscape, serviceWorkers: 'allow', permissions: [] },
    },
  ],
});
