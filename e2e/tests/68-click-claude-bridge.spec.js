// 68-click-claude-bridge.spec.js — happy-path regression for
// terminal-link click in a Claude-bridge session. Promotes the PE's
// manual repro (test/pe-repro.js, used during task #2 diagnosis) into
// a permanent guard: a real `startToolSession('claude')` flow,
// Claude renders its TUI, then we drive the REGISTERED link-provider's
// `activate` for the path Claude emitted — exact same code path xterm
// runs on a real mouse click.
//
// Gating: SKIPS when the Claude CLI binary is not installed in the
// runner's PATH (`claude --version` fails). The integrated behaviour
// the architect signed off is already covered by the resolver-chain
// unit suite (test/link-provider-resolver-chain.test.js); this spec
// adds a binary-present end-to-end guard so the actual Claude UI
// integration is exercised in dev (and in CI runners where Claude is
// available).
//
// Pre-fix (peer-review gemini_critic HIGH-2): an earlier version of
// this spec called `window.fileBrowser.resolveCandidates` directly
// inside `page.evaluate`, bypassing `_setupTerminalLinking`'s wiring
// entirely. The fix uses `activateTerminalLink` to drive the
// production-registered provider via xterm's `_linkProviderService`,
// so a Layer-4 regression would fail this assertion.

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
  activateTerminalLink,
} = require('../helpers/file-browser-v2-helpers');

// Synchronously check whether the Claude CLI is available. Caching the
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

  test('Claude session: clicking `src/app.js` in TUI output opens the file via session workingDir', async ({ page }) => {
    test.skip(!isClaudeAvailable(), 'claude CLI not installed; skip integration coverage');

    // Generous timeout — Claude's startup (trust prompt + TUI render +
    // model first-response) typically lands in 15–25s.
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

    // Drive past the trust prompt — Claude's auto-accept only matches
    // the legacy "Do you trust the files in this folder?" string;
    // current binaries ask "Quick safety check: ...". Press Enter
    // explicitly. Also closer to a real user flow.
    await page.waitForTimeout(4000);
    await page.evaluate(() => {
      window.app.socket.send(JSON.stringify({ type: 'input', data: '\r' }));
    });

    // Ask Claude to emit our fixture path.
    await page.waitForTimeout(6000);
    await page.evaluate(() => {
      window.app.socket.send(JSON.stringify({
        type: 'input',
        data: 'print the literal text src/app.js then exit\r',
      }));
    });

    // Poll the xterm buffer for `src/app.js` (excluding the prompt
    // echo line). Up to 45s — Claude's first response can be slow.
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

    // Drive the REGISTERED link provider's activate on the main
    // terminal — exact same code path xterm runs on a real click.
    const activated = await activateTerminalLink(page, 'src/app.js');
    expect(activated, 'link-provider activate fired for src/app.js').toBe(true);

    // The file-browser panel should open and the panel's currentPath
    // should land inside the fixture (parent dir of src/app.js).
    await page.waitForFunction(
      () => !!document.querySelector('.file-browser-panel.open'),
      { timeout: 8000 }
    );
    const panelDir = await page.waitForFunction(() => {
      const p = window.app._fileBrowserPanel;
      return (p && p._currentPath) ? p._currentPath : null;
    }, null, { timeout: 8000 }).then(h => h.jsonValue());
    expect(panelDir, 'panel currentPath should be set after click').toBeTruthy();
    expect(panelDir.replace(/\\/g, '/').startsWith(fixture.replace(/\\/g, '/')),
      `panel currentPath should be inside fixture (${fixture}); got: ${panelDir}`).toBe(true);
  });
});
