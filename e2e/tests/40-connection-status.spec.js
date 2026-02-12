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

test.describe('Connection Status Indicator', () => {

  test('connection status dot exists and shows connected', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Verify the connection status element exists in DOM
    const indicator = page.locator('#connectionStatus');
    await expect(indicator).toBeAttached();

    // Verify it has the 'connected' class when WebSocket is open
    const className = await page.evaluate(() => {
      const el = document.getElementById('connectionStatus');
      return el ? el.className : '';
    });
    expect(className).toContain('connected');
    expect(className).not.toContain('disconnected');
  });

  test('status dot changes to disconnected when WebSocket closes', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'status-disconnect');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Verify initial connected state
    await page.waitForFunction(() => {
      const el = document.getElementById('connectionStatus');
      return el && el.className.includes('connected');
    }, { timeout: 10000 });

    // Force-close the WebSocket
    await page.evaluate(() => {
      if (window.app && window.app.socket) {
        // Set maxReconnectAttempts to 0 so it goes directly to disconnected
        window.app.maxReconnectAttempts = 0;
        window.app.socket.close();
      }
    });

    // Verify the indicator changes to disconnected
    await page.waitForFunction(() => {
      const el = document.getElementById('connectionStatus');
      return el && el.className.includes('disconnected');
    }, { timeout: 15000 });

    const disconnectedClass = await page.evaluate(() => {
      const el = document.getElementById('connectionStatus');
      return el ? el.className : '';
    });
    expect(disconnectedClass).toContain('disconnected');
  });

  test('status dot returns to connected after reconnect', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'status-reconnect');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Verify initial connected state
    await page.waitForFunction(() => {
      const el = document.getElementById('connectionStatus');
      return el && el.className.includes('connected');
    }, { timeout: 10000 });

    // Force a non-clean disconnect by destroying the socket internally
    // (socket.close() produces a clean close that won't trigger reconnect)
    await page.evaluate(() => {
      if (window.app && window.app.socket) {
        // Simulate network failure — terminate without clean close handshake
        window.app.socket.onclose({ wasClean: false, code: 1006, reason: 'test' });
        window.app.socket = null;
      }
    });

    // Wait for reconnecting state (non-clean close triggers reconnect)
    await page.waitForFunction(() => {
      const el = document.getElementById('connectionStatus');
      if (!el) return false;
      return el.className.includes('reconnecting') || el.className.includes('disconnected');
    }, { timeout: 10000 });

    // Wait for auto-reconnect to establish new WebSocket
    await page.waitForFunction(() => {
      return window.app && window.app.socket && window.app.socket.readyState === 1;
    }, { timeout: 30000 });

    // Verify status dot returned to connected
    await page.waitForFunction(() => {
      const el = document.getElementById('connectionStatus');
      return el && el.className.includes('connected') && !el.className.includes('disconnected');
    }, { timeout: 10000 });

    const finalClass = await page.evaluate(() => {
      const el = document.getElementById('connectionStatus');
      return el ? el.className : '';
    });
    expect(finalClass).toContain('connected');
  });

  test('connection status has correct aria attributes', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Verify accessibility attributes
    const attrs = await page.evaluate(() => {
      const el = document.getElementById('connectionStatus');
      if (!el) return null;
      return {
        role: el.getAttribute('role'),
        ariaLabel: el.getAttribute('aria-label'),
        title: el.title,
      };
    });
    expect(attrs).not.toBeNull();
    expect(attrs.role).toBe('status');
    expect(attrs.ariaLabel).toContain('Connected');
    expect(attrs.title).toContain('Connected');
  });
});
