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

test.describe('Server Restart', () => {

  test('memory_warning message shows notification banner', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Simulate a memory_warning message from the server
    await page.evaluate(() => {
      window.app.handleMessage({
        type: 'memory_warning',
        rss: '2.1 GB',
        rssBytes: 2254857830,
        heapUsed: '1.5 GB',
        heapUsedBytes: 1610612736,
        threshold: '2048 MB',
        supervised: true
      });
    });

    // Verify notification banner appears
    const banner = page.locator('#memoryWarningBanner');
    await expect(banner).toBeVisible({ timeout: 5000 });

    // Verify banner text mentions memory
    const text = await banner.textContent();
    expect(text).toContain('2.1 GB');
    expect(text).toContain('Memory usage is high');

    // Verify restart button exists (supervised mode)
    const restartBtn = banner.locator('button', { hasText: 'Restart Now' });
    await expect(restartBtn).toBeVisible();

    // Verify dismiss button exists
    const dismissBtn = banner.locator('#memoryWarningDismiss');
    await expect(dismissBtn).toBeVisible();
  });

  test('dismiss button hides memory warning banner', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Show memory warning
    await page.evaluate(() => {
      window.app.handleMessage({
        type: 'memory_warning',
        rss: '2.5 GB',
        rssBytes: 2684354560,
        heapUsed: '1.8 GB',
        heapUsedBytes: 1932735283,
        threshold: '2048 MB',
        supervised: true
      });
    });

    const banner = page.locator('#memoryWarningBanner');
    await expect(banner).toBeVisible({ timeout: 5000 });

    // Click dismiss via JS (banner has CSS slide transition that interferes with
    // Playwright's actionability checks)
    await page.evaluate(() => {
      document.getElementById('memoryWarningDismiss').click();
    });

    // Banner should be hidden (predefined element stays in DOM, display:none)
    await expect(banner).not.toBeVisible({ timeout: 3000 });
  });

  test('unsupervised mode shows manual restart message without restart button', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Simulate memory_warning with supervised=false
    await page.evaluate(() => {
      window.app.handleMessage({
        type: 'memory_warning',
        rss: '2.1 GB',
        rssBytes: 2254857830,
        heapUsed: '1.5 GB',
        heapUsedBytes: 1610612736,
        threshold: '2048 MB',
        supervised: false
      });
    });

    const banner = page.locator('#memoryWarningBanner');
    await expect(banner).toBeVisible({ timeout: 5000 });

    // Should NOT have a "Restart Now" button
    const restartBtn = banner.locator('button', { hasText: 'Restart Now' });
    await expect(restartBtn).not.toBeAttached();

    // Should give actionable instructions for non-supervised mode
    const text = await banner.textContent();
    expect(text).toContain('Ctrl+C');
  });

  test('server_restarting message shows restarting status', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Simulate server_restarting
    await page.evaluate(() => {
      // Prevent actual reconnection logic from firing
      window.app.maxReconnectAttempts = 0;
      window.app.handleMessage({
        type: 'server_restarting',
        reason: 'user_requested'
      });
    });

    // Verify _serverRestarting flag is set
    const isRestarting = await page.evaluate(() => window.app._serverRestarting);
    expect(isRestarting).toBe(true);

    // Verify reconnect attempts were reset
    const attempts = await page.evaluate(() => window.app.reconnectAttempts);
    expect(attempts).toBe(0);
  });

  test('session_joined with wasActive shows tool-specific restart message', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'restart-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Join the session (without starting a terminal) to establish the session context
    await page.evaluate((sid) => {
      window.app.send({ type: 'join_session', sessionId: sid });
    }, sessionId);

    // Wait for session_joined response to complete
    await page.waitForFunction(() => window.app.currentClaudeSessionId, { timeout: 5000 });
    await page.waitForTimeout(500);

    // Now simulate a post-restart session_joined with wasActive=true
    // This mimics what the server sends after a restart — session was active, now stopped
    await page.evaluate((sid) => {
      window.app.handleMessage({
        type: 'session_joined',
        sessionId: sid,
        sessionName: 'restart-test',
        workingDir: '/',
        active: false,
        wasActive: true,
        agent: 'claude',
        outputBuffer: ['Previous output line 1\r\n', 'Previous output line 2\r\n']
      });
    }, sessionId);

    // Verify the restart message is written to the terminal
    await page.waitForFunction(() => {
      const term = window.app?.terminal;
      if (!term) return false;
      const buf = term.buffer?.active;
      if (!buf) return false;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i)?.translateToString(true) || '';
        if (line.includes('server was restarted')) return true;
      }
      return false;
    }, { timeout: 10000 });
  });

  test('duplicate memory_warning notifications are suppressed', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Send two memory warnings
    await page.evaluate(() => {
      window.app.handleMessage({
        type: 'memory_warning',
        rss: '2.1 GB',
        rssBytes: 2254857830,
        heapUsed: '1.5 GB',
        heapUsedBytes: 1610612736,
        threshold: '2048 MB',
        supervised: true
      });
      window.app.handleMessage({
        type: 'memory_warning',
        rss: '2.2 GB',
        rssBytes: 2362232012,
        heapUsed: '1.6 GB',
        heapUsedBytes: 1717986918,
        threshold: '2048 MB',
        supervised: true
      });
    });

    // Should only have one banner
    const banners = page.locator('#memoryWarningBanner');
    await expect(banners).toHaveCount(1);
  });
});
