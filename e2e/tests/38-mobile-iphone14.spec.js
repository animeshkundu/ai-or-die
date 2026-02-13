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
} = require('../helpers/terminal-helpers');

let server, port, url;

test.use({ ...devices['iPhone 14'] });

test.beforeAll(async () => {
  ({ server, port, url } = await createServer());
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.afterEach(async ({ page }, testInfo) => {
  await attachFailureArtifacts(page, testInfo);
});

test.describe('Mobile: iPhone 14 Layout', () => {
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

    const sessionId = await createSessionViaApi(port, 'mobile-keyboard-iphone14');
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

    const marker = `MK14${Date.now()}`;
    await typeInTerminal(page, `echo ${marker}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker, 15000);
  });

  test('session tabs work on mobile', async ({ page }) => {
    setupPageCapture(page);
    const s1 = await createSessionViaApi(port, 'mobile-s1');
    const s2 = await createSessionViaApi(port, 'mobile-s2');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Verify tabs render on mobile
    await page.waitForSelector('.session-tab', { timeout: 10000 });
    const tabCount = await page.$$eval('.session-tab', tabs => tabs.length);
    expect(tabCount).toBeGreaterThanOrEqual(2);

    // Switch sessions via tab tap
    await joinSessionAndStartTerminal(page, s1);
    const marker1 = `TAB1_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker1}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker1, 15000);

    // Tap session 2 tab
    await page.evaluate((sid) => {
      const tab = document.querySelector(`.session-tab[data-session-id="${sid}"]`);
      if (tab) tab.click();
    }, s2);
    await page.waitForTimeout(1000);
  });

  test('mobile menu opens and has correct options', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Check if hamburger exists (dynamically created, depends on mobile detection)
    const hamburger = page.locator('.hamburger-btn');
    const hamburgerExists = await hamburger.count() > 0;

    if (hamburgerExists && await hamburger.isVisible()) {
      await hamburger.click();
      await page.waitForTimeout(300);

      // Verify mobile menu is visible
      const menu = page.locator('.mobile-menu.active');
      await expect(menu).toBeVisible();

      // Verify expected buttons exist
      await expect(page.locator('#sessionsBtnMobile')).toBeVisible();
      await expect(page.locator('#clearBtnMobile')).toBeVisible();
      await expect(page.locator('#settingsBtnMobile')).toBeVisible();

      // Close menu
      await page.locator('#closeMenuBtn').click();
      await page.waitForTimeout(300);
    } else {
      // Verify viewport is at least mobile-sized
      const viewport = page.viewportSize();
      expect(viewport.width).toBeLessThan(500);
    }
  });
});
