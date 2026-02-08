const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
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

  test('CJK and powerline characters occupy correct cell widths', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Glyph Width Test');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Verify glyph widths by writing characters to the terminal and
    // measuring cursor advancement. This uses xterm's actual rendering
    // path — the same code that positions the cursor for real prompts.
    const widths = await page.evaluate(() => {
      return new Promise((resolve) => {
        const term = window.app.terminal;
        const results = {};

        // Helper: clear screen, write string, measure cursor delta
        function measure(label, str) {
          return new Promise((res) => {
            term.write('\x1b[2J\x1b[H', () => {
              const startX = term.buffer.active.cursorX;
              term.write(str, () => {
                results[label] = term.buffer.active.cursorX - startX;
                res();
              });
            });
          });
        }

        // Run measurements sequentially
        measure('ascii_A', 'A')
          .then(() => measure('ascii_hello', 'hello'))
          .then(() => measure('powerline', '\ue0b0'))
          .then(() => measure('gitBranch', '\ue0a0'))
          .then(() => measure('cjk_world', '\u4e16'))
          .then(() => measure('cjk_two', '\u754c'))
          .then(() => measure('mixed', 'AB\ue0b0\u4e16'))
          .then(() => resolve(results));
      });
    });

    // ASCII baseline
    expect(widths.ascii_A).toBe(1);
    expect(widths.ascii_hello).toBe(5);
    // Powerline glyphs (PUA): 1 cell each
    expect(widths.powerline).toBe(1);
    expect(widths.gitBranch).toBe(1);
    // CJK wide characters: 2 cells each
    expect(widths.cjk_world).toBe(2);
    expect(widths.cjk_two).toBe(2);
    // Mixed: A(1) + B(1) + powerline(1) + 世(2) = 5
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

  test('MesloLGS Nerd Font is available in the browser after load', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Font Check');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Wait for all fonts to settle, then check if MesloLGS Nerd Font is available
    const fontAvailable = await page.evaluate(() => {
      return document.fonts.ready.then(() => {
        return document.fonts.check('14px "MesloLGS Nerd Font"');
      });
    });

    expect(fontAvailable).toBe(true);
  });

  test('self-hosted WOFF2 serves with correct MIME type', async ({ page }) => {
    // Directly fetch the self-hosted font file from the server
    const response = await page.request.get(`${url}/fonts/MesloLGSNerdFont-Regular.woff2`);
    expect(response.status()).toBe(200);
    const contentType = response.headers()['content-type'];
    expect(contentType).toMatch(/font\/woff2|application\/octet-stream/);
  });

  test('no font-related network requests fail', async ({ page }) => {
    const failedFontRequests = [];

    page.on('requestfailed', (request) => {
      const url = request.url();
      if (url.includes('.woff2') || url.includes('.woff') || url.includes('nerd-font')) {
        failedFontRequests.push({ url, error: request.failure()?.errorText });
      }
    });

    const sessionId = await createSessionViaApi(port, 'Font Network Check');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Wait a bit for all font requests to settle
    await page.waitForTimeout(3000);

    expect(failedFontRequests).toEqual([]);
  });
});
