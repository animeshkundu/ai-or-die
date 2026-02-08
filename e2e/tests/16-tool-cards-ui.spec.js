const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

/**
 * E2E tests for the modernized tool cards UI on the "Choose Your Assistant" screen.
 * Validates: no "undefined" entries, correct ordering, SVG icons, accessibility,
 * card clickability, and visual hierarchy between available/unavailable tools.
 */
test.describe('Tool cards UI', () => {
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

  test('no "undefined" text appears in tool cards', async ({ page }) => {
    await createSessionViaApi(port, 'No Undefined');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 15000 });

    // Get all card name texts
    const cardNames = await page.locator('.tool-card-name').allTextContents();
    for (const name of cardNames) {
      expect(name).not.toBe('undefined');
      expect(name).not.toBe('');
      expect(name.toLowerCase()).not.toContain('undefined');
    }
  });

  test('vscodeTunnel is not rendered as a tool card', async ({ page }) => {
    await createSessionViaApi(port, 'No Tunnel Card');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 15000 });

    // No card should have data-tool="vscodeTunnel"
    const tunnelCard = page.locator('.tool-card[data-tool="vscodeTunnel"]');
    await expect(tunnelCard).toHaveCount(0);

    // Also verify via the "?" fallback icon — should not exist
    const questionCards = page.locator('.tool-card-name:text("undefined")');
    await expect(questionCards).toHaveCount(0);
  });

  test('Terminal card appears first in the list', async ({ page }) => {
    await createSessionViaApi(port, 'Terminal First');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 15000 });

    // The first card should be the terminal card
    const firstCard = page.locator('.tool-card').first();
    await expect(firstCard).toHaveAttribute('data-tool', 'terminal');
  });

  test('available tools appear before unavailable tools', async ({ page }) => {
    await createSessionViaApi(port, 'Sort Order');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 15000 });

    const cards = page.locator('.tool-card');
    const count = await cards.count();

    let seenDisabled = false;
    for (let i = 0; i < count; i++) {
      const isDisabled = await cards.nth(i).evaluate(el => el.classList.contains('disabled'));
      if (isDisabled) {
        seenDisabled = true;
      } else if (seenDisabled) {
        // An enabled card after a disabled card means sort is wrong
        throw new Error(`Available card at index ${i} appears after disabled card`);
      }
    }
  });

  test('tool cards use SVG icons (not text letters)', async ({ page }) => {
    await createSessionViaApi(port, 'SVG Icons');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 15000 });

    const icons = page.locator('.tool-card-icon');
    const count = await icons.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      // Each icon container should have an SVG child
      const svg = icons.nth(i).locator('svg');
      await expect(svg).toBeVisible();
    }
  });

  test('tool card icons have gradient backgrounds', async ({ page }) => {
    await createSessionViaApi(port, 'Gradient Icons');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 15000 });

    const firstIcon = page.locator('.tool-card-icon').first();
    const bg = await firstIcon.evaluate(el => el.style.background);
    expect(bg).toContain('linear-gradient');
  });

  test('entire card is clickable, no separate Start button', async ({ page }) => {
    await createSessionViaApi(port, 'Card Click');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 15000 });

    // No .tool-card-btn elements should exist
    const buttons = page.locator('.tool-card-btn');
    await expect(buttons).toHaveCount(0);

    // Available card should have cursor: pointer and be clickable
    const availableCard = page.locator('.tool-card:not(.disabled)').first();
    const cursor = await availableCard.evaluate(el => getComputedStyle(el).cursor);
    expect(cursor).toBe('pointer');
  });

  test('divider separates available and unavailable tools', async ({ page }) => {
    await createSessionViaApi(port, 'Divider Test');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 15000 });

    // If there are both available and disabled cards, a divider should exist
    const availableCount = await page.locator('.tool-card:not(.disabled)').count();
    const disabledCount = await page.locator('.tool-card.disabled').count();

    if (availableCount > 0 && disabledCount > 0) {
      const divider = page.locator('.tool-cards-divider');
      await expect(divider).toBeVisible();
      await expect(divider).toContainText('More tools');
    }
  });

  test('disabled cards show "Not installed" status', async ({ page }) => {
    await createSessionViaApi(port, 'Disabled Status');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 15000 });

    const disabledCard = page.locator('.tool-card.disabled').first();
    if (await disabledCard.isVisible()) {
      const status = disabledCard.locator('.tool-card-status');
      await expect(status).toContainText('Not installed');
    }
  });

  test('disabled card icons are desaturated (grayscale filter)', async ({ page }) => {
    await createSessionViaApi(port, 'Grayscale Icons');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 15000 });

    const disabledIcon = page.locator('.tool-card.disabled .tool-card-icon').first();
    if (await disabledIcon.isVisible()) {
      const filter = await disabledIcon.evaluate(el => getComputedStyle(el).filter);
      expect(filter).toContain('grayscale');
    }
  });

  test('available cards have keyboard accessibility', async ({ page }) => {
    await createSessionViaApi(port, 'A11y Test');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 15000 });

    const availableCard = page.locator('.tool-card:not(.disabled)').first();
    // Should have tabindex for keyboard navigation
    await expect(availableCard).toHaveAttribute('tabindex', '0');
    // Should have role and aria-label
    await expect(availableCard).toHaveAttribute('role', 'option');
    const ariaLabel = await availableCard.getAttribute('aria-label');
    expect(ariaLabel).toBeTruthy();
    expect(ariaLabel.length).toBeGreaterThan(0);
  });

  test('disabled cards have aria-disabled attribute', async ({ page }) => {
    await createSessionViaApi(port, 'A11y Disabled');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 15000 });

    const disabledCard = page.locator('.tool-card.disabled').first();
    if (await disabledCard.isVisible()) {
      await expect(disabledCard).toHaveAttribute('aria-disabled', 'true');
    }
  });

  test('tool cards container has listbox role', async ({ page }) => {
    await createSessionViaApi(port, 'Listbox Role');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 15000 });

    const container = page.locator('[data-tid="tool-cards"]');
    await expect(container).toHaveAttribute('role', 'listbox');
  });

  test('clicking available card starts the tool session', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Click Start');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Wait for WS and join session
    await page.waitForFunction(
      () => window.app && window.app.socket && window.app.socket.readyState === 1,
      { timeout: 20000 }
    );
    await page.evaluate((sid) => {
      window.app.send({ type: 'join_session', sessionId: sid });
    }, sessionId);
    await page.waitForFunction(
      () => window.app.currentClaudeSessionId != null,
      { timeout: 15000 }
    );

    await page.waitForSelector('.tool-card:not(.disabled)', { timeout: 10000 });

    // Click the first available card (should be terminal)
    const card = page.locator('.tool-card:not(.disabled)').first();
    await card.click();

    // Overlay should hide after tool starts
    await page.waitForFunction(() => {
      const overlay = document.getElementById('overlay');
      return !overlay || overlay.style.display === 'none';
    }, { timeout: 30000 });
  });

  test('hover reveals arrow chevron on available cards', async ({ page }) => {
    await createSessionViaApi(port, 'Hover Arrow');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card:not(.disabled)', { timeout: 15000 });

    const card = page.locator('.tool-card:not(.disabled)').first();
    const arrow = card.locator('.tool-card-arrow');

    // Arrow should exist but be invisible before hover
    await expect(arrow).toBeAttached();
    const opacityBefore = await arrow.evaluate(el => getComputedStyle(el).opacity);
    expect(parseFloat(opacityBefore)).toBe(0);

    // Hover over the card
    await card.hover();
    await page.waitForTimeout(200); // wait for transition

    // Arrow should become visible on hover
    const opacityAfter = await arrow.evaluate(el => getComputedStyle(el).opacity);
    expect(parseFloat(opacityAfter)).toBe(1);
  });

  test('card descriptions are updated and meaningful', async ({ page }) => {
    await createSessionViaApi(port, 'Descriptions');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 15000 });

    const descriptions = await page.locator('.tool-card-desc').allTextContents();

    // None should be the old generic descriptions
    for (const desc of descriptions) {
      expect(desc).not.toBe('Anthropic AI');
      expect(desc).not.toBe('OpenAI Codex');
      expect(desc).not.toBe('GitHub Copilot');
      expect(desc).not.toBe('Google Gemini');
      expect(desc).not.toBe('System Shell');
    }

    // Terminal description should mention shell
    const terminalCard = page.locator('.tool-card[data-tool="terminal"] .tool-card-desc');
    if (await terminalCard.isVisible()) {
      await expect(terminalCard).toContainText('shell');
    }
  });
});
