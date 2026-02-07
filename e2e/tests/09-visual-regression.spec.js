const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  typeInTerminal,
  pressKey,
  waitForTerminalText,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

/**
 * Visual regression tests — capture full-page and component screenshots
 * to protect against unintended UI changes.
 *
 * Baselines are platform-specific (linux/win32) and stored in
 * 09-visual-regression.spec.js-snapshots/. Update with:
 *   npx playwright test --update-snapshots --project visual-regression
 */
test.describe('Visual regression', () => {
  let server, port, url;

  test.beforeAll(async () => {
    const result = await createServer();
    server = result.server;
    port = result.port;
    url = result.url;
  });

  test.afterAll(async () => {
    if (server) server.close();
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  // ───────────────────────────────────────────────────────────
  // Full-page screenshots
  // ───────────────────────────────────────────────────────────

  test('welcome screen with tool cards', async ({ page }) => {
    // Create a session so the app auto-joins and shows tool cards
    const cwd = process.cwd();
    await createSessionViaApi(port, 'VR Welcome');
    await page.goto(url);
    await waitForAppReady(page);

    // Wait for tool cards to render
    await page.waitForSelector('[data-tid="tool-cards"]', { timeout: 15000 });
    await page.waitForSelector('.tool-card', { timeout: 10000 });

    // Small pause for fonts and animations to settle
    await page.waitForTimeout(1000);

    await expect(page).toHaveScreenshot('welcome-screen.png');
  });

  test('terminal active with shell prompt', async ({ page }) => {
    const cwd = process.cwd();
    const sessionId = await createSessionViaApi(port, 'VR Terminal');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Start terminal and wait for shell
    await joinSessionAndStartTerminal(page, sessionId);

    await expect(page).toHaveScreenshot('terminal-active.png');
  });

  test('multiple tabs open', async ({ page }) => {
    // Create 3 sessions and start terminal in one so the overlay dismisses
    const s1 = await createSessionViaApi(port, 'Tab One');
    await createSessionViaApi(port, 'Tab Two');
    await createSessionViaApi(port, 'Tab Three');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, s1);

    // Wait for all tabs to render
    await page.waitForTimeout(500);

    await expect(page).toHaveScreenshot('tab-bar-multiple.png');
  });

  test('settings modal open', async ({ page }) => {
    // Start a terminal first so the overlay is dismissed and settings button is accessible
    const sessionId = await createSessionViaApi(port, 'VR Settings');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    await page.evaluate(() => document.getElementById('settingsBtn').click());
    await page.waitForSelector('.settings-modal.active', { timeout: 10000 });
    await page.waitForTimeout(500);

    await expect(page).toHaveScreenshot('settings-modal.png');

    // Close settings
    await page.evaluate(() => document.getElementById('closeSettingsBtn').click());
  });

  test('context menu visible', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'VR Context');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Right-click on terminal to show context menu
    const terminal = page.locator('#terminal');
    await terminal.click({ button: 'right' });
    await page.waitForSelector('[data-tid="context-menu"]', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(300);

    await expect(page).toHaveScreenshot('context-menu.png');
  });

  // ───────────────────────────────────────────────────────────
  // Component-level screenshots
  // ───────────────────────────────────────────────────────────

  test('active tab component', async ({ page }) => {
    await createSessionViaApi(port, 'Active Tab');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await page.waitForTimeout(1000);

    const activeTab = page.locator('.session-tab.active').first();
    if (await activeTab.isVisible()) {
      await expect(activeTab).toHaveScreenshot('tab-active.png', {
        maxDiffPixelRatio: 0.10,  // Small element, font rendering varies across CI runs
      });
    }
  });

  test('tool card available component', async ({ page }) => {
    await createSessionViaApi(port, 'VR Card');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 10000 });
    await page.waitForTimeout(500);

    // Terminal card is always available
    const availableCard = page.locator('.tool-card:not(.disabled)').first();
    if (await availableCard.isVisible()) {
      await expect(availableCard).toHaveScreenshot('tool-card-available.png');
    }
  });

  test('tool card disabled component', async ({ page }) => {
    await createSessionViaApi(port, 'VR Disabled Card');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 10000 });
    await page.waitForTimeout(500);

    // Most AI tool cards will be disabled on CI (not installed)
    const disabledCard = page.locator('.tool-card.disabled').first();
    if (await disabledCard.isVisible()) {
      await expect(disabledCard).toHaveScreenshot('tool-card-disabled.png');
    }
  });

  test('context menu items component', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'VR Ctx Items');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const terminal = page.locator('#terminal');
    await terminal.click({ button: 'right' });
    await page.waitForSelector('[data-tid="context-menu"]', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(300);

    const menu = page.locator('[data-tid="context-menu"]');
    await expect(menu).toHaveScreenshot('context-menu-items.png');
  });
});
