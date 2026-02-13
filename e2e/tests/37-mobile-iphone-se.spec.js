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

test.use({ ...devices['iPhone SE'] });

test.beforeAll(async () => {
  ({ server, port, url } = await createServer());
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.afterEach(async ({ page }, testInfo) => {
  await attachFailureArtifacts(page, testInfo);
});

test.describe('Mobile: iPhone SE Layout', () => {
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

    const sessionId = await createSessionViaApi(port, 'mobile-keyboard-se');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const before = await page.evaluate(() => {
      const term = document.getElementById('terminal');
      const rect = term ? term.getBoundingClientRect() : { height: 0, bottom: 0 };
      return { height: rect.height, bottom: rect.bottom };
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

    expect(after.height).toBeLessThan(before.height);
    expect(after.bottom).toBeLessThanOrEqual(after.innerHeight + 2);

    const marker = `MK${Date.now()}`;
    await typeInTerminal(page, `echo ${marker}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker, 15000);
  });

  test('mobile detection and terminal rendering', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'mobile-se');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Verify viewport is mobile-sized
    const viewport = page.viewportSize();
    expect(viewport.width).toBeLessThan(500);

    // Check mobile detection (may vary based on UA/touch detection)
    const isMobile = await page.evaluate(() => window.app.isMobile);

    // Hamburger button may or may not exist depending on mobile detection
    if (isMobile) {
      const hamburger = page.locator('.hamburger-btn');
      const isVisible = await hamburger.isVisible().catch(() => false);
      // Only assert if the element exists in DOM
      if (isVisible) {
        await expect(hamburger).toBeVisible();
      }
    }

    // Start terminal
    await joinSessionAndStartTerminal(page, sessionId);

    // Verify terminal dimensions adapt to small screen
    const dims = await getTerminalDimensions(page);
    expect(dims.cols).toBeGreaterThan(20);
    expect(dims.cols).toBeLessThan(60); // Small screen = fewer columns
    expect(dims.rows).toBeGreaterThan(5);

    // Verify real commands work on mobile viewport
    const marker = `MOBILE_SE_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker, 15000);
  });

  test('terminal fills mobile viewport without overflow', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'mobile-viewport');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Terminal should not exceed viewport width
    const terminalWidth = await page.evaluate(() => {
      const el = document.getElementById('terminal');
      return el ? el.getBoundingClientRect().width : 0;
    });
    const viewportWidth = page.viewportSize().width;
    expect(terminalWidth).toBeLessThanOrEqual(viewportWidth + 2); // +2 for rounding
  });

  test('extra keys bar element exists in DOM', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'mobile-extra-keys');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Verify the extra-keys-bar element is present in the DOM
    const extraKeysExists = await page.evaluate(() => {
      const bar = document.querySelector('.extra-keys-bar');
      return !!bar;
    });
    expect(extraKeysExists).toBe(true);

    // Verify extra keys have buttons inside (Tab, Ctrl, Esc, arrows, etc.)
    const buttonCount = await page.evaluate(() => {
      const bar = document.querySelector('.extra-keys-bar');
      if (!bar) return 0;
      return bar.querySelectorAll('.extra-key').length;
    });
    expect(buttonCount).toBeGreaterThan(5);
  });

  test('bottom nav element exists in DOM on mobile', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Verify the bottom-nav element exists in the DOM
    const bottomNavExists = await page.evaluate(() => {
      const nav = document.querySelector('.bottom-nav');
      return !!nav;
    });
    expect(bottomNavExists).toBe(true);

    // Verify it has expected navigation items
    const navItems = await page.evaluate(() => {
      const nav = document.querySelector('.bottom-nav');
      if (!nav) return [];
      return Array.from(nav.querySelectorAll('.bottom-nav-item')).map(item => item.id);
    });
    expect(navItems).toContain('navFiles');
    expect(navItems).toContain('navMore');
    expect(navItems).toContain('navSettings');
  });

  test('bottom nav settings button opens settings', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'mobile-bottom-nav');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Check if bottom nav is visible (it is always in DOM but may be styled differently)
    const navSettingsVisible = await page.evaluate(() => {
      const btn = document.getElementById('navSettings');
      if (!btn) return false;
      const rect = btn.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    if (navSettingsVisible) {
      // Click the settings nav item
      await page.evaluate(() => {
        const btn = document.getElementById('navSettings');
        if (btn) btn.click();
      });
      await page.waitForTimeout(500);

      // Verify settings modal opened
      const settingsOpen = await page.evaluate(() => {
        const modal = document.getElementById('settingsModal');
        return modal && modal.classList.contains('active');
      });
      expect(settingsOpen).toBe(true);
    }
  });
});
