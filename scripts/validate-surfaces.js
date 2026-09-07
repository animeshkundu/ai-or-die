'use strict';

const { chromium, webkit } = require('playwright');
const { ClaudeCodeWebServer } = require('../src/server');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 11496;
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-or-die-multi-surface-'));

async function validate() {
  const server = new ClaudeCodeWebServer({
    port: PORT,
    sessionStoreOptions: { storageDir: TEMP_DIR },
    keepalive: false,
    usage: false,
    noAuth: true,
  });
  await server.start();

  try {
    const edgeBrowser = await chromium.launch({ headless: true, channel: 'msedge' });
    const webkitBrowser = await webkit.launch({ headless: true });

    // 1. Desktop Standard Web App (1280x800)
    console.log('Testing 1: Desktop Standard Web App...');
    const desktopPage = await edgeBrowser.newPage({ viewport: { width: 1280, height: 800 } });
    await desktopPage.goto('http://localhost:' + PORT);
    await desktopPage.waitForSelector('#terminal');
    await desktopPage.waitForTimeout(1000);

    const dMetrics = await desktopPage.evaluate(() => {
      const bNav = document.querySelector('.bottom-nav');
      const tabs = document.querySelector('.session-tabs-bar');
      const app = document.getElementById('app');
      const bNavStyle = window.getComputedStyle(bNav);
      const tabsStyle = window.getComputedStyle(tabs);
      const appStyle = window.getComputedStyle(app);
      const browseBtn = document.querySelector('.tab-browse-files');
      return {
        bottomNavDisplay: bNavStyle.display,
        tabsPaddingTop: tabsStyle.paddingTop,
        appPaddingBottom: appStyle.paddingBottom,
        browseFilesVisible: browseBtn ? window.getComputedStyle(browseBtn).display !== 'none' : false,
      };
    });
    console.log('Desktop Standard:', dMetrics);
    if (dMetrics.bottomNavDisplay !== 'none') throw new Error('Desktop bottomNav must be none');
    if (dMetrics.appPaddingBottom !== '0px') throw new Error('Desktop app padding-bottom must be 0px');
    if (dMetrics.tabsPaddingTop !== '0px') throw new Error('Desktop tabs padding-top must be 0px');
    if (!dMetrics.browseFilesVisible) throw new Error('Desktop browse files button must be visible');
    await desktopPage.close();

    // 2. Desktop Window Controls Overlay PWA (1280x800)
    console.log('Testing 2: Desktop Window Controls Overlay PWA...');
    const wcoContext = await edgeBrowser.newContext({ viewport: { width: 1280, height: 800 } });
    await wcoContext.addInitScript(() => {
      Object.defineProperty(navigator, 'windowControlsOverlay', {
        get: () => ({
          visible: true,
          getTitlebarAreaRect: () => ({ x: 0, y: 0, width: 1000, height: 40 }),
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
      });
      const origMatchMedia = window.matchMedia;
      window.matchMedia = function(q) {
        if (q.includes('display-mode: window-controls-overlay')) {
          return { matches: true, media: q, addListener:()=>{}, removeListener:()=>{}, addEventListener:()=>{}, removeEventListener:()=>{} };
        }
        return origMatchMedia.call(window, q);
      };
    });
    const wcoPage = await wcoContext.newPage();
    await wcoPage.goto('http://localhost:' + PORT);
    await wcoPage.waitForSelector('#terminal');
    await wcoPage.waitForTimeout(1000);

    const wcoMetrics = await wcoPage.evaluate(() => {
      const root = document.documentElement;
      const tabs = document.querySelector('.session-tabs-bar');
      const bNav = document.querySelector('.bottom-nav');
      return {
        isWcoVisible: root.classList.contains('wco-visible'),
        wcoPaddingRight: root.style.getPropertyValue('--wco-padding-right'),
        tabsPaddingRight: window.getComputedStyle(tabs).paddingRight,
        bottomNavDisplay: window.getComputedStyle(bNav).display,
      };
    });
    console.log('Desktop WCO:', wcoMetrics);
    if (!wcoMetrics.isWcoVisible) throw new Error('WCO visible class missing');
    if (wcoMetrics.bottomNavDisplay !== 'none') throw new Error('Desktop WCO bottomNav must be none');
    await wcoContext.close();

    // 3. Mobile Web App (WebKit Browser 393x852)
    console.log('Testing 3: Mobile Web App (WebKit Browser)...');
    const mobileBrowserContext = await webkitBrowser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1',
      viewport: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const mbPage = await mobileBrowserContext.newPage();
    await mbPage.goto('http://localhost:' + PORT);
    await mbPage.waitForSelector('#terminal');
    await mbPage.waitForTimeout(1000);

    const mbMetrics = await mbPage.evaluate(() => {
      const bNav = document.querySelector('.bottom-nav');
      const root = document.documentElement;
      return {
        isPwaStandalone: root.classList.contains('pwa-standalone'),
        bottomNavDisplay: window.getComputedStyle(bNav).display,
        navFilesWidth: document.getElementById('navFiles')?.getBoundingClientRect().width,
      };
    });
    console.log('Mobile Browser:', mbMetrics);
    if (mbMetrics.isPwaStandalone) throw new Error('Mobile browser must NOT be pwa-standalone');
    if (mbMetrics.bottomNavDisplay !== 'flex') throw new Error('Mobile browser bottom nav must be flex');
    if (!mbMetrics.navFilesWidth || mbMetrics.navFilesWidth < 44) throw new Error('navFiles width must be >= 44');
    await mobileBrowserContext.close();

    // 4. Mobile Standalone PWA (iPhone 16 WebKit 393x852)
    console.log('Testing 4: Mobile Standalone PWA (iPhone 16 WebKit)...');
    const pwaContext = await webkitBrowser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1',
      viewport: { width: 393, height: 852 },
      screen: { width: 393, height: 852 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    await pwaContext.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { get: () => true });
      const origMatchMedia = window.matchMedia;
      window.matchMedia = function(q) {
        if (q.includes('display-mode: standalone')) return { matches: true, media: q, addListener:()=>{}, removeListener:()=>{}, addEventListener:()=>{}, removeEventListener:()=>{} };
        return origMatchMedia.call(window, q);
      };
    });
    const pwaPage = await pwaContext.newPage();
    await pwaPage.goto('http://localhost:' + PORT);
    await pwaPage.waitForSelector('#terminal');
    await pwaPage.waitForTimeout(1000);

    const pwaMetrics = await pwaPage.evaluate(() => {
      const root = document.documentElement;
      const tabs = document.querySelector('.session-tabs-bar');
      const bNav = document.querySelector('.bottom-nav');
      const tabsRect = tabs.getBoundingClientRect();
      const bNavRect = bNav.getBoundingClientRect();
      return {
        isPwaStandalone: root.classList.contains('pwa-standalone'),
        tabsTop: tabsRect.top,
        tabsBottom: tabsRect.bottom,
        bNavTop: bNavRect.top,
        bNavBottom: bNavRect.bottom,
        bNavHeight: bNavRect.height,
        bottomNavDisplay: window.getComputedStyle(bNav).display,
      };
    });
    console.log('Mobile Standalone PWA:', pwaMetrics);
    if (!pwaMetrics.isPwaStandalone) throw new Error('Must have pwa-standalone class');
    if (pwaMetrics.tabsBottom < 90) throw new Error('Tabs bar must clear Dynamic Island (> 90px)');
    if (pwaMetrics.bNavBottom !== 852) throw new Error('Bottom nav must extend exactly to bottom (852px)');
    if (pwaMetrics.bottomNavDisplay !== 'flex') throw new Error('Bottom nav must be flex');
    await pwaContext.close();

    console.log('All 4 surfaces validated successfully with ZERO regression!');
    await edgeBrowser.close();
    await webkitBrowser.close();
  } finally {
    await server.close();
    try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch (_) {}
  }
}

validate().catch((err) => {
  console.error('Validation FAILED:', err);
  process.exit(1);
});
