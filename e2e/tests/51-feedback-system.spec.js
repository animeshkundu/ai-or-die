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

test.describe('FeedbackManager toast system', () => {

  test('window.feedback singleton is available after page load', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const hasFeedback = await page.evaluate(() => {
      return typeof window.feedback === 'object'
        && typeof window.feedback.info === 'function'
        && typeof window.feedback.success === 'function'
        && typeof window.feedback.warning === 'function'
        && typeof window.feedback.error === 'function';
    });
    expect(hasFeedback).toBe(true);
  });

  test('info toast appears and auto-dismisses', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    await page.evaluate(() => window.feedback.info('Test info message'));

    // Toast should appear
    const toast = page.locator('.toast-container .toast.toast--info');
    await expect(toast).toBeVisible({ timeout: 2000 });

    // Check message text
    const msg = await toast.locator('.toast__msg').textContent();
    expect(msg).toContain('Test info message');

    // Check icon is present (SVG)
    const icon = toast.locator('.toast__icon svg');
    await expect(icon).toBeVisible();

    // Should auto-dismiss after ~4 seconds
    await expect(toast).toBeHidden({ timeout: 6000 });
  });

  test('error toast is persistent and requires manual dismiss', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    await page.evaluate(() => window.feedback.error('Critical error'));

    const toast = page.locator('.toast.toast--error');
    await expect(toast).toBeVisible({ timeout: 2000 });

    // Verify role="alert" (only errors get alert)
    const role = await toast.getAttribute('role');
    expect(role).toBe('alert');

    // Wait 5 seconds — should still be visible (persistent)
    await page.waitForTimeout(5000);
    await expect(toast).toBeVisible();

    // Dismiss via X button
    await toast.locator('.toast__close').click();
    await expect(toast).toBeHidden({ timeout: 2000 });
  });

  test('toast with action button triggers callback', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Create toast with action that sets a global flag
    await page.evaluate(() => {
      window._actionTriggered = false;
      window.feedback.info('Update available', {
        duration: 0,
        action: 'Reload',
        onAction: () => { window._actionTriggered = true; }
      });
    });

    const toast = page.locator('.toast-container .toast');
    await expect(toast).toBeVisible({ timeout: 2000 });

    // Click the action button
    const actionBtn = toast.locator('.toast__action');
    await expect(actionBtn).toHaveText('Reload');
    await actionBtn.click();

    // Verify callback fired and toast dismissed
    const triggered = await page.evaluate(() => window._actionTriggered);
    expect(triggered).toBe(true);
    await expect(toast).toBeHidden({ timeout: 2000 });
  });

  test('max 3 visible toasts, 4th is queued', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Show 4 toasts rapidly
    await page.evaluate(() => {
      window.feedback.info('Toast 1');
      window.feedback.warning('Toast 2');
      window.feedback.success('Toast 3');
      window.feedback.info('Toast 4 queued');
    });

    await page.waitForTimeout(500);

    const visibleCount = await page.evaluate(() => {
      return document.querySelectorAll('.toast-container .toast').length;
    });
    expect(visibleCount).toBe(3);
  });

  test('duplicate messages are deduplicated', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    await page.evaluate(() => {
      window.feedback.info('Same message');
      window.feedback.info('Same message');
      window.feedback.info('Same message');
    });

    await page.waitForTimeout(500);

    const count = await page.evaluate(() => {
      return document.querySelectorAll('.toast-container .toast').length;
    });
    expect(count).toBe(1);
  });
});

test.describe('Clipboard micro-feedback badge', () => {

  test('copy badge element exists in header', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const badge = page.locator('#copyFeedbackBadge');
    // Badge exists in DOM but hidden
    await expect(badge).toBeAttached();
  });

  test('showCopiedFeedback callback shows badge briefly', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Trigger the callback
    await page.evaluate(() => {
      if (window.showCopiedFeedback) window.showCopiedFeedback();
    });

    const badge = page.locator('#copyFeedbackBadge');
    await expect(badge).toHaveClass(/visible/, { timeout: 1000 });

    // Should fade after 1.5s
    await expect(badge).not.toHaveClass(/visible/, { timeout: 3000 });
  });
});

test.describe('Banner status indicators', () => {

  test('status indicators container exists', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const container = page.locator('#statusIndicators');
    await expect(container).toBeAttached();
  });
});

test.describe('Header overflow menu', () => {

  test('overflow button is hidden on desktop viewport', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Default viewport is 1280x720 — desktop
    const overflowBtn = page.locator('#overflowMenuBtn');
    await expect(overflowBtn).toBeHidden();
  });

  test('overflow button appears on tablet viewport', async ({ page }) => {
    setupPageCapture(page);
    await page.setViewportSize({ width: 900, height: 720 });
    await page.goto(url);
    await waitForAppReady(page);

    const overflowBtn = page.locator('#overflowMenuBtn');
    await expect(overflowBtn).toBeVisible({ timeout: 2000 });
  });

  test('overflow menu opens and closes', async ({ page }) => {
    setupPageCapture(page);
    await page.setViewportSize({ width: 900, height: 720 });
    await page.goto(url);
    await waitForAppReady(page);

    const overflowBtn = page.locator('#overflowMenuBtn');
    const panel = page.locator('#overflowMenuPanel');

    // Open
    await overflowBtn.click();
    await expect(panel).toHaveClass(/open/, { timeout: 1000 });

    // Close by clicking outside
    await page.locator('body').click({ position: { x: 10, y: 10 } });
    await expect(panel).not.toHaveClass(/open/, { timeout: 1000 });
  });
});
