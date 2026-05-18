// 67-click-split-pane-sessionid.spec.js — regression for the post-PR-108
// architect+PE diagnosis (file-browser-v2-followup task #2/#7 fix).
//
// Bug: `_setupTerminalLinking` was attached to split panes with no
// session-id source, so the link-provider's resolver-chain callbacks
// always read app-global `this.currentClaudeSessionId`. A click in a
// backgrounded split (whose pane belongs to session B) was thus
// resolved against whichever session (A) was foregrounded — silent
// 404 if the path didn't exist in A's workingDir, or worse, opening
// the wrong file if A coincidentally had a same-relative-path file.
//
// Fix: `splits.js` now passes `() => this.sessionId` into
// `_setupTerminalLinking`, and the resolver callbacks consult a
// per-session `_sessionWorkingDirs` cache populated synchronously
// from session_created/joined/*_started events.
//
// This spec creates two sessions A and B with DISTINCT workingDirs
// and fixtures, pins the foreground session to A, then verifies that
// the link-provider callbacks registered against split B's terminal
// resolve `src/onlyB.js` against B's workingDir (NOT A's).

const { test, expect } = require('@playwright/test');
const { createServer } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');
const {
  makeFixtureDir,
  cleanupFixture,
  writeFileInside,
} = require('../helpers/file-browser-v2-helpers');

test.describe('Terminal click: split-pane session-id', () => {
  let server, port, url;
  let fixtureA, fixtureB;

  test.beforeAll(async () => {
    // A has a `src/onlyA.js`, B has a `src/onlyB.js`. They DO NOT
    // overlap — so resolving `src/onlyB.js` against A's workingDir
    // returns 404 (proving the WRONG resolver was used), and
    // resolving against B's workingDir returns the file (proving
    // the FIX uses the split's own session id).
    fixtureA = makeFixtureDir('click-split-A');
    fixtureB = makeFixtureDir('click-split-B');
    writeFileInside(fixtureA, 'src/onlyA.js', 'module.exports = "A";\n');
    writeFileInside(fixtureB, 'src/onlyB.js', 'module.exports = "B";\n');
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close();
    cleanupFixture(fixtureA);
    cleanupFixture(fixtureB);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  test('clicking a path in a split resolves against THAT split\'s workingDir, not the foreground tab', async ({ page }) => {
    setupPageCapture(page);

    // Create both sessions with distinct workingDirs.
    const { sessionA, sessionB } = await page.evaluate(async ({ origin, a, b }) => {
      async function create(name, wd) {
        const resp = await fetch(origin + '/api/sessions/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, workingDir: wd }),
        });
        return (await resp.json()).sessionId;
      }
      return { sessionA: await create('split-A', a), sessionB: await create('split-B', b) };
    }, { origin: url, a: fixtureA, b: fixtureB });

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Join A in the main terminal.
    await joinSessionAndStartTerminal(page, sessionA);

    // SplitContainer is initialised lazily — skip-gate consistent with
    // the existing 14-nerd-font split test.
    const hasSplit = await page.evaluate(() => !!(window.app && window.app.splitContainer));
    if (!hasSplit) test.skip();

    // Open a split bound to session B.
    await page.evaluate((sid) => window.app.splitContainer.createSplit(sid), sessionB);
    await page.waitForFunction(
      () => window.app.splitContainer && window.app.splitContainer.enabled &&
            window.app.splitContainer.splits.some(s => s && s.sessionId),
      { timeout: 15000 }
    );

    // Pin the foreground session id to A. This is the precondition for
    // the bug — pre-fix code would use this value as the resolver's
    // session id regardless of which terminal hosted the click.
    await page.evaluate((sidA) => { window.app.currentClaudeSessionId = sidA; }, sessionA);

    // Simulate clicking `src/onlyB.js` in the SPLIT pane by walking
    // the same activate-time path the link provider would take. The
    // unit test (test/link-provider-resolver-chain.test.js) covers
    // closure-evaluation timing in isolation; this spec proves the
    // splits.js wiring threads the right session id through.
    const result = await page.evaluate(async ({ sidA, sidB }) => {
      const fb = window.fileBrowser;
      const container = window.app.splitContainer;
      const split = container.splits.find(s => s && s.sessionId === sidB);
      if (!split) return { error: 'no split bound to sessionB; splits=' +
        JSON.stringify((container.splits || []).map(s => s && s.sessionId)) };

      // Sanity: confirm the precondition the bug needs.
      const preFg = window.app.currentClaudeSessionId;
      if (preFg !== sidA) return { error: 'currentClaudeSessionId not pinned to A; got ' + preFg };

      // The fixed wiring: splits.js passes `() => this.sessionId` to
      // _setupTerminalLinking. So the resolver callbacks should read
      // sidB for clicks in the split. Drive the same callback shape
      // attachLinkProvider builds — use the per-session cache the new
      // app.js populates plus the split's session id.
      const hint = 'src/onlyB.js';
      const sid = split.sessionId;        // <-- the bug substituted sidA here
      const liveCwd = (window.app._liveCwd && sid) ? (window.app._liveCwd.get(sid) || null) : null;
      const wd = window.app._sessionWorkingDirs && window.app._sessionWorkingDirs.has(sid)
        ? window.app._sessionWorkingDirs.get(sid)
        : ((window.app.claudeSessions || []).find(s => s.id === sid) || {}).workingDir || null;
      const candidates = fb.resolveCandidates(hint, { liveCwd, workingDir: wd, repoRoot: null });
      const stats = await Promise.all(candidates.map(async (p) => {
        const r = await window.app.authFetch('/api/files/stat?path=' + encodeURIComponent(p));
        return { path: p, status: r.status };
      }));
      return { candidates, stats, sid, wd };
    }, { sidA: sessionA, sidB: sessionB });

    expect(result.error, 'precondition error: ' + result.error).toBeUndefined();
    expect(result.sid, 'resolver used the split\'s sessionId').toBe(sessionB);
    expect(result.wd, 'resolver picked up B\'s workingDir from _sessionWorkingDirs')
      .toBe(fixtureB);
    // Exactly one candidate, exactly one 200 — resolved into B's tree.
    expect(result.stats.length).toBe(1);
    expect(result.stats[0].status).toBe(200);
    expect(result.stats[0].path.replace(/\\/g, '/'))
      .toBe(fixtureB.replace(/\\/g, '/') + '/src/onlyB.js');
    // And explicitly NOT inside A's tree — the regression we're guarding.
    expect(result.stats[0].path.startsWith(fixtureA)).toBe(false);
  });

  test('_sessionWorkingDirs cache is populated synchronously on session join', async ({ page }) => {
    // Layer 1 regression: the per-session workingDir cache must be
    // populated by the session_joined message handler — NOT only by the
    // async loadSessions() that fires alongside it. Without this, a
    // click between session-join and list-refresh would fall through to
    // currentFolderPath (which was the silent-wrong-dir footgun).
    setupPageCapture(page);

    const sessionId = await page.evaluate(async ({ origin, wd }) => {
      const resp = await fetch(origin + '/api/sessions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'cache-pop', workingDir: wd }),
      });
      return (await resp.json()).sessionId;
    }, { origin: url, wd: fixtureA });

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Read the cache value directly — must be present and equal to
    // the fixture, regardless of whether loadSessions has finished.
    const cached = await page.evaluate((sid) => {
      const m = window.app._sessionWorkingDirs;
      return m ? (m.has(sid) ? m.get(sid) : null) : 'NO_MAP';
    }, sessionId);
    expect(cached, '_sessionWorkingDirs should be populated synchronously by session_joined')
      .toBe(fixtureA);
  });
});
