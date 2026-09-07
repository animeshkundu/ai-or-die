'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
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
    const browser = await chromium.launch({
      headless: true,
      channel: 'msedge',
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1',
      viewport: { width: 393, height: 852 },
      screen: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });

    // Emulate standalone display mode before page loads
    await context.addInitScript(() => {
      // Emulate navigator.standalone (iOS Safari/Edge PWA)
      Object.defineProperty(navigator, 'standalone', {
        get: () => true,
        configurable: true,
      });

      // Override matchMedia to match display-mode: standalone
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

    // Click terminal option to start a session so we see the full active terminal screen
    const termCard = page.locator('.tool-card[data-tool="terminal"]');
    if (await termCard.isVisible({ timeout: 2000 }).catch(() => false)) {
      await termCard.click();
      await page.waitForTimeout(2500);
    }

    // Evaluate safe-area metrics and tabs-bar metrics
    const metrics = await page.evaluate(() => {
      const tabsBar = document.querySelector('.session-tabs-bar');
      const tabsBarRect = tabsBar ? tabsBar.getBoundingClientRect() : null;
      const computed = tabsBar ? window.getComputedStyle(tabsBar) : null;
      const root = document.documentElement;
      const rootComputed = window.getComputedStyle(root);

      return {
        classList: Array.from(root.classList),
        saTop: rootComputed.getPropertyValue('--sa-top'),
        saInsetTop: rootComputed.getPropertyValue('--safe-area-inset-top'),
        tabsBarPaddingTop: computed ? computed.paddingTop : null,
        tabsBarPaddingLeft: computed ? computed.paddingLeft : null,
        tabsBarPaddingRight: computed ? computed.paddingRight : null,
        tabsBarRect,
      };
    });

    console.log('Metrics in standalone mode on iPhone 16:', JSON.stringify(metrics, null, 2));

    // Attach Dynamic Island & Status Bar visual simulation overlay to match real iPhone 16 PWA
    await page.evaluate(() => {
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

      // Dynamic Island pill in center
      // iPhone 16 Dynamic Island is ~125px wide, ~37px tall, centered, top ~11px
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

      // Home indicator bar at bottom
      const homeIndicator = document.createElement('div');
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

    const screenshotsDir = path.join(__dirname, '..', '.claude-images');
    fs.mkdirSync(screenshotsDir, { recursive: true });
    const screenshotPath = path.join(screenshotsDir, 'iphone16-pwa-calibrated.png');
    await page.screenshot({ path: screenshotPath });
    console.log('Saved calibrated screenshot to:', screenshotPath);

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
