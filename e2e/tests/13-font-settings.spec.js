const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

test.describe('Font settings', () => {
  let server, port, url;

  test.beforeAll(async () => {
    const result = await createServer();
    server = result.server;
    port = result.port;
    url = result.url;
  });

  test.afterAll(async () => {
    if (server) await server.close();
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  test('font family setting changes terminal font', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Font Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    // Use evaluate to bypass layout stability checks from CDN font loading
    await page.evaluate(() => document.getElementById('settingsBtn').click());
    await page.waitForSelector('.settings-modal.active', { timeout: 10000 });

    // Change font to JetBrains Mono
    const fontSelect = page.locator('#fontFamily');
    await fontSelect.selectOption("'JetBrains Mono NF', 'MesloLGS Nerd Font', monospace");

    // Save settings
    await page.evaluate(() => document.getElementById('saveSettingsBtn').click());
    await page.waitForTimeout(500);

    // Verify terminal font changed
    const terminalFont = await page.evaluate(() => {
      return window.app && window.app.terminal ? window.app.terminal.options.fontFamily : null;
    });

    expect(terminalFont).toContain('JetBrains Mono');
  });

  test('cursor style setting changes terminal cursor', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Cursor Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    // Use evaluate to bypass layout stability checks from CDN font loading
    await page.evaluate(() => document.getElementById('settingsBtn').click());
    await page.waitForSelector('.settings-modal.active', { timeout: 10000 });

    // Change cursor to bar
    const cursorSelect = page.locator('#cursorStyle');
    await cursorSelect.selectOption('bar');

    // Save settings
    await page.evaluate(() => document.getElementById('saveSettingsBtn').click());
    await page.waitForTimeout(500);

    // Verify cursor style changed
    const cursorStyle = await page.evaluate(() => {
      return window.app && window.app.terminal ? window.app.terminal.options.cursorStyle : null;
    });

    expect(cursorStyle).toBe('bar');
  });

  test('font size setting persists', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Font Size Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Open settings and change font size
    // Use evaluate to bypass layout stability checks from CDN font loading
    await page.evaluate(() => document.getElementById('settingsBtn').click());
    await page.waitForSelector('.settings-modal.active', { timeout: 10000 });

    const slider = page.locator('#fontSize');
    await slider.fill('18');
    await page.evaluate(() => document.getElementById('saveSettingsBtn').click());
    await page.waitForTimeout(300);

    // Verify font size changed
    const fontSize = await page.evaluate(() => {
      return window.app && window.app.terminal ? window.app.terminal.options.fontSize : null;
    });

    expect(fontSize).toBe(18);
  });
});
