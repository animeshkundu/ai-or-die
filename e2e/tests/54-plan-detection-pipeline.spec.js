// @ts-check
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
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

test.describe('Plan detection pipeline — multi-tool', () => {

  test('Claude: processOutput triggers indicator and modal with structured plan', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'plan-claude');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    await page.evaluate(() => {
      const pd = window.app.planDetector;
      pd.setTool('claude');
      pd.startMonitoring();
      pd.processOutput('Plan mode is active. You MUST NOT make any edits.');
      pd.processOutput('## Implementation Plan:\n\n### 1. Add authentication\n- Create login endpoint\n- Add JWT validation\n\n### 2. Write tests\n- Unit tests for auth\n- Integration tests\n');
    });

    // Indicator should be visible and pulsing
    const btn = page.locator('#planIndicatorBtn');
    await expect(btn).toBeVisible({ timeout: 2000 });

    // Click to open modal
    await btn.click();
    const modal = page.locator('#planModal');
    await expect(modal).toHaveClass(/active/, { timeout: 2000 });

    // Verify rendered markdown
    const content = page.locator('#planContent');
    const hasH2 = await content.locator('h2').count();
    const hasH3 = await content.locator('h3').count();
    const hasUl = await content.locator('ul').count();
    expect(hasH2).toBeGreaterThan(0);
    expect(hasH3).toBeGreaterThan(0);
    expect(hasUl).toBeGreaterThan(0);
  });

  test('Copilot: processOutput triggers indicator and modal with numbered steps', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'plan-copilot');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    await page.evaluate(() => {
      const pd = window.app.planDetector;
      pd.setTool('copilot');
      pd.startMonitoring();
      pd.processOutput('PLAN MODE\n\nI will make the following changes:\n\n1. Update the user model to include email field\n2. Add email validation middleware\n3. Update the registration endpoint\n');
    });

    const btn = page.locator('#planIndicatorBtn');
    await expect(btn).toBeVisible({ timeout: 2000 });
    await btn.click();

    const modal = page.locator('#planModal');
    await expect(modal).toHaveClass(/active/, { timeout: 2000 });

    const text = await page.locator('#planContent').textContent();
    expect(text).toContain('PLAN MODE');
    expect(text).toContain('Update the user model');
  });

  test('Codex: processOutput stores plan in _latestPlan', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'plan-codex');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const hasPlan = await page.evaluate(() => {
      const pd = window.app.planDetector;
      pd.setTool('codex');
      pd.startMonitoring();
      pd.processOutput('[DRAFT PLAN]\n## Action items\n- Refactor database layer\n- Add connection pooling\n');
      return !!(window.app._latestPlan && window.app._latestPlan.content.includes('[DRAFT PLAN]'));
    });

    expect(hasPlan).toBe(true);
  });

  test('Gemini: processOutput triggers indicator and modal with analysis+plan', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'plan-gemini');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    await page.evaluate(() => {
      const pd = window.app.planDetector;
      pd.setTool('gemini');
      pd.startMonitoring();
      pd.processOutput('Sandbox mode\n\n## Analysis\nThe codebase needs restructuring.\n\n## Plan\n1. Create new module structure\n2. Move existing files\n3. Update imports\n');
    });

    const btn = page.locator('#planIndicatorBtn');
    await expect(btn).toBeVisible({ timeout: 2000 });
    await btn.click();

    const modal = page.locator('#planModal');
    await expect(modal).toHaveClass(/active/, { timeout: 2000 });

    const text = await page.locator('#planContent').textContent();
    expect(text).toContain('Analysis');
    expect(text).toContain('Plan');
  });

  test('ANSI-encoded plan content is detected correctly', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'plan-ansi');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    await page.evaluate(() => {
      const pd = window.app.planDetector;
      pd.setTool('claude');
      pd.startMonitoring();
      // Feed ANSI-wrapped plan content
      pd.processOutput('\x1b[1mPlan mode is active\x1b[0m. You MUST NOT make any edits.');
      pd.processOutput('\x1b[32m## Implementation Plan:\x1b[0m\n\n\x1b[33m### 1. First step\x1b[0m\n- Do something\n\n\x1b[33m### 2. Second step\x1b[0m\n- Do more\n');
    });

    const btn = page.locator('#planIndicatorBtn');
    await expect(btn).toBeVisible({ timeout: 2000 });
  });
});
