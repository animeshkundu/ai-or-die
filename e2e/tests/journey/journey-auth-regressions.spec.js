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

  // ---------------------------------------------------------------------------
  // Finding #17 — Cmd-P + generic-drop callbacks use AuthManager.getToken()
  //
  // Pre-fix: AuthManager had no getToken() method. The FindPanel's and
  // generic-drop's getAuthToken callbacks both called
  // `window.authManager.getToken()`, got undefined back, omitted the
  // token from the request URL, and the server 401'd. Under `--auth`:
  // Cmd-P returned 0 matches for every query; generic drop uploads
  // failed silently. Hidden because default mode tolerates tokenless
  // requests.
  //
  // The test captures ALL /api/files/find requests and asserts:
  //   1. The fetch URL carries `token=<TOKEN>` (proves getToken() works).
  //   2. The server returns matches (proves the auth path passes through
  //      to a working backend, not just that the URL shape is right).
  // ---------------------------------------------------------------------------
  test('Cmd-P under auth-on: request URL carries token= AND returns >0 matches', async () => {
    const findRequests = [];
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/api/files/find')) findRequests.push(u);
    });
    const findResponses = [];
    page.on('response', (resp) => {
      const u = resp.url();
      if (u.includes('/api/files/find')) {
        findResponses.push({ status: resp.status(), url: u });
      }
    });

    await page.goto(url + '/?token=' + TOKEN);
    await page.waitForFunction(
      () => !!(window.app && window.authManager && window.authManager.token),
      { timeout: 15000 });

    // Create a session targeting the repo as workingDir so /api/files/find
    // has a real directory to enumerate. Pass the bearer header explicitly
    // since this fetch sits outside the FindPanel's getAuthToken plumbing.
    const repoRoot = process.cwd();
    const sessionId = await page.evaluate(async ({ origin, workingDir, token }) => {
      const resp = await fetch(origin + '/api/sessions/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify({ name: 'cmdp-auth-regression', workingDir }),
      });
      const data = await resp.json();
      return data.sessionId || null;
    }, { origin: url, workingDir: repoRoot, token: TOKEN });
    expect(sessionId, 'session-create should succeed under auth').toBeTruthy();

    // Make this the active session so the FindPanel's getSession() and
    // getSearchPath() callbacks resolve through it.
    await page.evaluate((sid) => {
      window.app.currentClaudeSessionId = sid;
      // claudeSessions array is what getCurrentWorkingDir reads.
      if (!Array.isArray(window.app.claudeSessions)) window.app.claudeSessions = [];
      const exists = window.app.claudeSessions.find((s) => s.id === sid);
      if (!exists) window.app.claudeSessions.push({ id: sid });
    }, sessionId);

    // Sanity check: AuthManager.getToken() returns the actual token in
    // the browser context (the bug was that it returned undefined).
    const tokenSeenByJs = await page.evaluate(() => window.authManager.getToken());
    expect(tokenSeenByJs, 'authManager.getToken() must return the verified token').toBe(TOKEN);

    // Open Cmd-P and run a query that should match real repo files
    // (every Node project has package.json).
    await page.evaluate(() => window.app.toggleFindPanel());
    await page.evaluate(() => window.app._findPanel.runQuery('package'));

    // Wait for the request + results to land.
    await page.waitForFunction(
      () => {
        const p = window.app && window.app._findPanel;
        return p && Array.isArray(p._lastResults) && p._lastResults.length > 0;
      },
      { timeout: 10000 });

    // Assert: URL shape carries the token.
    const requestsWithToken = findRequests.filter(
      (u) => new URL(u).searchParams.get('token') === TOKEN);
    expect(
      requestsWithToken.length,
      'expected at least one /api/files/find request with token=' + TOKEN +
      '; saw: ' + JSON.stringify(findRequests)
    ).toBeGreaterThan(0);

    // Assert: server didn't 401 (would mean the token wasn't honoured).
    const auth401s = findResponses.filter((r) => r.status === 401);
    expect(auth401s.length,
      'expected NO 401s on /api/files/find under auth; saw: ' + JSON.stringify(findResponses)
    ).toBe(0);

    // Assert: panel rendered matches.
    const matches = await page.evaluate(() =>
      (window.app._findPanel._lastResults || []).map((m) => m.path));
    expect(matches.length,
      'Cmd-P should return matches under auth; got: ' + JSON.stringify(matches.slice(0, 3))
    ).toBeGreaterThan(0);
    // package.json is the most obvious match; assert that specifically.
    expect(
      matches.some((p) => /package\.json$/.test(p)),
      'package.json should appear in matches: ' + JSON.stringify(matches.slice(0, 5))
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Sibling defence — generic-drop's getAuthToken callback uses the same
  // path. Without a real <input type=file> drop here we just assert the
  // pure callback chain returns the live token, which is the actual
  // failure surface QA #17 caught.
  // ---------------------------------------------------------------------------
  test('generic-drop getAuthToken callback returns live token under auth', async () => {
    await page.goto(url + '/?token=' + TOKEN);
    await page.waitForFunction(
      () => !!(window.app && window.authManager && window.authManager.token),
      { timeout: 15000 });
    // The generic-drop wiring in app.js (~line 689) builds its
    // getAuthToken callback as `() => window.authManager.getToken()`. We
    // can re-evaluate that exact expression in the page context: if it
    // returns the literal token, the upload payload will carry it.
    const callbackResult = await page.evaluate(
      () => (window.authManager && window.authManager.getToken
        ? window.authManager.getToken() : null));
    expect(callbackResult,
      'app.js wires generic-drop.getAuthToken to authManager.getToken() — ' +
      'pre-fix this returned undefined and uploads 401d under auth'
    ).toBe(TOKEN);
  });
});
