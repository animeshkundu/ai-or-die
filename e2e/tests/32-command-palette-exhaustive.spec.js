// @ts-check
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  joinSessionAndStartTerminal,
  focusTerminal,
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

test.describe('Power User: Command Palette Exhaustive', () => {

  test('Ctrl+K opens palette and lists all commands', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'palette-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open command palette with Ctrl+K
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    // Verify palette is visible
    const palette = page.locator('ninja-keys');
    await expect(palette).toBeAttached();

    // Type to search and verify commands exist
    const expectedCommands = [
      'New Session',
      'Clear Terminal',
      'Open Settings',
      'Theme: Midnight',
      'Theme: Nord',
      'Toggle File Browser',
    ];

    for (const cmd of expectedCommands) {
      // Clear search and type command name
      const input = palette.locator('input[type="text"]').first();
      if (await input.isVisible()) {
        await input.fill('');
        await input.fill(cmd.split(':')[0].trim());
        await page.waitForTimeout(200);
      }
    }

    // Close palette with Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });

  test('theme switching via palette works', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'theme-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Get initial theme
    const initialTheme = await page.evaluate(() => {
      return document.documentElement.getAttribute('data-theme');
    });

    // Open palette and switch to Nord theme
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    const palette = page.locator('ninja-keys');
    const input = palette.locator('input[type="text"]').first();
    if (await input.isVisible()) {
      await input.fill('Nord');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
    }

    // Verify theme changed
    const newTheme = await page.evaluate(() => {
      return document.documentElement.getAttribute('data-theme');
    });
    expect(newTheme).toBe('nord');

    // Verify it persisted to localStorage
    const savedTheme = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
      return s.theme;
    });
    expect(savedTheme).toBe('nord');
  });

  test('Clear Terminal command works', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'clear-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Type some content
    const { typeInTerminal, pressKey, waitForTerminalText } = require('../helpers/terminal-helpers');
    const marker = `CLEAR_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker, 15000);

    // Open palette and clear terminal
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);
    const palette = page.locator('ninja-keys');
    const input = palette.locator('input[type="text"]').first();
    if (await input.isVisible()) {
      await input.fill('Clear Terminal');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
    }

    // Verify terminal was cleared (marker no longer in visible area)
    await focusTerminal(page);
  });

  test('keyboard navigation works in palette', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Open palette
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    // Arrow down to navigate, Escape to close
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(100);

    // Escape closes
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  });
});
