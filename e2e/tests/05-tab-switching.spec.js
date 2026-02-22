const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  waitForTerminalText,
  readTerminalContent,
  typeInTerminal,
  pressKey,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

test.describe('Tab switching: multiple sessions with isolated content', () => {
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

  test('switch between tabs preserves session content without garbling', async ({ page }) => {
    setupPageCapture(page);

    // Pre-create two sessions
    const sessionA = await createSessionViaApi(port, 'Tab A');
    const sessionB = await createSessionViaApi(port, 'Tab B');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // Join session A and start terminal
    await joinSessionAndStartTerminal(page, sessionA);

    // Type marker in session A
    const markerA = `TABA_${Date.now()}`;
    await typeInTerminal(page, `echo ${markerA}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, markerA, 15000);

    // Add session B tab and switch to it
    await page.evaluate(async (sid) => {
      const app = window.app;
      if (app.sessionTabManager) {
        app.sessionTabManager.addTab(sid, 'Tab B', 'idle');
        await app.sessionTabManager.switchToTab(sid);
      }
    }, sessionB);

    await page.waitForTimeout(3000);

    // Start terminal in session B
    await page.evaluate(() => window.app.startToolSession('terminal'));
    await page.waitForFunction(() => {
      const overlay = document.getElementById('overlay');
      return !overlay || overlay.style.display === 'none';
    }, { timeout: 30000 });
    await page.waitForTimeout(5000);

    // Type marker in session B
    const markerB = `TABB_${Date.now()}`;
    await typeInTerminal(page, `echo ${markerB}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, markerB, 15000);

    // Switch back to session A
    await page.evaluate(async (sid) => {
      await window.app.sessionTabManager.switchToTab(sid);
    }, sessionA);

    await page.waitForTimeout(3000);

    // Read session A content — should contain markerA (from output buffer replay)
    const contentA = await readTerminalContent(page);
    expect(contentA).toContain(markerA);

    // Check for garbled ANSI: orphaned ESC[ without a terminating letter
    const garbledPattern = /\x1b\[[0-9;]*$/m;
    expect(contentA).not.toMatch(garbledPattern);
  });

  test('switching tabs resets terminal mouse mode state', async ({ page }) => {
    setupPageCapture(page);

    const sessionA = await createSessionViaApi(port, 'Mouse Mode A');
    const sessionB = await createSessionViaApi(port, 'Mouse Mode B');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionA);

    // Enable mouse reporting mode in session A.
    await typeInTerminal(page, "printf '\\033[?1000h\\033[?1006h'");
    await pressKey(page, 'Enter');

    await page.waitForFunction(() => {
      const modes = window.app?.terminal?.modes;
      return modes && modes.mouseTrackingMode && modes.mouseTrackingMode !== 'none';
    }, { timeout: 10000 });

    // Switch to session B (no output buffer); terminal modes must reset.
    await page.evaluate(async (sid) => {
      const app = window.app;
      if (app.sessionTabManager) {
        app.sessionTabManager.addTab(sid, 'Mouse Mode B', 'idle');
        await app.sessionTabManager.switchToTab(sid);
      }
    }, sessionB);

    const modeAfterSwitch = await page.evaluate(() => window.app?.terminal?.modes?.mouseTrackingMode || 'none');
    expect(modeAfterSwitch).toBe('none');
  });
});
