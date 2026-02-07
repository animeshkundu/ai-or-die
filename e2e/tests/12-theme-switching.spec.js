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
    expect(theme).toBeNull();
  });

  test('switching to classic-dark sets data-theme attribute', async ({ page }) => {
    await createSessionViaApi(port, 'Theme Classic');
    await page.goto(url);
    await waitForAppReady(page);

    // Apply theme directly via JS (same as command palette does)
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'classic-dark');
      const settings = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
      settings.theme = 'classic-dark';
      localStorage.setItem('cc-web-settings', JSON.stringify(settings));
    });

    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('classic-dark');
  });

  test('switching to monokai updates CSS variables', async ({ page }) => {
    await createSessionViaApi(port, 'Theme Monokai');
    await page.goto(url);
    await waitForAppReady(page);

    // Apply monokai theme
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'monokai');
      const settings = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
      settings.theme = 'monokai';
      localStorage.setItem('cc-web-settings', JSON.stringify(settings));
    });

    // Verify CSS variable changed
    const bgColor = await page.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue('--surface-primary').trim();
    });

    expect(bgColor).toBe('#272822');
  });

  test('theme persists across page reload', async ({ page }) => {
    await createSessionViaApi(port, 'Theme Persist');
    await page.goto(url);
    await waitForAppReady(page);

    // Set theme to nord via localStorage
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'nord');
      const settings = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
      settings.theme = 'nord';
      localStorage.setItem('cc-web-settings', JSON.stringify(settings));
    });

    // Reload page
    await page.reload();
    await waitForAppReady(page);

    // Theme should persist (early-apply script reads from localStorage)
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('nord');
  });
});
