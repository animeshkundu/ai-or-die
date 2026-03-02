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

test.describe('Type-ahead input overlay', () => {

  test('input overlay trigger button exists in header', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const btn = page.locator('#inputOverlayBtn');
    await expect(btn).toBeVisible({ timeout: 2000 });
  });

  test('clicking trigger button opens overlay with backdrop', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'overlay-open');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Click trigger button
    await page.locator('#inputOverlayBtn').click();

    // Overlay and backdrop should be visible
    const overlay = page.locator('#inputOverlay');
    const backdrop = page.locator('#inputOverlayBackdrop');
    await expect(overlay).toBeVisible({ timeout: 2000 });
    await expect(backdrop).toBeVisible({ timeout: 2000 });

    // Textarea should be focused
    const isFocused = await page.evaluate(() => {
      return document.activeElement?.id === 'inputOverlayText';
    });
    expect(isFocused).toBe(true);
  });

  test('Escape closes overlay', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'overlay-esc');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open overlay
    await page.locator('#inputOverlayBtn').click();
    await expect(page.locator('#inputOverlay')).toBeVisible({ timeout: 2000 });

    // Press Escape
    await page.keyboard.press('Escape');

    // Overlay should close
    await expect(page.locator('#inputOverlay')).toBeHidden({ timeout: 2000 });
    await expect(page.locator('#inputOverlayBackdrop')).toBeHidden({ timeout: 2000 });
  });

  test('Ctrl+Shift+Space toggles overlay', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'overlay-shortcut');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await focusTerminal(page);

    // Open with Ctrl+Shift+Space
    await page.keyboard.press('Control+Shift+Space');
    await expect(page.locator('#inputOverlay')).toBeVisible({ timeout: 2000 });

    // Close with Ctrl+Shift+Space
    await page.keyboard.press('Control+Shift+Space');
    await expect(page.locator('#inputOverlay')).toBeHidden({ timeout: 2000 });
  });

  test('character count updates as user types', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'overlay-charcount');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open overlay
    await page.locator('#inputOverlayBtn').click();
    await expect(page.locator('#inputOverlay')).toBeVisible({ timeout: 2000 });

    // Type some text
    await page.locator('#inputOverlayText').fill('Hello world');

    // Trigger input event for character count update
    await page.locator('#inputOverlayText').dispatchEvent('input');

    const count = await page.locator('#inputCharCount').textContent();
    expect(parseInt(count)).toBeGreaterThan(0);
  });

  test('Insert and Send buttons exist with correct styling', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'overlay-buttons');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    await page.locator('#inputOverlayBtn').click();
    await expect(page.locator('#inputOverlay')).toBeVisible({ timeout: 2000 });

    // Insert is primary (btn-primary), Send is secondary (btn-secondary)
    const insertBtn = page.locator('.input-overlay-insert');
    const sendBtn = page.locator('.input-overlay-send');

    await expect(insertBtn).toBeVisible();
    await expect(sendBtn).toBeVisible();
    await expect(insertBtn).toHaveClass(/btn-primary/);
    await expect(sendBtn).toHaveClass(/btn-secondary/);
  });

  test('Insert sends text to terminal without Enter', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'overlay-insert');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open overlay, type, and insert
    await page.locator('#inputOverlayBtn').click();
    await expect(page.locator('#inputOverlay')).toBeVisible({ timeout: 2000 });

    await page.locator('#inputOverlayText').fill('echo hello');

    // Capture WS messages before clicking Insert
    const insertSent = page.evaluate(() => {
      return new Promise((resolve) => {
        const origSend = window.app.socket.send.bind(window.app.socket);
        window.app.socket.send = function(data) {
          origSend(data);
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'input') {
              resolve(parsed.data);
            }
          } catch(e) {}
        };
        // Timeout fallback
        setTimeout(() => resolve(null), 5000);
      });
    });

    await page.locator('.input-overlay-insert').click();

    const sentData = await insertSent;
    expect(sentData).toBeTruthy();
    // Insert should NOT end with \r (no Enter)
    expect(sentData.endsWith('\r')).toBe(false);
    expect(sentData).toContain('echo hello');

    // Overlay should close after Insert
    await expect(page.locator('#inputOverlay')).toBeHidden({ timeout: 2000 });
  });

  test('Send sends text to terminal with Enter', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'overlay-send');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open overlay, type, and send
    await page.locator('#inputOverlayBtn').click();
    await expect(page.locator('#inputOverlay')).toBeVisible({ timeout: 2000 });

    await page.locator('#inputOverlayText').fill('ls');

    const sendSent = page.evaluate(() => {
      return new Promise((resolve) => {
        const origSend = window.app.socket.send.bind(window.app.socket);
        window.app.socket.send = function(data) {
          origSend(data);
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'input') {
              resolve(parsed.data);
            }
          } catch(e) {}
        };
        setTimeout(() => resolve(null), 5000);
      });
    });

    await page.locator('.input-overlay-send').click();

    const sentData = await sendSent;
    expect(sentData).toBeTruthy();
    // Send SHOULD end with \r (Enter)
    expect(sentData.endsWith('\r')).toBe(true);

    await expect(page.locator('#inputOverlay')).toBeHidden({ timeout: 2000 });
  });

  test('plan detection is suppressed while overlay is active', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'overlay-suppress');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open overlay
    await page.locator('#inputOverlayBtn').click();
    await expect(page.locator('#inputOverlay')).toBeVisible({ timeout: 2000 });

    // Check suppression flag
    const suppressed = await page.evaluate(() => {
      return window.app.planDetector ? window.app.planDetector._suppressDetection : null;
    });
    expect(suppressed).toBe(true);

    // Close overlay
    await page.keyboard.press('Escape');

    // Suppression should be cleared
    const unsuppressed = await page.evaluate(() => {
      return window.app.planDetector ? window.app.planDetector._suppressDetection : null;
    });
    expect(unsuppressed).toBe(false);
  });

  test('modal mutex: opening settings closes overlay', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'overlay-mutex');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open overlay
    await page.locator('#inputOverlayBtn').click();
    await expect(page.locator('#inputOverlay')).toBeVisible({ timeout: 2000 });

    // Open settings
    await page.evaluate(() => window.app.showSettings());

    // Overlay should close, settings should open
    await expect(page.locator('#inputOverlay')).toBeHidden({ timeout: 2000 });
    const settingsOpen = await page.evaluate(() => {
      const modal = document.getElementById('settingsModal');
      return modal && modal.classList.contains('active');
    });
    expect(settingsOpen).toBe(true);
  });
});
