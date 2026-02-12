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

test.describe('Settings Grouped Sections', () => {

  test('settings modal has 5 section headers', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'settings-sections');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Verify 5 section headers exist
    const sections = await page.evaluate(() => {
      const headers = document.querySelectorAll('.setting-section-header');
      return Array.from(headers).map(h => h.textContent.trim());
    });
    expect(sections).toHaveLength(5);
    expect(sections).toContain('Terminal');
    expect(sections).toContain('Voice Input');
    expect(sections).toContain('Notifications');
    expect(sections).toContain('Display');
    expect(sections).toContain('Advanced');
  });

  test('clicking section header collapses the section', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'settings-collapse');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Verify the Terminal section is initially expanded (not collapsed)
    const initialState = await page.evaluate(() => {
      const section = document.querySelector('.setting-section[data-section="terminal"]');
      return section ? section.classList.contains('collapsed') : null;
    });
    expect(initialState).toBe(false);

    // Click the Terminal section header to collapse it
    await page.evaluate(() => {
      const header = document.querySelector('.setting-section[data-section="terminal"] .setting-section-header');
      if (header) header.click();
    });
    await page.waitForTimeout(300);

    // Verify the section is now collapsed
    const collapsedState = await page.evaluate(() => {
      const section = document.querySelector('.setting-section[data-section="terminal"]');
      if (!section) return null;
      return {
        isCollapsed: section.classList.contains('collapsed'),
        ariaExpanded: section.querySelector('.setting-section-header').getAttribute('aria-expanded'),
      };
    });
    expect(collapsedState.isCollapsed).toBe(true);
    expect(collapsedState.ariaExpanded).toBe('false');

    // The content should be hidden (display: none via CSS)
    const contentHidden = await page.evaluate(() => {
      const content = document.querySelector('.setting-section[data-section="terminal"] .setting-section-content');
      if (!content) return false;
      return window.getComputedStyle(content).display === 'none';
    });
    expect(contentHidden).toBe(true);
  });

  test('clicking collapsed section header expands it again', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'settings-expand');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Collapse the Notifications section
    await page.evaluate(() => {
      const header = document.querySelector('.setting-section[data-section="notifications"] .setting-section-header');
      if (header) header.click();
    });
    await page.waitForTimeout(200);

    // Verify collapsed
    const collapsed = await page.evaluate(() => {
      const section = document.querySelector('.setting-section[data-section="notifications"]');
      return section && section.classList.contains('collapsed');
    });
    expect(collapsed).toBe(true);

    // Click again to expand
    await page.evaluate(() => {
      const header = document.querySelector('.setting-section[data-section="notifications"] .setting-section-header');
      if (header) header.click();
    });
    await page.waitForTimeout(200);

    // Verify expanded
    const expanded = await page.evaluate(() => {
      const section = document.querySelector('.setting-section[data-section="notifications"]');
      if (!section) return null;
      return {
        isCollapsed: section.classList.contains('collapsed'),
        ariaExpanded: section.querySelector('.setting-section-header').getAttribute('aria-expanded'),
      };
    });
    expect(expanded.isCollapsed).toBe(false);
    expect(expanded.ariaExpanded).toBe('true');
  });

  test('Terminal Padding setting exists as range input', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'settings-padding');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Verify padding input exists and is a range
    const paddingInput = await page.evaluate(() => {
      const el = document.getElementById('terminalPadding');
      if (!el) return null;
      return {
        exists: true,
        type: el.type,
        min: el.min,
        max: el.max,
      };
    });
    expect(paddingInput).not.toBeNull();
    expect(paddingInput.exists).toBe(true);
    expect(paddingInput.type).toBe('range');
    expect(paddingInput.min).toBe('0');
    expect(paddingInput.max).toBe('20');
  });

  test('Voice Recording Mode setting exists as select', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'settings-voice');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Verify voice recording mode select exists
    const voiceSelect = await page.evaluate(() => {
      const el = document.getElementById('voiceRecordingMode');
      if (!el) return null;
      const options = Array.from(el.options).map(o => o.value);
      return {
        exists: true,
        tagName: el.tagName,
        options,
      };
    });
    expect(voiceSelect).not.toBeNull();
    expect(voiceSelect.exists).toBe(true);
    expect(voiceSelect.tagName).toBe('SELECT');
    expect(voiceSelect.options).toContain('push-to-talk');
    expect(voiceSelect.options).toContain('toggle');
  });

  test('Mic Sounds checkbox exists', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'settings-mic');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Verify mic sounds checkbox exists
    const micCheckbox = await page.evaluate(() => {
      const el = document.getElementById('micSounds');
      if (!el) return null;
      return {
        exists: true,
        type: el.type,
        checked: el.checked,
      };
    });
    expect(micCheckbox).not.toBeNull();
    expect(micCheckbox.exists).toBe(true);
    expect(micCheckbox.type).toBe('checkbox');
  });

  test('Autonomous Mode has warning styling', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'settings-autonomous');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Verify autonomous mode has warning styling
    const warningInfo = await page.evaluate(() => {
      const dangerousCheckbox = document.getElementById('dangerousMode');
      if (!dangerousCheckbox) return null;
      const group = dangerousCheckbox.closest('.setting-group');
      if (!group) return null;
      return {
        hasWarningClass: group.classList.contains('setting-group--warning'),
        hasWarningText: !!group.querySelector('.setting-warning'),
        warningText: group.querySelector('.setting-warning')?.textContent?.trim() || '',
      };
    });
    expect(warningInfo).not.toBeNull();
    expect(warningInfo.hasWarningClass).toBe(true);
    expect(warningInfo.hasWarningText).toBe(true);
    expect(warningInfo.warningText).toContain('permission prompts');
  });

  test('Reset to Defaults button exists in modal footer', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'settings-reset-btn');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Verify Reset to Defaults button exists
    const resetBtn = await page.evaluate(() => {
      const el = document.getElementById('resetSettingsBtn');
      if (!el) return null;
      return {
        exists: true,
        text: el.textContent.trim(),
        isInFooter: !!el.closest('.modal-footer'),
      };
    });
    expect(resetBtn).not.toBeNull();
    expect(resetBtn.exists).toBe(true);
    expect(resetBtn.text).toBe('Reset to Defaults');
    expect(resetBtn.isInFooter).toBe(true);
  });
});
