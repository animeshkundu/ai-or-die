// @ts-check
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  joinSessionAndStartTerminal,
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

test.describe('Keyboard Shortcuts Modal', () => {

  test('? key opens shortcuts modal when terminal is NOT focused', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'shortcuts-question');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Blur terminal so the ? key listener activates
    await page.evaluate(() => {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
      // Focus document body to ensure we are outside xterm
      document.body.focus();
    });
    await page.waitForTimeout(200);

    // Press ? key
    await page.keyboard.press('?');
    await page.waitForTimeout(500);

    // Verify the shortcuts modal is visible
    const isOpen = await page.evaluate(() => {
      const modal = document.getElementById('shortcutsModal');
      return modal && modal.classList.contains('active');
    });
    expect(isOpen).toBe(true);
  });

  test('shortcuts modal contains a table with shortcut entries', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Blur terminal and open shortcuts
    await page.evaluate(() => {
      if (document.activeElement) document.activeElement.blur();
      document.body.focus();
    });
    await page.waitForTimeout(200);
    await page.keyboard.press('?');
    await page.waitForTimeout(500);

    // Verify table exists
    const tableInfo = await page.evaluate(() => {
      const modal = document.getElementById('shortcutsModal');
      if (!modal) return null;
      const table = modal.querySelector('.shortcuts-table');
      if (!table) return null;
      const rows = table.querySelectorAll('tbody tr');
      return {
        hasTable: true,
        rowCount: rows.length,
        headers: Array.from(table.querySelectorAll('thead th')).map(th => th.textContent.trim()),
      };
    });

    expect(tableInfo).not.toBeNull();
    expect(tableInfo.hasTable).toBe(true);
    expect(tableInfo.rowCount).toBeGreaterThan(3);
    expect(tableInfo.headers).toContain('Shortcut');
    expect(tableInfo.headers).toContain('Action');
  });

  test('Ctrl+K shortcut is listed in the table', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Open shortcuts modal
    await page.evaluate(() => {
      if (document.activeElement) document.activeElement.blur();
      document.body.focus();
    });
    await page.waitForTimeout(200);
    await page.keyboard.press('?');
    await page.waitForTimeout(500);

    // Check that Ctrl+K is listed
    const hasCtrlK = await page.evaluate(() => {
      const modal = document.getElementById('shortcutsModal');
      if (!modal) return false;
      const kbds = modal.querySelectorAll('kbd');
      const kbdTexts = Array.from(kbds).map(k => k.textContent.trim().toLowerCase());
      // Look for 'ctrl' and 'k' in kbd elements
      return kbdTexts.includes('ctrl') && kbdTexts.includes('k');
    });
    expect(hasCtrlK).toBe(true);
  });

  test('Escape closes the shortcuts modal', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Open shortcuts modal
    await page.evaluate(() => {
      if (document.activeElement) document.activeElement.blur();
      document.body.focus();
    });
    await page.waitForTimeout(200);
    await page.keyboard.press('?');
    await page.waitForTimeout(500);

    // Verify it opened
    const openBefore = await page.evaluate(() => {
      const modal = document.getElementById('shortcutsModal');
      return modal && modal.classList.contains('active');
    });
    expect(openBefore).toBe(true);

    // Press Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Verify it closed
    const openAfter = await page.evaluate(() => {
      const modal = document.getElementById('shortcutsModal');
      return modal && modal.classList.contains('active');
    });
    expect(openAfter).toBeFalsy();
  });

  test('shortcuts modal opens via command palette', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Wait for ninja-keys custom element to be defined
    await page.waitForFunction(() => customElements.get('ninja-keys'), { timeout: 15000 });
    await page.waitForTimeout(500);

    // Open command palette with Ctrl+K
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    // Verify palette is open
    const palette = page.locator('ninja-keys');
    await expect(palette).toBeAttached();

    // Type "Keyboard" to search for shortcuts command
    const input = palette.locator('input[type="text"]').first();
    await expect(input).toBeVisible();
    await input.fill('Keyboard');
    await page.waitForTimeout(300);

    // Press Enter to select the first matching result
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    // Verify shortcuts modal is now open
    const isOpen = await page.evaluate(() => {
      const modal = document.getElementById('shortcutsModal');
      return modal && modal.classList.contains('active');
    });
    expect(isOpen).toBe(true);
  });

  test('close button closes shortcuts modal', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Open shortcuts modal
    await page.evaluate(() => {
      if (document.activeElement) document.activeElement.blur();
      document.body.focus();
    });
    await page.waitForTimeout(200);
    await page.keyboard.press('?');
    await page.waitForTimeout(500);

    // Click close button
    await page.click('#closeShortcutsBtn');
    await page.waitForTimeout(500);

    // Verify closed
    const isOpen = await page.evaluate(() => {
      const modal = document.getElementById('shortcutsModal');
      return modal && modal.classList.contains('active');
    });
    expect(isOpen).toBeFalsy();
  });
});
