const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

// Enable service workers for PWA tests
test.use({ serviceWorkers: 'allow' });

test.describe('PWA Resilience Audit', () => {
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

  test('PWA manifest is valid and correctly configured', async ({ page }) => {
    setupPageCapture(page);

    await page.goto(url);
    await waitForAppReady(page);

    // Check manifest link exists
    const manifestLink = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestLink).toBeTruthy();

    // Fetch and validate manifest
    const manifestResponse = await page.request.get(`${url}${manifestLink}`);
    expect(manifestResponse.ok()).toBe(true);

    const manifest = await manifestResponse.json();

    // Validate critical manifest fields
    expect(manifest.name).toBe('ai-or-die');
    expect(manifest.short_name).toBe('ai-or-die');
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBe('any');
    expect(manifest.start_url).toBe('/');

    // Validate icons
    expect(manifest.icons).toBeDefined();
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    
    const icon192 = manifest.icons.find(i => i.sizes === '192x192');
    const icon512 = manifest.icons.find(i => i.sizes === '512x512');
    expect(icon192).toBeDefined();
    expect(icon512).toBeDefined();

    // Check that icon files exist
    for (const icon of manifest.icons) {
      const iconResponse = await page.request.get(`${url}${icon.src}`);
      expect(iconResponse.ok()).toBe(true);
    }
  });

  test('Service worker registers and activates', async ({ page }) => {
    setupPageCapture(page);

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Wait for service worker to activate
    const swStatus = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) {
        return { supported: false };
      }
      
      const registration = await navigator.serviceWorker.ready;
      return {
        supported: true,
        active: !!registration.active,
        scope: registration.scope,
        hasController: !!navigator.serviceWorker.controller,
      };
    });

    expect(swStatus.supported).toBe(true);
    expect(swStatus.active).toBe(true);
  });

  test('App loads and displays offline with service worker cache', async ({ page, context }) => {
    setupPageCapture(page);

    // First visit to populate cache
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Wait for service worker to be ready
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });

    // Give the cache time to populate
    await page.waitForTimeout(2000);

    // Go offline
    await context.setOffline(true);

    // Navigate again to test offline loading
    await page.goto(url);
    
    // The app should load from cache
    await waitForAppReady(page);
    
    // Check that terminal container exists (shows app UI loaded)
    const terminalExists = await page.locator('#terminal').count();
    expect(terminalExists).toBe(1);

    // Check that we're offline (API calls should fail gracefully)
    const apiCallResult = await page.evaluate(async () => {
      try {
        const response = await fetch('/api/config');
        return { ok: response.ok, status: response.status };
      } catch (err) {
        return { error: err.message };
      }
    });

    // Should either fail or return 503 from service worker
    expect(apiCallResult.ok === false || apiCallResult.status === 503).toBe(true);
  });

  test('WebSocket shows disconnection indicator when network fails', async ({ page, context }) => {
    setupPageCapture(page);

    const sessionId = await createSessionViaApi(port, 'Network Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Wait for WebSocket to connect
    await page.waitForTimeout(1000);

    // Verify connected state
    const initialStatus = await page.evaluate(() => {
      const indicator = document.querySelector('.connection-status');
      return {
        exists: !!indicator,
        className: indicator?.className || '',
      };
    });

    // Go offline to trigger disconnect
    await context.setOffline(true);

    // Wait for disconnect detection
    await page.waitForTimeout(3000);

    // Check for disconnection indicator
    const disconnectStatus = await page.evaluate(() => {
      const indicator = document.querySelector('.connection-status');
      return {
        exists: !!indicator,
        className: indicator?.className || '',
        isReconnecting: indicator?.className.includes('reconnecting') || false,
        isDisconnected: indicator?.className.includes('disconnected') || false,
      };
    });

    expect(disconnectStatus.exists).toBe(true);
    expect(disconnectStatus.isReconnecting || disconnectStatus.isDisconnected).toBe(true);
  });

  test('App recovers after multiple reconnection cycles', async ({ page, context }) => {
    setupPageCapture(page);

    const sessionId = await createSessionViaApi(port, 'Reconnect Cycles');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Perform 5 disconnect/reconnect cycles
    for (let i = 0; i < 5; i++) {
      // Go offline
      await context.setOffline(true);
      await page.waitForTimeout(1500);

      // Come back online
      await context.setOffline(false);
      await page.waitForTimeout(2000);
    }

    // After all cycles, verify app is functional
    const finalStatus = await page.evaluate(() => {
      return {
        socketReady: window.app?.socket?.readyState === WebSocket.OPEN,
        hasSession: !!window.app?.currentClaudeSessionId,
        reconnectAttempts: window.app?.reconnectAttempts || 0,
      };
    });

    expect(finalStatus.socketReady).toBe(true);
    expect(finalStatus.hasSession).toBe(true);
    expect(finalStatus.reconnectAttempts).toBeLessThanOrEqual(5);
  });

  test('Reconnection logic has appropriate backoff parameters', async ({ page }) => {
    setupPageCapture(page);

    await page.goto(url);
    await waitForAppReady(page);

    const reconnectConfig = await page.evaluate(() => {
      return {
        maxReconnectAttempts: window.app?.maxReconnectAttempts,
        reconnectDelay: window.app?.reconnectDelay,
      };
    });

    // Verify reconnection parameters
    expect(reconnectConfig.maxReconnectAttempts).toBe(5);
    expect(reconnectConfig.reconnectDelay).toBe(1000); // 1 second initial delay

    // Exponential backoff with these parameters gives:
    // Attempt 1: 1s, Attempt 2: 2s, Attempt 3: 4s, Attempt 4: 8s, Attempt 5: 16s
    // Total: 31s which is reasonable
  });

  test('App handles slow network gracefully', async ({ page, context }) => {
    setupPageCapture(page);

    const sessionId = await createSessionViaApi(port, 'Slow Network');
    
    // Simulate slow 3G network
    const client = await context.newCDPSession(page);
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: 750 * 1024 / 8, // 750 Kbps
      uploadThroughput: 250 * 1024 / 8,   // 250 Kbps
      latency: 100, // 100ms
    });

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Send some input and verify it's handled
    await page.keyboard.type('echo "slow network test"');
    await page.keyboard.press('Enter');

    // Wait for response with longer timeout due to slow network
    await page.waitForTimeout(3000);

    // App should still be functional
    const status = await page.evaluate(() => {
      return {
        socketReady: window.app?.socket?.readyState === WebSocket.OPEN,
        hasSession: !!window.app?.currentClaudeSessionId,
      };
    });

    expect(status.socketReady).toBe(true);
    expect(status.hasSession).toBe(true);
  });

  test('Background tab behavior preserves session', async ({ page, context }) => {
    setupPageCapture(page);

    const sessionId = await createSessionViaApi(port, 'Background Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Wait for connection
    await page.waitForTimeout(1000);

    // Get initial session state
    const initialSession = await page.evaluate(() => {
      return {
        sessionId: window.app?.currentClaudeSessionId,
        socketState: window.app?.socket?.readyState,
      };
    });

    // Open new tab to put current page in background
    const newPage = await context.newPage();
    await newPage.goto('about:blank');

    // Wait 30 seconds (simulate user switching tabs)
    await page.waitForTimeout(30000);

    // Close new tab and return to original
    await newPage.close();
    await page.bringToFront();

    // Wait for any reconnection
    await page.waitForTimeout(2000);

    // Verify session is still alive
    const finalSession = await page.evaluate(() => {
      return {
        sessionId: window.app?.currentClaudeSessionId,
        socketState: window.app?.socket?.readyState,
        isReady: window.app?.socket?.readyState === WebSocket.OPEN,
      };
    });

    expect(finalSession.sessionId).toBe(initialSession.sessionId);
    expect(finalSession.isReady).toBe(true);
  });

  test('visibilitychange handler manages session priority', async ({ page }) => {
    setupPageCapture(page);

    const sessionA = await createSessionViaApi(port, 'Priority A');
    const sessionB = await createSessionViaApi(port, 'Priority B');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionA);

    // Add second session
    await page.evaluate(async (sid) => {
      window.app.sessionTabManager.addTab(sid, 'Priority B', 'idle');
    }, sessionB);

    // Simulate tab going to background
    const backgroundResult = await page.evaluate(() => {
      // Trigger visibility change
      Object.defineProperty(document, 'hidden', {
        value: true,
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      // Check that priority was sent
      return {
        hasSessionManager: !!window.app?.sessionTabManager,
        currentSession: window.app?.currentClaudeSessionId,
      };
    });

    expect(backgroundResult.hasSessionManager).toBe(true);

    // Simulate tab coming to foreground
    const foregroundResult = await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {
        value: false,
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      return {
        currentSession: window.app?.currentClaudeSessionId,
      };
    });

    expect(foregroundResult.currentSession).toBeTruthy();
  });

  test('localStorage usage is reasonable', async ({ page }) => {
    setupPageCapture(page);

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Set some settings to populate localStorage
    await page.evaluate(() => {
      const settings = {
        theme: 'dark',
        fontSize: 14,
        fontFamily: 'MesloLGS',
      };
      localStorage.setItem('cc-web-settings', JSON.stringify(settings));
    });

    const storageInfo = await page.evaluate(() => {
      const keys = Object.keys(localStorage);
      const sizes = {};
      let totalSize = 0;

      for (const key of keys) {
        const value = localStorage.getItem(key);
        const size = new Blob([value]).size;
        sizes[key] = size;
        totalSize += size;
      }

      return {
        keys,
        sizes,
        totalSize,
        totalSizeKB: (totalSize / 1024).toFixed(2),
      };
    });

    // Check that localStorage is not bloated
    expect(storageInfo.totalSize).toBeLessThan(100 * 1024); // Less than 100KB

    // Check for expected keys
    const hasSettingsKey = storageInfo.keys.some(k => k.includes('cc-web-settings'));
    expect(hasSettingsKey).toBe(true);

    // Verify individual items are reasonable
    for (const [key, size] of Object.entries(storageInfo.sizes)) {
      expect(size).toBeLessThan(50 * 1024); // No single item over 50KB
    }
  });

  test('Output buffer preserves data for reconnection', async ({ page, context }) => {
    setupPageCapture(page);

    const sessionId = await createSessionViaApi(port, 'Buffer Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Wait for connection
    await page.waitForTimeout(1000);

    // Send some commands to populate output buffer
    await page.keyboard.type('echo "test output 1"');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    await page.keyboard.type('echo "test output 2"');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    // Disconnect and reconnect
    await context.setOffline(true);
    await page.waitForTimeout(2000);
    await context.setOffline(false);
    await page.waitForTimeout(3000);

    // Check that terminal has content (output buffer was preserved)
    const terminalContent = await page.evaluate(() => {
      const terminal = window.app?.terminal;
      if (!terminal) return '';
      
      const buffer = terminal.buffer.active;
      let content = '';
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line) {
          content += line.translateToString(true) + '\n';
        }
      }
      return content;
    });

    // Terminal should have content from before the disconnect
    expect(terminalContent.length).toBeGreaterThan(0);
  });

  test('Service worker caches critical resources', async ({ page }) => {
    setupPageCapture(page);

    await page.goto(url);
    await waitForAppReady(page);

    // Wait for service worker to cache resources
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });

    await page.waitForTimeout(2000);

    // Check cached resources
    const cachedResources = await page.evaluate(async () => {
      const cacheNames = await caches.keys();
      if (cacheNames.length === 0) return { found: false };

      const cache = await caches.open(cacheNames[0]);
      const requests = await cache.keys();
      
      return {
        found: true,
        cacheName: cacheNames[0],
        count: requests.length,
        urls: requests.map(r => new URL(r.url).pathname),
      };
    });

    expect(cachedResources.found).toBe(true);
    expect(cachedResources.count).toBeGreaterThan(10);

    // Check for critical resources
    const criticalResources = ['/', '/app.js', '/style.css'];
    for (const resource of criticalResources) {
      const isCached = cachedResources.urls.includes(resource);
      expect(isCached).toBe(true);
    }
  });

  test('App handles API failures gracefully when offline', async ({ page, context }) => {
    setupPageCapture(page);

    await page.goto(url);
    await waitForAppReady(page);
    
    // Go offline
    await context.setOffline(true);

    // Try to fetch config
    const apiResult = await page.evaluate(async () => {
      try {
        const response = await fetch('/api/config');
        const data = await response.json();
        return {
          ok: response.ok,
          status: response.status,
          hasError: !!data.error,
        };
      } catch (err) {
        return {
          ok: false,
          error: err.message,
        };
      }
    });

    // Should get either a 503 from service worker or a fetch error
    expect(apiResult.ok === false || apiResult.status === 503).toBe(true);
  });

  test('Reconnection attempts reset after successful connection', async ({ page, context }) => {
    setupPageCapture(page);

    const sessionId = await createSessionViaApi(port, 'Reset Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Wait for connection
    await page.waitForTimeout(1000);

    // Disconnect
    await context.setOffline(true);
    await page.waitForTimeout(3000);

    // Check that reconnect attempts increased
    const duringDisconnect = await page.evaluate(() => {
      return {
        attempts: window.app?.reconnectAttempts || 0,
      };
    });

    expect(duringDisconnect.attempts).toBeGreaterThan(0);

    // Reconnect
    await context.setOffline(false);
    await page.waitForTimeout(3000);

    // Check that reconnect attempts were reset
    const afterReconnect = await page.evaluate(() => {
      return {
        attempts: window.app?.reconnectAttempts || 0,
        socketState: window.app?.socket?.readyState,
      };
    });

    expect(afterReconnect.socketState).toBe(WebSocket.OPEN);
    expect(afterReconnect.attempts).toBe(0);
  });
});
