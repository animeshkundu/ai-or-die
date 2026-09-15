'use strict';

// Join-replay mode convergence + conditional repaint assist.
//
// Two regressions, one shared root: the client RIS-clears (`\x1bc`)
// before replaying, which wipes xterm modes, while the replay restores
// only tail bytes — never the terminal *mode state* — and nothing
// afterwards asks the PTY app to repaint.
//
// 1. Wheel-dead: a long mouse-TUI session evicts both the alt-enter AND
//    the mouse-enable DECSET from the ring. The alt prepend (86-alt-screen)
//    lands the client in the alternate screen, but with
//    `mouseTrackingMode === 'none'` the wheel policy suppresses every
//    notch (zero PTY bytes) until the TUI repaints. The replay must
//    re-assert the enables. Pre-fix this test fails with
//    `Expected "vt200", Received "none"` — the exact production mechanism
//    behind "partially scrollable, now not scrollable at all".
// 2. Repaint assist: after a replay the client may ask the server for a
//    same-size PTY resize (real SIGWINCH) so an incremental TUI repaints
//    from its own model without any browser-dimension change. The server
//    acks `repaint_assisted{ok:true}` for live alt sessions.

const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  joinSessionAndStartTerminal,
  attachFailureArtifacts,
} = require('../helpers/terminal-helpers');

