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

test.describe('App tunnel banner auto-dismiss', () => {

  test('running state auto-dismisses within 6 seconds', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Simulate restarting state (no action buttons -> 5s dismiss timer)
    await page.evaluate(() => {
      if (!window.AppTunnelUI) return;
      const tunnelUI = new window.AppTunnelUI({ app: window.app });
      window.app._appTunnelUI = tunnelUI;
      tunnelUI.handleMessage({ type: 'app_tunnel_restarting' });
    });
    await page.waitForTimeout(500);

    // Verify banner is visible
    const visibleBefore = await page.evaluate(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner && banner.classList.contains('visible');
    });
    expect(visibleBefore).toBe(true);

    // Wait for 5s auto-dismiss + 1s buffer
    await page.waitForTimeout(5500);

    // Verify banner auto-dismissed
    const visibleAfter = await page.evaluate(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner && banner.classList.contains('visible');
    });
    expect(visibleAfter).toBe(false);
  });

  test('running state with action buttons uses 20s timer', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

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

    // Banner visible at start
    const visibleBefore = await page.evaluate(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner && banner.classList.contains('visible');
    });
    expect(visibleBefore).toBe(true);

    // Still visible after 6s (because 20s timer for actions)
    await page.waitForTimeout(6000);
    const stillVisible = await page.evaluate(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner && banner.classList.contains('visible');
    });
    expect(stillVisible).toBe(true);
  });
});

test.describe('VSCode tunnel banner auto-dismiss', () => {

  test('auto-collapse timer is set after banner renders', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    const timerInfo = await page.evaluate(() => {
      if (!window.VSCodeTunnelUI) return null;
      const tunnelUI = new window.VSCodeTunnelUI({ app: window.app });
      tunnelUI.banner = document.getElementById('vscodeTunnelBanner');
      tunnelUI.handleMessage({
        type: 'vscode_tunnel_started',
        url: 'https://test.vscode.dev',
      });
      return {
        hasTimer: !!tunnelUI._autoCollapseTimer,
        remaining: tunnelUI._autoCollapseRemaining,
      };
    });

    expect(timerInfo).not.toBeNull();
    expect(timerInfo.hasTimer).toBe(true);
    // Running banner has actions -> 20s
    expect(timerInfo.remaining).toBe(20000);
  });
});

test.describe('Memory warning banner', () => {

  test('supervised mode has Restart button and 20s timer', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    const result = await page.evaluate(() => {
      if (!window.app || !window.app._showMemoryWarning) return null;
      window.app._showMemoryWarning({ rss: '512MB', supervised: true });
      const banner = document.getElementById('memoryWarningBanner');
      const restartBtn = banner ? banner.querySelector('.vst-restart-btn') : null;
      return {
        bannerVisible: banner && banner.classList.contains('visible'),
        hasRestartBtn: !!restartBtn,
        restartText: restartBtn ? restartBtn.textContent.trim() : '',
        timer: window.app._memoryWarningRemaining,
      };
    });

    expect(result).not.toBeNull();
    expect(result.bannerVisible).toBe(true);
    expect(result.hasRestartBtn).toBe(true);
    expect(result.restartText).toBe('Restart Now');
    expect(result.timer).toBe(20000);
  });

  test('unsupervised mode has no Restart button and 5s timer', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    const result = await page.evaluate(() => {
      if (!window.app || !window.app._showMemoryWarning) return null;
      window.app._showMemoryWarning({ rss: '512MB', supervised: false });
      const banner = document.getElementById('memoryWarningBanner');
      const restartBtn = banner ? banner.querySelector('.vst-restart-btn') : null;
      return {
        bannerVisible: banner && banner.classList.contains('visible'),
        hasRestartBtn: !!restartBtn,
        timer: window.app._memoryWarningRemaining,
      };
    });

    expect(result).not.toBeNull();
    expect(result.bannerVisible).toBe(true);
    expect(result.hasRestartBtn).toBe(false);
    expect(result.timer).toBe(5000);
  });

  test('memory warning uses vst-* visual classes', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    const elements = await page.evaluate(() => {
      if (!window.app || !window.app._showMemoryWarning) return null;
      window.app._showMemoryWarning({ rss: '256MB', supervised: true });
      const banner = document.getElementById('memoryWarningBanner');
      if (!banner) return null;
      return {
        hasVstIcon: !!banner.querySelector('.vst-icon'),
        hasVstMessage: !!banner.querySelector('.vst-message'),
        hasVstClose: !!banner.querySelector('.vst-close'),
        bannerClass: banner.className,
      };
    });

    expect(elements).not.toBeNull();
    expect(elements.hasVstIcon).toBe(true);
    expect(elements.hasVstMessage).toBe(true);
    expect(elements.hasVstClose).toBe(true);
    expect(elements.bannerClass).toContain('vscode-tunnel-banner');
  });

  test('hover pauses auto-dismiss timer on app tunnel banner', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Simulate restarting state (5s dismiss, no action buttons)
    await page.evaluate(() => {
      if (!window.AppTunnelUI) return;
      const tunnelUI = new window.AppTunnelUI({ app: window.app });
      window.app._appTunnelUI = tunnelUI;
      tunnelUI.handleMessage({ type: 'app_tunnel_restarting' });
    });
    await page.waitForTimeout(200);

    // Dispatch mouseenter directly to trigger hover-pause
    // (Playwright .hover() struggles with overlapping terminal overlay)
    await page.evaluate(() => {
      const banner = document.getElementById('appTunnelBanner');
      if (banner) banner.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    });

    // Wait 6s while "hovering" (timer should be paused)
    await page.waitForTimeout(6000);

    // Banner should still be visible because hover paused the timer
    const stillVisible = await page.evaluate(() => {
      const banner = document.getElementById('appTunnelBanner');
      return banner && banner.classList.contains('visible');
    });
    expect(stillVisible).toBe(true);
  });
});
