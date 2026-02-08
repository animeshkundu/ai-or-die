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

test.describe('Output coalescing: batched broadcasts during heavy output', () => {
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

  test('input is processed during heavy output streaming', async ({ page }) => {
    await setupTerminalPage(page);

    // Start a continuous output generator using node (cross-platform).
    // Prints 500 lines with 10ms delay between each, taking ~5 seconds total.
    const cmd = 'node -e "let i=0;const iv=setInterval(()=>{if(i++>=500){clearInterval(iv);return}console.log(\'F_\'+i)},10)"';
    await typeInTerminal(page, cmd);
    await pressKey(page, 'Enter');

    // Wait for initial output to confirm streaming has started
    await waitForTerminalText(page, 'F_1', 15000);

    // While output is still flowing, type a command into the terminal
    await typeInTerminal(page, 'echo INPUT_MARKER');
    await pressKey(page, 'Enter');

    // Assert that our input was processed and echoed back despite heavy output
    await waitForTerminalText(page, 'INPUT_MARKER', 30000);
  });

  test('backspace editing works correctly with fire-and-forget input', async ({ page }) => {
    await setupTerminalPage(page);

    // Type the initial text with per-character delay (via typeInTerminal)
    await typeInTerminal(page, 'echo EDIT_ABCXYZ');

    // Send 3 Backspace keys to remove 'XYZ'
    await pressKey(page, 'Backspace');
    await pressKey(page, 'Backspace');
    await pressKey(page, 'Backspace');

    // Type the replacement text
    await typeInTerminal(page, 'END');

    // Execute the command
    await pressKey(page, 'Enter');

    // The shell should have echoed EDIT_ABCEND (not EDIT_ABCXYZ)
    await waitForTerminalText(page, 'EDIT_ABCEND', 15000);
  });

  test('large output burst exceeding coalesce threshold is delivered completely', async ({ page }) => {
    await setupTerminalPage(page);

    // Generate ~45KB of output in a rapid burst using node (cross-platform).
    // 500 lines, each with a numbered marker and 80 'x' characters (~90 bytes/line).
    const cmd = 'node -e "for(let i=1;i<=500;i++) console.log(\'BIG_\'+String(i).padStart(4,\'0\')+\'_\'+\'x\'.repeat(80))"';
    await typeInTerminal(page, cmd);
    await pressKey(page, 'Enter');

    // Wait for the last line to appear, confirming the entire burst was delivered
    await waitForTerminalText(page, 'BIG_0500', 30000);

    // Verify first, middle, and last lines are all present in the terminal buffer
    const content = await readTerminalContent(page);
    expect(content).toContain('BIG_0001');
    expect(content).toContain('BIG_0250');
    expect(content).toContain('BIG_0500');
  });
});
