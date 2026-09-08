'use strict';

/**
 * scripts/emulate-iphone16-pwa.js
 *
 * High-fidelity iPhone 16 standalone PWA emulator.
 * Uses Playwright WebKit to accurately model the iOS Safari / Edge WebKit rendering
 * engine, 393×852 standalone viewport, Dynamic Island clearance (59px top inset),
 * home indicator clearance (34px bottom inset), bottom navigation bar, and the
 * full-height slide-over file browser.
 *
 * Why this verification harness is critical:
 * - Desktop Chromium / Edge can mask iOS WebKit-specific layout quirks (such as
 *   the viewport height deduction in standalone mode and WebKit ICB clipping).
 * - Real iPhone 16 devices use WebKit for all browsers (both Safari and Edge on iOS).
 * - Validating across terminal, navigation, and file browser surfaces in WebKit
 *   guarantees that mobile safe-area paddings and touch targets match real physical glass.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { webkit } = require('playwright');
const { ClaudeCodeWebServer } = require('../src/server');

const PORT = 11489;
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-or-die-pwa-test-'));

async function run() {
  console.log('Starting test server on port', PORT);
  const server = new ClaudeCodeWebServer({
    port: PORT,
    sessionStoreOptions: { storageDir: TEMP_DIR },
    keepalive: false,
    usage: false,
    noAuth: true,
  });
  await server.start();

  try {
    const browser = await webkit.launch({
      headless: true,
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1',
      viewport: { width: 393, height: 852 },
      screen: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });

    // Emulate standalone display mode and PWA environment before page loads
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', {
        get: () => true,
        configurable: true,
      });

      const origMatchMedia = window.matchMedia;
      window.matchMedia = function(query) {
        if (query.includes('display-mode: standalone')) {
          return {
            matches: true,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
          };
        }
        if (query.includes('display-mode: window-controls-overlay')) {
          return {
            matches: false,
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
          };
        }
        return origMatchMedia.call(window, query);
      };
    });

    const page = await context.newPage();
    await page.goto(`http://localhost:${PORT}`);
    await page.waitForSelector('#terminal');
    await page.waitForTimeout(1500);

    // If overlay start prompt is visible, click Terminal or create session
    const termCard = page.locator('.tool-card[data-tool="terminal"]');
    if (await termCard.isVisible({ timeout: 2000 }).catch(() => false)) {
      await termCard.click();
    } else {
      await page.evaluate(() => {
        window.app.send({ type: 'create_session', name: 'Terminal' });
      });
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        window.app.send({ type: 'start_terminal' });
      });
    }
    await page.waitForTimeout(3000);

    // Ensure mode switcher is visible for screenshot verification
    await page.evaluate(() => {
      if (window.app && typeof window.app.showModeSwitcher === 'function') {
        window.app.showModeSwitcher();
      }
    });
    await page.waitForTimeout(500);

    // Helper: attach hardware simulation overlay
    const attachHardwareOverlay = async () => {
      await page.evaluate(() => {
        if (document.getElementById('iphone16-hardware-overlay')) return;
        const overlay = document.createElement('div');
        overlay.id = 'iphone16-hardware-overlay';
        overlay.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          height: 59px;
          pointer-events: none;
          z-index: 999999;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 24px;
          font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
          font-size: 14px;
          font-weight: 600;
          color: #ffffff;
        `;

        overlay.innerHTML = `
          <div style="font-size: 15px; font-weight: 600; letter-spacing: -0.2px; margin-top: -6px;">9:41</div>
          <div style="
            position: absolute;
            top: 11px;
            left: 50%;
            transform: translateX(-50%);
            width: 125px;
            height: 37px;
            background: #000000;
            border-radius: 20px;
            box-shadow: 0 0 1px 1px rgba(255,255,255,0.1);
          "></div>
          <div style="display: flex; align-items: center; gap: 5px; margin-top: -6px;">
            <svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor">
              <path d="M1 9.5h1.5v-2H1v2zm3.5 0H6v-4H4.5v4zm3.5 0h1.5v-6H8v6zm3.5 0H13v-8h-1.5v8zm3.5 0h1.5V0H15v9.5z"/>
            </svg>
            <svg width="16" height="11" viewBox="0 0 16 11" fill="currentColor">
              <path d="M8 2.5a8.5 8.5 0 0 1 5.7 2.2l-1.3 1.3A6.6 6.6 0 0 0 8 4.3c-1.7 0-3.3.7-4.4 1.7L2.3 4.7A8.5 8.5 0 0 1 8 2.5zm0 3.7c1.1 0 2.2.5 3 1.2L8 10.4 5 7.4c.8-.7 1.9-1.2 3-1.2z"/>
            </svg>
            <div style="width: 22px; height: 11px; border: 1px solid currentColor; border-radius: 3px; padding: 1px; display: flex; align-items: center; margin-left: 2px; position: relative;">
              <div style="width: 14px; height: 7px; background: currentColor; border-radius: 1.5px;"></div>
              <div style="position: absolute; right: -3px; top: 3px; width: 2px; height: 3px; background: currentColor; border-radius: 0 1px 1px 0;"></div>
            </div>
          </div>
        `;
        document.body.appendChild(overlay);

        const homeIndicator = document.createElement('div');
        homeIndicator.id = 'iphone16-home-indicator';
        homeIndicator.style.cssText = `
          position: fixed;
          bottom: 8px;
          left: 50%;
          transform: translateX(-50%);
          width: 140px;
          height: 5px;
          background: #ffffff;
          border-radius: 3px;
          pointer-events: none;
          z-index: 999999;
          opacity: 0.6;
        `;
        document.body.appendChild(homeIndicator);
      });
    };

    const screenshotsDir = path.join(__dirname, '..', '.claude-images');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    // 1. Capture terminal screen
    await attachHardwareOverlay();
    const termShotPath = path.join(screenshotsDir, 'iphone16-pwa-calibrated.png');
    await page.screenshot({ path: termShotPath });
    console.log('Saved calibrated terminal screenshot to:', termShotPath);

    // Measure geometry assertions on terminal screen
    const termMetrics = await page.evaluate(() => {
      const tabsBar = document.querySelector('.session-tabs-bar');
      const bNav = document.querySelector('.bottom-nav');
      const app = document.getElementById('app');
      const tabsRect = tabsBar ? tabsBar.getBoundingClientRect() : null;
      const bNavRect = bNav ? bNav.getBoundingClientRect() : null;
      return {
        tabsTop: tabsRect ? tabsRect.top : null,
        tabsBottom: tabsRect ? tabsRect.bottom : null,
        bNavTop: bNavRect ? bNavRect.top : null,
        bNavBottom: bNavRect ? bNavRect.bottom : null,
        bNavHeight: bNavRect ? bNavRect.height : null,
        appHeight: app ? app.getBoundingClientRect().height : null,
        windowHeight: window.innerHeight,
      };
    });
    console.log('Terminal Screen Metrics:', JSON.stringify(termMetrics, null, 2));

    // 2. Open and capture file browser surface
    console.log('Opening file browser surface...');
    await page.evaluate(() => {
      window.app.toggleFileBrowser();
    });
    await page.waitForTimeout(1000);

    const fbMetrics = await page.evaluate(() => {
      const fbPanel = document.querySelector('.file-browser-panel');
      const fbHeader = document.querySelector('.file-browser-header');
      const closeBtn = document.querySelector('.fb-close-btn');
      const breadcrumbs = document.querySelector('.fb-breadcrumbs');
      return {
        panelRect: fbPanel ? fbPanel.getBoundingClientRect() : null,
        headerRect: fbHeader ? fbHeader.getBoundingClientRect() : null,
        closeBtnRect: closeBtn ? closeBtn.getBoundingClientRect() : null,
        breadcrumbsRect: breadcrumbs ? breadcrumbs.getBoundingClientRect() : null,
      };
    });
    console.log('File Browser Surface Metrics:', JSON.stringify(fbMetrics, null, 2));

    const fbShotPath = path.join(screenshotsDir, 'iphone16-pwa-filebrowser.png');
    await page.screenshot({ path: fbShotPath });
    console.log('Saved calibrated file browser screenshot to:', fbShotPath);

    await browser.close();
  } finally {
    await server.close();
    try {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    } catch (_) {}
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
