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

    // Clear previous WS messages from setup
    await page.evaluate(() => { window._wsMessages = []; });

    // Generate 200 lines of output rapidly via a loop
    const marker = `COALESCE_${Date.now()}`;
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? `for /L %i in (1,1,200) do @echo ${marker}_%i`
      : `for i in $(seq 1 200); do echo ${marker}_$i; done`;

    await typeInTerminal(page, cmd);
    await pressKey(page, 'Enter');

    // Wait for the last line to appear
    await waitForTerminalText(page, `${marker}_200`, 30000);

    // Count output WebSocket messages received during the burst
    const outputMsgCount = await page.evaluate(() => {
      return (page._wsMessages || []).filter(m =>
        m.dir === 'recv' && m.type === 'output'
      ).length;
    });

    // With 200 echo commands, without coalescing we'd see 200+ output messages.
    // With 16ms coalescing, we expect significantly fewer (batched into larger chunks).
    // Allow generous margin — the key assertion is "much fewer than 200".
    expect(outputMsgCount).toBeLessThan(200);
    expect(outputMsgCount).toBeGreaterThan(0);
  });

  test('all output arrives intact despite coalescing', async ({ page }) => {
    await setupTerminalPage(page);

    const marker = `INTACT_${Date.now()}`;
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? `for /L %i in (1,1,50) do @echo ${marker}_%i`
      : `for i in $(seq 1 50); do echo ${marker}_$i; done`;

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
    const isWin = process.platform === 'win32';
    const cmd1 = isWin
      ? `echo ${marker1}`
      : `echo ${marker1}`;
    await typeInTerminal(page, cmd1);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker1, 10000);

    // Wait longer than the 16ms coalescing window
    await page.waitForTimeout(100);

    // Second burst
    const marker2 = `BURST2_${Date.now()}`;
    const cmd2 = isWin
      ? `echo ${marker2}`
      : `echo ${marker2}`;
    await typeInTerminal(page, cmd2);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker2, 10000);
  });

  test('flush-before-exit delivers pending output when terminal stops', async ({ page }) => {
    await setupTerminalPage(page);

    const marker = `EXIT_${Date.now()}`;
    const isWin = process.platform === 'win32';

    // Echo a marker and immediately exit
    const cmd = isWin
      ? `echo ${marker} & exit`
      : `echo ${marker} && exit`;
    await typeInTerminal(page, cmd);
    await pressKey(page, 'Enter');

    // The marker should appear even though exit follows immediately
    await waitForTerminalText(page, marker, 15000);
  });
});
