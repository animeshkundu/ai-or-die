// 69-click-terminal-bash-cd.spec.js — Terminal bridge + bash + cd
// regression. Companion to the Claude-bridge happy path (spec 68) and
// the split-pane regression (spec 67). Covers the user-reported
// failure mode the team-lead surfaced in the post-fix clarification:
// Terminal bridge spawns bash in fixtureRoot, user cd's into projA,
// emits OSC 7, prints `src/onlyA.js`, clicks. The chain must resolve
// against the OSC-7 liveCwd (projA), not the spawn workingDir
// (fixtureRoot — wrong dir).
//
// Pre-fix the same flow with NO OSC 7 hook installed would silently
// fail. The fix shipped two improvements that interact here:
//   - Layer 1 cache: workingDir is the session spawn dir; liveCwd
//     overlays the OSC 7 tracking on top.
//   - Layer 2 diagnostic toast: when the chain can't resolve, the
//     user sees WHAT was tried + an OSC 7 hint.
//
// This spec exercises both: WITH the hook the click resolves. The
// toast-without-hook case is covered by the unit suite
// (test/link-provider-resolver-chain.test.js
// "zero-hit failure: shows OSC 7 hint when liveCwd missing but
// workingDir present").
//
// Like specs 67 and 68, this uses `activateTerminalLink` to drive
// the REGISTERED link provider via xterm's `_linkProviderService` —
// real click code path, not the synthetic `resolveCandidates` call
// (peer-review gemini_critic HIGH-2).

const path = require('path');
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
  osc7EmitCommand,
  activateTerminalLink,
} = require('../helpers/file-browser-v2-helpers');

test.describe('Terminal click: bash + cd + OSC 7 (user-reported flow)', () => {
  let server, port, url;
  let fixtureRoot, projA;

  test.beforeAll(async () => {
    fixtureRoot = makeFixtureDir('click-bash-cd');
    projA = path.join(fixtureRoot, 'projA');
    writeFileInside(projA, 'src/onlyA.js', 'module.exports = "A";\n');
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close();
    cleanupFixture(fixtureRoot);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  test('bash session: cd + OSC 7 emit + print path + click opens file via liveCwd', async ({ page }) => {
    setupPageCapture(page);

    const sessionId = await page.evaluate(async ({ origin, wd }) => {
      const resp = await fetch(origin + '/api/sessions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'bash-cd', workingDir: wd }),
      });
      return (await resp.json()).sessionId;
    }, { origin: url, wd: fixtureRoot });

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Step 1 — cd inside bash to projA. Sentinel echo for
    // deterministic wait.
    await page.evaluate((sub) => {
      window.app.socket.send(JSON.stringify({
        type: 'input',
        data: 'cd ' + sub + ' && echo OK_CD_A\r',
      }));
    }, projA);
    await waitForTerminalText(page, 'OK_CD_A', 8000);

    // Step 2 — emit OSC 7. Simulates a real bash PROMPT_COMMAND
    // firing after the cd.
    await page.evaluate((emitCmd) => {
      window.app.socket.send(JSON.stringify({ type: 'input', data: emitCmd }));
    }, osc7EmitCommand(projA));

    // Wait for the server-side osc7 parser to broadcast cwd_changed
    // and the client to populate _liveCwd[sessionId] → projA.
    await page.waitForFunction(
      ({ sid, expected }) => {
        const m = window.app._liveCwd;
        if (!m || !m.has(sid)) return false;
        return m.get(sid) === expected;
      },
      { sid: sessionId, expected: projA },
      { timeout: 8000 }
    );

    // Step 3 — print the path-shaped output.
    await page.evaluate(() => {
      window.app.socket.send(JSON.stringify({
        type: 'input',
        data: "printf '%s\\n' 'src/onlyA.js'\r",
      }));
    });
    await waitForTerminalText(page, 'src/onlyA.js', 6000);

    // Step 4 — drive the REGISTERED link provider's activate on the
    // main terminal. Exact same code path xterm runs on a real click.
    const activated = await activateTerminalLink(page, 'src/onlyA.js');
    expect(activated, 'link-provider activate fired for src/onlyA.js').toBe(true);

    // The file-browser panel should open and the panel's currentPath
    // should land in projA (NOT fixtureRoot — that would mean the
    // chain joined against the spawn workingDir, which would have
    // 404'd since src/onlyA.js doesn't exist at fixtureRoot/src/).
    await page.waitForFunction(
      () => !!document.querySelector('.file-browser-panel.open'),
      { timeout: 8000 }
    );
    // Poll for the panel's currentPath to populate (navigateTo is
    // async — listing fetch + render). Read from the panel instance
    // directly rather than scraping breadcrumb DOM: more reliable
    // and survives DOM-structure refactors.
    const panelDir = await page.waitForFunction(() => {
      const p = window.app._fileBrowserPanel;
      return (p && p._currentPath) ? p._currentPath : null;
    }, null, { timeout: 8000 }).then(h => h.jsonValue());

    expect(panelDir, 'panel currentPath should reflect a path inside projA').toBeTruthy();
    // projA is the directory the user cd'd to + emitted OSC 7 for —
    // the panel should have navigated to its parent dir (src/), which
    // lives inside projA. Compare against the projA prefix.
    expect(panelDir.replace(/\\/g, '/').startsWith(projA.replace(/\\/g, '/')),
      `panel currentPath should be inside projA (${projA}); got: ${panelDir}`).toBe(true);
  });
});
