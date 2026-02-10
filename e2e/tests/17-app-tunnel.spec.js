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

/**
 * Create a mock TunnelManager to inject into the server via setTunnelManager().
 * Mirrors the real TunnelManager API surface used by the server.
 */
function createMockTunnelManager(options = {}) {
  return {
    getStatus: () => ({
      running: options.running !== false,
      publicUrl: options.publicUrl || null,
    }),
    restart: async () => options.restartResult || { success: true, publicUrl: options.publicUrl },
    stop: async () => {},
  };
}

test.describe('App-level Dev Tunnel UI', () => {
  let server, port, url;

  test.beforeAll(async () => {
    const result = await createServer();
    server = result.server;
    port = result.port;
    url = result.url;
  });

  test.afterAll(async () => {
    if (server) {
      server.close();
    }
  });

  test.afterEach(async ({ page }, testInfo) => {
    // Reset tunnel manager between tests to prevent leaking state
    server.tunnelManager = null;
    await attachFailureArtifacts(page, testInfo);
  });

  /**
   * Helper: navigate to the app, create and join a session, wait for ready.
   */
  async function setupWithSession(page) {
    const sessionId = await createSessionViaApi(port, 'App Tunnel Test');
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

  test('tunnel button hidden when no tunnel configured', async ({ page }) => {
    // No setTunnelManager call — server.tunnelManager remains null
    await setupWithSession(page);

    // The client sends app_tunnel_status on connect; wait for the response
    const statusMsg = await waitForWsMessage(page, 'recv', 'app_tunnel_status', 5000);
    expect(statusMsg).toBeTruthy();

    // Verify the button is hidden
    const btnDisplay = await page.evaluate(() => {
      const btn = document.getElementById('appTunnelBtn');
      return btn ? btn.style.display : 'not-found';
    });
    expect(btnDisplay).toBe('none');
  });

  test('tunnel button visible with running class when tunnel is active', async ({ page }) => {
    server.setTunnelManager(createMockTunnelManager({
      running: true,
      publicUrl: 'https://test-tunnel.devtunnels.ms',
    }));

    await setupWithSession(page);

    // Wait for the app_tunnel_status WS response
    const statusMsg = await waitForWsMessage(page, 'recv', 'app_tunnel_status', 5000);
    expect(statusMsg).toBeTruthy();

    // Verify button is visible and has the 'running' class
    await page.waitForFunction(() => {
      const btn = document.getElementById('appTunnelBtn');
      return btn && btn.style.display !== 'none' && btn.classList.contains('running');
    }, { timeout: 10000 });
  });

  test('clicking tunnel button shows banner with URL', async ({ page }) => {
    server.setTunnelManager(createMockTunnelManager({
      running: true,
      publicUrl: 'https://test-tunnel.devtunnels.ms',
    }));

    await setupWithSession(page);

    // Wait for status to be applied to button
    await page.waitForFunction(() => {
      const btn = document.getElementById('appTunnelBtn');
      return btn && btn.classList.contains('running');
    }, { timeout: 10000 });

    // Click the tunnel button to toggle the banner
    await page.evaluate(() => document.getElementById('appTunnelBtn').click());

    // Wait for banner to become visible
    await page.waitForFunction(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner && banner.classList.contains('visible');
    }, { timeout: 5000 });

    // Verify banner contains the tunnel URL
    const bannerText = await page.evaluate(() => document.getElementById('appTunnelBanner').textContent);
    expect(bannerText).toContain('test-tunnel.devtunnels.ms');

    // Verify Restart button exists
    const hasRestart = await page.evaluate(() => !!document.querySelector('#appTunnelBanner .vst-restart-btn'));
    expect(hasRestart).toBe(true);
  });

  test('restart tunnel button triggers restart and shows restarting state', async ({ page }) => {
    let restartCalled = false;
    const mock = createMockTunnelManager({
      running: true,
      publicUrl: 'https://test-tunnel.devtunnels.ms',
    });
    mock.restart = async () => {
      restartCalled = true;
      await new Promise(r => setTimeout(r, 500));
      return { success: true, publicUrl: 'https://test-tunnel.devtunnels.ms' };
    };
    server.setTunnelManager(mock);

    await setupWithSession(page);

    // Wait for status to propagate
    await page.waitForFunction(() => {
      const btn = document.getElementById('appTunnelBtn');
      return btn && btn.classList.contains('running');
    }, { timeout: 10000 });

    // Click the tunnel button to show the banner
    await page.evaluate(() => document.getElementById('appTunnelBtn').click());
    await page.waitForFunction(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner && banner.classList.contains('visible');
    }, { timeout: 5000 });

    // Click the "Restart Tunnel" button in the banner
    await page.evaluate(() => document.querySelector('#appTunnelBanner .vst-restart-btn').click());

    // Verify the banner shows the restarting state (spinner text)
    await page.waitForFunction(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner && banner.textContent.includes('Restarting');
    }, { timeout: 5000 });

    // Wait for the restart to complete and status to update (server broadcasts app_tunnel_status)
    await page.waitForFunction(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner && banner.textContent.includes('test-tunnel.devtunnels.ms');
    }, { timeout: 10000 });

    // Confirm the mock's restart was actually called
    expect(restartCalled).toBe(true);
  });
});
