'use strict';

// Alt-screen join-replay convergence (tab-switch ghost-box regression).
//
// Symptom (production, opencode over devtunnel): switching away and back
// leaves a stale "ghost" region of old normal-buffer rows behind the live
// fullscreen TUI, plus detached status-line fragments. It self-heals on
// resize (SIGWINCH forces the TUI to repaint from intact internal state),
// proving no bytes are lost — only the xterm-side render diverges.
//
// Root cause: fullscreen TUIs enter the alternate screen once (DECSET
// 1049h), but the join replay replays only the newest 1000 chunks / 512KB.
// A long session evicts the alt-enter, so the replay draws alt frames into
// the NORMAL buffer. Every switch ghosts, quick ones included.
//
// What this proves on main HEAD (pre-fix): after a >512KB alt-screen flood
// and a quick A->B->A switch, the client terminal is in the NORMAL buffer
// and the normal buffer is polluted with alt lines. Post-fix the replay
// re-enters alt and all three assertions hold.

const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  joinSessionAndStartTerminal,
  attachFailureArtifacts,
} = require('../helpers/terminal-helpers');

test.describe('Alt-screen replay convergence on tab switch', () => {
  let server; let port; let url;

  test.beforeAll(async () => {
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close();
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  // Flood ~700KB inside the alternate screen (deterministically evicts the
  // alt-enter from the 512KB ring regardless of PTY chunk coalescing),
  // then quick-switch away and back.
  async function floodAltScreen(page) {
    await page.evaluate(() => {
      const term = window.app && window.app.terminal;
      if (!term) throw new Error('no terminal');
    });
    // Enter alt-screen, flood, stay there (node exits back to the shell
    // prompt, which remains in alt-screen — exactly the opencode shape).
    // Quoting is PowerShell/cmd/bash-portable: double-quoted arg, single-
    // quoted JS strings, backslash-x escapes decoded by node (never a raw
    // ESC byte, which ConPTY/PowerShell command lines mangle). Matches the
    // proven spec-15/16 pattern. printf is NOT used (absent on Windows).
    // The command is submitted with CR (\r, like the Enter key) — a lone
    // LF is not a submit in all Windows shells/readline modes.
    await page.evaluate(() => {
      window.app.send({
        type: 'input',
        data: 'node -e "process.stdout.write(\'\\x1b[?1049h\');const s=\'x\'.repeat(1024);for(let i=0;i<700;i++)console.log(\'alt-\'+i+\'-\'+s)"\r',
        claim: true,
        viewId: 'main',
      });
    });
    // ~700KB burst; wait for the tail to land on screen.
    await page.waitForFunction(() => {
      const term = window.app && window.app.terminal;
      if (!term) return false;
      const buf = term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString(true).includes('alt-699-')) return true;
      }
      return false;
    }, undefined, { timeout: 90000 });
    // Settle: let the server ring + transcript absorb the burst.
    await page.waitForTimeout(2000);
  }

  function activeBufferType(page) {
    return page.evaluate(() => {
      const term = window.app && window.app.terminal;
      if (!term || !term.buffer || !term.buffer.active) return 'missing';
      return term.buffer.active.type || 'unknown';
    });
  }

  function normalBufferText(page) {
    return page.evaluate(() => {
      const term = window.app && window.app.terminal;
      const buf = term && term.buffer && term.buffer.normal;
      if (!buf) return '';
      const lines = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      return lines.join('\n');
    });
  }

  async function switchTo(page, sid) {
    await page.evaluate(async (id) => {
      await window.app.sessionTabManager.switchToTab(id);
    }, sid);
    await page.waitForTimeout(1500);
  }

  test('long alt session reconverges after a quick switch (no ghost rows)', async ({ page }) => {
    const sessionA = await createSessionViaApi(port, 'Alt App');
    const sessionB = await createSessionViaApi(port, 'Plain Shell');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    await joinSessionAndStartTerminal(page, sessionA);
    await floodAltScreen(page);

    // Sanity: we really are in alt-screen before switching.
    expect(await activeBufferType(page)).toBe('alternate');

    // Session B tab, quick switch away and straight back.
    await page.evaluate(async (sid) => {
      const app = window.app;
      app.sessionTabManager.addTab(sid, 'Plain Shell', 'idle');
      await app.sessionTabManager.switchToTab(sid);
    }, sessionB);
    await page.evaluate(() => window.app.startToolSession('terminal'));
    await page.waitForTimeout(2000);
    await switchTo(page, sessionA);

    // 1. The replay must have re-entered the alternate screen. Pre-fix the
    //    evicted enter strands the client in the normal buffer.
    expect(await activeBufferType(page)).toBe('alternate');
    // 2. The alt tail survived the round trip.
    const altText = await page.evaluate(() => {
      const term = window.app && window.app.terminal;
      const buf = term.buffer.active;
      const lines = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      return lines.join('\n');
    });
    expect(altText).toContain('alt-699-');
    // 3. No ghost: the normal buffer must not hold alt-screen rows.
    expect(await normalBufferText(page)).not.toContain('alt-699-');
  });

  test('short alt session still converges (no-prepend path unchanged)', async ({ page }) => {
    const sessionA = await createSessionViaApi(port, 'Short Alt');
    const sessionB = await createSessionViaApi(port, 'Plain Shell 2');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    await joinSessionAndStartTerminal(page, sessionA);
    // Small alt session: enter survives in the ring, no prepend expected.
    // node -e (not printf) for Windows shells; CR submits everywhere.
    await page.evaluate(() => {
      window.app.send({
        type: 'input',
        data: 'node -e "process.stdout.write(\'\\x1b[?1049hshort-alt-view\\r\\n\')"\r',
        claim: true,
        viewId: 'main',
      });
    });
    await page.waitForFunction(() => {
      const term = window.app && window.app.terminal;
      return term && term.buffer.active.type === 'alternate';
    }, undefined, { timeout: 30000 });

    await page.evaluate(async (sid) => {
      const app = window.app;
      app.sessionTabManager.addTab(sid, 'Plain Shell 2', 'idle');
      await app.sessionTabManager.switchToTab(sid);
    }, sessionB);
    await page.evaluate(() => window.app.startToolSession('terminal'));
    await page.waitForTimeout(2000);
    await switchTo(page, sessionA);

    expect(await activeBufferType(page)).toBe('alternate');
    const altText = await page.evaluate(() => {
      const term = window.app && window.app.terminal;
      const buf = term.buffer.active;
      const lines = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      return lines.join('\n');
    });
    expect(altText).toContain('short-alt-view');
  });
});
