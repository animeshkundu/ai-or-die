const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

test.describe('Nerd Font rendering infrastructure', () => {
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

  test('default font includes Nerd Font on fresh load', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Nerd Font Default');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const fontFamily = await page.evaluate(() => {
      return window.app && window.app.terminal
        ? window.app.terminal.options.fontFamily
        : null;
    });

    expect(fontFamily).not.toBeNull();
    expect(fontFamily).toMatch(/Meslo.*Nerd/i);
  });

  test('unicode11 addon is active', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Unicode11 Check');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const unicodeVersion = await page.evaluate(() => {
      return window.app && window.app.terminal
        ? window.app.terminal.unicode.activeVersion
        : null;
    });

    expect(unicodeVersion).toBe('11');
  });

  test('settings are applied on init without manual save', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Settings Init Test');
    await page.goto(url);

    // Clear saved settings so we get fresh defaults
    await page.evaluate(() => localStorage.removeItem('cc-web-settings'));
    await page.reload();

    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const fontFamily = await page.evaluate(() => {
      return window.app && window.app.terminal
        ? window.app.terminal.options.fontFamily
        : null;
    });

    expect(fontFamily).not.toBeNull();
    expect(fontFamily).toContain('MesloLGS Nerd Font');
  });

  test('saved JetBrains Mono setting persists after reload', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'JetBrains Persist');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Save JetBrains Mono into localStorage as if user had set it
    await page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
      settings.fontFamily = "'JetBrains Mono', monospace";
      localStorage.setItem('cc-web-settings', JSON.stringify(settings));
    });

    // Reload to test that init reads and applies the saved setting
    await page.reload();
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await page.waitForTimeout(1000);

    const fontFamily = await page.evaluate(() => {
      return window.app && window.app.terminal
        ? window.app.terminal.options.fontFamily
        : null;
    });

    expect(fontFamily).not.toBeNull();
    expect(fontFamily).toContain('JetBrains Mono');
    expect(fontFamily).not.toMatch(/Meslo.*Nerd/i);
  });

  test('unicode11 addon in split pane terminals', async ({ page }) => {
    const sessionId1 = await createSessionViaApi(port, 'Split Main');
    const sessionId2 = await createSessionViaApi(port, 'Split Right');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId1);

    // Check if SplitContainer is available
    const hasSplitContainer = await page.evaluate(() => {
      return !!(window.app && window.app.splitContainer);
    });

    if (!hasSplitContainer) {
      test.skip();
      return;
    }

    // Create a split programmatically
    await page.evaluate((sid2) => {
      return window.app.splitContainer.createSplit(sid2);
    }, sessionId2);

    await page.waitForFunction(() => {
      return window.app.splitContainer && window.app.splitContainer.enabled;
    }, { timeout: 10000 });

    // Verify unicode version on both split terminals
    const splitUnicodeVersions = await page.evaluate(() => {
      const container = window.app.splitContainer;
      if (!container || !container.splits) return [];
      return container.splits.map(split => {
        return split.terminal ? split.terminal.unicode.activeVersion : null;
      });
    });

    expect(splitUnicodeVersions.length).toBeGreaterThanOrEqual(2);
    expect(splitUnicodeVersions[0]).toBe('11');
    expect(splitUnicodeVersions[1]).toBe('11');
  });
});
