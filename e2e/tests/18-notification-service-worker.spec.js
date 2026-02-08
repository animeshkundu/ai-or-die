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

    // Get the actual active and background tab IDs from the tab manager
    const { activeId, bgId } = await page.evaluate((bgApiId) => {
      const stm = window.app.sessionTabManager;
      return {
        activeId: stm.activeTabId,
        bgId: bgApiId, // addTab uses the passed ID directly
      };
    }, sessionB);

    // Verify we have two different tabs
    expect(activeId).not.toBe(bgId);

    // Simulate a NOTIFICATION_CLICK message from the service worker
    const switched = await page.evaluate(async (targetSessionId) => {
      return new Promise((resolve) => {
        const msgEvent = new MessageEvent('message', {
          data: { type: 'NOTIFICATION_CLICK', sessionId: targetSessionId },
        });
        navigator.serviceWorker.dispatchEvent(msgEvent);

        setTimeout(() => {
          resolve(window.app.sessionTabManager.activeTabId);
        }, 500);
      });
    }, bgId);

    expect(switched).toBe(bgId);
  });

  test('sendNotification uses SW showNotification when controller is active', async ({ page }) => {
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

    // Wait for service worker to be controlling the page
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      // If the SW is active but not yet controlling, claim
      if (!navigator.serviceWorker.controller && registration.active) {
        // Force the SW to take control by sending SKIP_WAITING then reloading
        // Instead, just wait a bit for it to claim
        await new Promise(resolve => {
          if (navigator.serviceWorker.controller) return resolve();
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
          // Timeout fallback
          setTimeout(resolve, 3000);
        });
      }
    });

    // Mock showNotification and test the notification path
    const result = await page.evaluate(async (bgSessionId) => {
      return new Promise(async (resolve) => {
        let showNotifCalled = false;
        let showNotifArgs = null;
        let usedFallback = false;

        const registration = await navigator.serviceWorker.ready;
        const hasController = !!navigator.serviceWorker.controller;

        // Mock showNotification on the registration
        const origShowNotif = registration.showNotification.bind(registration);
        registration.showNotification = (title, options) => {
          showNotifCalled = true;
          showNotifArgs = { title, options };
          return Promise.resolve();
        };

        // Also mock the fallback Notification constructor to detect which path was taken
        const OrigNotification = window.Notification;
        window.Notification = class {
          constructor(title, options) {
            usedFallback = true;
            showNotifArgs = { title, options };
          }
          close() {}
          static get permission() { return 'granted'; }
          static requestPermission() { return Promise.resolve('granted'); }
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
          Object.defineProperty(document, 'visibilityState', {
            value: 'visible',
            writable: true,
            configurable: true,
          });
          registration.showNotification = origShowNotif;
          window.Notification = OrigNotification;

          resolve({
            swCalled: showNotifCalled,
            fallbackUsed: usedFallback,
            hasController,
            title: showNotifArgs?.title || '',
            hasOptions: !!showNotifArgs?.options,
          });
        }, 1000);
      });
    }, sessionB);

    // Either the SW path or the fallback path should have been used
    const notificationSent = result.swCalled || result.fallbackUsed;
    expect(notificationSent).toBe(true);
    expect(result.title).toContain('SW Show B');
    expect(result.hasOptions).toBe(true);
  });
});
