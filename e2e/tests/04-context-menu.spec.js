const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

test.describe('Context menu: right-click terminal shows menu', () => {
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

  async function setupTerminalPage(page) {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, `Ctx_${Date.now()}`);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    await joinSessionAndStartTerminal(page, sessionId);
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

  test('menu item text is left-aligned consistently', async ({ page }) => {
    await setupTerminalPage(page);

    // Open context menu
    const terminalArea = page.locator('[data-tid="terminal"] .xterm-screen, #terminal .xterm-screen').first();
    await terminalArea.click({ button: 'right', position: { x: 100, y: 50 } });

    const menu = page.locator('[data-tid="context-menu"]');
    await expect(menu).toBeVisible();

    // Use direct children to avoid querySelectorAll traversal quirks.
    // children[0] = .ctx-icon, children[1] = text label
    const measurements = await menu.locator('.ctx-item').evaluateAll(items =>
      items.map(item => {
        const textEl = item.children[1];
        if (!textEl) return null;
        const parentRect = item.getBoundingClientRect();
        const textRect = textEl.getBoundingClientRect();
        return {
          action: item.dataset.action,
          relativeLeft: textRect.left - parentRect.left,
        };
      }).filter(v => v !== null)
    );

    // All text labels should have the same relative left offset (within 2px)
    expect(measurements.length).toBeGreaterThanOrEqual(7);
    const firstOffset = measurements[0].relativeLeft;
    for (const m of measurements) {
      expect(Math.abs(m.relativeLeft - firstOffset)).toBeLessThanOrEqual(2);
    }
  });
});
