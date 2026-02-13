// @ts-check
const { test, expect, devices } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  joinSessionAndStartTerminal,
  typeInTerminal,
  pressKey,
  waitForTerminalText,
  getTerminalDimensions,
} = require('../helpers/terminal-helpers');

let server, port, url;

test.use({ ...devices['Pixel 7'] });

test.beforeAll(async () => {
  ({ server, port, url } = await createServer());
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.afterEach(async ({ page }, testInfo) => {
  await attachFailureArtifacts(page, testInfo);
});

test.describe('Mobile: Pixel 7 Layout', () => {
  test('keyboard open keeps terminal visible and typing still works', async ({ page }) => {
    setupPageCapture(page);
    await page.addInitScript(() => {
      const listeners = { resize: new Set(), scroll: new Set() };
      const state = {
        width: window.innerWidth,
        height: window.innerHeight,
        offsetTop: 0,
      };

      const visualViewportMock = {
        get width() { return state.width; },
        get height() { return state.height; },
        get offsetTop() { return state.offsetTop; },
        addEventListener(type, callback) {
          if (listeners[type]) listeners[type].add(callback);
        },
        removeEventListener(type, callback) {
          if (listeners[type]) listeners[type].delete(callback);
        },
      };

      const emit = (type) => {
        if (!listeners[type]) return;
        listeners[type].forEach((callback) => callback());
      };

      window.__setTestVisualViewport = (nextState) => {
        if (typeof nextState.height === 'number') state.height = nextState.height;
        if (typeof nextState.offsetTop === 'number') state.offsetTop = nextState.offsetTop;
        emit('resize');
        emit('scroll');
      };

      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        get() {
          return visualViewportMock;
        },
      });
    });

    const sessionId = await createSessionViaApi(port, 'mobile-keyboard-pixel7');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const beforeHeight = await page.evaluate(() => {
      const term = document.getElementById('terminal');
      return term ? term.getBoundingClientRect().height : 0;
    });

    await page.evaluate(() => {
      const nextHeight = Math.round(window.innerHeight * 0.62);
      window.__setTestVisualViewport({ height: nextHeight, offsetTop: 0 });
    });

    await expect(page.locator('.extra-keys-bar.visible')).toBeVisible();

    const after = await page.evaluate(() => {
      const term = document.getElementById('terminal');
      const rect = term ? term.getBoundingClientRect() : { height: 0, bottom: 0 };
      return { height: rect.height, bottom: rect.bottom, innerHeight: window.innerHeight };
    });

    expect(after.height).toBeLessThan(beforeHeight);
    expect(after.bottom).toBeLessThanOrEqual(after.innerHeight + 2);

    const marker = `MKP7${Date.now()}`;
    await typeInTerminal(page, `node -e "console.log('${marker}')"`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker, 15000);
  });

  test('real terminal commands work on Android viewport', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'pixel-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Run a multi-step command
    const marker = `PIXEL7_${Date.now()}`;
    await typeInTerminal(page, `node -e "console.log('${marker}')" `);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker, 15000);

    // Verify terminal dimensions are reasonable for Android
    const dims = await getTerminalDimensions(page);
    expect(dims.cols).toBeGreaterThan(25);
    expect(dims.rows).toBeGreaterThan(10);
  });
});
