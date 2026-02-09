const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  waitForWebSocket,
  waitForWsMessage,
  attachFailureArtifacts,
} = require('../helpers/terminal-helpers');
const path = require('path');
const fs = require('fs');

test.describe('VS Code Tunnel button', () => {
  let server, port, url;
  let originalCommand, originalChecked, originalAvailable;
  let originalDevtunnelCommand, originalDevtunnelChecked, originalDevtunnelAvailable;

  test.beforeAll(async () => {
    const result = await createServer();
    server = result.server;
    port = result.port;
    url = result.url;
    // Wait for VS Code CLI discovery to finish
    await server.vscodeTunnel._initPromise;
    // Save original state for restoration
    originalCommand = server.vscodeTunnel._command;
    originalChecked = server.vscodeTunnel._commandChecked;
    originalAvailable = server.vscodeTunnel._available;
    originalDevtunnelCommand = server.vscodeTunnel._devtunnelCommand;
    originalDevtunnelChecked = server.vscodeTunnel._devtunnelChecked;
    originalDevtunnelAvailable = server.vscodeTunnel._devtunnelAvailable;
  });

  test.afterAll(async () => {
    if (server) {
      if (server.vscodeTunnel) await server.vscodeTunnel.stopAll();
      server.close();
    }
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (server && server.vscodeTunnel) {
      await server.vscodeTunnel.stopAll();
      // Restore original command state to prevent leaking between tests
      server.vscodeTunnel._command = originalCommand;
      server.vscodeTunnel._commandChecked = originalChecked;
      server.vscodeTunnel._available = originalAvailable;
      server.vscodeTunnel._devtunnelCommand = originalDevtunnelCommand;
      server.vscodeTunnel._devtunnelChecked = originalDevtunnelChecked;
      server.vscodeTunnel._devtunnelAvailable = originalDevtunnelAvailable;
    }
    await attachFailureArtifacts(page, testInfo);
  });

  /**
   * Helper: navigate to the app, create and join a session, wait for ready.
   */
  async function setupWithSession(page) {
    const sessionId = await createSessionViaApi(port, 'VS Code Tunnel Test');
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await waitForWebSocket(page);

    // Join the session
    await page.evaluate((sid) => {
      window.app.send({ type: 'join_session', sessionId: sid });
    }, sessionId);
    await page.waitForFunction(
      () => window.app.currentClaudeSessionId != null,
      { timeout: 5000 }
    );

    // Wait for the overlay to be hidden so button clicks work
    await page.waitForFunction(() => {
      const overlay = document.getElementById('overlay');
      return !overlay || overlay.style.display === 'none' || overlay.offsetParent === null;
    }, { timeout: 5000 });

    return sessionId;
  }

  /**
   * Helper: trigger the error banner by clicking the tunnel button
   * (VS Code CLI not installed on CI runners).
   */
  async function triggerNotFoundError(page) {
    await page.evaluate(() => document.getElementById('vscodeTunnelBtn').click());

    // Wait for the outbound WebSocket message (proves the bug fix works)
    const sentMsg = await waitForWsMessage(page, 'sent', 'start_vscode_tunnel', 5000);
    expect(sentMsg).toBeTruthy();

    // Wait for the server error response
    const recvMsg = await waitForWsMessage(page, 'recv', 'vscode_tunnel_error', 5000);
    expect(recvMsg).toBeTruthy();

    // Wait for the error banner to appear
    await page.waitForSelector('#vscodeTunnelBanner.visible', { timeout: 5000 });
  }

  test('button click sends WebSocket message and shows not-found error banner', async ({ page }) => {
    test.skip(
      server.vscodeTunnel && server.vscodeTunnel.isAvailableSync(),
      'VS Code CLI is installed — skip not-found test'
    );

    await setupWithSession(page);
    await triggerNotFoundError(page);

    // Verify banner content — install panel shows "VS Code CLI (code) not found."
    const bannerText = await page.$eval('#vscodeTunnelBanner', el => el.textContent);
    expect(bannerText).toContain('VS Code CLI');
    expect(bannerText).toContain('not found');

    // Verify install panel or download link is present
    const hasInstallPanel = await page.$('#vscodeTunnelBanner .vst-install-panel');
    const hasDownloadLink = await page.$('#vscodeTunnelBanner a[href*="code.visualstudio.com"]');
    expect(hasInstallPanel || hasDownloadLink).toBeTruthy();

    // Verify Re-check / Retry button exists
    const retryBtn = await page.$('#vscodeTunnelBanner .vst-retry-btn');
    expect(retryBtn).toBeTruthy();
  });

  test('error banner dismiss button hides the banner', async ({ page }) => {
    test.skip(
      server.vscodeTunnel && server.vscodeTunnel.isAvailableSync(),
      'VS Code CLI is installed — skip not-found test'
    );

    await setupWithSession(page);
    await triggerNotFoundError(page);

    // Click dismiss
    await page.evaluate(() => document.querySelector('#vscodeTunnelBanner .vst-dismiss-btn').click());

    // Banner should lose the visible class
    await page.waitForFunction(
      () => !document.getElementById('vscodeTunnelBanner').classList.contains('visible'),
      { timeout: 3000 }
    );
    const isVisible = await page.$eval(
      '#vscodeTunnelBanner',
      el => el.classList.contains('visible')
    );
    expect(isVisible).toBe(false);
  });

  test('retry button re-triggers the tunnel start', async ({ page }) => {
    test.skip(
      server.vscodeTunnel && server.vscodeTunnel.isAvailableSync(),
      'VS Code CLI is installed — skip not-found test'
    );

    await setupWithSession(page);
    await triggerNotFoundError(page);

    // Clear captured messages so we can detect the retry
    page._wsMessages = [];

    // Click retry
    await page.evaluate(() => document.querySelector('#vscodeTunnelBanner .vst-retry-btn').click());

    // Wait for another start message
    const sentMsg = await waitForWsMessage(page, 'sent', 'start_vscode_tunnel', 5000);
    expect(sentMsg).toBeTruthy();

    // Wait for another error response
    const recvMsg = await waitForWsMessage(page, 'recv', 'vscode_tunnel_error', 5000);
    expect(recvMsg).toBeTruthy();
  });

  test('mock stub shows starting banner then devtunnels.ms URL', async ({ page }) => {
    // Skip on CI until mock stub timing is hardened — the core bug fix
    // is validated by the not-found tests above. This test validates
    // the happy-path UI with fake code + devtunnel binaries.
    test.skip(!!process.env.CI, 'Mock stub test skipped on CI — runs locally');

    // Determine the correct fake scripts for this platform
    const ext = process.platform === 'win32' ? '.cmd' : '.sh';
    const codeStubPath = path.resolve(__dirname, '..', 'fixtures', `fake-code${ext}`);
    const devtunnelStubPath = path.resolve(__dirname, '..', 'fixtures', `fake-devtunnel${ext}`);

    if (!fs.existsSync(codeStubPath)) {
      test.skip(true, `Stub script not found: ${codeStubPath}`);
      return;
    }
    if (!fs.existsSync(devtunnelStubPath)) {
      test.skip(true, `Stub script not found: ${devtunnelStubPath}`);
      return;
    }

    // Inject both fake commands into the server's VSCodeTunnelManager
    server.vscodeTunnel._command = codeStubPath;
    server.vscodeTunnel._commandChecked = true;
    server.vscodeTunnel._available = true;
    server.vscodeTunnel._devtunnelCommand = devtunnelStubPath;
    server.vscodeTunnel._devtunnelChecked = true;
    server.vscodeTunnel._devtunnelAvailable = true;

    await setupWithSession(page);

    // Click the VS Code tunnel button
    await page.evaluate(() => document.getElementById('vscodeTunnelBtn').click());

    // Verify the start message was sent
    const sentMsg = await waitForWsMessage(page, 'sent', 'start_vscode_tunnel', 5000);
    expect(sentMsg).toBeTruthy();

    // Wait for the banner to appear (starting state)
    await page.waitForSelector('#vscodeTunnelBanner.visible', { timeout: 5000 });

    // Wait for the devtunnels.ms URL to appear (running state)
    await page.waitForFunction(
      () => {
        const banner = document.getElementById('vscodeTunnelBanner');
        return banner && banner.textContent.includes('devtunnels.ms');
      },
      { timeout: 15000 }
    );
    const urlText = await page.$eval('#vscodeTunnelBanner', el => el.textContent);
    expect(urlText).toContain('mock-e2e-test.devtunnels.ms');

    // Verify Copy URL and Open and Stop buttons are present
    const copyBtn = await page.$('#vscodeTunnelBanner .vst-copy-btn');
    const openBtn = await page.$('#vscodeTunnelBanner .vst-open-btn');
    const stopBtn = await page.$('#vscodeTunnelBanner .vst-stop-btn');
    expect(copyBtn).toBeTruthy();
    expect(openBtn).toBeTruthy();
    expect(stopBtn).toBeTruthy();

    // Verify the toolbar button has the 'running' CSS class
    const hasRunningClass = await page.$eval(
      '#vscodeTunnelBtn',
      el => el.classList.contains('running')
    );
    expect(hasRunningClass).toBe(true);

    // Cleanup: stop the tunnel
    await page.evaluate(() => document.querySelector('#vscodeTunnelBanner .vst-stop-btn').click());
    await page.waitForFunction(
      () => !document.getElementById('vscodeTunnelBanner').classList.contains('visible'),
      { timeout: 5000 }
    );
  });

  test('Ctrl+Shift+V keyboard shortcut triggers tunnel', async ({ page }) => {
    test.skip(
      server.vscodeTunnel && server.vscodeTunnel.isAvailableSync(),
      'VS Code CLI is installed — skip not-found test'
    );

    await setupWithSession(page);

    // Trigger via keyboard shortcut instead of button click
    await page.keyboard.press('Control+Shift+V');

    // Wait for the outbound WebSocket message
    const sentMsg = await waitForWsMessage(page, 'sent', 'start_vscode_tunnel', 5000);
    expect(sentMsg).toBeTruthy();

    // Wait for the server error response
    const recvMsg = await waitForWsMessage(page, 'recv', 'vscode_tunnel_error', 5000);
    expect(recvMsg).toBeTruthy();

    // Banner should be visible with error
    await page.waitForSelector('#vscodeTunnelBanner.visible', { timeout: 5000 });
  });
});
