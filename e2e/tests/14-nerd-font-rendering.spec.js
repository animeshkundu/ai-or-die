const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
  waitForTerminalText,
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

  test('powerline characters render at correct cursor position via terminal.write', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Cursor Position Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Write directly to the terminal (bypassing the shell) so we control
    // exactly what characters land in the buffer. This tests xterm's write
    // path and Unicode11 width calculation without shell echo interference.
    //
    // Use ESC[2J ESC[H to clear screen and move cursor to 0,0 first,
    // so cursor position is deterministic regardless of shell prompt state.
    const result = await page.evaluate(() => {
      return new Promise((resolve) => {
        const term = window.app.terminal;

        // Clear screen and move cursor to origin (0,0)
        term.write('\x1b[2J\x1b[H', () => {
          const startX = term.buffer.active.cursorX; // should be 0

          // Write test string with powerline glyph and CJK character:
          // \ue0b0 = powerline right arrow (1 cell)
          // \u4e16 = CJK "世" (2 cells with Unicode 11)
          term.write('AA\ue0b0BB\u4e16CC', () => {
            const endX = term.buffer.active.cursorX;
            const delta = endX - startX;

            // Read back the line from the buffer
            const line = term.buffer.active.getLine(term.buffer.active.cursorY);
            const text = line ? line.translateToString(true) : '';

            resolve({ startX, endX, delta, text });
          });
        });
      });
    });

    // Cursor should advance by exactly 9 cells:
    // 'A'(1) + 'A'(1) + '\ue0b0'(1) + 'B'(1) + 'B'(1) + '世'(2) + 'C'(1) + 'C'(1) = 9
    expect(result.startX).toBe(0);
    expect(result.delta).toBe(9);
    // Buffer text should contain our characters
    expect(result.text).toContain('AA');
    expect(result.text).toContain('BB');
    expect(result.text).toContain('CC');
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
