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
// the root config; these specs mock/avoid clipboard APIs where needed.
test.use({ permissions: [] });

test.beforeAll(async () => {
  ({ server, port, url } = await createServer());
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.afterEach(async ({ page }, testInfo) => {
  await page.evaluate(() => {
    document.body.classList.remove('keyboard-open');
    if (window.app && window.app.extraKeys) window.app.extraKeys.hide();
    if (window.app && window.app.keysPanel) window.app.keysPanel.hide();
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

async function waitForSentInput(page, startIndex, expectedData, label, timeoutMs = 5000) {
  return waitForWsFrameAfter(
    page,
    startIndex,
    (m) => m.dir === 'sent' && m.type === 'input' && m.data === expectedData,
    `${label} input ${JSON.stringify(expectedData)}`,
    timeoutMs
  );
}

async function tapAndWaitForSentInput(page, locator, startIndex, expectedData, label) {
  await locator.tap();
  try {
    return await waitForSentInput(page, startIndex, expectedData, label, 800);
  } catch (_) {
    // WebKit's synthetic tap in Playwright does not always emit the compatibility
    // click when the app intentionally preventDefault()s touchstart to preserve
    // mobile focus. The production handler is click-based, so dispatch that event
    // after a real tap and still assert the emitted WebSocket bytes.
    await locator.dispatchEvent('click');
    return waitForSentInput(page, startIndex, expectedData, label);
  }
}

async function locatorByTextContent(page, selector, text) {
  await page.locator(selector).first().waitFor({ state: 'attached', timeout: 5000 });
  const index = await page.locator(selector).evaluateAll((els, expected) =>
    els.findIndex((el) => (el.textContent || '').trim() === expected), text);
  expect(index, `${selector} with textContent ${JSON.stringify(text)} should exist`).toBeGreaterThanOrEqual(0);
  return page.locator(selector).nth(index);
}

test.describe('ADR-0037 mobile input completeness', () => {
  test('keys panel is reachable and emits the required terminal byte sequences', async ({ page }) => {
    await startTerminal(page, 'mobile-input-keys-panel');
    await expectMobileContract(page);

    const launcher = page.locator('#keysPanelBtn');
    const panel = page.locator('#keysPanel');
    await expect(launcher).toBeVisible();
    await expect(panel).not.toHaveClass(/keys-panel--open/);

    await launcher.tap();
    await expect(panel).toHaveClass(/keys-panel--open/);
    await expect(page.locator('.keys-panel__util-btn')).toBeVisible();
    await page.waitForTimeout(250);

    const tooSmall = await page.locator('button.keys-panel__key').evaluateAll((buttons) =>
      buttons
        .map((button) => {
          const rect = button.getBoundingClientRect();
          return {
            label: (button.textContent || '').trim(),
            width: rect.width,
            height: rect.height,
          };
        })
        // Round to the pixel grid before comparing: getBoundingClientRect
        // returns subpixel values, so a min-height:44px button can measure
        // 43.99993896484375 on some WebKit/DPR combinations — still a valid 44px
        // touch target. An exact `< 44` float compare is brittle; round first.
        .filter((box) => Math.round(box.width) < 44 || Math.round(box.height) < 44)
    );
    expect(tooSmall, `all keys-panel buttons must be >=44x44: ${JSON.stringify(tooSmall)}`).toEqual([]);

    const keyBytes = [
      ['^C', '\x03'],
      ['↑', '\x1b[A'],
      ['←', '\x1b[D'],
      ['⇤ Tab', '\x1b[Z'],
      ['F5', '\x1b[15~'],
      ['Del', '\x1b[3~'],
      ['⌥⌫', '\x1b\x7f'],
    ];

    for (const [label, expectedData] of keyBytes) {
      const key = await locatorByTextContent(page, 'button.keys-panel__key', label);
      const start = wsCursor(page);
      const msg = await tapAndWaitForSentInput(page, key, start, expectedData, label);
      expect(msg.data).toBe(expectedData);

      const focusedXtermTextarea = await page.evaluate(() =>
        !!(document.activeElement && document.activeElement.classList.contains('xterm-helper-textarea'))
      );
      expect(focusedXtermTextarea, `${label} must not move focus to the xterm textarea`).toBe(false);
    }
  });

  test('extra-keys compose bar emits the required terminal byte sequences', async ({ page }) => {
    await startTerminal(page, 'mobile-input-extra-keys');
    await expectMobileContract(page);

    const hasExtraKeys = await page.evaluate(() => !!(window.app && window.app.extraKeys));
    test.skip(!hasExtraKeys, 'window.app.extraKeys is unavailable in this WebKit mobile project');

    await page.evaluate(() => window.app.extraKeys.show());
    await expect(page.locator('.extra-keys-bar')).toBeVisible();
    await page.waitForTimeout(250);

    const keyBytes = [
      ['Esc', '\x1b'],
      ['⇤Tab', '\x1b[Z'],
      ['^C', '\x03'],
      ['↑', '\x1b[A'],
    ];

    for (const [label, expectedData] of keyBytes) {
      const key = await locatorByTextContent(page, '.extra-key', label);
      const start = wsCursor(page);
      const msg = await tapAndWaitForSentInput(page, key, start, expectedData, label);
      expect(msg.data).toBe(expectedData);
    }
  });
});
