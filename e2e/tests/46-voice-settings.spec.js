// @ts-check
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  waitForTerminalCanvas,
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

test.describe('Voice Settings — recording mode, input method, mic sounds', () => {

  test('Recording Mode select exists with Push-to-Talk and Toggle options', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'voice-settings-1');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings modal
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Verify Recording Mode select exists
    const selectExists = await page.evaluate(() => {
      return !!document.getElementById('voiceRecordingMode');
    });
    expect(selectExists).toBe(true);

    // Verify options are Push-to-Talk and Toggle
    const options = await page.evaluate(() => {
      const select = document.getElementById('voiceRecordingMode');
      if (!select) return [];
      return Array.from(select.options).map(opt => ({
        value: opt.value,
        text: opt.text,
      }));
    });

    expect(options).toHaveLength(2);
    expect(options[0].value).toBe('push-to-talk');
    expect(options[0].text).toBe('Push-to-Talk');
    expect(options[1].value).toBe('toggle');
    expect(options[1].text).toBe('Toggle');

    // Close settings
    await page.click('#closeSettingsBtn');
  });

  test('default Recording Mode is Push-to-Talk', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'voice-settings-default');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Check default value
    const defaultMode = await page.evaluate(() => {
      const select = document.getElementById('voiceRecordingMode');
      return select ? select.value : null;
    });
    expect(defaultMode).toBe('push-to-talk');

    await page.click('#closeSettingsBtn');
  });

  test('Recording Mode change to Toggle persists across reload', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'voice-settings-persist');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings and change to Toggle
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    await page.selectOption('#voiceRecordingMode', 'toggle');
    await page.waitForTimeout(200);

    // Save settings
    await page.click('#saveSettingsBtn');
    await page.waitForTimeout(500);
    await page.click('#closeSettingsBtn');
    await page.waitForTimeout(300);

    // Reload page and rejoin session so overlay hides
    await page.reload();
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings — wait for button to be actionable after overlay clears
    await page.waitForSelector('#settingsBtn', { state: 'visible', timeout: 10000 });
    await page.waitForTimeout(500);
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Verify Toggle is still selected
    const mode = await page.evaluate(() => {
      const select = document.getElementById('voiceRecordingMode');
      return select ? select.value : null;
    });
    expect(mode).toBe('toggle');

    // Also verify via localStorage
    const persisted = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
      return s.voiceRecordingMode;
    });
    expect(persisted).toBe('toggle');

    await page.click('#closeSettingsBtn');
  });

  test('Input Method select exists with Auto, Cloud, and Local options', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'voice-settings-method');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Verify Input Method select exists
    const selectExists = await page.evaluate(() => {
      return !!document.getElementById('voiceMethod');
    });
    expect(selectExists).toBe(true);

    // Verify options
    const options = await page.evaluate(() => {
      const select = document.getElementById('voiceMethod');
      if (!select) return [];
      return Array.from(select.options).map(opt => ({
        value: opt.value,
        text: opt.text,
      }));
    });

    expect(options).toHaveLength(3);
    expect(options[0].value).toBe('auto');
    expect(options[0].text).toBe('Auto');
    expect(options[1].value).toBe('cloud');
    expect(options[1].text).toBe('Cloud');
    expect(options[2].value).toBe('local');
    expect(options[2].text).toBe('Local');

    await page.click('#closeSettingsBtn');
  });

  test('Mic Sounds checkbox exists and is checked by default', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'voice-settings-mic-sounds');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Verify Mic Sounds checkbox exists
    const checkboxExists = await page.evaluate(() => {
      const el = document.getElementById('micSounds');
      return el && el.type === 'checkbox';
    });
    expect(checkboxExists).toBe(true);

    // Verify it is checked by default
    const isChecked = await page.evaluate(() => {
      const el = document.getElementById('micSounds');
      return el ? el.checked : null;
    });
    expect(isChecked).toBe(true);

    await page.click('#closeSettingsBtn');
  });

  test('Mic Sounds unchecked state persists across reload', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'voice-settings-mic-persist');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings and uncheck Mic Sounds
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    await page.evaluate(() => {
      const cb = document.getElementById('micSounds');
      if (cb && cb.checked) cb.click();
    });
    await page.waitForTimeout(200);

    // Save settings
    await page.click('#saveSettingsBtn');
    await page.waitForTimeout(500);
    await page.click('#closeSettingsBtn');
    await page.waitForTimeout(300);

    // Reload and rejoin session so overlay hides
    await page.reload();
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings — wait for button to be actionable after overlay clears
    await page.waitForSelector('#settingsBtn', { state: 'visible', timeout: 10000 });
    await page.waitForTimeout(500);
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Verify Mic Sounds remains unchecked
    const isChecked = await page.evaluate(() => {
      const el = document.getElementById('micSounds');
      return el ? el.checked : null;
    });
    expect(isChecked).toBe(false);

    // Verify via localStorage
    const persisted = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
      return s.micSounds;
    });
    expect(persisted).toBe(false);

    await page.click('#closeSettingsBtn');
  });

  test('Voice Input section header is present in settings modal', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'voice-settings-section');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Verify the Voice Input section header exists
    const sectionHeader = await page.evaluate(() => {
      const section = document.querySelector('.setting-section[data-section="voice"]');
      if (!section) return null;
      const header = section.querySelector('.setting-section-header');
      return header ? header.textContent.trim() : null;
    });
    expect(sectionHeader).toBe('Voice Input');

    await page.click('#closeSettingsBtn');
  });

  test('Input Method default is Auto', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'voice-settings-method-default');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    const defaultMethod = await page.evaluate(() => {
      const select = document.getElementById('voiceMethod');
      return select ? select.value : null;
    });
    expect(defaultMethod).toBe('auto');

    await page.click('#closeSettingsBtn');
  });

  test('voice settings are included in loadSettings defaults', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Load default settings from the app
    const defaults = await page.evaluate(() => {
      if (!window.app || !window.app.loadSettings) return null;
      const settings = window.app.loadSettings();
      return {
        voiceRecordingMode: settings.voiceRecordingMode,
        voiceMethod: settings.voiceMethod,
        micSounds: settings.micSounds,
      };
    });

    expect(defaults).not.toBeNull();
    expect(defaults.voiceRecordingMode).toBe('push-to-talk');
    expect(defaults.voiceMethod).toBe('auto');
    expect(defaults.micSounds).toBe(true);
  });
});
