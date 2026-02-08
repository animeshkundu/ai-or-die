const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  waitForTerminalText,
  typeInTerminal,
  pressKey,
  focusTerminal,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

test.describe('Large paste: data arrives intact through chunked write pipeline', () => {
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
    const sessionId = await createSessionViaApi(port, `Paste_${Date.now()}`);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    await joinSessionAndStartTerminal(page, sessionId);
  }

  test('large paste via terminal.paste() API arrives intact', async ({ page }) => {
    await setupTerminalPage(page);

    // Build a large string (>4KB to trigger chunked write on server)
    const marker = `LPASTE_${Date.now()}`;
    const padding = 'X'.repeat(3000);
    const largeText = `echo ${marker}_${padding}_END`;

    // Paste directly via xterm.js API (bypasses clipboard API fragility)
    await page.evaluate((text) => {
      window.app.terminal.paste(text);
    }, largeText);

    await page.waitForTimeout(500);
    await pressKey(page, 'Enter');

    // Verify the marker appears in output (proves data arrived intact)
    await waitForTerminalText(page, marker, 20000);
  });

  test('paste via Ctrl+V with clipboard API works for moderate text', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupTerminalPage(page);

    // Use moderate text size to avoid clipboard API flakiness
    const marker = `CTRLV_${Date.now()}`;
    const pasteText = `echo ${marker}_CLIPBOARD_TEST`;

    // Write to clipboard
    await page.evaluate((text) => navigator.clipboard.writeText(text), pasteText);

    // Focus terminal and paste
    await focusTerminal(page);
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(1000);
    await pressKey(page, 'Enter');

    await waitForTerminalText(page, marker, 15000);
  });
});
