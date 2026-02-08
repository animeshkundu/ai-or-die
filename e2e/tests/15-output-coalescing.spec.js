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

test.describe('Output coalescing: batched broadcasts during heavy output', () => {
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

  async function setupTerminalPage(page) {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, `Coalesce_${Date.now()}`);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
  }

  test('heavy output is coalesced into fewer WebSocket messages', async ({ page }) => {
    await setupTerminalPage(page);

    // Record message count before the burst
    // page._wsMessages is a Playwright-side (Node.js) array, not browser-side
    const msgCountBefore = page._wsMessages.filter(m =>
      m.dir === 'recv' && m.type === 'output'
    ).length;

    // Generate 200 lines of output rapidly via node (cross-platform)
    const marker = `COAL_${Date.now()}`;
    const cmd = `node -e "for(let i=1;i<=200;i++) console.log('${marker}_'+i)"`;

    await typeInTerminal(page, cmd);
    await pressKey(page, 'Enter');

    // Wait for the last line to appear
    await waitForTerminalText(page, `${marker}_200`, 30000);

    // Count output WebSocket messages received during the burst
    // page._wsMessages is populated by setupPageCapture's Playwright-side listener
    const outputMsgCount = page._wsMessages.filter(m =>
      m.dir === 'recv' && m.type === 'output'
    ).length - msgCountBefore;

    // With 200 console.log calls, without coalescing we'd see 200+ output messages.
    // With 16ms coalescing, multiple PTY batches are merged into single sends.
    // The exact count depends on system speed but should be well under 200.
    expect(outputMsgCount).toBeGreaterThan(0);
    expect(outputMsgCount).toBeLessThan(200);
  });

  test('all output arrives intact despite coalescing', async ({ page }) => {
    await setupTerminalPage(page);

    // Use node for cross-platform output generation
    const marker = `INTACT_${Date.now()}`;
    const cmd = `node -e "for(let i=1;i<=50;i++) console.log('${marker}_'+i)"`;

    await typeInTerminal(page, cmd);
    await pressKey(page, 'Enter');

    // Verify first and last lines appear in the terminal
    await waitForTerminalText(page, `${marker}_1`, 15000);
    await waitForTerminalText(page, `${marker}_50`, 15000);
  });

  test('output continues to flow after coalescing window', async ({ page }) => {
    await setupTerminalPage(page);

    // First burst
    const marker1 = `BURST1_${Date.now()}`;
    await typeInTerminal(page, `node -e "console.log('${marker1}')"`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker1, 10000);

    // Wait longer than the 16ms coalescing window
    await page.waitForTimeout(100);

    // Second burst
    const marker2 = `BURST2_${Date.now()}`;
    await typeInTerminal(page, `node -e "console.log('${marker2}')"`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker2, 10000);
  });

  test('flush-before-exit delivers pending output when terminal stops', async ({ page }) => {
    await setupTerminalPage(page);

    const marker = `EXIT_${Date.now()}`;

    // Echo a marker and immediately exit (cross-platform via node)
    await typeInTerminal(page, `node -e "console.log('${marker}'); process.exit(0)"`);
    await pressKey(page, 'Enter');

    // The marker should appear even though exit follows immediately
    await waitForTerminalText(page, marker, 15000);
  });
});
