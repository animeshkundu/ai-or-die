// @ts-check
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
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

test.describe('Tunnel Banner UI', () => {

  test('banner appears when tunnel status is set to running', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Simulate tunnel running state by creating the AppTunnelUI and feeding it
    // a tunnel_status message via page.evaluate
    await page.evaluate(() => {
      if (!window.AppTunnelUI) return;
      const tunnelUI = new window.AppTunnelUI({ app: window.app });
      window.app._appTunnelUI = tunnelUI;
      // Simulate a WebSocket message: tunnel is running with a public URL
      tunnelUI.handleMessage({
        type: 'app_tunnel_status',
        running: true,
        publicUrl: 'https://test-tunnel.example.com/?token=abc123',
      });
    });

    await page.waitForTimeout(500);

    // Verify the banner is visible
    const bannerVisible = await page.evaluate(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner && banner.classList.contains('visible');
    });
    expect(bannerVisible).toBe(true);

    // Verify the banner contains the tunnel URL text
    const bannerText = await page.evaluate(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner ? banner.textContent : '';
    });
    expect(bannerText).toContain('test-tunnel.example.com');
  });

  test('banner shows correct buttons when tunnel is running', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Simulate tunnel running
    await page.evaluate(() => {
      if (!window.AppTunnelUI) return;
      const tunnelUI = new window.AppTunnelUI({ app: window.app });
      window.app._appTunnelUI = tunnelUI;
      tunnelUI.handleMessage({
        type: 'app_tunnel_status',
        running: true,
        publicUrl: 'https://test-tunnel.example.com',
      });
    });
    await page.waitForTimeout(500);

    // Verify Copy URL, Open, and Restart Tunnel buttons exist
    const buttons = await page.evaluate(() => {
      const banner = document.getElementById('appTunnelBanner');
      if (!banner) return [];
      return Array.from(banner.querySelectorAll('button')).map(b => b.textContent.trim());
    });
    expect(buttons).toContain('Copy URL');
    expect(buttons).toContain('Open');
    expect(buttons).toContain('Restart Tunnel');
  });

  test('dismiss button hides the banner', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Simulate tunnel running
    await page.evaluate(() => {
      if (!window.AppTunnelUI) return;
      const tunnelUI = new window.AppTunnelUI({ app: window.app });
      window.app._appTunnelUI = tunnelUI;
      tunnelUI.handleMessage({
        type: 'app_tunnel_status',
        running: true,
        publicUrl: 'https://test-tunnel.example.com',
      });
    });
    await page.waitForTimeout(500);

    // Verify banner is visible before dismiss
    const visibleBefore = await page.evaluate(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner && banner.classList.contains('visible');
    });
    expect(visibleBefore).toBe(true);

    // Click the dismiss button
    await page.evaluate(() => {
      const banner = document.getElementById('appTunnelBanner');
      if (!banner) return;
      const dismissBtn = banner.querySelector('.vst-dismiss-btn');
      if (dismissBtn) dismissBtn.click();
    });
    await page.waitForTimeout(500);

    // Verify banner is hidden
    const visibleAfter = await page.evaluate(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner && banner.classList.contains('visible');
    });
    expect(visibleAfter).toBe(false);
  });

  test('banner shows restarting state', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Simulate tunnel restarting
    await page.evaluate(() => {
      if (!window.AppTunnelUI) return;
      const tunnelUI = new window.AppTunnelUI({ app: window.app });
      window.app._appTunnelUI = tunnelUI;
      tunnelUI.handleMessage({
        type: 'app_tunnel_restarting',
      });
    });
    await page.waitForTimeout(500);

    // Verify banner is visible
    const bannerVisible = await page.evaluate(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner && banner.classList.contains('visible');
    });
    expect(bannerVisible).toBe(true);

    // Verify it shows restarting text
    const bannerText = await page.evaluate(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner ? banner.textContent : '';
    });
    expect(bannerText).toContain('Restarting');
  });

  test('banner is hidden when tunnel is stopped', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Simulate tunnel stopped (no public URL)
    await page.evaluate(() => {
      if (!window.AppTunnelUI) return;
      const tunnelUI = new window.AppTunnelUI({ app: window.app });
      window.app._appTunnelUI = tunnelUI;
      tunnelUI.handleMessage({
        type: 'app_tunnel_status',
        running: false,
        publicUrl: null,
      });
    });
    await page.waitForTimeout(500);

    // Verify banner is NOT visible
    const bannerVisible = await page.evaluate(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner && banner.classList.contains('visible');
    });
    expect(bannerVisible).toBeFalsy();
  });
});
