#!/usr/bin/env node
'use strict';

// Captures the client surfaces that PR #153 redesigns, so a reviewer can see the
// change rather than infer it from a CSS diff. Run against two checkouts and the
// output pairs up as before/after.
//
// Usage: node scripts/capture-shell-screenshots.js <outDir> [label]

const path = require('path');
const fs = require('fs');
const { chromium, webkit } = require('playwright');
const {
  createServer, createSessionViaApi,
} = require(path.join(__dirname, '..', 'e2e', 'helpers', 'server-factory'));
const {
  waitForAppReady, waitForTerminalCanvas, joinSessionAndStartTerminal,
} = require(path.join(__dirname, '..', 'e2e', 'helpers', 'terminal-helpers'));

const OUT = process.argv[2] || 'screenshots';
const LABEL = process.argv[3] || 'shot';
const CR = String.fromCharCode(13);

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: {
    width: 393,
    height: 852,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    browserName: 'webkit',
  },
};

async function settle(page) {
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(450);
}

async function shot(page, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${LABEL}-${name}.png`);
  await page.screenshot({ path: file });
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`  ${name.padEnd(28)} ${String(kb).padStart(5)} KB`);
}

async function main() {
  const { server, port, url } = await createServer();
  let chromiumBrowser = null;
  let webkitBrowser = null;

  async function browserFor(vp) {
    if (vp.browserName === 'webkit') {
      if (!webkitBrowser) {
        webkitBrowser = await webkit.launch({
          headless: process.env.PW_CAPTURE_HEADED !== '1',
        });
      }
      return webkitBrowser;
    }
    if (!chromiumBrowser) chromiumBrowser = await chromium.launch();
    return chromiumBrowser;
  }

  async function withPage(vp, fn) {
    const browser = await browserFor(vp);
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height },
      isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor || 1 });
    const page = await ctx.newPage();
    try { await fn(page); } finally { await ctx.close(); }
  }

  try {
    // 1-2. Welcome / overlay chrome, dark + light, desktop.
    for (const theme of ['dark', 'light']) {
      await withPage(VIEWPORTS.desktop, async (page) => {
        await page.goto(url);
        await waitForAppReady(page);
        await waitForTerminalCanvas(page);
        await page.evaluate((t) => window.ThemeManager.applyThemePreference(t), theme);
        await settle(page);
        await shot(page, `01-welcome-desktop-${theme}`);
      });
    }

    // 3. Live terminal with output, desktop.
    await withPage(VIEWPORTS.desktop, async (page) => {
      const sid = await createSessionViaApi(port, 'Shell shots');
      await page.goto(url);
      await waitForAppReady(page);
      await waitForTerminalCanvas(page);
      await joinSessionAndStartTerminal(page, sid);
      await page.evaluate(() => window.ThemeManager.applyThemePreference('dark'));
      await page.waitForTimeout(3500);
      await page.evaluate((cr) => window.app.send({ type: 'input',
        data: 'echo SHELL-DEMO; echo "second line"; echo "third line"' + cr }), CR);
      await page.waitForTimeout(2500);
      await settle(page);
      await shot(page, '02-terminal-active-desktop-dark');

      // 4. Settings modal.
      await page.click('#settingsBtn');
      await page.waitForSelector('.settings-modal.active', { timeout: 8000 });
      await settle(page);
      await shot(page, '03-settings-modal-desktop-dark');
      await page.evaluate(() => window.app.hideSettings());
      await page.waitForSelector('.settings-modal.active', { state: 'hidden', timeout: 8000 });

      // 5. File browser panel.
      const fbBtn = await page.$('#browseFilesBtn, #filesBtn, [data-action="file-browser"]');
      if (fbBtn) {
        await fbBtn.click().catch(() => {});
        await page.waitForTimeout(1600);
        await settle(page);
        await shot(page, '04-file-browser-desktop-dark');
        await page.evaluate(() => window.ThemeManager.applyThemePreference('light'));
        await settle(page);
        await shot(page, '04-file-browser-desktop-light');
        await page.evaluate(() => window.app._fileBrowserPanel.close());
        await page.waitForSelector('.file-browser-panel.open', { state: 'hidden', timeout: 8000 });
      }
      await page.evaluate(() => window.ThemeManager.applyThemePreference('light'));
      await settle(page);
      await shot(page, '02-terminal-active-desktop-light');
      await page.click('#settingsBtn');
      await page.waitForSelector('.settings-modal.active', { timeout: 8000 });
      await settle(page);
      await shot(page, '03-settings-modal-desktop-light');
    });

    // 6-7. Phone: welcome + live terminal with bottom nav.
    await withPage(VIEWPORTS.phone, async (page) => {
      await page.goto(url);
      await waitForAppReady(page);
      await waitForTerminalCanvas(page);
      await page.evaluate(() => window.ThemeManager.applyThemePreference('dark'));
      await settle(page);
      await shot(page, '05-welcome-phone-dark');
      await page.evaluate(() => window.ThemeManager.applyThemePreference('light'));
      await settle(page);
      await shot(page, '05-welcome-phone-light');
    });
    await withPage(VIEWPORTS.phone, async (page) => {
      const sid = await createSessionViaApi(port, 'Phone shots');
      await page.goto(url);
      await waitForAppReady(page);
      await waitForTerminalCanvas(page);
      await joinSessionAndStartTerminal(page, sid);
      await page.evaluate(() => window.ThemeManager.applyThemePreference('dark'));
      await page.waitForTimeout(3500);
      await page.evaluate((cr) => window.app.send({ type: 'input',
        data: 'echo MOBILE-DEMO; echo "second line"' + cr }), CR);
      await page.waitForTimeout(2500);
      await settle(page);
      await shot(page, '06-terminal-active-phone-dark');
      await page.click('#settingsBtn');
      await page.waitForSelector('.settings-modal.active', { timeout: 8000 });
      await settle(page);
      await shot(page, '07-settings-modal-phone-dark');
      await page.evaluate(() => window.app.hideSettings());
      await page.waitForSelector('.settings-modal.active', { state: 'hidden', timeout: 8000 });
      await page.click('#navFiles');
      await page.waitForSelector('.file-browser-panel.open', { timeout: 8000 });
      await settle(page);
      await shot(page, '08-file-browser-phone-dark');
      await page.evaluate(() => window.app._fileBrowserPanel.close());
      await page.waitForSelector('.file-browser-panel.open', { state: 'hidden', timeout: 8000 });
      await page.evaluate(() => window.ThemeManager.applyThemePreference('light'));
      await settle(page);
      await shot(page, '06-terminal-active-phone-light');
      await page.click('#settingsBtn');
      await page.waitForSelector('.settings-modal.active', { timeout: 8000 });
      await settle(page);
      await shot(page, '07-settings-modal-phone-light');
      await page.evaluate(() => window.app.hideSettings());
      await page.waitForSelector('.settings-modal.active', { state: 'hidden', timeout: 8000 });
      await page.click('#navFiles');
      await page.waitForSelector('.file-browser-panel.open', { timeout: 8000 });
      await settle(page);
      await shot(page, '08-file-browser-phone-light');
    });
  } finally {
    await Promise.all([
      chromiumBrowser && chromiumBrowser.close().catch(() => {}),
      webkitBrowser && webkitBrowser.close().catch(() => {}),
    ]);
    await server.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
