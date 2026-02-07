const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
} = require('../helpers/terminal-helpers');

test.describe('Theme switching', () => {
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

  test('default theme is midnight (no data-theme attribute)', async ({ page }) => {
    await createSessionViaApi(port, 'Theme Default');
    await page.goto(url);
    await waitForAppReady(page);

    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    // Midnight is default — no attribute or null
    expect(theme).toBeNull();
  });

  test('switching to classic-dark sets data-theme attribute', async ({ page }) => {
    await createSessionViaApi(port, 'Theme Classic');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Open settings and change theme
    await page.waitForSelector('#settingsBtn', { state: 'visible', timeout: 10000 });
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 10000 });

    const themeSelect = page.locator('#themeSelect');
    await themeSelect.selectOption('classic-dark');

    // Save settings
    await page.click('#saveSettingsBtn');
    await page.waitForTimeout(500);

    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('classic-dark');
  });

  test('switching to monokai updates CSS variables', async ({ page }) => {
    await createSessionViaApi(port, 'Theme Monokai');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Open settings and change theme
    await page.waitForSelector('#settingsBtn', { state: 'visible', timeout: 10000 });
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 10000 });

    const themeSelect = page.locator('#themeSelect');
    await themeSelect.selectOption('monokai');
    await page.click('#saveSettingsBtn');
    await page.waitForTimeout(500);

    // Verify CSS variable changed
    const bgColor = await page.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue('--surface-primary').trim();
    });

    // Monokai background is #272822
    expect(bgColor).toBe('#272822');
  });

  test('theme persists across page reload', async ({ page }) => {
    await createSessionViaApi(port, 'Theme Persist');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Set theme to nord
    await page.waitForSelector('#settingsBtn', { state: 'visible', timeout: 10000 });
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 10000 });
    await page.locator('#themeSelect').selectOption('nord');
    await page.click('#saveSettingsBtn');
    await page.waitForTimeout(300);

    // Reload page
    await page.reload();
    await waitForAppReady(page);

    // Theme should persist
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('nord');
  });
});
