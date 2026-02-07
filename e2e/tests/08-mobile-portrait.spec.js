const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  waitForTerminalText,
  typeInTerminal,
  pressKey,
  getTerminalDimensions,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

test.describe('Mobile portrait: app renders and works at mobile viewport sizes', () => {
  let server, port, url;

  test.beforeAll(async () => {
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) server.close();
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  /**
   * Setup a page with a running terminal session.
   * Pre-creates session via REST, joins via window.app, starts terminal.
   */
  async function setupTerminalPage(page) {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, `Mobile_${Date.now()}`);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
  }

  test('app loads and terminal renders at mobile viewport', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, `MobileLoad_${Date.now()}`);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Verify the viewport is mobile-sized (set by Playwright device descriptor)
    // Note: Playwright device viewports use CSS sizes (e.g. iPhone 14 = 390x664),
    // not screen resolutions (390x844)
    const viewport = page.viewportSize();
    expect(viewport.width).toBeLessThan(500);
    expect(viewport.height).toBeGreaterThan(600);
  });

  test('terminal dimensions are smaller than desktop', async ({ page }) => {
    await setupTerminalPage(page);

    const dims = await getTerminalDimensions(page);
    // Desktop default is 1280x720 which yields ~150+ cols
    // Mobile portrait (390-412px wide) should yield significantly fewer columns
    expect(dims.cols).toBeGreaterThan(5);
    expect(dims.cols).toBeLessThan(80);
    expect(dims.rows).toBeGreaterThan(3);
  });

  test('mobile device is detected by the app', async ({ page }) => {
    await setupTerminalPage(page);

    // Playwright device emulation sets hasTouch + mobile user agent,
    // so app.isMobile (set by detectMobile()) should be true
    const isMobile = await page.evaluate(() => {
      return window.app && window.app.isMobile;
    });
    expect(isMobile).toBe(true);
  });

  test('mobile menu element exists in the DOM', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, `MobileMenu_${Date.now()}`);
    await page.goto(url);
    await waitForAppReady(page);

    // The mobile menu element should be in the DOM
    const mobileMenu = page.locator('#mobileMenu');
    await expect(mobileMenu).toBeAttached();

    // Mobile menu buttons should exist
    await expect(page.locator('#sessionsBtnMobile')).toBeAttached();
    await expect(page.locator('#clearBtnMobile')).toBeAttached();
    await expect(page.locator('#settingsBtnMobile')).toBeAttached();
  });

  test('desktop-only elements are hidden at mobile width', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, `MobileCSS_${Date.now()}`);
    await page.goto(url);
    await waitForAppReady(page);

    // @media (max-width: 768px) hides .desktop-only elements
    const desktopOnlyElements = await page.locator('.desktop-only').all();
    for (const el of desktopOnlyElements) {
      await expect(el).toBeHidden();
    }
  });

  test('user types echo command and sees output at mobile viewport', async ({ page }) => {
    await setupTerminalPage(page);

    const marker = `MOBILE_ECHO_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker}`);
    await pressKey(page, 'Enter');

    await waitForTerminalText(page, marker, 15000);
  });

  test('terminal does not exceed mobile viewport width', async ({ page }) => {
    await setupTerminalPage(page);

    const viewport = page.viewportSize();
    const terminalWidth = await page.evaluate(() => {
      const el = document.querySelector('.xterm');
      return el ? el.offsetWidth : 0;
    });

    // Terminal width should not exceed viewport width
    expect(terminalWidth).toBeLessThanOrEqual(viewport.width);
  });
});
