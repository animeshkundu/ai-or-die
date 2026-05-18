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
// and fixtures, pins the foreground session to A, then drives the
// REGISTERED link provider's `activate` for the SPLIT terminal — the
// same code path xterm runs on a real mouse click. It verifies the
// file-browser panel opens to a file inside B's tree (NOT A's),
// which only works if the wiring threads `() => this.sessionId`
// through to the resolver's getWorkingDir callback.
//
// (Critical: peer-review gemini_critic flagged that an earlier version
// of this spec called `window.fileBrowser.resolveCandidates` directly
// in `page.evaluate` — bypassing `_setupTerminalLinking` and `splits.js`
// wiring entirely. That version would have silently kept passing even
// if Layer 4 regressed. The activateTerminalLink helper closes that
// gap by invoking the production-registered provider.)

const { test, expect } = require('@playwright/test');
const { createServer } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
  waitForTerminalText,
} = require('../helpers/terminal-helpers');
const {
  makeFixtureDir,
  cleanupFixture,
  writeFileInside,
  activateTerminalLink,
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

    // Start a terminal in B FIRST (joining B switches the foreground,
    // and createSplit only ATTACHES to existing tool sessions — it
    // doesn't spawn). Without this, the split's terminal stays empty
    // and the path-emit step has nothing to type into.
    await joinSessionAndStartTerminal(page, sessionB);
    // Then join A and start its terminal — now A is foreground and
    // A also has a running terminal tool.
    await joinSessionAndStartTerminal(page, sessionA);

    // SplitContainer is initialised lazily — skip-gate consistent with
    // the existing 14-nerd-font split test.
    const hasSplit = await page.evaluate(() => !!(window.app && window.app.splitContainer));
    test.skip(!hasSplit, 'splitContainer not available in this build');

    // Open a split bound to session B. The split's `createSplit`
    // wires `_setupTerminalLinking` with `() => this.sessionId` —
    // that's the wiring this spec is here to regress.
    await page.evaluate((sid) => window.app.splitContainer.createSplit(sid), sessionB);
    await page.waitForFunction(
      () => window.app.splitContainer && window.app.splitContainer.enabled &&
            window.app.splitContainer.splits.some(s => s && s.sessionId),
      { timeout: 15000 }
    );

    // Discover the split's index for the activateTerminalLink helper.
    const splitIndex = await page.evaluate((sid) => {
      const splits = window.app.splitContainer.splits || [];
      return splits.findIndex(s => s && s.sessionId === sid);
    }, sessionB);
    expect(splitIndex, 'expected to find a split bound to sessionB').toBeGreaterThanOrEqual(0);

    // Wait for the split's terminal to be fully constructed (the
    // link provider attaches when split.terminal exists + xterm has
    // registerLinkProvider). Without this we race the assertion.
    await page.waitForFunction((idx) => {
      const s = window.app.splitContainer.splits[idx];
      return !!(s && s.terminal && s.terminal._fbLinkProvider);
    }, splitIndex, { timeout: 10000 });

    // Force the split's fit() to run AFTER the container has its
    // final flex dimensions — programmatic createSplit can race the
    // layout, leaving the split's xterm at the default 80x24 fallback
    // or worse (tiny widths that wrap the printf output across rows
    // and break the link provider's regex). We explicitly fit + wait
    // for a usable column count.
    await page.evaluate((idx) => {
      const s = window.app.splitContainer.splits[idx];
      try { s.fit(); } catch (_) {}
    }, splitIndex);
    await page.waitForFunction((idx) => {
      const s = window.app.splitContainer.splits[idx];
      return !!(s && s.terminal && s.terminal.cols >= 60);
    }, splitIndex, { timeout: 8000 });

    // Wait for split's shell prompt to land before sending input —
    // otherwise printf can be consumed before the shell is ready.
    await page.waitForFunction((idx) => {
      const t = window.app.splitContainer.splits[idx].terminal;
      const buf = t.buffer.active;
      for (let y = 0; y < buf.length; y++) {
        const line = buf.getLine(y);
        if (line && line.translateToString(true).trim().length > 0) return true;
      }
      return false;
    }, splitIndex, { timeout: 10000 });

    // Send `printf '%s\n' 'src/onlyB.js'` to the SPLIT's socket.
    await page.evaluate(({ idx }) => {
      const split = window.app.splitContainer.splits[idx];
      split.socket.send(JSON.stringify({
        type: 'input',
        data: "printf '%s\\n' 'src/onlyB.js'\r",
      }));
    }, { idx: splitIndex });

    // Wait for the path to appear in the SPLIT's buffer.
    await page.waitForFunction(({ idx }) => {
      const t = window.app.splitContainer.splits[idx].terminal;
      const buf = t.buffer.active;
      for (let y = 0; y < buf.length; y++) {
        const line = buf.getLine(y);
        if (!line) continue;
        const text = line.translateToString(true);
        // Skip the printf input line; we want the OUTPUT line.
        if (text.indexOf('src/onlyB.js') >= 0 && text.indexOf('printf') === -1) {
          return true;
        }
      }
      return false;
    }, { idx: splitIndex }, { timeout: 8000 });

    // Pin the foreground session id to A. This is the precondition
    // for the bug — pre-fix code would use this value as the
    // resolver's session id regardless of which terminal hosted the
    // click, so the chain would join `src/onlyB.js` against A's
    // workingDir (no such file → 404 → silent failure).
    await page.evaluate((sidA) => { window.app.currentClaudeSessionId = sidA; }, sessionA);

    // Drive the REGISTERED link provider's activate on the split's
    // terminal — exact same code path xterm runs on a real click.
    const activated = await activateTerminalLink(page, 'src/onlyB.js', {
      terminalAccessor: `window.app.splitContainer.splits[${splitIndex}].terminal`,
    });
    expect(activated, 'link-provider activate fired for src/onlyB.js in the split').toBe(true);

    // After activate, openFileInViewer → panel.openToFile → navigateTo
    // the parent dir. Wait for the panel to open AND assert that the
    // panel's _currentPath landed inside fixtureB's tree, NOT fixtureA's.
    await page.waitForFunction(
      () => !!document.querySelector('.file-browser-panel.open'),
      { timeout: 8000 }
    );
    const panelDir = await page.waitForFunction(() => {
      const p = window.app._fileBrowserPanel;
      return (p && p._currentPath) ? p._currentPath : null;
    }, null, { timeout: 8000 }).then(h => h.jsonValue());
    expect(panelDir, 'panel currentPath should be set after click').toBeTruthy();
    // The load-bearing assertion: panel landed inside fixtureB.
    expect(panelDir.replace(/\\/g, '/').startsWith(fixtureB.replace(/\\/g, '/')),
      `panel currentPath should be inside fixtureB (${fixtureB}); got: ${panelDir}`).toBe(true);
    // Negative: must NOT be inside fixtureA (the foreground tab's
    // workingDir — the bug we're guarding against would have routed
    // through there).
    expect(panelDir.replace(/\\/g, '/').startsWith(fixtureA.replace(/\\/g, '/')),
      `panel currentPath must NOT be inside fixtureA (foreground tab) — that's the bug; got: ${panelDir}`).toBe(false);
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
