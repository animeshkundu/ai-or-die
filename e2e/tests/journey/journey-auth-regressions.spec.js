// e2e/tests/journey/journey-auth-regressions.spec.js
//
// Regression assertions for QA #13's three auth-on findings. Where
// journey-auth.spec.js does exploratory `recordFinding(...)` calls, this
// spec ASSERTS the fixed behaviour so a future regression bumps a test.
//
// Boots its own auth-mode server via the createServer helper (no need
// for a pre-running 11501 process — CI-friendly).

const { test, expect } = require('@playwright/test');
const { createServer } = require('../../helpers/server-factory');

const TOKEN = 'qa13regr';

test.describe('Auth-on regressions (QA #13)', () => {
  let server, port, url;
  let consoleSamples;
  let context, page;

  test.beforeAll(async () => {
    ({ server, port, url } = await createServer({ auth: TOKEN }));
  });

  test.afterAll(async () => {
    if (server) await server.close();
  });

  test.beforeEach(async ({ browser }) => {
    consoleSamples = [];
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    page.on('console', (msg) => {
      consoleSamples.push({ type: msg.type(), text: msg.text() });
    });
  });

  test.afterEach(async () => {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  });

  // ---------------------------------------------------------------------------
  // Finding #2 — `?token=…` URL is honoured (no auth modal).
  // ---------------------------------------------------------------------------
  test('?token= URL auto-authenticates (no auth modal)', async () => {
    await page.goto(url + '/?token=' + TOKEN);
    // App should boot without ever rendering the auth modal. Auth modal
    // exposes #auth-token input — its absence after a reasonable wait
    // is the signal.
    await page.waitForFunction(() => !!(window.app && window.authManager),
      { timeout: 15000 });
    // Modal must NOT appear.
    const modalExists = await page.evaluate(() => !!document.getElementById('auth-token'));
    expect(modalExists, 'auth modal should not render when ?token= is valid').toBe(false);
    // sessionStorage should now hold the verified token.
    const stored = await page.evaluate(() => sessionStorage.getItem('cc-web-token'));
    expect(stored, 'token should be persisted to sessionStorage').toBe(TOKEN);
  });

  // ---------------------------------------------------------------------------
  // Finding #3 — token is stripped from the URL bar after auth.
  // ---------------------------------------------------------------------------
  test('?token= is stripped from the URL bar (no leak)', async () => {
    await page.goto(url + '/?token=' + TOKEN);
    await page.waitForFunction(() => !!(window.authManager && window.authManager.token),
      { timeout: 15000 });
    // Wait for the strip — extractAndStripUrlToken runs at the very
    // start of authManager.initialize(), but the page URL update is
    // synchronous after history.replaceState. A brief wait covers any
    // task-queue interleaving.
    await page.waitForFunction(() => !window.location.search.includes('token='),
      { timeout: 5000 });
    const urlNow = page.url();
    expect(urlNow, 'token must NOT appear in the address bar').not.toMatch(/[?&]token=/);
  });

  test('other query params survive the token strip', async () => {
    await page.goto(url + '/?session=abc&token=' + TOKEN + '&other=xyz');
    await page.waitForFunction(() => !window.location.search.includes('token='),
      { timeout: 15000 });
    const urlNow = page.url();
    expect(urlNow, 'session= must survive').toMatch(/[?&]session=abc/);
    expect(urlNow, 'other= must survive').toMatch(/[?&]other=xyz/);
    expect(urlNow, 'token= must NOT survive').not.toMatch(/[?&]token=/);
  });

  // ---------------------------------------------------------------------------
  // Finding #4 — SW registration error does NOT leak the token in
  // console logs (sanitizer redacts `?token=…` before logging).
  // ---------------------------------------------------------------------------
  test('SW errors / unhandled rejections do NOT leak the token to console', async () => {
    await page.goto(url + '/?token=' + TOKEN);
    await page.waitForFunction(() => !!(window.authManager && window.authManager.token),
      { timeout: 15000 });

    // Even with a successful SW registration we want the no-leak
    // invariant to hold across ALL captured console messages — the
    // sanitiser is a global guard, not just for the SW path.
    await page.waitForTimeout(500);
    const tokenLeaks = consoleSamples.filter(function (s) {
      return s && s.text && s.text.indexOf(TOKEN) !== -1;
    });
    expect(tokenLeaks, 'no console message may include the literal token; got: ' +
      JSON.stringify(tokenLeaks.slice(0, 3))).toEqual([]);
  });

  test('sanitizeAuthLog is exposed globally for non-class call sites', async () => {
    await page.goto(url + '/?token=' + TOKEN);
    await page.waitForFunction(() => typeof window.sanitizeAuthLog === 'function',
      { timeout: 15000 });
    const sanitised = await page.evaluate(() =>
      window.sanitizeAuthLog('GET /api/x?token=secret HTTP/1.1'));
    expect(sanitised).not.toContain('secret');
    expect(sanitised).toContain('<redacted>');
  });
});
