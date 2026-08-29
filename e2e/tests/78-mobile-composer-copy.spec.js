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
  waitForWsMessage,
} = require('../helpers/terminal-helpers');

let server, port, url;

// WebKit does not recognize Chromium's clipboard permissions inherited from
// the root config; the copy spec stubs navigator.clipboard directly. Blocking
// the service worker keeps clipboard assertions on the page's live APIs.
test.use({ permissions: [], serviceWorkers: 'block' });

async function stubClipboard(page) {
  await page.evaluate(() => {
    const state = { attempts: 0, completed: 0, text: null, error: null };
    const writeText = (text) => new Promise((resolve, reject) => {
      state.attempts += 1;
      if (typeof text !== 'string') {
        state.error = `clipboard.writeText expects a string, got ${typeof text}`;
        reject(new TypeError(state.error));
        return;
      }
      // Keep completion asynchronous so the test proves the UI awaits the
      // clipboard write instead of relying on a same-tick assignment.
      setTimeout(() => {
        state.text = text;
        state.completed += 1;
        resolve();
      }, 0);
    });

    let installed = false;
    let installError = null;
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      installed = !!(navigator.clipboard && navigator.clipboard.writeText === writeText);
    } catch (error) {
      installError = error;
    }

    if (!installed && navigator.clipboard) {
      try {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          value: writeText,
          configurable: true,
        });
        installed = navigator.clipboard.writeText === writeText;
      } catch (error) {
        installError = error;
      }
    }

    if (!installed) {
      throw new Error(`Unable to install clipboard stub: ${installError ? installError.message : 'unknown error'}`);
    }
    window.__mobileClipboard = state;
  });
}

async function waitForClipboardWrite(page) {
  await expect.poll(() => page.evaluate(() => {
    const state = window.__mobileClipboard;
    if (!state) return { attempts: 0, completed: 0, error: 'clipboard stub missing' };
    return {
      attempts: state.attempts,
      completed: state.completed,
      text: state.text,
      error: state.error,
    };
  }), { timeout: 5000 }).toMatchObject({ attempts: 1, completed: 1, error: null });
}

async function recordTouchEvents(locator) {
  await locator.evaluate((button) => {
    window.__mobileCopyEvents = [];
    for (const type of ['touchstart', 'touchend', 'click']) {
      button.addEventListener(type, () => window.__mobileCopyEvents.push(type));
    }
  });
}

async function expectTouchCopy(page) {
  await expect.poll(() => page.evaluate(() => window.__mobileCopyEvents || []), {
    timeout: 5000,
  }).toEqual(['touchstart', 'touchend']);
  await expect.poll(() => page.evaluate(() => window.__mobileClipboard), {
    timeout: 5000,
  }).toMatchObject({ attempts: 1, completed: 1, error: null });
}

async function waitForKeyboardSettled(page, expected) {
  await expect.poll(() => page.evaluate(() => ({
    keyboardOpen: document.body.classList.contains('keyboard-open'),
    inKeyboardTransition: !!(window.app && window.app._inKeyboardTransition),
    terminalHeight: document.getElementById('terminal')?.style.height || '',
  })), { timeout: 5000 }).toEqual({
    ...expected,
    inKeyboardTransition: false,
  });
}

async function expectVisibleText(page) {
  await page.waitForFunction(() => {
    const t = window.app && window.app.terminal;
    if (!t || !t.buffer || !t.buffer.active) return false;
    const buf = t.buffer.active;
    const rows = t.rows || 24;
    const start = buf.viewportY || 0;
    for (let i = 0; i < rows; i++) {
      const line = buf.getLine(start + i);
      if (line && line.translateToString(true).trim()) return true;
    }
    return false;
  }, null, { timeout: 15000 });
}

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
  await waitForAppReady(page, 20000);
  expect(await page.evaluate(() => !!(window.app && window.app.terminal))).toBe(true);
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
  const started = await waitForWsMessage(page, 'recv', 'terminal_started', 10000);
  expect(started, 'terminal_started frame should be received').toBeTruthy();
  expect(started).toMatchObject({ type: 'terminal_started', sessionId });
  await page.evaluate(() => document.body.classList.remove('keyboard-open'));
  return sessionId;
}

async function expectMobileContract(page) {
  const state = await page.evaluate(() => ({
    hasApp: !!window.app,
    isMobile: !!(window.app && window.app.isMobile),
    bodyIsMobile: document.body.classList.contains('is-mobile'),
  }));
  expect(state.hasApp).toBe(true);
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

    // A live shell prompt is enough to prove the visible-screen fallback, but
    // wait for it to settle before installing the strict asynchronous stub.
    await expectVisibleText(page);
    await stubClipboard(page);

    const before = await page.evaluate(() => ({
      keyboardOpen: document.body.classList.contains('keyboard-open'),
      terminalHeight: document.getElementById('terminal')?.style.height || '',
    }));
    const launcher = page.locator('#keysPanelBtn');
    await expect(launcher).toBeVisible();
    await recordTouchEvents(launcher);
    await launcher.tap();
    await expect(page.locator('#keysPanel')).toHaveClass(/keys-panel--open/);

    const copyButton = page.locator('.keys-panel__util-btn');
    await expect(copyButton).toBeVisible();
    await recordTouchEvents(copyButton);
    await copyButton.tap();
    await expectTouchCopy(page);
    await waitForClipboardWrite(page);

    const copied = await page.evaluate(() => window.__mobileClipboard.text);
    expect(typeof copied).toBe('string');
    expect(copied.length).toBeGreaterThan(0);
    await expect(page.locator('.toast--success .toast__msg')).toContainText('Copied screen');
    await waitForKeyboardSettled(page, before);
    expect(await page.evaluate(() => window.__mobileClipboard.error)).toBeNull();
    expect(await page.evaluate(() => window.__mobileClipboard.attempts)).toBe(1);
    expect(await page.evaluate(() => window.__mobileClipboard.completed)).toBe(1);
    expect(await page.evaluate(() => window.__mobileCopyEvents)).toEqual(
      expect.arrayContaining(['touchstart', 'touchend'])
    );

    // Copy-screen wrote the visible terminal text (a live shell always shows a
    // prompt) to the clipboard.
    expect(copied).not.toBe('');
  });
});
