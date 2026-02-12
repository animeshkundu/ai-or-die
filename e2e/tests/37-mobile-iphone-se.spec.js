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