test.describe('Replay mode convergence + repaint assist', () => {
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

  // Enter alt-screen, enable mouse tracking (opencode shape: 1000h + SGR
  // 1006h), flood ~700KB so the ring evicts BOTH the alt-enter and the
  // mouse enables, then stay in alt-screen.
  // Portable quoting: node -e with backslash-x escapes (no raw ESC byte,
  // no printf), CR submits everywhere. Matches the spec-15/16 pattern.
  async function floodAltScreenWithMouse(page) {
    await page.evaluate(() => {
      const term = window.app && window.app.terminal;
      if (!term) throw new Error('no terminal');
    });
    await page.evaluate(() => {
      window.app.send({
        type: 'input',
        data: 'node -e "process.stdout.write(\'\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h\');const s=\'x\'.repeat(1024);for(let i=0;i<700;i++)console.log(\'malt-\'+i+\'-\'+s)"\r',
        claim: true,
        viewId: 'main',
      });
    });
    await page.waitForFunction(() => {
      const term = window.app && window.app.terminal;
      if (!term) return false;
      const buf = term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString(true).includes('malt-699-')) return true;
      }
      return false;
    }, undefined, { timeout: 90000 });
    await page.waitForTimeout(2000);
  }

  function clientModes(page) {
    return page.evaluate(() => {
      const term = window.app && window.app.terminal;
      if (!term) return {};
      return {
        buffer: term.buffer && term.buffer.active && term.buffer.active.type,
        mouse: term.modes && term.modes.mouseTrackingMode,
      };
    });
  }

  async function switchTo(page, sid) {
    await page.evaluate(async (id) => {
      await window.app.sessionTabManager.switchToTab(id);
    }, sid);
    await page.waitForTimeout(1500);
  }

  test('evicted mouse enables are restored after a quick switch (wheel stays alive)', async ({ page }) => {
    const sessionA = await createSessionViaApi(port, 'Mouse TUI');
    const sessionB = await createSessionViaApi(port, 'Plain Shell');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    await joinSessionAndStartTerminal(page, sessionA);
    await floodAltScreenWithMouse(page);

    // Sanity: really in alt-screen with tracking before switching.
    expect((await clientModes(page)).buffer).toBe('alternate');

    await page.evaluate(async (sid) => {
      const app = window.app;
      app.sessionTabManager.addTab(sid, 'Plain Shell', 'idle');
      await app.sessionTabManager.switchToTab(sid);
    }, sessionB);
    await page.evaluate(() => window.app.startToolSession('terminal'));
    await page.waitForTimeout(2000);
    await switchTo(page, sessionA);

    // 1. Back in the alternate screen (alt-enter convergence, spec 86).
    expect((await clientModes(page)).buffer).toBe('alternate');
    // 2. Mouse tracking survived the RIS-clear + replay round trip.
    //    Pre-fix the enables were evicted and never re-asserted: 'none',
    //    and every wheel notch died in the suppress branch.
    expect((await clientModes(page)).mouse).toBe('vt200');
    // 3. The alt tail survived the round trip.
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
    expect(altText).toContain('malt-699-');
    // 4. Wheel policy would forward, not suppress.
    const verdict = await page.evaluate(() => {
      if (window.app && typeof window.app.__wheelDiag === 'function') {
        return window.app.__wheelDiag().verdict;
      }
      return 'no-diag';
    });
    expect(verdict).toBe('passthrough');
    // 5. A real wheel notch becomes SGR bytes (the production symptom
    //    was zero PTY bytes here). Hook onData, dispatch one notch over
    //    the terminal, await the 64/65 report xterm emits for tracked
    //    wheels. Either direction counts — the assertion is that the
    //    notch is forwarded, not swallowed.
    await page.evaluate(() => {
      window.__wheelReports = [];
      window.app.terminal.onData((d) => {
        if (d.includes('[<64;') || d.includes('[<65;')) window.__wheelReports.push(d);
      });
      const el = document.querySelector('#terminal .xterm-screen')
        || document.querySelector('#terminal');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new WheelEvent('wheel', {
        deltaY: 120,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
        bubbles: true,
        cancelable: true,
      }));
    });
    await page.waitForFunction(
      () => Array.isArray(window.__wheelReports) && window.__wheelReports.length > 0,
      undefined,
      { timeout: 30000 }
    );
    const report = await page.evaluate(() => window.__wheelReports[0]);
    expect(report).toMatch(/\[<6[45];/);
  });

  test('request_repaint elicits a server assist ack on live alt sessions', async ({ page }) => {
    const sessionA = await createSessionViaApi(port, 'Alt App');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    await joinSessionAndStartTerminal(page, sessionA);
    // Align the tab bar with the wire: joinSession bypasses the tab
    // manager, leaving activeTabId on the previous tab (restored from
    // localStorage when an earlier test ran in the same origin). A
    // mismatched activeTab makes session_joined stale-guard drop the
    // repaint — correctly — and the terminal would keep showing the
    // other tab. switchToTab re-joins idempotently and repaints.
    await page.evaluate(async (sid) => {
      const app = window.app;
      if (!app.sessionTabManager.tabs.has(sid)) {
        app.sessionTabManager.addTab(sid, 'Alt App', 'idle');
      }
      await app.sessionTabManager.switchToTab(sid);
    }, sessionA);
    await page.evaluate(() => {
      window.app.send({
        type: 'input',
        data: 'node -e "process.stdout.write(\'\\x1b[?1049halt-assist-view\\r\\n\')"\r',
        claim: true,
        viewId: 'main',
      });
    });
    await page.waitForFunction(() => {
      const term = window.app && window.app.terminal;
      return term && term.buffer.active.type === 'alternate';
    }, undefined, { timeout: 30000 });

    // Arm an ack collector BEFORE requesting, then clear the client
    // debounce so the request always goes out under test.
    // NOTE: the join itself already fired an automatic post-replay assist
    // ('tab-switch'), so this probe can legitimately land inside the
    // server's 2s per-session rate window — especially on a warm worker.
    // In that case we wait out the window and probe once more.
    await page.evaluate(() => {
      window.__repaintAcks = [];
      const sock = window.app.socket;
      sock.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg && msg.type === 'repaint_assisted') window.__repaintAcks.push(msg);
        } catch (_) { /* binary frames */ }
      });
    });
    async function requestAndAwaitAck(tag) {
      const before = await page.evaluate(() => window.__repaintAcks.length);
      await page.evaluate((t) => {
        window.app._lastRepaintAssistAt = 0;
        window.app._requestRepaintAssist(t);
      }, tag);
      await page.waitForFunction(
        (n) => Array.isArray(window.__repaintAcks) && window.__repaintAcks.length > n,
        before,
        { timeout: 30000 }
      );
      return page.evaluate(() => window.__repaintAcks[window.__repaintAcks.length - 1]);
    }
    let ack = await requestAndAwaitAck('e2e-probe');
    if (!ack.ok && ack.reason === 'rate-limited') {
      await page.waitForTimeout(2300);
      ack = await requestAndAwaitAck('e2e-probe-retry');
    }
    expect(ack.sessionId).toBe(sessionA);
    expect(ack.ok, `repaint assist rejected: ${ack.reason}`).toBe(true);
  });
});
