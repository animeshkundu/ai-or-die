const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
} = require('../helpers/terminal-helpers');

test.describe('Tab management: close and quick-create behavior', () => {
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

  test('closing active tab does not show error overlay', async ({ page }) => {
    setupPageCapture(page);

    // Pre-create two sessions
    const sessionA = await createSessionViaApi(port, 'Close Test A');
    const sessionB = await createSessionViaApi(port, 'Close Test B');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Wait for session tab manager to be ready with WebSocket open
    await page.waitForFunction(
      () => window.app && window.app.sessionTabManager
        && window.app.socket && window.app.socket.readyState === 1,
      { timeout: 20000 }
    );

    // Add both sessions as tabs
    await page.evaluate(({ sidA, sidB }) => {
      const mgr = window.app.sessionTabManager;
      mgr.addTab(sidA, 'Close Test A', 'idle');
      mgr.addTab(sidB, 'Close Test B', 'idle');
    }, { sidA: sessionA, sidB: sessionB });

    // Switch to session A (the one we will close)
    await page.evaluate(async (sid) => {
      await window.app.sessionTabManager.switchToTab(sid);
    }, sessionA);

    await page.waitForTimeout(500);

    // Close session A via the tab manager
    await page.evaluate((sid) => {
      window.app.sessionTabManager.closeSession(sid);
    }, sessionA);

    // Wait for the server-side session_deleted message to arrive and be processed
    await page.waitForTimeout(2000);

    // Assert: the error overlay should NOT be visible
    const overlayDisplay = await page.evaluate(() => {
      const overlay = document.getElementById('overlay');
      return overlay ? overlay.style.display : 'not-found';
    });
    expect(overlayDisplay).not.toBe('flex');

    // Also verify the errorMessage div is not visible
    const errorDisplay = await page.evaluate(() => {
      const el = document.getElementById('errorMessage');
      return el ? el.style.display : 'not-found';
    });
    expect(errorDisplay).not.toBe('block');

    // Assert: session B should now be the active tab
    const activeTabId = await page.evaluate(() => {
      return window.app.sessionTabManager.activeTabId;
    });
    expect(activeTabId).toBe(sessionB);
  });

  test('plus button quick-creates session with active tab working directory', async ({ page }) => {
    setupPageCapture(page);

    // Pre-create one session
    const sessionA = await createSessionViaApi(port, 'Quick Create Base');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Wait for session tab manager to be ready with WebSocket open
    await page.waitForFunction(
      () => window.app && window.app.sessionTabManager
        && window.app.socket && window.app.socket.readyState === 1,
      { timeout: 20000 }
    );

    // Add and switch to the session tab
    await page.evaluate(async (sid) => {
      const mgr = window.app.sessionTabManager;
      mgr.addTab(sid, 'Quick Create Base', 'idle');
      await mgr.switchToTab(sid);
    }, sessionA);

    await page.waitForTimeout(500);

    // Verify the quick-create button exists
    const newBtnExists = await page.evaluate(() => {
      return !!document.getElementById('tabNewBtn');
    });
    expect(newBtnExists).toBe(true);

    // Count tabs before clicking
    const tabCountBefore = await page.evaluate(() => {
      return window.app.sessionTabManager.tabs.size;
    });

    // Click the quick-create button
    await page.click('#tabNewBtn');

    // Wait for a new tab to appear (tab count increases)
    await page.waitForFunction(
      (prevCount) => {
        const mgr = window.app && window.app.sessionTabManager;
        return mgr && mgr.tabs.size > prevCount;
      },
      tabCountBefore,
      { timeout: 10000 }
    );

    // Verify a new tab was created
    const tabCountAfter = await page.evaluate(() => {
      return window.app.sessionTabManager.tabs.size;
    });
    expect(tabCountAfter).toBeGreaterThan(tabCountBefore);
  });
});
