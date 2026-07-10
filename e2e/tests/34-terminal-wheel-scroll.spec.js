// @ts-check
// 34-terminal-wheel-scroll.spec.js — trackpad/mouse wheel policy in the alt
// buffer. Verifies our capture-phase handler preempts xterm 6.0's built-in
// wheel->arrow translation so scrolling does not hijack a full-screen TUI.
//
// We observe what the terminal would SEND to the pty by hooking terminal.onData
// (xterm emits the synthetic Up/Down arrows there). A real, trusted wheel event
// is dispatched with page.mouse.wheel over the terminal element.
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

let server, port, url;

test.beforeAll(async () => {
  ({ server, port, url } = await createServer());
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.afterEach(async ({ page }, testInfo) => {
  await attachFailureArtifacts(page, testInfo);
});

const ARROW_RE = /\x1b(\[|O)[AB]/; // CSI or SS3 cursor Up/Down

// Reset the onData recorder and put the client terminal into the requested
// buffer + wheel mode, then return once the buffer type is settled.
async function prime(page, { alt, mode }) {
  await page.evaluate(({ alt, mode }) => {
    const term = window.app.terminal;
    window.__wheelData = [];
    if (!window.__wheelRecorderAttached) {
      term.onData((d) => { (window.__wheelData ||= []).push(d); });
      window.__wheelRecorderAttached = true;
    }
    window.app._wheelScrollMode = mode;
    // Enter/leave the alternate screen buffer on the CLIENT terminal only.
    term.write(alt ? '\x1b[?1049h' : '\x1b[?1049l');
  }, { alt, mode });

  await page.waitForFunction(
    (wantAlt) => {
      const t = window.app && window.app.terminal;
      return !!t && (t.buffer.active.type === 'alternate') === wantAlt;
    },
    alt,
    { timeout: 5000 }
  );
}

async function wheelOverTerminal(page, deltaY) {
  const box = await page.locator('#terminal').boundingBox();
  if (!box) throw new Error('terminal element has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(150);
  return page.evaluate(() => (window.__wheelData || []).join(''));
}

test.describe('Terminal wheel policy (alt-buffer scroll hijack)', () => {
  test.beforeEach(async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'wheel-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);
  });

  test('normal buffer: wheel does not emit arrow keys (native scroll)', async ({ page }) => {
    await prime(page, { alt: false, mode: 'dontHijack' });
    const data = await wheelOverTerminal(page, 200);
    expect(ARROW_RE.test(data)).toBe(false);
  });

  test('alt buffer, default (dontHijack): wheel is suppressed, no arrows to the pty', async ({ page }) => {
    await prime(page, { alt: true, mode: 'dontHijack' });
    const data = await wheelOverTerminal(page, 200);
    expect(ARROW_RE.test(data)).toBe(false);
  });

  test('alt buffer, altScroll: wheel sends arrow keys (pagers scroll)', async ({ page }) => {
    await prime(page, { alt: true, mode: 'altScroll' });
    const data = await wheelOverTerminal(page, 200);
    expect(ARROW_RE.test(data)).toBe(true);
  });

  test('explicit DEC 1007h overrides dontHijack -> arrows (app opted in)', async ({ page }) => {
    await prime(page, { alt: true, mode: 'dontHijack' });
    await page.evaluate(() => window.app.terminal.write('\x1b[?1007h'));
    await page.waitForTimeout(50);
    const data = await wheelOverTerminal(page, 200);
    expect(ARROW_RE.test(data)).toBe(true);
  });

  test('explicit DEC 1007l overrides altScroll -> suppressed (app opted out)', async ({ page }) => {
    await prime(page, { alt: true, mode: 'altScroll' });
    await page.evaluate(() => window.app.terminal.write('\x1b[?1007l'));
    await page.waitForTimeout(50);
    const data = await wheelOverTerminal(page, 200);
    expect(ARROW_RE.test(data)).toBe(false);
  });

  test('alt buffer + mouse tracking: xterm reports mouse wheel, not arrows', async ({ page }) => {
    await prime(page, { alt: true, mode: 'dontHijack' });
    // Enable X11 mouse tracking (1000) + SGR encoding (1006).
    await page.evaluate(() => window.app.terminal.write('\x1b[?1000h\x1b[?1006h'));
    await page.waitForFunction(
      () => window.app.terminal.modes.mouseTrackingMode !== 'none',
      { timeout: 3000 }
    );
    const data = await wheelOverTerminal(page, 200);
    expect(ARROW_RE.test(data)).toBe(false);              // not hijacked into arrows
    expect(/\x1b\[<6[45];/.test(data)).toBe(true);        // SGR mouse-wheel button 64/65
  });

  test('DEC 1007 does not leak across alt-buffer sessions (no re-hijack)', async ({ page }) => {
    // Repro of the reviewer's critical: app A sets 1007h then exits the alt
    // buffer; a later app B (Claude Code TUI: alt, no mouse, no 1007) must NOT
    // inherit app A's 1007 and get its wheel turned into arrows.
    await prime(page, { alt: true, mode: 'dontHijack' });
    await page.evaluate(() => window.app.terminal.write('\x1b[?1007h')); // app A opts in
    await page.waitForTimeout(30);
    await page.evaluate(() => window.app.terminal.write('\x1b[?1049l')); // app A leaves alt buffer
    await page.waitForTimeout(30);
    await page.evaluate(() => { window.__wheelData = []; window.app.terminal.write('\x1b[?1049h'); }); // app B enters
    await page.waitForFunction(
      () => window.app.terminal.buffer.active.type === 'alternate',
      { timeout: 5000 }
    );
    const data = await wheelOverTerminal(page, 200);
    expect(ARROW_RE.test(data)).toBe(false); // stale 1007 must not hijack app B
  });

  test('split pane terminals get the same wheel policy (dontHijack suppresses)', async ({ page }) => {
    const sessionB = await createSessionViaApi(port, 'wheel-split-b');
    await page.evaluate(async (sid) => { await window.app.splitContainer.createSplit(sid); }, sessionB);
    await page.waitForFunction(() => {
      const sc = window.app.splitContainer;
      return !!(sc && sc.enabled && sc.splits[1] && sc.splits[1].terminal && sc.splits[1]._wheelHandler);
    }, { timeout: 15000 });

    await page.evaluate(() => {
      const s = window.app.splitContainer.splits[1];
      window.__splitData = [];
      s.terminal.onData((d) => { (window.__splitData ||= []).push(d); });
      window.app._wheelScrollMode = 'dontHijack';
      s.terminal.write('\x1b[?1049h');
    });
    await page.waitForFunction(
      () => window.app.splitContainer.splits[1].terminal.buffer.active.type === 'alternate',
      { timeout: 5000 }
    );

    const box = await page.locator('.split-right').boundingBox();
    if (!box) throw new Error('split-right has no bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(150);

    const data = await page.evaluate(() => (window.__splitData || []).join(''));
    expect(ARROW_RE.test(data)).toBe(false);
  });

  test('Settings toggle UI: choosing "Scroll (send arrows)" and saving changes real behavior', async ({ page }) => {
    // Drives the actual dropdown -> Save -> applySettings wiring (the other
    // tests set _wheelScrollMode directly and would miss a mis-wired control).
    await page.click('#settingsBtn');
    await page.waitForSelector('#settingsModal.active, .settings-modal.active', { timeout: 5000 });
    await page.selectOption('#wheelScrollMode', 'altScroll');
    await page.click('#saveSettingsBtn');
    // saveSettings -> applySettings caches the new mode...
    await page.waitForFunction(() => window.app._wheelScrollMode === 'altScroll', { timeout: 5000 });
    // ...and flashes "Saved" for ~1.5s before closing. Wait for the modal to
    // actually close so the wheel reaches the terminal, not the modal overlay.
    await page.waitForFunction(() => {
      const m = document.getElementById('settingsModal');
      return !m || !m.classList.contains('active');
    }, { timeout: 5000 });
    // The setting must also persist to localStorage (the source loadSettings reads).
    const persisted = await page.evaluate(() => window.app.loadSettings().wheelScrollMode);
    expect(persisted).toBe('altScroll');

    // Enter the alt buffer WITHOUT overriding the mode — it must come from the setting.
    await page.evaluate(() => {
      const term = window.app.terminal;
      window.__wheelData = [];
      if (!window.__wheelRecorderAttached) {
        term.onData((d) => { (window.__wheelData ||= []).push(d); });
        window.__wheelRecorderAttached = true;
      }
      term.write('\x1b[?1049h');
    });
    await page.waitForFunction(
      () => window.app.terminal.buffer.active.type === 'alternate',
      { timeout: 5000 }
    );
    const data = await wheelOverTerminal(page, 200);
    expect(ARROW_RE.test(data)).toBe(true); // setting=altScroll via UI -> arrows
  });
});
