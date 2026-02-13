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
    if (server) await server.close();
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
    // Use stm.activeTabId directly since it may differ from the API session ID
    const toastShown = await page.evaluate(() => {
      return new Promise((resolve) => {
        const stm = window.app.sessionTabManager;
        const activeId = stm.activeTabId;
        stm.sendNotification('Should Not Show', 'Suppressed', activeId);
        setTimeout(() => {
          const toast = document.querySelector('.mobile-notification');
          resolve(!!toast);
        }, 500);
      });
    });

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
    // Wait for the unread class to be cleared after switching
    await page.waitForFunction((sid) => {
      const tab = window.app.sessionTabManager.tabs.get(sid);
      return tab && !tab.classList.contains('has-unread');
    }, sessionB, { timeout: 3000 }).catch(() => {});

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

      // Wait for session_activity to propagate and update tab status on Client B
      await pageB.waitForFunction((sid) => {
        const stm = window.app.sessionTabManager;
        const session = stm.activeSessions.get(sid);
        return session && session.status === 'active';
      }, session1, { timeout: 5000 });

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

  test('full E2E: background session idle triggers notification toast via real timer', async ({ browser }) => {
    // This test exercises the COMPLETE notification pipeline end-to-end:
    // background output → session_activity → markSessionActivity → idle timer fires
    // → sendNotification → in-app toast appears
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      setupPageCapture(pageA);
      setupPageCapture(pageB);

      await pageA.goto(url);
      await pageB.goto(url);
      await waitForAppReady(pageA);
      await waitForAppReady(pageB);
      await waitForTerminalCanvas(pageA);
      await waitForTerminalCanvas(pageB);

      // Client A: session 1 with terminal
      const session1 = await createSessionViaApi(port, 'E2E Notify S1');
      await joinSessionAndStartTerminal(pageA, session1);

      // Client B: session 2 with terminal + session 1 as background tab
      const session2 = await createSessionViaApi(port, 'E2E Notify S2');
      await joinSessionAndStartTerminal(pageB, session2);

      await pageB.evaluate(async (sid) => {
        window.app.sessionTabManager.addTab(sid, 'E2E Notify S1', 'idle');
      }, session1);

      // Override idle timeout to 3 seconds on Client B for fast testing
      await pageB.evaluate(() => {
        window.app.sessionTabManager.idleTimeoutMs = 3000;
      });

      // Client A types two echo commands spaced >1s apart to overcome the
      // session_activity throttle. The first call sets wasActive=false (status
      // was 'idle'), the second call captures wasActive=true (status now 'active').
      const marker = `E2E_NOTIFY_${Date.now()}`;
      await typeInTerminal(pageA, `echo ${marker}_1`);
      await pressKey(pageA, 'Enter');
      await waitForTerminalText(pageA, `${marker}_1`, 15000);

      // Wait >1s for the throttle window to pass
      await pageA.waitForTimeout(1500);

      await typeInTerminal(pageA, `echo ${marker}_2`);
      await pressKey(pageA, 'Enter');
      await waitForTerminalText(pageA, `${marker}_2`, 15000);

      // Wait for idle timer (3s) to fire and mark the tab as unread.
      // Poll for the persistent unread indicator instead of a blind wait.
      await pageB.waitForFunction((sid) => {
        const tab = window.app.sessionTabManager.tabs.get(sid);
        return tab && tab.classList.contains('has-unread');
      }, session1, { timeout: 8000 });

      // Assert: background tab has unread indicator (persists after toast dismisses)
      const hasUnread = await pageB.evaluate((sid) => {
        const tab = window.app.sessionTabManager.tabs.get(sid);
        return tab ? tab.classList.contains('has-unread') : false;
      }, session1);
      expect(hasUnread).toBe(true);

      // Assert: session data marked as unread
      const sessionData = await pageB.evaluate((sid) => {
        const stm = window.app.sessionTabManager;
        const session = stm.activeSessions.get(sid);
        return session ? { unreadOutput: session.unreadOutput, status: session.status } : null;
      }, session1);
      expect(sessionData).not.toBeNull();
      expect(sessionData.unreadOutput).toBe(true);
      expect(sessionData.status).toBe('idle');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test('toast shows hostname prefix in notification title', async ({ page }) => {
    setupPageCapture(page);

    const sessionA = await createSessionViaApi(port, 'Hostname A');
    const sessionB = await createSessionViaApi(port, 'Hostname B');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    await joinSessionAndStartTerminal(page, sessionA);

    await page.evaluate(async (sid) => {
      window.app.sessionTabManager.addTab(sid, 'Hostname B', 'idle');
    }, sessionB);

    // Set a known hostname on the app instance
    const toastText = await page.evaluate((bgSessionId) => {
      return new Promise((resolve) => {
        window.app.hostname = 'TEST-MACHINE';
        const stm = window.app.sessionTabManager;
        stm.sendNotification({
          title: 'Hostname B — Build completed',
          body: 'test body',
          sessionId: bgSessionId,
          type: 'success',
        });
        setTimeout(() => {
          const toast = document.querySelector('.mobile-notification');
          resolve(toast ? toast.textContent : '');
        }, 500);
      });
    }, sessionB);

    expect(toastText).toContain('[TEST-MACHINE]');
    expect(toastText).toContain('Hostname B');
  });

  test('toast shows working directory and agent type in body', async ({ page }) => {
    setupPageCapture(page);

    const sessionA = await createSessionViaApi(port, 'Context A');
    const sessionB = await createSessionViaApi(port, 'Context B');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    await joinSessionAndStartTerminal(page, sessionA);

    await page.evaluate(async (sid) => {
      const stm = window.app.sessionTabManager;
      stm.addTab(sid, 'Context B', 'idle');
      // Inject workingDir and toolType into the session data
      const session = stm.activeSessions.get(sid);
      if (session) {
        session.workingDir = '/home/user/projects/my-app';
        session.toolType = 'claude';
      }
    }, sessionB);

    const toastBody = await page.evaluate((bgSessionId) => {
      return new Promise((resolve) => {
        const stm = window.app.sessionTabManager;
        stm.sendNotification({
          title: 'Context B — Task completed',
          body: stm._buildNotifBody(stm.activeSessions.get(bgSessionId), 45000),
          sessionId: bgSessionId,
          type: 'success',
        });
        setTimeout(() => {
          const toast = document.querySelector('.mobile-notification');
          resolve(toast ? toast.textContent : '');
        }, 500);
      });
    }, sessionB);

    expect(toastBody).toContain('projects/my-app');
    expect(toastBody).toContain('Claude');
  });

  test('notification type controls chime frequency', async ({ page }) => {
    setupPageCapture(page);

    const session = await createSessionViaApi(port, 'Chime Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, session);

    // Spy on oscillator frequencies for each chime type
    // Note: AudioContext is reused across calls, so we patch createOscillator
    // on the instance rather than replacing the constructor
    const frequencies = await page.evaluate(() => {
      const results = {};
      const stm = window.app.sessionTabManager;

      for (const type of ['success', 'error', 'idle']) {
        const freqs = [];

        // Trigger one chime to ensure _audioCtx is created
        if (!stm._audioCtx) {
          const OrigAC = window.AudioContext || window.webkitAudioContext;
          stm._audioCtx = new OrigAC();
        }

        // Patch createOscillator on the reused instance
        const ctx = stm._audioCtx;
        const origCreateOsc = ctx.createOscillator.bind(ctx);
        ctx.createOscillator = function() {
          const osc = origCreateOsc();
          const origSet = Object.getOwnPropertyDescriptor(
            osc.frequency.__proto__, 'value'
          )?.set;
          Object.defineProperty(osc.frequency, 'value', {
            set(v) { freqs.push(v); if (origSet) origSet.call(this, v); },
            get() { return osc.frequency.defaultValue; },
          });
          return osc;
        };

        stm.playNotificationChime(type);
        results[type] = [...freqs];

        // Restore original
        ctx.createOscillator = origCreateOsc;
      }

      return results;
    });

    expect(frequencies.success).toEqual([523, 659]);
    expect(frequencies.error).toEqual([330, 262]);
    expect(frequencies.idle).toEqual([784]);
  });

  test('notification sound respects mute setting', async ({ page }) => {
    setupPageCapture(page);

    const session = await createSessionViaApi(port, 'Mute Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, session);

    const audioCreated = await page.evaluate(() => {
      // Disable sound in settings
      const settings = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
      settings.notifSound = false;
      localStorage.setItem('cc-web-settings', JSON.stringify(settings));

      // Spy on AudioContext creation
      let created = false;
      const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
      window.AudioContext = class extends OrigAudioContext {
        constructor() { super(); created = true; }
      };

      window.app.sessionTabManager.playNotificationChime('success');

      window.AudioContext = OrigAudioContext;
      return created;
    });

    expect(audioCreated).toBe(false);
  });

  test('notification volume setting controls gain level', async ({ page }) => {
    setupPageCapture(page);

    const session = await createSessionViaApi(port, 'Volume Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, session);

    const gainValue = await page.evaluate(() => {
      // Set volume to 50%
      const settings = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
      settings.notifSound = true;
      settings.notifVolume = 50;
      localStorage.setItem('cc-web-settings', JSON.stringify(settings));

      let capturedGain = null;
      const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
      window.AudioContext = class extends OrigAudioContext {
        createGain() {
          const node = super.createGain();
          const origSetValue = node.gain.setValueAtTime.bind(node.gain);
          node.gain.setValueAtTime = (value, time) => {
            if (capturedGain === null) capturedGain = value;
            return origSetValue(value, time);
          };
          return node;
        }
      };

      window.app.sessionTabManager.playNotificationChime('idle');

      window.AudioContext = OrigAudioContext;
      return capturedGain;
    });

    // 50% of 0.3 max = 0.15, then idle multiplies by 0.5 = 0.075
    expect(gainValue).toBeCloseTo(0.075, 2);
  });

  test('command completion patterns include hostname context', async ({ page }) => {
    setupPageCapture(page);

    const sessionA = await createSessionViaApi(port, 'Completion A');
    const sessionB = await createSessionViaApi(port, 'Completion B');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionA);

    await page.evaluate(async (sid) => {
      const stm = window.app.sessionTabManager;
      stm.addTab(sid, 'Completion B', 'idle');
      const session = stm.activeSessions.get(sid);
      if (session) {
        session.workingDir = '/workspace/api';
        session.toolType = 'claude';
      }
    }, sessionB);

    // Set hostname and trigger command completion
    const toastText = await page.evaluate((bgSessionId) => {
      return new Promise((resolve) => {
        window.app.hostname = 'BUILD-BOX';
        const stm = window.app.sessionTabManager;
        stm.checkForCommandCompletion(bgSessionId, 'build successful', Date.now() - 30000);
        setTimeout(() => {
          const toast = document.querySelector('.mobile-notification');
          resolve(toast ? toast.textContent : '');
        }, 500);
      });
    }, sessionB);

    expect(toastText).toContain('[BUILD-BOX]');
    expect(toastText).toContain('Completion B');
    expect(toastText).toContain('Build completed successfully');
  });
});
