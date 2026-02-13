const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  joinSessionAndStartTerminal,
  attachFailureArtifacts,
} = require('../helpers/terminal-helpers');

test.describe('Nerd Font visual rendering', () => {
  let server, port, url;

  test.beforeAll(async () => {
    const result = await createServer();
    server = result.server;
    port = result.port;
    url = result.url;
  });

  test.afterAll(async () => {
    if (server) await server.close();
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  test('all 14 WOFF2 font files are served with correct MIME type', async ({ page }) => {
    const fontPaths = [
      '/fonts/MesloLGSNerdFont-Regular.woff2',
      '/fonts/MesloLGSNerdFont-Bold.woff2',
      '/fonts/MesloLGSNerdFont-Italic.woff2',
      '/fonts/MesloLGSNerdFont-BoldItalic.woff2',
      '/fonts/JetBrainsMonoNerdFont-Regular.woff2',
      '/fonts/JetBrainsMonoNerdFont-Bold.woff2',
      '/fonts/JetBrainsMonoNerdFont-Italic.woff2',
      '/fonts/JetBrainsMonoNerdFont-BoldItalic.woff2',
      '/fonts/FiraCodeNerdFont-Regular.woff2',
      '/fonts/FiraCodeNerdFont-Bold.woff2',
      '/fonts/CaskaydiaCoveNerdFont-Regular.woff2',
      '/fonts/CaskaydiaCoveNerdFont-Bold.woff2',
      '/fonts/CaskaydiaCoveNerdFont-Italic.woff2',
      '/fonts/CaskaydiaCoveNerdFont-BoldItalic.woff2',
    ];

    for (const fontPath of fontPaths) {
      const response = await page.request.get(`${url}${fontPath}`);
      expect(response.status(), `${fontPath} should return 200`).toBe(200);
      const contentType = response.headers()['content-type'];
      expect(contentType, `${fontPath} should have font/woff2 MIME type`).toMatch(
        /font\/woff2|application\/octet-stream/
      );
    }
  });

  test('MesloLGS Nerd Font is available in the browser after load', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'MesloLGS Font Check');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const fontAvailable = await page.evaluate(() => {
      return document.fonts.ready.then(() => {
        return document.fonts.check('14px "MesloLGS Nerd Font"');
      });
    });

    expect(fontAvailable).toBe(true);
  });

  test('JetBrains Mono NF is available in the browser after load', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'JetBrains Font Check');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Explicitly trigger font load (fonts only load when used on page)
    const fontAvailable = await page.evaluate(async () => {
      await document.fonts.load('14px "JetBrains Mono NF"');
      return document.fonts.check('14px "JetBrains Mono NF"');
    });

    expect(fontAvailable).toBe(true);
  });

  test('Fira Code NF is available in the browser after load', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Fira Code Font Check');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const fontAvailable = await page.evaluate(async () => {
      await document.fonts.load('14px "Fira Code NF"');
      return document.fonts.check('14px "Fira Code NF"');
    });

    expect(fontAvailable).toBe(true);
  });

  test('Cascadia Code NF is available in the browser after load', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Cascadia Font Check');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const fontAvailable = await page.evaluate(async () => {
      await document.fonts.load('14px "Cascadia Code NF"');
      return document.fonts.check('14px "Cascadia Code NF"');
    });

    expect(fontAvailable).toBe(true);
  });

  test('PUA glyph cell widths are correct for non-default font', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'PUA Glyph Non-Default');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Switch terminal to JetBrains Mono NF with MesloLGS fallback
    await page.evaluate(() => {
      window.app.terminal.options.fontFamily =
        "'JetBrains Mono NF', 'MesloLGS Nerd Font', monospace";
    });

    // Allow the font switch to take effect
    await page.waitForTimeout(500);

    const widths = await page.evaluate(() => {
      return new Promise((resolve) => {
        const term = window.app.terminal;
        const results = {};

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

        measure('powerline', '\ue0b0')
          .then(() => measure('gitBranch', '\ue0a0'))
          .then(() => measure('folderIcon', '\uf07c'))
          .then(() => resolve(results));
      });
    });

    // Powerline right arrow: 1 cell
    expect(widths.powerline).toBe(1);
    // Git branch icon: 1 cell
    expect(widths.gitBranch).toBe(1);
    // Folder open icon: 1 cell
    expect(widths.folderIcon).toBe(1);
  });

  test('settings font switch applies Nerd Font family with MesloLGS fallback', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Font Fallback Check');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Read all #fontFamily select options from the DOM
    const options = await page.evaluate(() => {
      const select = document.getElementById('fontFamily');
      if (!select) return [];
      return Array.from(select.options).map(opt => ({
        text: opt.text,
        value: opt.value,
      }));
    });

    // Every non-Meslo option should include MesloLGS Nerd Font as a fallback
    const nonMesloOptions = options.filter(opt => !opt.text.includes('Meslo'));
    for (const opt of nonMesloOptions) {
      // System Monospace and Consolas also use MesloLGS as fallback
      expect(opt.value, `"${opt.text}" option should include MesloLGS Nerd Font fallback`).toContain(
        'MesloLGS Nerd Font'
      );
    }

    // Programmatically select JetBrains Mono and verify terminal fontFamily
    await page.evaluate(() => document.getElementById('settingsBtn').click());
    await page.waitForSelector('.settings-modal.active', { timeout: 10000 });

    const fontSelect = page.locator('#fontFamily');
    await fontSelect.selectOption("'JetBrains Mono NF', 'MesloLGS Nerd Font', monospace");

    await page.evaluate(() => document.getElementById('saveSettingsBtn').click());
    await page.waitForTimeout(500);

    const terminalFont = await page.evaluate(() => {
      return window.app && window.app.terminal
        ? window.app.terminal.options.fontFamily
        : null;
    });

    expect(terminalFont).not.toBeNull();
    expect(terminalFont).toContain('JetBrains Mono NF');
    expect(terminalFont).toContain('MesloLGS Nerd Font');
  });

  test('no font-related network requests fail', async ({ page }) => {
    const failedFontRequests = [];

    page.on('requestfailed', (request) => {
      const reqUrl = request.url();
      if (reqUrl.includes('.woff2') || reqUrl.includes('.woff')) {
        failedFontRequests.push({ url: reqUrl, error: request.failure()?.errorText });
      }
    });

    const sessionId = await createSessionViaApi(port, 'Font Network Check');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Wait for all fonts to finish loading via the Fonts API
    await page.evaluate(() => document.fonts.ready);
    // Brief extra settle for any trailing network requests
    await page.waitForTimeout(500);

    expect(failedFontRequests).toEqual([]);
  });
});
