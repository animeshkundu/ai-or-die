const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  setupPageCapture,
  attachFailureArtifacts,
} = require('../helpers/terminal-helpers');

test.describe('Tab management: close, quick-create, and dropdown behavior', () => {
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

  test('closing active tab does not show error message', async ({ page }) => {
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
      { timeout: 10000 }
    );

    // Remove any pre-existing tabs (the page auto-creates an initial session on
    // load) so the tab bar contains only the two sessions this test controls.
    await page.evaluate(() => {
      const mgr = window.app.sessionTabManager;
      for (const id of [...mgr.tabs.keys()]) {
        mgr.closeSession(id, { skipServerRequest: true, skipConfirmation: true });
      }
    });

    // Add both sessions as tabs and join session A via the full joinSession path
    await page.evaluate(async ({ sidA, sidB }) => {
      const mgr = window.app.sessionTabManager;
      mgr.addTab(sidA, 'Close Test A', 'idle');
      mgr.addTab(sidB, 'Close Test B', 'idle');
      await mgr.switchToTab(sidA);
    }, { sidA: sessionA, sidB: sessionB });

    // Wait for join to complete and session to be fully active
    await page.waitForFunction(
      (sid) => window.app && window.app.currentClaudeSessionId === sid,
      sessionA,
      { timeout: 10000 }
    );

    // Hide any existing overlays (e.g., start prompt) before testing
    await page.evaluate(() => {
      const overlay = document.getElementById('overlay');
      if (overlay) overlay.style.display = 'none';
      const errorMsg = document.getElementById('errorMessage');
      if (errorMsg) errorMsg.style.display = 'none';
    });

    // Close session A — this should suppress the error dialog
    await page.evaluate((sid) => {
      window.app.sessionTabManager.closeSession(sid);
    }, sessionA);

    // Wait for session B to become the active tab after closing A
    await page.waitForFunction(
      (sid) => window.app && window.app.sessionTabManager &&
        window.app.sessionTabManager.activeTabId === sid,
      sessionB,
      { timeout: 5000 }
    );

    // Assert: the errorMessage div should NOT have been shown
    // We check if showError was called by looking at the errorMessage display.
    // Since we explicitly set it to 'none' before the close, if it's anything
    // other than 'none' it means showError() was triggered.
    const errorVisible = await page.evaluate(() => {
      const el = document.getElementById('errorMessage');
      if (!el) return false;
      return el.style.display !== 'none' && el.style.display !== '';
    });
    expect(errorVisible).toBe(false);

    // Assert: session B should now be the active tab
    const activeTabId = await page.evaluate(() => {
      return window.app.sessionTabManager.activeTabId;
    });
    expect(activeTabId).toBe(sessionB);
  });

  test('quick-create inherits working directory from active tab', async ({ page }) => {
    setupPageCapture(page);

    // Use the server's base folder (process.cwd()) as our workingDir —
    // it is guaranteed to pass the server's path validation.
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'WorkDir Test', workingDir: process.cwd() })
    });
    const data = await res.json();
    expect(data.success).toBe(true);
    const originalSessionId = data.sessionId;
    const workingDir = data.session.workingDir;

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Wait for session tab manager and WebSocket to be ready
    await page.waitForFunction(
      () => window.app && window.app.sessionTabManager
        && window.app.socket && window.app.socket.readyState === 1,
      { timeout: 10000 }
    );

    // Add the session tab with its workingDir and switch to it
    await page.evaluate(async ({ sid, name, dir }) => {
      const mgr = window.app.sessionTabManager;
      mgr.addTab(sid, name, 'idle', dir);
      await mgr.switchToTab(sid);
    }, { sid: originalSessionId, name: 'WorkDir Test', dir: workingDir });

    // Wait for the tab to become active
    await page.waitForFunction(
      (sid) => window.app && window.app.sessionTabManager.activeTabId === sid,
      originalSessionId,
      { timeout: 10000 }
    );

    // Record ALL existing session IDs before clicking quick-create
    const existingIds = await page.evaluate(() => {
      return Array.from(window.app.sessionTabManager.activeSessions.keys());
    });

    // Click the quick-create (plus) button via JS to avoid visibility/scroll issues
    await page.evaluate(() => {
      document.getElementById('tabNewBtn').click();
    });

    // Wait for a new tab to appear (a session ID not in existingIds)
    await page.waitForFunction(
      (knownIds) => {
        const mgr = window.app && window.app.sessionTabManager;
        if (!mgr) return false;
        for (const id of mgr.activeSessions.keys()) {
          if (!knownIds.includes(id)) return true;
        }
        return false;
      },
      existingIds,
      { timeout: 10000 }
    );

    // Find the newly created session (ID not in existingIds)
    const newTabData = await page.evaluate((knownIds) => {
      const mgr = window.app.sessionTabManager;
      for (const [id, sessionData] of mgr.activeSessions) {
        if (!knownIds.includes(id)) {
          return { id, workingDir: sessionData.workingDir, name: sessionData.name };
        }
      }
      return null;
    }, existingIds);

    expect(newTabData).toBeTruthy();
    expect(newTabData.workingDir).toBe(workingDir);

    // The tab name should contain the folder name derived from the workingDir
    const separator = workingDir.includes('\\') ? '\\' : '/';
    const expectedFolder = workingDir.split(separator).filter(Boolean).pop();
    expect(newTabData.name).toContain(expectedFolder);
  });

  test('dropdown chevron opens folder browser modal', async ({ page }) => {
    setupPageCapture(page);

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Wait for session tab manager to be initialized
    await page.waitForFunction(
      () => window.app && window.app.sessionTabManager,
      { timeout: 10000 }
    );

    // Verify the dropdown button exists
    const dropdownExists = await page.evaluate(() => {
      return !!document.getElementById('tabNewDropdown');
    });
    expect(dropdownExists).toBe(true);

    // Click the dropdown chevron via JS to avoid visibility/scroll issues
    await page.evaluate(() => {
      document.getElementById('tabNewDropdown').click();
    });

    // Wait for the folder browser modal to become active
    await page.waitForFunction(() => {
      const modal = document.getElementById('folderBrowserModal');
      return modal && modal.classList.contains('active');
    }, { timeout: 5000 });

    // Assert the modal is visible
    const modalActive = await page.evaluate(() => {
      const modal = document.getElementById('folderBrowserModal');
      return modal && modal.classList.contains('active');
    });
    expect(modalActive).toBe(true);

    // Close the modal
    await page.evaluate(() => {
      document.getElementById('folderBrowserModal').classList.remove('active');
    });

    // Verify it closed
    const modalClosed = await page.evaluate(() => {
      const modal = document.getElementById('folderBrowserModal');
      return modal && !modal.classList.contains('active');
    });
    expect(modalClosed).toBe(true);
  });
});
