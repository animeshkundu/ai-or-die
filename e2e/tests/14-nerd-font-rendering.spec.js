const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
  waitForTerminalText,
  focusTerminal,
} = require('../helpers/terminal-helpers');

test.describe('Nerd Font rendering infrastructure', () => {
  let server, port, url;

  test.beforeAll(async () => {
    const result = await createServer();
    server = result.server;
    port = result.port;
    url = result.url;
  });

  test.afterAll(async () => {
    if (server) server.close();
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  test('default font includes Nerd Font on fresh load', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Nerd Font Default');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const fontFamily = await page.evaluate(() => {
      return window.app && window.app.terminal
        ? window.app.terminal.options.fontFamily
        : null;
    });

    expect(fontFamily).not.toBeNull();
    expect(fontFamily).toMatch(/Meslo.*Nerd/i);
  });

  test('unicode11 addon is active', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Unicode11 Check');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const unicodeVersion = await page.evaluate(() => {
      return window.app && window.app.terminal
        ? window.app.terminal.unicode.activeVersion
        : null;
    });

    expect(unicodeVersion).toBe('11');
  });

  test('settings are applied on init without manual save', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Settings Init Test');
    await page.goto(url);

    // Clear saved settings so we get fresh defaults
    await page.evaluate(() => localStorage.removeItem('cc-web-settings'));
    await page.reload();

    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const fontFamily = await page.evaluate(() => {
      return window.app && window.app.terminal
        ? window.app.terminal.options.fontFamily
        : null;
    });

    expect(fontFamily).not.toBeNull();
    expect(fontFamily).toContain('MesloLGS Nerd Font');
  });

  test('saved JetBrains Mono setting persists after reload', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'JetBrains Persist');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Save JetBrains Mono into localStorage as if user had set it
    await page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('cc-web-settings') || '{}');
      settings.fontFamily = "'JetBrains Mono', monospace";
      localStorage.setItem('cc-web-settings', JSON.stringify(settings));
    });

    // Reload to test that init reads and applies the saved setting
    await page.reload();
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await page.waitForTimeout(1000);

    const fontFamily = await page.evaluate(() => {
      return window.app && window.app.terminal
        ? window.app.terminal.options.fontFamily
        : null;
    });

    expect(fontFamily).not.toBeNull();
    expect(fontFamily).toContain('JetBrains Mono');
    expect(fontFamily).not.toMatch(/Meslo.*Nerd/i);
  });

  test('unicode11 glyph widths are correct for powerline and wide characters', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Glyph Width Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Use terminal.unicode.getStringCellWidth() to verify glyph widths.
    // This is the exact function xterm.js uses for cursor positioning.
    const widths = await page.evaluate(() => {
      const term = window.app && window.app.terminal;
      if (!term || !term.unicode) return null;
      const wcwidth = (str) => term.unicode.getStringCellWidth(str);
      return {
        // Powerline glyphs (PUA) — should be 1 cell each
        powerlineRight: wcwidth('\ue0b0'),     //
        powerlineLeft: wcwidth('\ue0b2'),      //
        gitBranch: wcwidth('\ue0a0'),          //
        // CJK wide characters — should be 2 cells each with Unicode 11
        cjk: wcwidth('\u4e16'),                // 世
        cjkTwo: wcwidth('\u754c'),             // 界
        // Basic ASCII — should be 1 cell each
        ascii: wcwidth('A'),
        asciiWord: wcwidth('hello'),           // 5 cells
        // Mixed string: ASCII + powerline + CJK
        mixed: wcwidth('AB\ue0b0\u4e16'),     // 2 + 1 + 2 = 5
      };
    });

    expect(widths).not.toBeNull();
    // Powerline glyphs: 1 cell each
    expect(widths.powerlineRight).toBe(1);
    expect(widths.powerlineLeft).toBe(1);
    expect(widths.gitBranch).toBe(1);
    // CJK: 2 cells each (this is the key Unicode 11 improvement)
    expect(widths.cjk).toBe(2);
    expect(widths.cjkTwo).toBe(2);
    // ASCII baseline
    expect(widths.ascii).toBe(1);
    expect(widths.asciiWord).toBe(5);
    // Mixed string
    expect(widths.mixed).toBe(5);
  });

  test('powerline characters render at correct cursor position through shell', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Cursor Position Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await focusTerminal(page);

    // Echo a string with powerline chars through the actual shell and check
    // that the cursor lands at the expected column. This tests the full
    // pipeline: shell → PTY → WebSocket → xterm.write → cursor positioning.
    const marker = `PL_${Date.now()}`;

    // Use printf to write: marker + powerline glyph + "END"
    // printf is cross-platform (bash + powershell alias)
    // Expected: marker(variable) + \ue0b0(1 cell) + END(3 cells)
    const isWindows = process.platform === 'win32';
    const cmd = isWindows
      ? `powershell -Command "Write-Host ('${marker}' + [char]0xe0b0 + 'END')"\r`
      : `printf '${marker}\\ue0b0END\\n'\r`;

    await page.evaluate((input) => {
      window.app.send({ type: 'input', data: input });
    }, cmd);

    // Wait for the marker to appear in terminal output
    await waitForTerminalText(page, marker);
    await page.waitForTimeout(1000);

    // Read the terminal buffer and find our output line
    const result = await page.evaluate((mkr) => {
      const term = window.app.terminal;
      const buffer = term.buffer.active;
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (!line) continue;
        const text = line.translateToString(true);
        if (text.includes(mkr) && text.includes('END')) {
          // Find the column positions of marker start and "END"
          const markerCol = text.indexOf(mkr);
          const endCol = text.indexOf('END', markerCol + mkr.length);
          // Between marker end and "END", there should be exactly 1 cell
          // for the powerline glyph \ue0b0
          const gap = endCol - (markerCol + mkr.length);
          return { found: true, gap, line: text.substring(markerCol, endCol + 3) };
        }
      }
      return { found: false };
    }, marker);

    expect(result.found).toBe(true);
    // The powerline glyph should occupy exactly 1 cell between marker and "END"
    expect(result.gap).toBe(1);
  });

  test('unicode11 addon in split pane terminals', async ({ page }) => {
    const sessionId1 = await createSessionViaApi(port, 'Split Main');
    const sessionId2 = await createSessionViaApi(port, 'Split Right');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId1);

    // Check if SplitContainer is available
    const hasSplitContainer = await page.evaluate(() => {
      return !!(window.app && window.app.splitContainer);
    });

    if (!hasSplitContainer) {
      test.skip();
      return;
    }

    // Create a split programmatically
    await page.evaluate((sid2) => {
      return window.app.splitContainer.createSplit(sid2);
    }, sessionId2);

    await page.waitForFunction(() => {
      return window.app.splitContainer && window.app.splitContainer.enabled;
    }, { timeout: 10000 });

    // Verify unicode version on both split terminals
    const splitUnicodeVersions = await page.evaluate(() => {
      const container = window.app.splitContainer;
      if (!container || !container.splits) return [];
      return container.splits.map(split => {
        return split.terminal ? split.terminal.unicode.activeVersion : null;
      });
    });

    expect(splitUnicodeVersions.length).toBeGreaterThanOrEqual(2);
    expect(splitUnicodeVersions[0]).toBe('11');
    expect(splitUnicodeVersions[1]).toBe('11');
  });
});
