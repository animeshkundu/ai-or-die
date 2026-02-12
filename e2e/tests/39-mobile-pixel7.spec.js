// @ts-check
const { test, expect, devices } = require('@playwright/test');
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
  getTerminalDimensions,
} = require('../helpers/terminal-helpers');

let server, port, url;

test.use({ ...devices['Pixel 7'] });

test.beforeAll(async () => {
  ({ server, port, url } = await createServer());
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.afterEach(async ({ page }, testInfo) => {
  await attachFailureArtifacts(page, testInfo);
});

test.describe('Mobile: Pixel 7 Layout', () => {
  test('real terminal commands work on Android viewport', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'pixel-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Run a multi-step command
    const marker = `PIXEL7_${Date.now()}`;
    await typeInTerminal(page, `node -e "console.log('${marker}')" `);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker, 15000);

    // Verify terminal dimensions are reasonable for Android
    const dims = await getTerminalDimensions(page);
    expect(dims.cols).toBeGreaterThan(25);
    expect(dims.rows).toBeGreaterThan(10);
  });
});
