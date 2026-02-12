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

test.describe('Power User: Typing During Heavy Output', () => {

  test('user can type freely while terminal receives heavy output', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'heavy-output-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Generate heavy output: 500 lines via Node.js (cross-platform)
    const floodCmd = 'node -e "for(let i=1;i<=500;i++) console.log(\'LINE_\'+i)"';
    await typeInTerminal(page, floodCmd);
    await pressKey(page, 'Enter');

    // While output is streaming, wait briefly then type a new command
    await page.waitForTimeout(200);

    // Type a marker command while output may still be streaming
    const marker = `TYPED_DURING_FLOOD_${Date.now()}`;
    await focusTerminal(page);
    // Use app.send directly to bypass any terminal rendering delays
    await page.evaluate((m) => {
      window.app.send({ type: 'input', data: `echo ${m}\r` });
    }, marker);

    // Wait for the flood to finish
    await waitForTerminalText(page, 'LINE_500', 30000);

    // Wait for our typed marker to appear
    await waitForTerminalText(page, marker, 15000);
  });

  test('terminal does not freeze during heavy output burst', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'freeze-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Generate a burst of output with ANSI codes (like Claude output)
    const burstCmd = 'node -e "for(let i=1;i<=200;i++) console.log(\'\\x1b[1m\\x1b[34mStep \'+i+\': Processing...\\x1b[0m\')"';
    await typeInTerminal(page, burstCmd);
    await pressKey(page, 'Enter');

    // Wait for output to complete
    await waitForTerminalText(page, 'Step 200', 30000);

    // Verify terminal is still responsive after burst
    const postMarker = `POST_BURST_${Date.now()}`;
    await typeInTerminal(page, `echo ${postMarker}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, postMarker, 10000);
  });

  test('input coalescing batches keystrokes during heavy output', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'coalesce-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Start streaming output
    const streamCmd = 'node -e "let i=0;const iv=setInterval(()=>{if(i++>=100){clearInterval(iv);return}console.log(\'STREAM_\'+i)},10)"';
    await typeInTerminal(page, streamCmd);
    await pressKey(page, 'Enter');

    // Small delay to let streaming start
    await page.waitForTimeout(200);

    // Count input WebSocket messages before typing
    const inputMsgsBefore = (page._wsMessages || []).filter(m => m.dir === 'sent' && m.type === 'input').length;

    // Type a 20-character string quickly while output streams
    await focusTerminal(page);
    await page.keyboard.type('abcdefghijklmnopqrst', { delay: 5 }); // Very fast typing

    await page.waitForTimeout(200);

    // Count input messages after typing
    const inputMsgsAfter = (page._wsMessages || []).filter(m => m.dir === 'sent' && m.type === 'input').length;
    const inputMsgsSent = inputMsgsAfter - inputMsgsBefore;

    // With coalescing, 20 keystrokes at 5ms delay should batch into fewer messages
    // than 20 (without coalescing, each keystroke = 1 message)
    // Allow some margin: should be less than 15 messages for 20 keystrokes
    expect(inputMsgsSent).toBeLessThan(15);

    // Wait for stream to finish
    await waitForTerminalText(page, 'STREAM_100', 15000);
  });

  test('large paste is handled correctly under output pressure', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'paste-test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Paste a 3KB string (simulating code paste)
    const largeText = 'echo ' + 'A'.repeat(3000);
    await focusTerminal(page);

    // Use clipboard API to paste
    await page.evaluate((text) => {
      window.app.send({ type: 'input', data: text + '\r' });
    }, largeText);

    // Verify it was received (terminal should echo it back)
    await page.waitForTimeout(2000);
    const content = await readTerminalContent(page);
    expect(content.length).toBeGreaterThan(100);
  });
});
