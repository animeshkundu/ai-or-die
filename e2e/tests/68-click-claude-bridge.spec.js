// 68-click-claude-bridge.spec.js — happy-path regression for
// terminal-link click in a Claude-bridge session. Promotes the PE's
// manual repro (test/pe-repro.js, used during task #2 diagnosis) into
// a permanent guard: a real `startToolSession('claude')` flow,
// Claude renders its TUI, then we drive the link-provider's resolver
// chain against a path emitted in Claude output.
//
// Gating: SKIPS when the Claude CLI binary is not installed in the
// runner's PATH (`claude --version` fails). The integrated behaviour
// the architect signed off is already covered by the resolver-chain
// unit suite (test/link-provider-resolver-chain.test.js) and the
// split-pane e2e (e2e/tests/67-click-split-pane-sessionid.spec.js);
// this spec adds a binary-present end-to-end guard so the actual
// Claude UI integration is exercised in dev (and in CI runners where
// Claude is available).
//
// Why not use `page.mouse.click()` to drive the actual xterm click
// pipeline? Two reasons:
//   - xterm's hit-test depends on canvas/WebGL rendering, which is
//     headless-Chromium fiddly. (Existing file-browser-v2 specs
//     exercise the same resolver chain via the synthetic helper.)
//   - The bug we're guarding lives in app.js wiring + the resolver
//     callbacks themselves — those are exercised by the synthetic
//     path identically to the click path. The link-provider regex
//     test already proves the regex match for Claude's `⏺ <path>`
//     output format.

const { execFileSync } = require('child_process');
const { test, expect } = require('@playwright/test');
const { createServer } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
} = require('../helpers/terminal-helpers');
const {
  makeFixtureDir,
  cleanupFixture,
  writeFileInside,
} = require('../helpers/file-browser-v2-helpers');

// Synchronously check whether the Claude CLI is available. We use
// `claude --version` rather than `which claude` so the check survives
// PATH manipulations and works on Windows runners too. Caching the
// result avoids spawning per-test.
let _claudeAvailable;
function isClaudeAvailable() {
  if (_claudeAvailable !== undefined) return _claudeAvailable;
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 5000 });
    _claudeAvailable = true;
  } catch (_) {
    _claudeAvailable = false;
  }
  return _claudeAvailable;
}

test.describe('Terminal click: Claude-bridge happy path', () => {
  let server, port, url;
  let fixture;

  test.beforeAll(async () => {
    fixture = makeFixtureDir('click-claude');
    writeFileInside(fixture, 'src/app.js', 'module.exports = {};\n');
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close();
    cleanupFixture(fixture);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  test('Claude session: clicking `src/app.js` in TUI output resolves via session workingDir', async ({ page }) => {
    test.skip(!isClaudeAvailable(), 'claude CLI not installed; skip integration coverage');

    // Generous timeout — Claude's startup (trust prompt + TUI render +
    // model first-response) typically lands in 15–25s on this hardware.
    test.setTimeout(120000);

    setupPageCapture(page);

    const sessionId = await page.evaluate(async ({ origin, wd }) => {
      const resp = await fetch(origin + '/api/sessions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'click-claude', workingDir: wd }),
      });
      return (await resp.json()).sessionId;
    }, { origin: url, wd: fixture });

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Join the session and start Claude. We can't use the existing
    // `joinSessionAndStartTerminal` helper because it hard-codes the
    // 'terminal' tool.
    await page.waitForFunction(
      () => window.app && window.app.sessionTabManager &&
            window.app.socket && window.app.socket.readyState === 1,
      { timeout: 20000 }
    );
    await page.evaluate(async (sid) => { await window.app.joinSession(sid); }, sessionId);
    await page.evaluate(() => { window.app.startToolSession('claude'); });

    // Wait for the overlay to hide (claude_started fires).
    await page.waitForFunction(() => {
      const o = document.getElementById('overlay');
      return !o || o.style.display === 'none';
    }, { timeout: 60000 });

    // Drive past the trust prompt — Claude's auto-accept (claude-bridge.js)
    // matches the old "Do you trust the files in this folder?" string; the
    // current binary asks "Quick safety check: Is this a project you
    // created or one you trust?" so we press Enter explicitly. This is
    // also closer to a real user flow.
    await page.waitForTimeout(4000);
    await page.evaluate(() => {
      window.app.socket.send(JSON.stringify({ type: 'input', data: '\r' }));
    });

    // Ask Claude to emit our fixture path. Generous wait for first
    // model response; the assertion below is what really gates pass/fail.
    await page.waitForTimeout(6000);
    await page.evaluate(() => {
      window.app.socket.send(JSON.stringify({
        type: 'input',
        data: 'print the literal text src/app.js then exit\r',
      }));
    });

    // Poll the xterm buffer for `src/app.js` (excluding the prompt
    // echo line). Up to 45s — Claude's first response can be slow
    // under load.
    const found = await page.waitForFunction(() => {
      const term = window.app.terminal;
      if (!term) return null;
      const buf = term.buffer.active;
      for (let y = 0; y < buf.length; y++) {
        const l = buf.getLine(y);
        if (!l) continue;
        const txt = l.translateToString(false);
        if (txt.includes('src/app.js') && !txt.includes('print the literal')) {
          return { y, txt };
        }
      }
      return null;
    }, null, { timeout: 45000 });
    expect(found, 'Claude should emit src/app.js in its output').toBeTruthy();

    // Verify the resolver-chain wiring against Claude-bridge state.
    // For a Claude session: liveCwd is null (no OSC 7), workingDir
    // comes from the per-session cache (populated synchronously on
    // session_joined / claude_started). Mirrors what the link
    // provider's activate handler does internally.
    const result = await page.evaluate(async () => {
      const fb = window.fileBrowser;
      const sid = window.app.currentClaudeSessionId;
      // Same lookups the activate handler does, via the new helper.
      const wd = window.app.getSessionWorkingDir(sid);
      const liveCwd = (window.app._liveCwd && sid) ? (window.app._liveCwd.get(sid) || null) : null;
      const repoRoot = window.app._getRepoRootCached ? window.app._getRepoRootCached(sid) : null;
      const candidates = fb.resolveCandidates('src/app.js', { liveCwd, workingDir: wd, repoRoot });
      const stats = await Promise.all(candidates.map(async (p) => {
        const r = await window.app.authFetch('/api/files/stat?path=' + encodeURIComponent(p));
        return { path: p, status: r.status };
      }));
      return { sid, wd, liveCwd, candidates, stats };
    });

    expect(result.sid, 'session id should be set').toBeTruthy();
    expect(result.wd, 'session workingDir should resolve to the fixture').toBe(fixture);
    expect(result.liveCwd, 'Claude bridge does not emit OSC 7 — liveCwd is null').toBeNull();
    expect(result.stats.length).toBe(1);
    expect(result.stats[0].status).toBe(200);
    expect(result.stats[0].path.replace(/\\/g, '/'))
      .toBe(fixture.replace(/\\/g, '/') + '/src/app.js');
  });
});
