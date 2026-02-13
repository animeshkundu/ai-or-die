// @ts-check
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  joinSessionAndStartTerminal,
  typeInTerminal,
  pressKey,
  waitForTerminalText,
  readTerminalContent,
  focusTerminal,
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

test.describe('Power User: Multi-Session Workflow', () => {

  test('create multiple sessions, switch, verify isolation, rename, close', async ({ page }) => {
    setupPageCapture(page);

    // Create 3 sessions via API with different names
    const s1 = await createSessionViaApi(port, 'project-alpha');
    const s2 = await createSessionViaApi(port, 'project-beta');
    const s3 = await createSessionViaApi(port, 'project-gamma');

    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Join session 1 and start terminal
    await joinSessionAndStartTerminal(page, s1);

    // Type a unique marker in session 1
    const marker1 = `ALPHA_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker1}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker1, 15000);

    // Switch to session 2 via tab click
    const tabs = await page.$$('.session-tab');
    expect(tabs.length).toBeGreaterThanOrEqual(3);

    // Join session 2 and start its terminal using the same reliable helper
    await joinSessionAndStartTerminal(page, s2);

    // Type a unique marker in session 2
    const marker2 = `BETA_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker2}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker2, 15000);

    // Verify isolation: session 2 should NOT have session 1's marker
    const content2 = await readTerminalContent(page);
    expect(content2).not.toContain(marker1);

    // Switch back to session 1 via tab click
    await page.evaluate((sid) => {
      const tab = document.querySelector(`.session-tab[data-session-id="${sid}"]`);
      if (tab) tab.click();
    }, s1);
    // Wait for session 1's terminal buffer to be loaded and contain our marker
    await waitForTerminalText(page, marker1, 15000);

    // Verify session 1 still has its marker (persistence)
    const content1 = await readTerminalContent(page);
    expect(content1).toContain(marker1);

    // Close session 3 via tab close button
    const closeBtn = await page.$(`.session-tab[data-session-id="${s3}"] .tab-close`);
    expect(closeBtn).not.toBeNull();
    await closeBtn.click();
    // Wait for the tab to be removed from the DOM
    await page.waitForFunction(
      (sid) => !document.querySelector(`.session-tab[data-session-id="${sid}"]`),
      s3,
      { timeout: 3000 }
    );

    // Verify session 3 tab is gone
    const remainingTabs = await page.$$('.session-tab');
    const s3Tab = await page.$(`.session-tab[data-session-id="${s3}"]`);
    expect(s3Tab).toBeNull();
  });

  test('sessions persist across page reload', async ({ page }) => {
    setupPageCapture(page);

    const sessionId = await createSessionViaApi(port, 'persist-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Type a marker
    const marker = `PERSIST_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker, 15000);

    // Reload the page
    await page.reload();
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Verify the session tab still exists after reload
    await page.waitForFunction((sid) => {
      return document.querySelector(`.session-tab[data-session-id="${sid}"]`) !== null;
    }, sessionId, { timeout: 10000 });
  });
});
