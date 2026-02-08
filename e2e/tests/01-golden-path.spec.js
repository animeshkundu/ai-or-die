const { test, expect } = require('@playwright/test');
const { spawnCli } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  waitForTerminalText,
  typeInTerminal,
  pressKey,
  getTerminalDimensions,
  setupPageCapture,
  attachFailureArtifacts,
  waitForWebSocket,
} = require('../helpers/terminal-helpers');

test.describe('Golden path: fresh user opens app and uses terminal', () => {
  let cliProcess;
  let url;
  let port;

  test.beforeAll(async () => {
    const result = await spawnCli();
    cliProcess = result.process;
    url = result.url;
    port = result.port;
  });

  test.afterAll(async () => {
    if (cliProcess) {
      cliProcess.kill();
      await new Promise((resolve) => {
        cliProcess.on('exit', resolve);
        setTimeout(resolve, 5000);
      });
    }
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  test('app loads, terminal renders, user types command and sees output', async ({ page }) => {
    setupPageCapture(page);

    // 1. Create a session via REST API first (on a fresh CI machine there are
    //    no sessions, so the app would show folder browser and never connect WS)
    const cwd = process.cwd();
    const createRes = await page.request.post(`${url}/api/sessions/create`, {
      data: { name: 'Golden Path Test', workingDir: cwd }
    });
    const sessionData = await createRes.json();
    const sessionId = sessionData.sessionId;

    // 2. Navigate to the app — with a session existing, it will auto-join
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);

    // 3. Wait for the app to auto-join the existing session
    await page.waitForFunction(
      () => window.app && window.app.currentClaudeSessionId != null,
      { timeout: 20000 }
    );

    // 4. Start terminal — find the Terminal tool card (always available, sorted first)
    //    Cards are clickable divs with data-tool attribute, no separate button.
    const terminalCard = page.locator('.tool-card:not(.disabled)').first();
    await expect(terminalCard).toBeVisible({ timeout: 10000 });
    await terminalCard.click();

    // 5. Wait for terminal to be active (overlay hides)
    await page.waitForFunction(() => {
      const overlay = document.querySelector('[data-tid="overlay"]') || document.getElementById('overlay');
      return !overlay || overlay.style.display === 'none';
    }, { timeout: 30000 });

    // 6. Wait for shell prompt (generous for Windows ConPTY)
    await page.waitForTimeout(5000);

    // 7. Type command and verify output
    const marker = `GOLDEN_${Date.now()}`;
    await typeInTerminal(page, `echo ${marker}`);
    await pressKey(page, 'Enter');
    await waitForTerminalText(page, marker, 15000);

    // 8. Verify terminal dimensions
    const dims = await getTerminalDimensions(page);
    expect(dims.cols).toBeGreaterThan(30);
    expect(dims.rows).toBeGreaterThan(3);
  });
});
