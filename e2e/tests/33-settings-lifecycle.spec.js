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

test.describe('Power User: Settings Lifecycle', () => {

  test('settings save and persist across reload', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'settings-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    // Join session so the overlay hides and the settings button is clickable
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Change theme to 'nord' via select + trigger change event
    await page.selectOption('#themeSelect', 'nord');
    await page.evaluate(() => {
      document.getElementById('themeSelect').dispatchEvent(new Event('change'));
    });
    await page.waitForTimeout(500);

    // Verify theme applied (either via change handler or after save)
    const themeBeforeSave = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    // Theme may apply on change or only on save — check after save

    // Change font size
    await page.evaluate(() => {
      const slider = document.getElementById('fontSize');
      if (slider) {
        slider.value = '18';
        slider.dispatchEvent(new Event('input'));
      }
    });

    // Save settings
    // saveSettings() flashes "Saved" then calls hideSettings() on a 1500ms
    // timer (src/public/app.js), so the modal closes ITSELF after a save.
    // Clicking #closeSettingsBtn afterwards was a race: on a fast machine the
    // click landed inside the 1500ms window and worked, but when Playwright's
    // actionability checks pushed it past the timer the modal had already gone,
    // the button was in the DOM but not visible, and the click spun until the
    // 60s test timeout. That is the Windows CI failure in this spec — the
    // screenshot at failure shows the terminal with no modal at all.
    // Wait for the documented behaviour instead of racing it.
    await page.click('#saveSettingsBtn');
    await page.waitForSelector('.settings-modal.active', { state: 'hidden', timeout: 10000 });

    // Reload page
    await page.reload();
    await waitForAppReady(page);

    // Verify theme persisted via localStorage (data-theme attribute may be null for midnight default)
    const persistedSettings = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
    });
    expect(persistedSettings.theme).toBe('nord');

    // Verify font size persisted
    const persistedFontSize = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
      return s.fontSize;
    });
    expect(String(persistedFontSize)).toBe('18');
  });

  test('reset to defaults clears all settings', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'reset-defaults-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Set a non-default theme first
    await page.evaluate(() => {
      const s = { theme: 'monokai', fontSize: 20, cursorStyle: 'underline' };
      localStorage.setItem('cc-web-settings', JSON.stringify(s));
    });
    await page.reload();
    await waitForAppReady(page);
    await waitForWebSocket(page);
    // Join session so the overlay hides and the settings button is clickable
    await joinSessionAndStartTerminal(page, sessionId);

    // Verify non-default theme is applied
    const preTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(preTheme).toBe('monokai');

    // Open settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Click Reset to Defaults
    const resetBtn = page.locator('#resetSettingsBtn');
    if (await resetBtn.isVisible()) {
      await resetBtn.click();
      await page.waitForTimeout(500);
    }

    // Save; the modal closes itself.
    // saveSettings() flashes "Saved" then calls hideSettings() on a 1500ms
    // timer (src/public/app.js), so the modal closes ITSELF after a save.
    // Clicking #closeSettingsBtn afterwards was a race: on a fast machine the
    // click landed inside the 1500ms window and worked, but when Playwright's
    // actionability checks pushed it past the timer the modal had already gone,
    // the button was in the DOM but not visible, and the click spun until the
    // 60s test timeout. That is the Windows CI failure in this spec — the
    // screenshot at failure shows the terminal with no modal at all.
    // Wait for the documented behaviour instead of racing it.
    await page.click('#saveSettingsBtn');
    await page.waitForSelector('.settings-modal.active', { state: 'hidden', timeout: 10000 });

    // Verify theme is back to default (midnight = no data-theme attribute)
    const postTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(postTheme === null || postTheme === 'midnight' || postTheme === '').toBeTruthy();
  });

  test('cursor style changes apply to terminal', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'cursor-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings and change cursor to underline
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });
    await page.selectOption('#cursorStyle', 'underline');
    await page.click('#saveSettingsBtn');
    // Modal closes itself 1500ms after save; see note above.
    await page.waitForSelector('.settings-modal.active', { state: 'hidden', timeout: 10000 });

    // Verify cursor style applied to terminal
    const cursorStyle = await page.evaluate(() => {
      return window.app.terminal.options.cursorStyle;
    });
    expect(cursorStyle).toBe('underline');
  });

  test('scrollback setting applies to terminal', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'scrollback-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings and change scrollback
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });
    await page.selectOption('#scrollback', '50000');
    await page.click('#saveSettingsBtn');
    // Modal closes itself 1500ms after save; see note above.
    await page.waitForSelector('.settings-modal.active', { state: 'hidden', timeout: 10000 });

    // Verify scrollback applied
    const scrollback = await page.evaluate(() => {
      return window.app.terminal.options.scrollback;
    });
    expect(scrollback).toBe(50000);
  });
});
