const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  waitForTerminalText,
  typeInTerminal,
  pressKey,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
  waitForWsMessage,
} = require('../helpers/terminal-helpers');

// Keep copy assertions deterministic when a previously registered service
// worker could otherwise serve stale page state.
test.use({ serviceWorkers: 'block' });

test.describe('Context menu: right-click terminal shows menu', () => {
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

  async function setupTerminalPage(page) {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, `Ctx_${Date.now()}`);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    await joinSessionAndStartTerminal(page, sessionId);
    const started = await waitForWsMessage(page, 'recv', 'terminal_started', 10000);
    expect(started, 'terminal_started frame should be received').toBeTruthy();
    expect(started).toMatchObject({ type: 'terminal_started', sessionId });
  }

  async function stubClipboard(page) {
    await page.evaluate(() => {
      const state = { attempts: 0, completed: 0, text: null, error: null };
      const writeText = (text) => new Promise((resolve, reject) => {
        state.attempts += 1;
        if (typeof text !== 'string') {
          state.error = `clipboard.writeText expects a string, got ${typeof text}`;
          reject(new TypeError(state.error));
          return;
        }
        // Complete asynchronously so the assertion proves the copy path waits
        // for the clipboard promise.
        setTimeout(() => {
          state.text = text;
          state.completed += 1;
          resolve();
        }, 0);
      });
      const readText = () => Promise.resolve(state.text || '');

      let installed = false;
      let installError = null;
      try {
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText, readText },
          configurable: true,
        });
        installed = !!(navigator.clipboard && navigator.clipboard.writeText === writeText
          && navigator.clipboard.readText === readText);
      } catch (error) {
        installError = error;
      }
      if (!installed && navigator.clipboard) {
        try {
          Object.defineProperty(navigator.clipboard, 'writeText', {
            value: writeText,
            configurable: true,
          });
          Object.defineProperty(navigator.clipboard, 'readText', {
            value: readText,
            configurable: true,
          });
          installed = navigator.clipboard.writeText === writeText
            && navigator.clipboard.readText === readText;
        } catch (error) {
          installError = error;
        }
      }
      if (!installed) {
        throw new Error(`Unable to install clipboard stub: ${installError ? installError.message : 'unknown error'}`);
      }
      window.__contextClipboard = state;
    });
  }

  async function waitForClipboardWrite(page) {
    await expect.poll(() => page.evaluate(() => window.__contextClipboard), {
      timeout: 5000,
    }).toMatchObject({ attempts: 1, completed: 1, error: null });
  }

  test('right-click on terminal shows context menu with all items', async ({ page }) => {
    await setupTerminalPage(page);

    // Right-click on the terminal canvas
    const terminalArea = page.locator('[data-tid="terminal"] .xterm-screen, #terminal .xterm-screen').first();
    await terminalArea.click({ button: 'right', position: { x: 100, y: 50 } });

    // Menu should be visible
    const menu = page.locator('[data-tid="context-menu"]');
    await expect(menu).toBeVisible();

    // Verify all menu items exist
    await expect(menu.locator('[data-action="copy"]')).toBeVisible();
    await expect(menu.locator('[data-action="paste"]')).toBeVisible();
    await expect(menu.locator('[data-action="pastePlain"]')).toBeVisible();
    await expect(menu.locator('[data-action="pasteImage"]')).toBeVisible();
    await expect(menu.locator('[data-action="attachImage"]')).toBeVisible();
    await expect(menu.locator('[data-action="selectAll"]')).toBeVisible();
    await expect(menu.locator('[data-action="clear"]')).toBeVisible();
  });

  test('Copy stays enabled without a selection and copies visible terminal output', async ({ page }) => {
    await setupTerminalPage(page);
    await stubClipboard(page);

    const marker = `CTX_COPY_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker, 15000);
    await page.evaluate(() => window.app.terminal.clearSelection());

    const terminalArea = page.locator('[data-tid="terminal"] .xterm-screen, #terminal .xterm-screen').first();
    await terminalArea.click({ button: 'right', position: { x: 100, y: 50 } });

    const copyItem = page.locator('#termContextMenu [data-action="copy"]');
    await expect(copyItem).toBeVisible();
    await expect(copyItem).not.toHaveClass(/disabled/);
    await expect(copyItem).not.toHaveAttribute('aria-disabled', 'true');

    await copyItem.click();
    await waitForClipboardWrite(page);
    const clipboardText = await page.evaluate(() => window.__contextClipboard.text);
    expect(clipboardText).toContain(marker);
    expect(await page.evaluate(() => window.__contextClipboard.error)).toBeNull();
    expect(await page.evaluate(() => window.__contextClipboard.attempts)).toBe(1);
    expect(await page.evaluate(() => window.__contextClipboard.completed)).toBe(1);
  });

  test('Select All menu item selects terminal content', async ({ page }) => {
    await setupTerminalPage(page);

    // Open context menu
    const terminalArea = page.locator('[data-tid="terminal"] .xterm-screen, #terminal .xterm-screen').first();
    await terminalArea.click({ button: 'right', position: { x: 100, y: 50 } });

    // Click Select All
    await page.locator('#termContextMenu [data-action="selectAll"]').click();

    // Verify terminal has selection
    const hasSelection = await page.evaluate(() => window.app.terminal.hasSelection());
    expect(hasSelection).toBe(true);
  });

  test('context menu closes when clicking elsewhere', async ({ page }) => {
    await setupTerminalPage(page);

    // Open context menu
    const terminalArea = page.locator('[data-tid="terminal"] .xterm-screen, #terminal .xterm-screen').first();
    await terminalArea.click({ button: 'right', position: { x: 100, y: 50 } });

    const menu = page.locator('[data-tid="context-menu"]');
    await expect(menu).toBeVisible();

    // Click elsewhere
    await page.locator('body').click({ position: { x: 10, y: 10 } });
    await expect(menu).not.toBeVisible();
  });

  test('Escape key closes context menu', async ({ page }) => {
    await setupTerminalPage(page);

    // Open context menu
    const terminalArea = page.locator('[data-tid="terminal"] .xterm-screen, #terminal .xterm-screen').first();
    await terminalArea.click({ button: 'right', position: { x: 100, y: 50 } });

    const menu = page.locator('[data-tid="context-menu"]');
    await expect(menu).toBeVisible();

    // Press Escape
    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
  });

  test('all menu items have SVG icons', async ({ page }) => {
    await setupTerminalPage(page);

    // Open context menu
    const terminalArea = page.locator('[data-tid="terminal"] .xterm-screen, #terminal .xterm-screen').first();
    await terminalArea.click({ button: 'right', position: { x: 100, y: 50 } });

    const menu = page.locator('[data-tid="context-menu"]');
    await expect(menu).toBeVisible();

    // Every .ctx-item should have a .ctx-icon containing an <svg>
    const actions = ['copy', 'paste', 'pastePlain', 'pasteImage', 'attachImage', 'selectAll', 'clear'];
    for (const action of actions) {
      const icon = menu.locator(`[data-action="${action}"] .ctx-icon svg`);
      await expect(icon).toBeAttached();
    }
  });

  test('icon containers are consistent width for text alignment', async ({ page }) => {
    await setupTerminalPage(page);

    // Open context menu
    const terminalArea = page.locator('[data-tid="terminal"] .xterm-screen, #terminal .xterm-screen').first();
    await terminalArea.click({ button: 'right', position: { x: 100, y: 50 } });

    const menu = page.locator('[data-tid="context-menu"]');
    await expect(menu).toBeVisible();

    // Verify all icon containers render at consistent width and position
    const iconData = await menu.locator('.ctx-item .ctx-icon').evaluateAll(icons =>
      icons.map(icon => {
        const rect = icon.getBoundingClientRect();
        return { width: rect.width, left: rect.left };
      })
    );

    expect(iconData.length).toBeGreaterThanOrEqual(7);

    // All icons should be 16px wide (enforced by CSS min-width)
    for (const icon of iconData) {
      expect(icon.width).toBeCloseTo(16, 0);
    }

    // All icons should be at the same horizontal position
    const firstLeft = iconData[0].left;
    for (const icon of iconData) {
      expect(Math.abs(icon.left - firstLeft)).toBeLessThanOrEqual(1);
    }
  });

  test('text labels are left-aligned at a consistent position', async ({ page }) => {
    await setupTerminalPage(page);

    // Open context menu
    const terminalArea = page.locator('[data-tid="terminal"] .xterm-screen, #terminal .xterm-screen').first();
    await terminalArea.click({ button: 'right', position: { x: 100, y: 50 } });

    const menu = page.locator('[data-tid="context-menu"]');
    await expect(menu).toBeVisible();

    // Collect bounding rects of every text label span (not .ctx-icon, not .shortcut)
    const labelData = await menu.locator('.ctx-item span:not(.ctx-icon):not(.shortcut)').evaluateAll(spans =>
      spans.map(s => {
        const rect = s.getBoundingClientRect();
        const style = window.getComputedStyle(s);
        return { left: rect.left, textAlign: style.textAlign };
      })
    );

    expect(labelData.length).toBeGreaterThanOrEqual(7);

    // All text labels should be left-aligned
    for (const label of labelData) {
      expect(label.textAlign).toBe('left');
    }

    // All text labels should start at the same horizontal position
    const firstLabelLeft = labelData[0].left;
    for (const label of labelData) {
      expect(Math.abs(label.left - firstLabelLeft)).toBeLessThanOrEqual(1);
    }
  });
});
