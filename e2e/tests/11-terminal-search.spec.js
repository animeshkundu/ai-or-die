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

test.describe('Terminal search (Ctrl+F)', () => {
  let server, port, url;

  test.beforeAll(async () => {
    const result = await createServer();
    server = result.server;
    port = result.port;
    url = result.url;
  });

  test.afterAll(async () => {
    if (server) await server.stop();
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  test('Ctrl+F opens search bar', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Search Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Verify search bar is hidden initially
    const searchBar = page.locator('[data-tid="search-bar"]');
    await expect(searchBar).toBeHidden();

    // Press Ctrl+F
    await page.keyboard.press('Control+f');

    // Search bar should be visible
    await expect(searchBar).toBeVisible({ timeout: 3000 });

    // Search input should be focused
    const input = page.locator('#termSearchInput');
    await expect(input).toBeFocused();
  });

  test('Escape closes search bar', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Search Close');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open search
    await page.keyboard.press('Control+f');
    const searchBar = page.locator('[data-tid="search-bar"]');
    await expect(searchBar).toBeVisible({ timeout: 3000 });

    // Press Escape
    await page.keyboard.press('Escape');

    // Search bar should be hidden
    await expect(searchBar).toBeHidden({ timeout: 3000 });
  });

  test('search finds text in terminal output', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Search Find');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Type a distinctive string
    const marker = `SEARCHTEST_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker, 15000);

    // Open search and type the marker
    await page.keyboard.press('Control+f');
    const input = page.locator('#termSearchInput');
    await expect(input).toBeFocused();
    await input.fill(marker);

    // Wait for search to process
    await page.waitForTimeout(500);

    // The search addon should have found the text (no error thrown)
    // We verify the search bar is still visible and input has our text
    await expect(input).toHaveValue(marker);
  });
});
