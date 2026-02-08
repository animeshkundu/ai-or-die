const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

// Enable service workers for this test file
test.use({ serviceWorkers: 'allow' });

test.describe('Service worker notifications', () => {
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

  test('service worker registers and has notificationclick handler', async ({ page }) => {
    setupPageCapture(page);

    await createSessionViaApi(port, 'SW Register');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Wait for service worker to activate
    const swActive = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const registration = await navigator.serviceWorker.ready;
      return !!registration.active;
    });

    expect(swActive).toBe(true);
  });

  test('NOTIFICATION_CLICK message from SW triggers tab switch', async ({ page }) => {
    setupPageCapture(page);

    const sessionA = await createSessionViaApi(port, 'SW Click A');
    const sessionB = await createSessionViaApi(port, 'SW Click B');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionA);

    // Add session B as a background tab
    await page.evaluate(async (sid) => {
      window.app.sessionTabManager.addTab(sid, 'SW Click B', 'idle');
    }, sessionB);

    // Verify session A is active
    const activeBeforeClick = await page.evaluate(() => {
      return window.app.sessionTabManager.activeTabId;
    });
    expect(activeBeforeClick).toBe(sessionA);

    // Simulate a NOTIFICATION_CLICK message from the service worker
    const switched = await page.evaluate(async (targetSessionId) => {
      return new Promise((resolve) => {
        // Post the message as if it came from the SW
        const msgEvent = new MessageEvent('message', {
          data: { type: 'NOTIFICATION_CLICK', sessionId: targetSessionId },
        });
        navigator.serviceWorker.dispatchEvent(msgEvent);

        // Wait for tab switch to process
        setTimeout(() => {
          resolve(window.app.sessionTabManager.activeTabId);
        }, 500);
      });
    }, sessionB);

    expect(switched).toBe(sessionB);
  });

  test('sendNotification attempts SW showNotification when page is hidden', async ({ page }) => {
    setupPageCapture(page);

    const sessionA = await createSessionViaApi(port, 'SW Show A');
    const sessionB = await createSessionViaApi(port, 'SW Show B');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionA);

    await page.evaluate(async (sid) => {
      window.app.sessionTabManager.addTab(sid, 'SW Show B', 'idle');
    }, sessionB);

    // Wait for service worker to be ready
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });

    // Mock the visibility state and capture showNotification calls
    const result = await page.evaluate(async (bgSessionId) => {
      return new Promise(async (resolve) => {
        // Track if showNotification was called
        let showNotifCalled = false;
        let showNotifArgs = null;

        // Get the actual registration
        const registration = await navigator.serviceWorker.ready;

        // Mock showNotification
        const origShowNotif = registration.showNotification.bind(registration);
        registration.showNotification = (title, options) => {
          showNotifCalled = true;
          showNotifArgs = { title, options };
          // Don't actually show the notification in the test
          return Promise.resolve();
        };

        // Override document.visibilityState
        Object.defineProperty(document, 'visibilityState', {
          value: 'hidden',
          writable: true,
          configurable: true,
        });

        const stm = window.app.sessionTabManager;
        stm.sendNotification({
          title: 'SW Show B — Build completed',
          body: 'Test body for SW',
          sessionId: bgSessionId,
          type: 'success',
        });

        // Wait for the async SW ready promise to resolve
        setTimeout(() => {
          // Restore
          Object.defineProperty(document, 'visibilityState', {
            value: 'visible',
            writable: true,
            configurable: true,
          });
          registration.showNotification = origShowNotif;

          resolve({
            called: showNotifCalled,
            title: showNotifArgs?.title || '',
            hasActions: Array.isArray(showNotifArgs?.options?.actions),
            hasData: !!showNotifArgs?.options?.data,
          });
        }, 500);
      });
    }, sessionB);

    expect(result.called).toBe(true);
    expect(result.title).toContain('SW Show B');
    expect(result.hasActions).toBe(true);
    expect(result.hasData).toBe(true);
  });
});
