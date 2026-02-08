const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  waitForTerminalText,
  typeInTerminal,
  pressKey,
  getTerminalDimensions,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

test.describe('Terminal I/O: user types commands and sees output', () => {
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

  /**
   * Setup a page with a running terminal session.
   * Pre-creates session via REST, joins via window.app, starts terminal.
   */
  async function setupTerminalPage(page) {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, `IO_${Date.now()}`);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    await joinSessionAndStartTerminal(page, sessionId);
  }

  test('user types echo command and sees output in terminal', async ({ page }) => {
    await setupTerminalPage(page);

    const marker = `IO_ECHO_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker}`);
    await pressKey(page, 'Enter');

    await waitForTerminalText(page, marker, 15000);
  });

  test('multi-line output appears correctly', async ({ page }) => {
    await setupTerminalPage(page);

    const marker = `IO_MULTI_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker}_LINE1 && echo ${marker}_LINE2`);
    await pressKey(page, 'Enter');

    await waitForTerminalText(page, `${marker}_LINE1`, 15000);
    await waitForTerminalText(page, `${marker}_LINE2`, 5000);
  });

  test('terminal has valid dimensions', async ({ page }) => {
    await setupTerminalPage(page);

    const dims = await getTerminalDimensions(page);
    expect(dims.cols).toBeGreaterThan(30);
    expect(dims.rows).toBeGreaterThan(3);
  });
});
