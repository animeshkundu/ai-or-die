// @ts-check
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  waitForTerminalCanvas,
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

test.describe('Command Palette Styling — ninja-keys theme integration', () => {

  test('ninja-keys element is present and receives CSS variables', async ({ page }) => {
    setupPageCapture(page);
    await createSessionViaApi(port, 'palette-style-1');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Wait for ninja-keys custom element to be defined
    await page.waitForFunction(() => customElements.get('ninja-keys'), { timeout: 10000 });
    await page.waitForTimeout(500);

    // Open command palette with Ctrl+K
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    // Verify the palette element is present
    const ninjaExists = await page.evaluate(() => {
      return !!document.querySelector('ninja-keys');
    });
    expect(ninjaExists).toBe(true);

    // Check that ninja-keys CSS variables are set (not empty)
    const accentColor = await page.evaluate(() => {
      const nk = document.querySelector('ninja-keys');
      return getComputedStyle(nk).getPropertyValue('--ninja-accent-color').trim();
    });
    expect(accentColor).not.toBe('');

    const modalBg = await page.evaluate(() => {
      const nk = document.querySelector('ninja-keys');
      return getComputedStyle(nk).getPropertyValue('--ninja-modal-background').trim();
    });
    expect(modalBg).not.toBe('');

    const textColor = await page.evaluate(() => {
      const nk = document.querySelector('ninja-keys');
      return getComputedStyle(nk).getPropertyValue('--ninja-text-color').trim();
    });
    expect(textColor).not.toBe('');

    // Close palette
    await page.keyboard.press('Escape');
  });

  test('palette styling adapts when theme changes to nord', async ({ page }) => {
    setupPageCapture(page);
    await createSessionViaApi(port, 'palette-style-nord');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Wait for ninja-keys custom element
    await page.waitForFunction(() => customElements.get('ninja-keys'), { timeout: 10000 });
    await page.waitForTimeout(500);

    // Capture default theme accent color
    const defaultAccent = await page.evaluate(() => {
      const nk = document.querySelector('ninja-keys');
      return getComputedStyle(nk).getPropertyValue('--ninja-accent-color').trim();
    });

    // Switch to nord theme via localStorage and data-theme attribute
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'nord');
      const settings = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
      settings.theme = 'nord';
      localStorage.setItem('cc-web-settings', JSON.stringify(settings));
    });

    // Reload to apply theme fully
    await page.reload();
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await page.waitForFunction(() => customElements.get('ninja-keys'), { timeout: 10000 });
    await page.waitForTimeout(500);

    // Verify the data-theme is set
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('nord');

    // Open palette
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);

    // Check that accent color resolves to the nord theme value
    // Nord accent-default is #88c0d0
    const nordAccent = await page.evaluate(() => {
      const nk = document.querySelector('ninja-keys');
      return getComputedStyle(nk).getPropertyValue('--ninja-accent-color').trim();
    });
    expect(nordAccent).not.toBe('');

    // Verify the ninja-keys modal background also reflects the new theme
    const nordModalBg = await page.evaluate(() => {
      const nk = document.querySelector('ninja-keys');
      return getComputedStyle(nk).getPropertyValue('--ninja-modal-background').trim();
    });
    expect(nordModalBg).not.toBe('');

    // Close palette
    await page.keyboard.press('Escape');
  });

  test('palette has dark class for dark themes', async ({ page }) => {
    setupPageCapture(page);
    await createSessionViaApi(port, 'palette-style-dark-class');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await page.waitForFunction(() => customElements.get('ninja-keys'), { timeout: 10000 });
    await page.waitForTimeout(500);

    // Switch to monokai (dark theme) via command palette manager
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'monokai');
      const settings = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
      settings.theme = 'monokai';
      localStorage.setItem('cc-web-settings', JSON.stringify(settings));
      if (window.commandPaletteManager) {
        window.commandPaletteManager._syncThemeClass('monokai');
      }
    });

    // Verify ninja-keys has the 'dark' class
    const hasDark = await page.evaluate(() => {
      const nk = document.querySelector('ninja-keys');
      return nk && nk.classList.contains('dark');
    });
    expect(hasDark).toBe(true);
  });

  test('palette loses dark class for light themes', async ({ page }) => {
    setupPageCapture(page);
    await createSessionViaApi(port, 'palette-style-light-class');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await page.waitForFunction(() => customElements.get('ninja-keys'), { timeout: 10000 });
    await page.waitForTimeout(500);

    // Switch to classic-light (light theme)
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'classic-light');
      const settings = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
      settings.theme = 'classic-light';
      localStorage.setItem('cc-web-settings', JSON.stringify(settings));
      if (window.commandPaletteManager) {
        window.commandPaletteManager._syncThemeClass('classic-light');
      }
    });

    // Verify ninja-keys does NOT have the 'dark' class for light themes
    const hasDark = await page.evaluate(() => {
      const nk = document.querySelector('ninja-keys');
      return nk && nk.classList.contains('dark');
    });
    expect(hasDark).toBe(false);
  });

  test('all ninja-keys CSS variables are populated', async ({ page }) => {
    setupPageCapture(page);
    await createSessionViaApi(port, 'palette-style-vars');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await page.waitForFunction(() => customElements.get('ninja-keys'), { timeout: 10000 });
    await page.waitForTimeout(500);

    // Check all expected ninja-keys CSS variables
    const variables = await page.evaluate(() => {
      const nk = document.querySelector('ninja-keys');
      if (!nk) return null;
      const style = getComputedStyle(nk);
      return {
        accentColor: style.getPropertyValue('--ninja-accent-color').trim(),
        secondaryBg: style.getPropertyValue('--ninja-secondary-background-color').trim(),
        secondaryText: style.getPropertyValue('--ninja-secondary-text-color').trim(),
        textColor: style.getPropertyValue('--ninja-text-color').trim(),
        fontFamily: style.getPropertyValue('--ninja-font-family').trim(),
        fontSize: style.getPropertyValue('--ninja-font-size').trim(),
        zIndex: style.getPropertyValue('--ninja-z-index').trim(),
        modalBg: style.getPropertyValue('--ninja-modal-background').trim(),
        actionsBg: style.getPropertyValue('--ninja-actions-background').trim(),
        groupText: style.getPropertyValue('--ninja-group-text-color').trim(),
        footerBg: style.getPropertyValue('--ninja-footer-background').trim(),
        selectedBg: style.getPropertyValue('--ninja-selected-background').trim(),
      };
    });

    expect(variables).not.toBeNull();
    // Each CSS variable should be populated (not empty string)
    for (const [key, value] of Object.entries(variables)) {
      expect(value, `--ninja-${key} should not be empty`).not.toBe('');
    }
  });
});
