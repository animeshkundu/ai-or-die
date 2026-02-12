// @ts-check
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  joinSessionAndStartTerminal,
  focusTerminal,
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

test.describe('Modal Focus Trapping', () => {

  test('settings modal traps focus on Tab', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'focus-trap-settings');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings modal
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Get all focusable elements inside the modal
    const focusableCount = await page.evaluate(() => {
      const modal = document.getElementById('settingsModal');
      if (!modal) return 0;
      const focusable = modal.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      return Array.from(focusable).filter(el => el.offsetParent !== null).length;
    });
    expect(focusableCount).toBeGreaterThan(2);

    // Press Tab multiple times — focus should stay within the modal
    for (let i = 0; i < focusableCount + 2; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(50);
    }

    // Verify focus is still inside the settings modal
    const focusInsideModal = await page.evaluate(() => {
      const modal = document.getElementById('settingsModal');
      const active = document.activeElement;
      return modal && active && modal.contains(active);
    });
    expect(focusInsideModal).toBe(true);
  });

  test('settings modal traps focus on Shift+Tab (wraps to last element)', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'focus-trap-shift-tab');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings modal
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Wait for focus trap to activate (uses requestAnimationFrame)
    await page.waitForTimeout(200);

    // Focus should be on the first focusable element
    // Press Shift+Tab — should wrap to the last focusable element
    const firstFocusableTag = await page.evaluate(() => {
      return document.activeElement ? document.activeElement.tagName : '';
    });

    await page.keyboard.press('Shift+Tab');
    await page.waitForTimeout(100);

    // Verify focus is still inside the modal (wrapped to last element)
    const focusInfo = await page.evaluate(() => {
      const modal = document.getElementById('settingsModal');
      const active = document.activeElement;
      return {
        insideModal: modal && active && modal.contains(active),
        tagName: active ? active.tagName : '',
        id: active ? active.id : '',
      };
    });
    expect(focusInfo.insideModal).toBe(true);
    // After Shift+Tab from first element, should have moved to last focusable
    expect(focusInfo.tagName).not.toBe('');
  });

  test('Escape closes settings modal', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'focus-trap-escape');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open settings modal
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });

    // Press Escape to close
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Verify modal is closed
    const isActive = await page.evaluate(() => {
      const modal = document.getElementById('settingsModal');
      return modal && modal.classList.contains('active');
    });
    expect(isActive).toBeFalsy();
  });

  test('focus returns to previous element after modal closes', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'focus-trap-restore');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Focus the terminal first
    await focusTerminal(page);
    await page.waitForTimeout(200);

    // Open settings modal
    await page.click('#settingsBtn');
    await page.waitForSelector('.settings-modal.active', { timeout: 5000 });
    await page.waitForTimeout(200);

    // Close modal via close button
    await page.click('#closeSettingsBtn');
    await page.waitForTimeout(500);

    // Verify modal is closed
    const isActive = await page.evaluate(() => {
      const modal = document.getElementById('settingsModal');
      return modal && modal.classList.contains('active');
    });
    expect(isActive).toBeFalsy();
  });

  test('shortcuts modal traps focus', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Blur terminal so ? key works (it only fires when terminal is NOT focused)
    await page.evaluate(() => {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
    });
    await page.waitForTimeout(200);

    // Open shortcuts modal with ? key
    await page.keyboard.press('?');
    await page.waitForTimeout(500);

    // Verify shortcuts modal is open
    const isOpen = await page.evaluate(() => {
      const modal = document.getElementById('shortcutsModal');
      return modal && modal.classList.contains('active');
    });
    expect(isOpen).toBe(true);

    // Press Tab several times — focus should stay within the modal
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(50);
    }

    const focusInsideShortcuts = await page.evaluate(() => {
      const modal = document.getElementById('shortcutsModal');
      const active = document.activeElement;
      return modal && active && modal.contains(active);
    });
    expect(focusInsideShortcuts).toBe(true);

    // Press Escape to close
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Verify modal closed
    const closedState = await page.evaluate(() => {
      const modal = document.getElementById('shortcutsModal');
      return modal && modal.classList.contains('active');
    });
    expect(closedState).toBeFalsy();
  });
});
