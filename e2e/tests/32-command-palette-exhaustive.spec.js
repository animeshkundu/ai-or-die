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

    const input = palette.locator('input[type="text"]').first();
    await expect(input).toBeVisible();

    for (const cmd of expectedCommands) {
      await input.fill('');
      await input.fill(cmd.split(':')[0].trim());
      await page.waitForTimeout(300);
      // Verify at least one matching result appears
      const results = palette.locator('ninja-keys [class*="action"]');
      const count = await results.count().catch(() => 0);
      expect(count).toBeGreaterThan(0);
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
    const { typeInTerminal, pressKey, waitForTerminalText, readTerminalContent } = require('../helpers/terminal-helpers');
    const marker = `CLEAR_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker, 15000);

    // Open palette and clear terminal
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);
    const palette = page.locator('ninja-keys');
    const input = palette.locator('input[type="text"]').first();
    await expect(input).toBeVisible();
    await input.fill('Clear Terminal');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    // Verify terminal was actually cleared
    await focusTerminal(page);
    const content = await readTerminalContent(page);
    expect(content).not.toContain(marker);
  });

  test('keyboard navigation works in palette', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Open palette and verify visible
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);
    const palette = page.locator('ninja-keys');
    await expect(palette).toBeAttached();

    // Arrow down to navigate — verify palette stays open
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(100);
    await expect(palette).toBeAttached();

    // Escape closes the palette
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    // Verify palette is no longer open (ninja-keys hides its internal content)
    const isOpen = await page.evaluate(() => {
      const nk = document.querySelector('ninja-keys');
      return nk && nk.opened;
    });
    expect(isOpen).toBeFalsy();
  });
});
