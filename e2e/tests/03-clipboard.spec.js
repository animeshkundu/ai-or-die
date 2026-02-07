const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  waitForTerminalText,
  readTerminalContent,
  typeInTerminal,
  pressKey,
  focusTerminal,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

test.describe('Clipboard: keyboard shortcuts for copy and paste', () => {
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
    const sessionId = await createSessionViaApi(port, `Clip_${Date.now()}`);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    await joinSessionAndStartTerminal(page, sessionId);
  }

  test('Ctrl+C with selection copies text to clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupTerminalPage(page);

    // Type something to create content
    const marker = `COPY_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker, 15000);

    // Select all terminal text
    await page.evaluate(() => window.app.terminal.selectAll());

    // Verify selection exists
    const hasSelection = await page.evaluate(() => window.app.terminal.hasSelection());
    expect(hasSelection).toBe(true);

    // Press Ctrl+C (should copy selection, NOT send SIGINT)
    await focusTerminal(page);
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);

    // Read clipboard
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain(marker);
  });

  test('Ctrl+C without selection sends SIGINT (shell stays alive)', async ({ page }) => {
    await setupTerminalPage(page);

    // Press Ctrl+C without any selection (should send SIGINT)
    await focusTerminal(page);
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(1000);

    // Shell should still be alive — type a new command
    const marker = `ALIVE_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker}`);
    await pressKey(page, 'Enter');

    await waitForTerminalText(page, marker, 15000);
  });

  test('Ctrl+V pastes text from clipboard into terminal', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setupTerminalPage(page);

    // Write text to clipboard
    const pasteText = `echo PASTED_${Date.now()}`;
    await page.evaluate((text) => navigator.clipboard.writeText(text), pasteText);

    // Focus terminal and press Ctrl+V
    await focusTerminal(page);
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(1000);

    // Press Enter to execute
    await pressKey(page, 'Enter');

    // Verify pasted text produced output
    await waitForTerminalText(page, 'PASTED_', 15000);
  });
});
