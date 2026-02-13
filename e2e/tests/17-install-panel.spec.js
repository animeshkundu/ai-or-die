const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  attachFailureArtifacts,
} = require('../helpers/terminal-helpers');

/**
 * E2E tests for the CLI tool install panel within the "Choose Your Assistant" screen.
 * On CI runners, most AI tools are NOT installed, so the "unavailable/installable"
 * state is the natural default — perfect for testing without mocks.
 */
test.describe('Install panel UI', () => {
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

  test('installable cards use .installable class instead of .disabled', async ({ page }) => {
    await createSessionViaApi(port, 'Installable Class');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 10000 });

    // Check if there are any installable cards (tools not installed on CI)
    const installableCards = page.locator('.tool-card.installable');
    const disabledCards = page.locator('.tool-card.disabled');
    const installableCount = await installableCards.count();
    const disabledCount = await disabledCards.count();

    // At least one of the AI tools should be unavailable on CI
    // Terminal is always available and never installable/disabled
    const terminalCard = page.locator('.tool-card[data-tool="terminal"]');
    await expect(terminalCard).not.toHaveClass(/disabled|installable/);

    // If tools are unavailable, they should be installable (not disabled)
    if (installableCount > 0 || disabledCount > 0) {
      // All unavailable non-terminal tools should use .installable
      expect(disabledCount).toBe(0);
    }
  });

  test('installable cards have correct ARIA attributes', async ({ page }) => {
    await createSessionViaApi(port, 'Installable A11y');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 10000 });

    const installableCard = page.locator('.tool-card.installable').first();
    if (await installableCard.count() > 0) {
      await expect(installableCard).toHaveAttribute('tabindex', '0');
      await expect(installableCard).toHaveAttribute('aria-expanded', 'false');
      await expect(installableCard).toHaveAttribute('role', 'button');
      // Should NOT have aria-disabled
      const ariaDisabled = await installableCard.getAttribute('aria-disabled');
      expect(ariaDisabled).toBeNull();
    }
  });

  test('installable cards have pointer cursor', async ({ page }) => {
    await createSessionViaApi(port, 'Installable Cursor');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 10000 });

    const installableCard = page.locator('.tool-card.installable').first();
    if (await installableCard.count() > 0) {
      const cursor = await installableCard.evaluate(el => getComputedStyle(el).cursor);
      expect(cursor).toBe('pointer');
    }
  });

  test('clicking installable card expands install panel', async ({ page }) => {
    await createSessionViaApi(port, 'Expand Panel');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 10000 });

    const installableCard = page.locator('.tool-card.installable').first();
    if (await installableCard.count() === 0) {
      test.skip();
      return;
    }

    const toolId = await installableCard.getAttribute('data-tool');
    const expansion = page.locator(`#install-expansion-${toolId}`);

    // Should be hidden initially
    await expect(expansion).not.toHaveClass(/expanded/);

    // Click to expand
    await installableCard.click();

    // Should now be expanded
    await expect(installableCard).toHaveAttribute('aria-expanded', 'true');
    await expect(expansion).toHaveClass(/expanded/);
  });

  test('expansion shows install command in code block', async ({ page }) => {
    await createSessionViaApi(port, 'Install Command');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 10000 });

    const installableCard = page.locator('.tool-card.installable').first();
    if (await installableCard.count() === 0) {
      test.skip();
      return;
    }

    await installableCard.click();
    const toolId = await installableCard.getAttribute('data-tool');
    const expansion = page.locator(`#install-expansion-${toolId}`);

    // Should contain a code element with an install command
    const codeBlock = expansion.locator('.install-cmd-block code');
    await expect(codeBlock.first()).toBeVisible();
    const cmdText = await codeBlock.first().textContent();
    expect(cmdText.length).toBeGreaterThan(0);
  });

  test('copy button copies command to clipboard', async ({ page }) => {
    await createSessionViaApi(port, 'Copy Button');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 10000 });

    const installableCard = page.locator('.tool-card.installable').first();
    if (await installableCard.count() === 0) {
      test.skip();
      return;
    }

    await installableCard.click();
    const toolId = await installableCard.getAttribute('data-tool');
    const expansion = page.locator(`#install-expansion-${toolId}`);

    const copyBtn = expansion.locator('.btn-copy').first();
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    // Button text should change to "Copied!"
    await expect(copyBtn).toHaveText('Copied!');

    // Clipboard should contain the command
    const clipText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipText.length).toBeGreaterThan(0);
  });

  test('expansion shows auth steps', async ({ page }) => {
    await createSessionViaApi(port, 'Auth Steps');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 10000 });

    const installableCard = page.locator('.tool-card.installable').first();
    if (await installableCard.count() === 0) {
      test.skip();
      return;
    }

    await installableCard.click();
    const toolId = await installableCard.getAttribute('data-tool');
    const expansion = page.locator(`#install-expansion-${toolId}`);

    // Should have auth steps section
    const authSteps = expansion.locator('.install-auth-steps');
    await expect(authSteps).toBeVisible();
    const stepCount = await expansion.locator('.install-auth-step').count();
    expect(stepCount).toBeGreaterThan(0);
  });

  test('accordion behavior: expanding one card collapses another', async ({ page }) => {
    await createSessionViaApi(port, 'Accordion');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 10000 });

    const installableCards = page.locator('.tool-card.installable');
    const count = await installableCards.count();
    if (count < 2) {
      test.skip();
      return;
    }

    // Expand first card
    const first = installableCards.nth(0);
    await first.click();
    await expect(first).toHaveAttribute('aria-expanded', 'true');

    // Expand second card
    const second = installableCards.nth(1);
    await second.click();
    await expect(second).toHaveAttribute('aria-expanded', 'true');

    // First should now be collapsed
    await expect(first).toHaveAttribute('aria-expanded', 'false');
  });

  test('"Open Terminal" button is present in expansion', async ({ page }) => {
    await createSessionViaApi(port, 'Open Terminal Btn');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 10000 });

    const installableCard = page.locator('.tool-card.installable').first();
    if (await installableCard.count() === 0) {
      test.skip();
      return;
    }

    await installableCard.click();
    const toolId = await installableCard.getAttribute('data-tool');
    const expansion = page.locator(`#install-expansion-${toolId}`);

    // Should have Open Terminal button
    const terminalBtn = expansion.locator('.btn-install-terminal');
    await expect(terminalBtn).toBeVisible();
    await expect(terminalBtn).toContainText('Open Terminal');
  });

  test('"Verify Install" button is present in expansion', async ({ page }) => {
    await createSessionViaApi(port, 'Verify Btn');
    await page.goto(url);
    await waitForAppReady(page);
    await page.waitForSelector('.tool-card', { timeout: 10000 });

    const installableCard = page.locator('.tool-card.installable').first();
    if (await installableCard.count() === 0) {
      test.skip();
      return;
    }

    await installableCard.click();
    const toolId = await installableCard.getAttribute('data-tool');
    const expansion = page.locator(`#install-expansion-${toolId}`);

    const verifyBtn = expansion.locator('.btn-verify');
    await expect(verifyBtn).toBeVisible();
    await expect(verifyBtn).toContainText('Verify');
  });

  test('/api/config includes prerequisites when tools are unavailable', async ({ page }) => {
    const resp = await page.request.get(`http://127.0.0.1:${port}/api/config`);
    const config = await resp.json();

    // Check that tools object exists
    expect(config.tools).toBeTruthy();

    // Check for install metadata on unavailable tools
    for (const [toolId, tool] of Object.entries(config.tools)) {
      if (!tool.available && toolId !== 'terminal') {
        expect(tool.install).toBeTruthy();
        expect(tool.install.methods).toBeTruthy();
        expect(Array.isArray(tool.install.methods)).toBe(true);
        expect(tool.install.authSteps).toBeTruthy();
        expect(tool.install.docsUrl).toBeTruthy();
      }
    }

    // If any tools are unavailable, prerequisites should be present
    const hasUnavailable = Object.entries(config.tools).some(
      ([id, t]) => !t.available && id !== 'terminal'
    );
    if (hasUnavailable) {
      expect(config.prerequisites).toBeTruthy();
      expect(typeof config.prerequisites.npm).toBe('object');
      expect(typeof config.prerequisites.npm.available).toBe('boolean');
    }
  });

  test('POST /api/tools/:toolId/recheck returns availability status', async ({ page }) => {
    const resp = await page.request.post(`http://127.0.0.1:${port}/api/tools/claude/recheck`);
    const result = await resp.json();

    expect(result.toolId).toBe('claude');
    expect(typeof result.available).toBe('boolean');
  });
});
