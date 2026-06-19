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

const SETTINGS_PANES = ['terminal', 'voice', 'notifications', 'display', 'advanced', 'install'];

async function openSettings(page, sessionName) {
  setupPageCapture(page);
  const sessionId = await createSessionViaApi(port, sessionName);
  await page.goto(url);
  await waitForAppReady(page);
  await waitForWebSocket(page);
  await joinSessionAndStartTerminal(page, sessionId);

  await page.click('#settingsBtn');
  await page.waitForSelector('#settingsModal.active', { timeout: 5000 });
}

async function expectSelectedPane(page, paneName) {
  for (const name of SETTINGS_PANES) {
    const tab = page.locator(`#settingsTab-${name}`);
    const pane = page.locator(`#settingsPane-${name}`);
    const selected = name === paneName;

    await expect(tab).toHaveAttribute('aria-selected', String(selected));
    await expect(tab).toHaveAttribute('tabindex', selected ? '0' : '-1');

    if (selected) {
      await expect(pane).toBeVisible();
      await expect(pane).not.toHaveAttribute('hidden', '');
    } else {
      await expect(pane).toHaveAttribute('hidden', '');
      await expect(pane).toBeHidden();
    }
  }

  const visiblePaneIds = await page.locator('.settings-pane').evaluateAll((panes) =>
    panes.filter((pane) => !pane.hidden).map((pane) => pane.id)
  );
  expect(visiblePaneIds).toEqual([`settingsPane-${paneName}`]);
}

test.beforeAll(async () => {
  ({ server, port, url } = await createServer());
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.afterEach(async ({ page }, testInfo) => {
  await attachFailureArtifacts(page, testInfo);
});

test.describe('Settings tablist panes', () => {
  test('settings modal renders six tabs and six panes with Terminal active initially', async ({ page }) => {
    await openSettings(page, 'settings-tablist-initial');

    await expect(page.locator('#settingsModal.active .modal-content')).toBeVisible();
    await expect(page.locator('#settingsModal .modal-header')).toBeVisible();
    await expect(page.locator('#settingsModal .modal-footer')).toBeVisible();

    await expect(page.locator('.settings-nav[role="tablist"]')).toBeVisible();
    await expect(page.locator('.settings-tab[role="tab"]')).toHaveCount(6);
    await expect(page.locator('.settings-pane[role="tabpanel"]')).toHaveCount(6);

    for (const name of SETTINGS_PANES) {
      await expect(page.locator(`#settingsTab-${name}`)).toHaveAttribute('aria-controls', `settingsPane-${name}`);
      await expect(page.locator(`#settingsPane-${name}`)).toHaveAttribute('aria-labelledby', `settingsTab-${name}`);
    }

    await expectSelectedPane(page, 'terminal');
  });

  test('clicking the Notifications tab switches the visible pane and selected state', async ({ page }) => {
    await openSettings(page, 'settings-tablist-click');

    await page.click('#settingsTab-notifications');

    await expectSelectedPane(page, 'notifications');
    await expect(page.locator('#settingsTab-terminal')).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('#settingsPane-terminal')).toHaveAttribute('hidden', '');
  });

  test('arrow keys, Home, and End move selection among focused tabs', async ({ page }) => {
    await openSettings(page, 'settings-tablist-keyboard');

    await page.focus('#settingsTab-terminal');
    await page.keyboard.press('ArrowDown');
    await expectSelectedPane(page, 'voice');
    await expect(page.locator('#settingsTab-voice')).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expectSelectedPane(page, 'notifications');
    await expect(page.locator('#settingsTab-notifications')).toBeFocused();

    await page.keyboard.press('ArrowUp');
    await expectSelectedPane(page, 'voice');
    await expect(page.locator('#settingsTab-voice')).toBeFocused();

    await page.keyboard.press('ArrowLeft');
    await expectSelectedPane(page, 'terminal');
    await expect(page.locator('#settingsTab-terminal')).toBeFocused();

    await page.keyboard.press('End');
    await expectSelectedPane(page, 'install');
    await expect(page.locator('#settingsTab-install')).toBeFocused();

    await page.keyboard.press('Home');
    await expectSelectedPane(page, 'terminal');
    await expect(page.locator('#settingsTab-terminal')).toBeFocused();
  });

  test('settings controls remain available from their respective panes', async ({ page }) => {
    await openSettings(page, 'settings-tablist-controls');

    // Terminal pane is active by default.
    const paddingInput = page.locator('#terminalPadding');
    await expect(paddingInput).toBeVisible();
    await expect(paddingInput).toHaveAttribute('type', 'range');
    await expect(paddingInput).toHaveAttribute('min', '0');
    await expect(paddingInput).toHaveAttribute('max', '20');

    await page.click('#settingsTab-voice');
    await expect(page.locator('#voiceRecordingMode')).toBeVisible();
    await expect(page.locator('#voiceRecordingMode')).toHaveJSProperty('tagName', 'SELECT');
    await expect(page.locator('#micSounds')).toBeVisible();
    await expect(page.locator('#micSounds')).toHaveAttribute('type', 'checkbox');

    await page.click('#settingsTab-advanced');
    const dangerousCheckbox = page.locator('#dangerousMode');
    await expect(dangerousCheckbox).toBeVisible();
    await expect(dangerousCheckbox.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " setting-group ")][1]')).toHaveClass(/setting-group--warning/);
    await expect(page.locator('#settingsPane-advanced .setting-warning')).toContainText('permission prompts');

    const resetBtn = page.locator('#resetSettingsBtn');
    await expect(resetBtn).toBeVisible();
    await expect(resetBtn).toHaveText('Reset to Defaults');
    await expect(resetBtn.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " modal-footer ")][1]')).toBeVisible();
  });
});
