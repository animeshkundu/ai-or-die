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

test.describe('Plan viewer — indicator and modal', () => {

  test('plan indicator button exists but is hidden by default', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const btn = page.locator('#planIndicatorBtn');
    await expect(btn).toBeAttached();
    await expect(btn).toBeHidden();
  });

  test('plan indicator shows when plan mode activates', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'plan-indicator');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Simulate plan mode activation
    await page.evaluate(() => {
      if (window.app.planDetector) {
        window.app.planDetector.planModeActive = true;
        if (window.app.planDetector.onPlanModeChange) {
          window.app.planDetector.onPlanModeChange(true);
        }
      }
    });

    const btn = page.locator('#planIndicatorBtn');
    await expect(btn).toBeVisible({ timeout: 2000 });
  });

  test('plan indicator hides when plan mode deactivates', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'plan-deactivate');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Activate then deactivate plan mode
    await page.evaluate(() => {
      const pd = window.app.planDetector;
      if (pd) {
        pd.planModeActive = true;
        if (pd.onPlanModeChange) pd.onPlanModeChange(true);
        pd.planModeActive = false;
        if (pd.onPlanModeChange) pd.onPlanModeChange(false);
      }
    });

    await expect(page.locator('#planIndicatorBtn')).toBeHidden({ timeout: 2000 });
  });

  test('clicking plan indicator opens modal with rendered content', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'plan-modal');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Simulate plan detection with markdown content
    await page.evaluate(() => {
      const plan = {
        content: '## Implementation Plan\n\n### 1. Add feature\n- Step A\n- Step B\n\n### 2. Write tests\n\n```js\nconsole.log("hello");\n```\n',
        timestamp: Date.now()
      };
      window.app._latestPlan = plan;
      // Show indicator
      const pd = window.app.planDetector;
      if (pd) {
        pd.planModeActive = true;
        pd.currentPlan = plan;
        if (pd.onPlanModeChange) pd.onPlanModeChange(true);
        if (pd.onPlanDetected) pd.onPlanDetected(plan);
      }
    });

    // Click plan indicator
    const btn = page.locator('#planIndicatorBtn');
    await expect(btn).toBeVisible({ timeout: 2000 });
    await btn.click();

    // Plan modal should open
    const modal = page.locator('#planModal');
    await expect(modal).toHaveClass(/active/, { timeout: 2000 });

    // Content should be rendered as HTML (not raw text)
    const content = page.locator('#planContent');
    await expect(content).toBeVisible();

    // Check for rendered markdown elements
    const hasH2 = await content.locator('h2').count();
    const hasH3 = await content.locator('h3').count();
    const hasUl = await content.locator('ul').count();
    const hasCode = await content.locator('pre').count();

    expect(hasH2).toBeGreaterThan(0);
    expect(hasH3).toBeGreaterThan(0);
    expect(hasUl).toBeGreaterThan(0);
    expect(hasCode).toBeGreaterThan(0);
  });

  test('plan modal does NOT auto-open — only indicator pulses', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'plan-no-autoopen');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Simulate plan detection
    await page.evaluate(() => {
      const plan = { content: '## Test Plan\n\n- Step 1\n', timestamp: Date.now() };
      if (window.app.planDetector && window.app.planDetector.onPlanDetected) {
        window.app.planDetector.onPlanDetected(plan);
      }
    });

    await page.waitForTimeout(1000);

    // Modal should NOT be open
    const isModalOpen = await page.evaluate(() => {
      const modal = document.getElementById('planModal');
      return modal && modal.classList.contains('active');
    });
    expect(isModalOpen).toBeFalsy();

    // But indicator should be pulsing
    const isPulsing = await page.evaluate(() => {
      const btn = document.getElementById('planIndicatorBtn');
      return btn && btn.classList.contains('plan-pulse');
    });
    expect(isPulsing).toBe(true);
  });

  test('XSS is blocked in plan content', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'plan-xss');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Set a global flag that XSS would set
    await page.evaluate(() => { window._xssTriggered = false; });

    // Inject plan with XSS payload
    await page.evaluate(() => {
      const plan = {
        content: '## Plan\n\n<img src=x onerror="window._xssTriggered=true">\n<script>window._xssTriggered=true</script>\n',
        timestamp: Date.now()
      };
      window.app._latestPlan = plan;
      window.app.showPlanModal(plan);
    });

    await page.waitForTimeout(1000);

    // XSS should NOT have fired
    const xssTriggered = await page.evaluate(() => window._xssTriggered);
    expect(xssTriggered).toBe(false);
  });

  test('plan accept/reject buttons still work', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'plan-accept');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Open plan modal
    await page.evaluate(() => {
      const plan = { content: '## Accept Test\n\n- Step 1\n', timestamp: Date.now() };
      window.app.showPlanModal(plan);
    });

    const modal = page.locator('#planModal');
    await expect(modal).toHaveClass(/active/, { timeout: 2000 });

    // Accept button exists
    const acceptBtn = page.locator('#acceptPlanBtn');
    await expect(acceptBtn).toBeVisible();

    // Reject button exists
    const rejectBtn = page.locator('#rejectPlanBtn');
    await expect(rejectBtn).toBeVisible();
  });
});

test.describe('Plan detector — multi-tool awareness', () => {

  test('setTool method exists and clears buffer', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const result = await page.evaluate(() => {
      const pd = window.app?.planDetector;
      if (!pd) return { exists: false };
      pd.outputBuffer = ['some old buffer content'];
      pd.setTool('copilot');
      return {
        exists: true,
        tool: pd.currentTool,
        bufferCleared: pd.outputBuffer.length === 0
      };
    });

    expect(result.exists).toBe(true);
    expect(result.tool).toBe('copilot');
    expect(result.bufferCleared).toBe(true);
  });

  test('_suppressDetection flag prevents detection', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const result = await page.evaluate(() => {
      const pd = window.app?.planDetector;
      if (!pd) return null;

      // Enable monitoring
      pd.startMonitoring();
      pd._suppressDetection = true;

      // Feed plan-like content
      let planDetected = false;
      pd.onPlanDetected = () => { planDetected = true; };
      pd.processOutput('Plan mode is active. MUST NOT make any edits.');
      pd.processOutput('## Implementation Plan:\n### 1. Add feature\n- Step A\n### 2. Test\n- Step B');

      return { planDetected };
    });

    expect(result).not.toBeNull();
    expect(result.planDetected).toBe(false);
  });
});

test.describe('Plan API endpoints', () => {

  test('GET /api/plans/list returns JSON with plans array', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const response = await page.evaluate(async () => {
      const res = await fetch('/api/plans/list');
      return { status: res.status, body: await res.json() };
    });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('plans');
    expect(Array.isArray(response.body.plans)).toBe(true);
  });

  test('GET /api/plans/content rejects path traversal', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const response = await page.evaluate(async () => {
      const res = await fetch('/api/plans/content?name=../../etc/passwd&scope=global');
      return { status: res.status };
    });

    // Should be 400 (invalid name after sanitization) or 403 or 404
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test('GET /api/plans/content requires name and scope', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const response = await page.evaluate(async () => {
      const res = await fetch('/api/plans/content');
      return { status: res.status };
    });

    expect(response.status).toBe(400);
  });

  test('GET /api/plans/content with nonexistent file returns 404', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const response = await page.evaluate(async () => {
      const res = await fetch('/api/plans/content?name=nonexistent-plan-xyz.md&scope=workspace');
      return { status: res.status };
    });

    expect(response.status).toBe(404);
  });
});
