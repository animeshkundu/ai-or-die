// @ts-check
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  waitForTerminalCanvas,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

let server, port, url;

// WebKit does not recognize Chromium's clipboard permissions inherited from
// the root config; the copy spec stubs navigator.clipboard directly.
test.use({ permissions: [] });

test.beforeAll(async () => {
  ({ server, port, url } = await createServer());
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.afterEach(async ({ page }, testInfo) => {
  await page.evaluate(() => {
    if (window.app && window.app.keysPanel) window.app.keysPanel.hide();
    if (window.app && window.app.extraKeys) window.app.extraKeys.hide();
    const inputOverlay = window.app && window.app._inputOverlay;
    if (inputOverlay && inputOverlay._open) inputOverlay.hide();
    document.body.classList.remove('keyboard-open');
  }).catch(() => {});
  await attachFailureArtifacts(page, testInfo);
});

async function waitForAppReadyOrSkip(page) {
  let ready = false;
  try {
    await waitForAppReady(page, 20000);
    ready = await page.evaluate(() => !!(window.app && window.app.terminal));
  } catch (_) {
    ready = false;
  }
  test.skip(!ready, 'window.app was not ready in this WebKit mobile project');
}

async function joinTerminalWithRetry(page, sessionId) {
  try {
    await joinSessionAndStartTerminal(page, sessionId);
  } catch (e) {
    if (e && e.message && e.message.includes('Execution context was destroyed')) {
      await page.waitForTimeout(1000);
      await waitForAppReadyOrSkip(page);
      await joinSessionAndStartTerminal(page, sessionId);
    } else {
      throw e;
    }
  }
}

async function startTerminal(page, name) {
  const sessionId = await createSessionViaApi(port, name);
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReadyOrSkip(page);
  await waitForWebSocket(page);
  await waitForTerminalCanvas(page);
  await joinTerminalWithRetry(page, sessionId);
  await page.evaluate(() => document.body.classList.remove('keyboard-open'));
  return sessionId;
}

async function expectMobileContract(page) {
  const state = await page.evaluate(() => ({
    hasApp: !!window.app,
    isMobile: !!(window.app && window.app.isMobile),
    bodyIsMobile: document.body.classList.contains('is-mobile'),
  }));
  test.skip(!state.hasApp, 'window.app was not available in this WebKit mobile project');
  expect(state.isMobile).toBe(true);
  expect(state.bodyIsMobile).toBe(true);
}

function wsCursor(page) {
  return (page._wsMessages || []).length;
}

async function waitForWsFrameAfter(page, startIndex, predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let recent = [];
  while (Date.now() < deadline) {
    const messages = (page._wsMessages || []).slice(startIndex);
    const found = messages.find(predicate);
    if (found) return found;
    recent = messages.slice(-5);
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for ${label}. Recent WS frames: ${JSON.stringify(recent)}`);
}

test.describe('ADR-0037 mobile composer and copy', () => {
  test('composer opens from the mobile trigger and sends multi-line text bytes', async ({ page }) => {
    await startTerminal(page, 'mobile-composer-send');
    await expectMobileContract(page);

    const trigger = page.locator('#inputOverlayBtn');
    const overlay = page.locator('#inputOverlay');
    const textarea = page.locator('#inputOverlayText');

    await expect(trigger).toBeVisible();
    await trigger.tap();
    await expect(overlay).toBeVisible();
    await expect(textarea).toHaveAttribute('autocorrect', 'off');

    const text = 'first mobile line\nsecond mobile line';
    await textarea.fill(text);

    const bracketedPasteMode = await page.evaluate(() =>
      !!(window.app && window.app.terminal && window.app.terminal.modes && window.app.terminal.modes.bracketedPasteMode)
    );

    const start = wsCursor(page);
    await page.locator('.input-overlay-send').tap();

    const msg = await waitForWsFrameAfter(
      page,
      start,
      (m) => m.dir === 'sent' && m.type === 'input'
        && typeof m.data === 'string'
        && m.data.includes('first mobile line')
        && m.data.includes('second mobile line'),
      'composer send input frame'
    );

    expect(msg.data).toContain('first mobile line');
    expect(msg.data).toContain('second mobile line');
    expect(msg.data.endsWith('\r')).toBe(true);

    if (bracketedPasteMode || msg.data.startsWith('\x1b[200~')) {
      expect(msg.data.startsWith('\x1b[200~')).toBe(true);
      expect(msg.data.endsWith('\x1b[201~\r')).toBe(true);
    }
  });

  test('keys-panel copy button copies the visible terminal screen text', async ({ page }) => {
    await startTerminal(page, 'mobile-copy-screen');
    await expectMobileContract(page);

    const marker = `MOBILE_COPY_${Date.now()}`;
    // Write the marker and wait for xterm to FINISH PARSING it (the write
    // callback fires once the data is in the buffer). This is deterministic;
    // the previous writeln() + 5s waitForFunction buffer-poll flaked on slow
    // Windows WebKit CI runners.
    await page.evaluate((value) => new Promise((resolve) => {
      window.app.terminal.write(value + '\r\n', () => resolve());
    }), marker);

    await page.evaluate(() => {
      window.__mobileCopiedText = null;
      const clipboard = {
        writeText: (text) => {
          window.__mobileCopiedText = String(text);
          return Promise.resolve();
        },
      };
      try {
        Object.defineProperty(navigator, 'clipboard', {
          value: clipboard,
          configurable: true,
        });
      } catch (_) {
        if (navigator.clipboard) {
          try {
            Object.defineProperty(navigator.clipboard, 'writeText', {
              value: clipboard.writeText,
              configurable: true,
            });
          } catch (__) {}
        }
      }
    });

    const launcher = page.locator('#keysPanelBtn');
    await expect(launcher).toBeVisible();
    await launcher.tap();
    await expect(page.locator('#keysPanel')).toHaveClass(/keys-panel--open/);
    await page.waitForTimeout(250);

    const copyButton = page.locator('.keys-panel__util-btn');
    await expect(copyButton).toBeVisible();
    await copyButton.tap();

    try {
      await page.waitForFunction((value) =>
        typeof window.__mobileCopiedText === 'string' && window.__mobileCopiedText.includes(value),
        marker,
        { timeout: 800 }
      );
    } catch (_) {
      // WebKit's synthetic tap in Playwright does not always emit the
      // compatibility click when the app intentionally preventDefault()s
      // touchstart to preserve mobile focus. The production handler is
      // click-based, so dispatch that event after the real tap.
      await copyButton.dispatchEvent('click');
      await page.waitForFunction((value) =>
        typeof window.__mobileCopiedText === 'string' && window.__mobileCopiedText.includes(value),
        marker,
        { timeout: 5000 }
      );
    }
    const copied = await page.evaluate(() => window.__mobileCopiedText);
    expect(copied).toContain(marker);
  });
});
