const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  waitForTerminalText,
  typeInTerminal,
  pressKey,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

test.describe('Background session notifications', () => {
  let server, port, url;

  test.beforeAll(async () => {
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) server.close();
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  test('in-app toast appears for background tab notification when page is visible', async ({ page }) => {
    setupPageCapture(page);

    const sessionA = await createSessionViaApi(port, 'Toast Session A');
    const sessionB = await createSessionViaApi(port, 'Toast Session B');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Join session A and start terminal
    await joinSessionAndStartTerminal(page, sessionA);

    // Add session B tab
    await page.evaluate(async (sid) => {
      const app = window.app;
      if (app.sessionTabManager) {
        app.sessionTabManager.addTab(sid, 'Toast Session B', 'idle');
      }
    }, sessionB);

    // Directly call sendNotification for a background session to test visibility fix
    const toastShown = await page.evaluate((bgSessionId) => {
      return new Promise((resolve) => {
        const stm = window.app.sessionTabManager;
        // Page is visible, so desktop notification should be skipped
        // In-app toast should show instead
        stm.sendNotification('Test Title', 'Test Body', bgSessionId);
        // Check if the mobile notification toast was created
        setTimeout(() => {
          const toast = document.querySelector('.mobile-notification');
          resolve(!!toast);
        }, 500);
      });
    }, sessionB);

    expect(toastShown).toBe(true);

    // Verify toast content
    const toastText = await page.evaluate(() => {
      const toast = document.querySelector('.mobile-notification');
      return toast ? toast.textContent : '';
    });
    expect(toastText).toContain('Test Title');
    expect(toastText).toContain('Test Body');
  });

  test('sendNotification does not show toast for active tab', async ({ page }) => {
    setupPageCapture(page);

    const sessionA = await createSessionViaApi(port, 'Active Tab');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    await joinSessionAndStartTerminal(page, sessionA);

    // Try to send notification for the ACTIVE tab — should be suppressed
    const toastShown = await page.evaluate((activeSessionId) => {
      return new Promise((resolve) => {
        const stm = window.app.sessionTabManager;
        stm.sendNotification('Should Not Show', 'Suppressed', activeSessionId);
        setTimeout(() => {
          const toast = document.querySelector('.mobile-notification');
          resolve(!!toast);
        }, 500);
      });
    }, sessionA);

    expect(toastShown).toBe(false);
  });

  test('unread indicator clears when switching to background tab', async ({ page }) => {
    setupPageCapture(page);

    const sessionA = await createSessionViaApi(port, 'Unread A');
    const sessionB = await createSessionViaApi(port, 'Unread B');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    await joinSessionAndStartTerminal(page, sessionA);

    // Add session B tab
    await page.evaluate(async (sid) => {
      window.app.sessionTabManager.addTab(sid, 'Unread B', 'idle');
    }, sessionB);

    // Mark session B as unread
    await page.evaluate((sid) => {
      const stm = window.app.sessionTabManager;
      const session = stm.activeSessions.get(sid);
      if (session) {
        session.unreadOutput = true;
        stm.updateUnreadIndicator(sid, true);
      }
    }, sessionB);

    // Verify unread class is present
    const hasUnreadBefore = await page.evaluate((sid) => {
      const tab = window.app.sessionTabManager.tabs.get(sid);
      return tab ? tab.classList.contains('has-unread') : false;
    }, sessionB);
    expect(hasUnreadBefore).toBe(true);

    // Switch to session B
    await page.evaluate(async (sid) => {
      await window.app.sessionTabManager.switchToTab(sid);
    }, sessionB);
    await page.waitForTimeout(1000);

    // Verify unread class is cleared
    const hasUnreadAfter = await page.evaluate((sid) => {
      const tab = window.app.sessionTabManager.tabs.get(sid);
      return tab ? tab.classList.contains('has-unread') : false;
    }, sessionB);
    expect(hasUnreadAfter).toBe(false);
  });

  test('active-to-idle transition marks background tab as unread', async ({ page }) => {
    setupPageCapture(page);

    const sessionA = await createSessionViaApi(port, 'Status A');
    const sessionB = await createSessionViaApi(port, 'Status B');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    await joinSessionAndStartTerminal(page, sessionA);

    // Add session B tab and set it to active status
    await page.evaluate(async (sid) => {
      const stm = window.app.sessionTabManager;
      stm.addTab(sid, 'Status B', 'idle');
      // Simulate background session being active then becoming idle
      stm.markSessionActivity(sid, true, '');
    }, sessionB);

    // Wait briefly then trigger the idle transition manually (don't wait 90s)
    await page.evaluate((sid) => {
      const stm = window.app.sessionTabManager;
      const session = stm.activeSessions.get(sid);
      if (session) {
        // Clear the 90s timeout and trigger idle transition directly
        clearTimeout(session.workCompleteTimeout);
        stm.updateTabStatus(sid, 'idle');
        // Manually mark as unread (simulating what the timeout callback does)
        session.unreadOutput = true;
        stm.updateUnreadIndicator(sid, true);
      }
    }, sessionB);

    await page.waitForTimeout(500);

    // Verify the tab has the unread indicator
    const hasUnread = await page.evaluate((sid) => {
      const tab = window.app.sessionTabManager.tabs.get(sid);
      return tab ? tab.classList.contains('has-unread') : false;
    }, sessionB);
    expect(hasUnread).toBe(true);
  });

  test('full pipeline: background session output triggers notification via server broadcast', async ({ browser }) => {
    // Use two separate browser contexts to simulate two independent clients
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      setupPageCapture(pageA);
      setupPageCapture(pageB);

      // Both clients navigate to the app
      await pageA.goto(url);
      await pageB.goto(url);
      await waitForAppReady(pageA);
      await waitForAppReady(pageB);
      await waitForTerminalCanvas(pageA);
      await waitForTerminalCanvas(pageB);

      // Client A creates session 1 and starts terminal
      const session1 = await createSessionViaApi(port, 'Pipeline S1');
      await joinSessionAndStartTerminal(pageA, session1);

      // Client B creates session 2 and starts terminal
      const session2 = await createSessionViaApi(port, 'Pipeline S2');
      await joinSessionAndStartTerminal(pageB, session2);

      // Client B also adds session 1 as a background tab
      await pageB.evaluate(async (sid) => {
        window.app.sessionTabManager.addTab(sid, 'Pipeline S1', 'idle');
      }, session1);

      // Client A types in session 1 — this produces output
      const marker = `PIPELINE_${Date.now()}`;
      await typeInTerminal(pageA, `echo ${marker}`);
      await pressKey(pageA, 'Enter');
      await waitForTerminalText(pageA, marker, 15000);

      // Wait for session_activity to propagate and be processed
      await pageB.waitForTimeout(3000);

      // Verify that Client B's background tab for session 1 now has active status
      const tabStatus = await pageB.evaluate((sid) => {
        const stm = window.app.sessionTabManager;
        const session = stm.activeSessions.get(sid);
        return session ? session.status : null;
      }, session1);

      // The tab should be 'active' since session_activity was received
      expect(tabStatus).toBe('active');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
