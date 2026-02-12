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
  test.use({ ...devices['iPhone SE'] });

  test('mobile detection and terminal rendering', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'mobile-se');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Verify mobile detection
    const isMobile = await page.evaluate(() => window.app.isMobile);
    expect(isMobile).toBeTruthy();

    // Verify hamburger menu is visible
    const hamburger = page.locator('.hamburger-btn');
    await expect(hamburger).toBeVisible();

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
});

test.describe('Mobile: iPhone 14 Layout', () => {
  test.use({ ...devices['iPhone 14'] });

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

    // Open hamburger menu — must be visible on mobile
    const hamburger = page.locator('.hamburger-btn');
    await expect(hamburger).toBeVisible();
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
  });
});

test.describe('Mobile: Pixel 7 Layout', () => {
  test.use({ ...devices['Pixel 7'] });

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
