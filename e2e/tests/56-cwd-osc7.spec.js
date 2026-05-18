// 56-cwd-osc7.spec.js — Live OSC 7 CWD tracking + follow-toggle UI.
//
// Per ADR-0019 + docs/specs/file-browser.md "Live CWD follow-toggle":
// when a Terminal-bridge session emits an OSC 7 escape sequence for a
// new directory, the server's terminal-bridge.js feeds it through
// osc7-parser.js, validates it, mirrors onto the session record, and
// broadcasts a `cwd_changed` WebSocket frame. The client stashes the
// new cwd and (when the per-session follow flag is on) navigates the
// file browser panel to it.
//
// This spec exercises the full pipeline through a real shell process.

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
  waitForWsMessage,
} = require('../helpers/terminal-helpers');
const {
  makeFixtureDir,
  cleanupFixture,
  writeFileInside,
  osc7EmitCommand,
} = require('../helpers/file-browser-v2-helpers');

test.describe('OSC 7 live CWD tracking', () => {
  let server, port, url;
  let dirA, dirB, dirC;

  test.beforeAll(async () => {
    // Three sibling directories inside the project so validatePath()
    // approves all of them. dirA is where the session starts; dirB and
    // dirC are the two CWDs the test will "cd into" via OSC 7 emits.
    dirA = makeFixtureDir('osc7-A');
    dirB = makeFixtureDir('osc7-B');
    dirC = makeFixtureDir('osc7-C');
    // Distinct file in each so we can assert the panel re-roots by
    // looking at the file listing.
    writeFileInside(dirA, 'marker-A.txt', 'A');
    writeFileInside(dirB, 'marker-B.txt', 'B');
    writeFileInside(dirC, 'marker-C.txt', 'C');

    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close();
    cleanupFixture(dirA);
    cleanupFixture(dirB);
    cleanupFixture(dirC);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  /**
   * Open the file browser panel pointed at `startDir`. Uses the same
   * lazy-construct pattern as 14-file-browser.spec.js so the panel is
   * available before we attempt to assert against it.
   */
  async function openBrowserAt(page, startDir) {
    await page.evaluate((dir) => {
      if (!window.app._fileBrowserPanel && window.fileBrowser) {
        window.app._fileBrowserPanel = new window.fileBrowser.FileBrowserPanel({
          app: window.app,
          authFetch: (u, o) => window.app.authFetch(u, o),
          initialPath: null,
        });
      }
      window.app._fileBrowserPanel.open(dir);
    }, startDir.replace(/\\/g, '/'));
    await page.waitForSelector('.file-browser-panel.open', { timeout: 10000 });
  }

  /**
   * Send a printf command into the running shell that emits an OSC 7
   * escape for `targetDir`. The bridge's osc7-parser will catch the
   * sequence in the PTY output stream and trigger a `cwd_changed` WS
   * broadcast.
   */
  async function emitOsc7(page, targetDir) {
    const cmd = osc7EmitCommand(targetDir);
    await page.evaluate((data) => {
      if (window.app && window.app.socket && window.app.socket.readyState === 1) {
        window.app.socket.send(JSON.stringify({ type: 'input', data }));
      }
    }, cmd);
  }

  test('cwd_changed WS frame fires on OSC 7 emit; panel re-roots when follow=on', async ({ page }) => {
    setupPageCapture(page);

    const sessionId = await createSessionViaApi(port, 'osc7-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // IMPORTANT: open the panel BEFORE emitting OSC 7. The bridge dedupes
    // identical consecutive OSC 7 emits ("Only emit on actual change" —
    // terminal-bridge.js), so re-emitting the same dir twice will only
    // fire one cwd_changed frame. We open the panel first, then fire a
    // single OSC 7 emit, then assert the panel re-roots.
    await openBrowserAt(page, dirA);

    await emitOsc7(page, dirB);

    // Wait for the broadcast to land at the client side.
    const cwdMsg = await waitForWsMessage(page, 'recv', 'cwd_changed', 8000);
    expect(cwdMsg, 'cwd_changed WS frame should be broadcast').toBeTruthy();
    expect(cwdMsg.cwd).toBe(dirB);
    expect(cwdMsg.source).toBe('osc7');

    // Panel re-roots to dirB.
    await page.waitForFunction((expectedDir) => {
      const panel = window.app._fileBrowserPanel;
      if (!panel) return false;
      const current = (panel._currentPath || '').replace(/\\/g, '/');
      return current === expectedDir.replace(/\\/g, '/');
    }, dirB, { timeout: 10000 });

    // Sanity: marker-B.txt is visible (we re-rooted to dirB).
    await page.waitForFunction(() => {
      const items = document.querySelectorAll('.file-item-name');
      for (const el of items) if (el.textContent === 'marker-B.txt') return true;
      return false;
    }, { timeout: 5000 });
  });

  test('follow toggle: paused state does NOT re-root; re-engaging jumps to latest', async ({ page }) => {
    setupPageCapture(page);

    const sessionId = await createSessionViaApi(port, 'osc7-toggle');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Establish a baseline liveCwd of dirB so the follow toggle button
    // becomes visible (it's hidden until the first liveCwd is observed
    // for the active session — see _refreshFollowToggleUI).
    await emitOsc7(page, dirB);
    await waitForWsMessage(page, 'recv', 'cwd_changed', 8000);

    await openBrowserAt(page, dirB);
    // Wait for panel to settle on dirB.
    await page.waitForFunction((expected) => {
      const panel = window.app._fileBrowserPanel;
      return panel && (panel._currentPath || '').replace(/\\/g, '/') === expected.replace(/\\/g, '/');
    }, dirB, { timeout: 10000 });

    // Pause following: programmatic flip via the panel's API (the click
    // handler ultimately calls setFollowsTerminal). Per ADR-0019 the
    // toggle is per-session, so we read the active session id from app.
    await page.evaluate(() => {
      const sid = window.app.currentClaudeSessionId;
      window.app._fileBrowserPanel.setFollowsTerminal(sid, false);
    });

    // Emit OSC 7 for dirC; the panel must NOT re-root because follow=off.
    await emitOsc7(page, dirC);
    // Wait for the WS frame so we know the server processed the emit.
    const c2 = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
          const found = (window.app && Array.isArray(window.app._wsMessages))
            ? window.app._wsMessages.find((m) => m.type === 'cwd_changed' && m.cwd && m.cwd.endsWith('-C'))
            : null;
          if (found) { resolve(found); return; }
          if (Date.now() - start > 5000) { resolve(null); return; }
          setTimeout(tick, 100);
        };
        tick();
      });
    });
    // page._wsMessages is the canonical capture; the inline poll above
    // is just defensive — fall back to the helper for the assertion.
    const cwdC = await waitForWsMessage(page, 'recv', 'cwd_changed', 8000);
    expect(cwdC).toBeTruthy();
    // Multiple cwd_changed frames may have arrived (one for B, one for C);
    // assert that AT LEAST one of them is for dirC.
    const haveCFrame = (page._wsMessages || []).some(
      (m) => m.dir === 'recv' && m.type === 'cwd_changed' && m.cwd === dirC
    );
    expect(haveCFrame, 'cwd_changed for dirC should have been broadcast').toBe(true);

    // Give the client a small window to (incorrectly) re-root if it ignored
    // the follow=off flag. This is short on purpose; the re-root path is
    // synchronous from notifyCwdChanged so any drift would land here.
    await page.waitForTimeout(300);
    const stayedOnB = await page.evaluate((expected) => {
      const panel = window.app._fileBrowserPanel;
      return panel && (panel._currentPath || '').replace(/\\/g, '/') === expected.replace(/\\/g, '/');
    }, dirB);
    expect(stayedOnB, 'panel should NOT re-root while follow=off').toBe(true);

    // Re-engage following: per spec, flipping back to true with a
    // stashed liveCwd should immediately re-root to the latest seen cwd
    // (dirC). This is the contract that makes the toggle a "catch-up"
    // affordance, not just a future-tense one.
    await page.evaluate(() => {
      const sid = window.app.currentClaudeSessionId;
      window.app._fileBrowserPanel.setFollowsTerminal(sid, true);
    });
    await page.waitForFunction((expected) => {
      const panel = window.app._fileBrowserPanel;
      return panel && (panel._currentPath || '').replace(/\\/g, '/') === expected.replace(/\\/g, '/');
    }, dirC, { timeout: 5000 });
  });
});
