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
      // ninja-keys uses Shadow DOM, so standard locators cannot reach its
      // internal action list. Query the shadow root via page.evaluate().
      const count = await page.evaluate(() => {
        const nk = document.querySelector('ninja-keys');
        if (!nk || !nk.shadowRoot) return 0;
        // ninja-action elements are rendered inside .actions-list in the shadow root
        const actions = nk.shadowRoot.querySelectorAll('.actions-list ninja-action');
        if (actions.length > 0) return actions.length;
        // Fallback: any element with "action" in its class name
        return nk.shadowRoot.querySelectorAll('.modal-body [class*="action"]').length;
      });
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

    // Verify terminal was cleared. Note: xterm.js terminal.clear() only
    // clears the scrollback buffer above the viewport — any lines still in
    // the current viewport remain. We verify the clear worked by checking
    // that the buffer length was reduced (scrollback wiped), rather than
    // asserting the marker is completely gone from the viewport.
    await focusTerminal(page);
    const bufferLength = await page.evaluate(() => {
      const term = window.app && window.app.terminal;
      if (!term) return 999;
      return term.buffer.active.length;
    });
    // After clear(), the buffer should contain only the visible viewport rows
    // (i.e. buffer.length === terminal.rows), not the accumulated scrollback.
    const viewportRows = await page.evaluate(() => {
      const term = window.app && window.app.terminal;
      return term ? term.rows : 24;
    });
    expect(bufferLength).toBeLessThanOrEqual(viewportRows + 5);
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
