const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  waitForTerminalText,
  readTerminalContent,
  typeInTerminal,
  pressKey,
  focusTerminal,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

test.describe('Vim/edit and session lifecycle', () => {
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
    const sessionId = await createSessionViaApi(port, `Vim_${Date.now()}`);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    return sessionId;
  }

  test('vi opens, user types, saves, and file contains content', async ({ page }) => {
    await setupTerminalPage(page);

    const isWindows = process.platform === 'win32';
    const filename = `playwright_test_${Date.now()}.txt`;
    const marker = `VIM_CONTENT_${Date.now()}`;

    if (isWindows) {
      // On Windows CI runners, vi/vim may not be installed. Use PowerShell to
      // write a file and verify, which tests the same terminal I/O chain.
      await typeInTerminal(page, `"${marker}" | Out-File -FilePath ${filename}`);
      await pressKey(page, 'Enter');
      await page.waitForTimeout(2000);

      // Read it back
      await typeInTerminal(page, `Get-Content ${filename}`);
      await pressKey(page, 'Enter');
      await waitForTerminalText(page, marker, 15000);

      // Clean up
      await typeInTerminal(page, `Remove-Item ${filename}`);
      await pressKey(page, 'Enter');
      await page.waitForTimeout(1000);
    } else {
      // On Linux, vi is always available
      // Open vi with the test file
      await typeInTerminal(page, `vi ${filename}`);
      await pressKey(page, 'Enter');
      await page.waitForTimeout(2000);

      // Enter insert mode
      await focusTerminal(page);
      await page.keyboard.press('i');
      await page.waitForTimeout(500);

      // Type content
      await page.keyboard.type(marker, { delay: 30 });
      await page.waitForTimeout(500);

      // Exit insert mode and save: Esc, :wq, Enter
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      await page.keyboard.type(':wq', { delay: 50 });
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);

      // Verify the file was written by catting it
      await typeInTerminal(page, `cat ${filename}`);
      await pressKey(page, 'Enter');
      await waitForTerminalText(page, marker, 10000);

      // Clean up
      await typeInTerminal(page, `rm ${filename}`);
      await pressKey(page, 'Enter');
      await page.waitForTimeout(1000);
    }
  });

  test('user can close a session and start a new one', async ({ page }) => {
    setupPageCapture(page);

    // Create and join first session
    const session1 = await createSessionViaApi(port, `Close_A_${Date.now()}`);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, session1);

    // Type a marker so we can verify isolation later
    const marker1 = `SESS1_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker1}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker1, 15000);

    // Stop the tool (simulates closing the terminal in a session)
    await page.evaluate(() => {
      window.app.send({ type: 'stop' });
    });

    // Wait for the tool to stop
    await page.waitForTimeout(3000);

    // Delete the session via REST API
    const delRes = await page.request.delete(`${url}/api/sessions/${session1}`);
    expect(delRes.ok()).toBeTruthy();

    // Create a new session
    const session2 = await createSessionViaApi(port, `Close_B_${Date.now()}`);

    // Join the new session and start a terminal
    await page.evaluate(async (sid) => {
      if (window.app.sessionTabManager) {
        window.app.sessionTabManager.addTab(sid, 'New Session', 'idle');
        await window.app.sessionTabManager.switchToTab(sid);
      }
    }, session2);

    await page.waitForTimeout(2000);
    await page.evaluate(() => window.app.startToolSession('terminal'));
    await page.waitForFunction(() => {
      const overlay = document.getElementById('overlay');
      return !overlay || overlay.style.display === 'none';
    }, { timeout: 30000 });
    await page.waitForTimeout(5000);

    // Type a new marker
    const marker2 = `SESS2_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker2}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker2, 15000);

    // Verify the new session works — marker2 appears in output
    const content = await readTerminalContent(page);
    expect(content).toContain(marker2);
  });
});
