'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { chromium, devices } = require('playwright');
const { ClaudeCodeWebServer } = require('../src/server');

const PORT = 11488;
const TEST_SESSION_DIR = path.join(__dirname, 'fixtures', 'tmp-geometry-sessions-' + Date.now());

describe('Multi-device terminal geometry and scaling on iPhone 16', function () {
  this.timeout(45000);
  let server;
  let browser;

  before(async function () {
    fs.mkdirSync(TEST_SESSION_DIR, { recursive: true });
    server = new ClaudeCodeWebServer({
      port: PORT,
      sessionStoreOptions: {
        sessionsDir: TEST_SESSION_DIR,
        persistIntervalMs: 1000,
      },
      keepalive: false,
      usage: false,
    });
    await server.start();
    browser = await chromium.launch({
      headless: true,
      channel: 'msedge',
    });
  });

  after(async function () {
    if (browser) await browser.close();
    if (server) await server.close();
    try {
      fs.rmSync(TEST_SESSION_DIR, { recursive: true, force: true });
    } catch (_) {}
  });

  it('Existing session opened on iPhone 16 displays Fit Screen button and transfers lease on click and typing', async function () {
    // 1. Open Desktop browser (1440x900)
    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const desktopPage = await desktopContext.newPage();
    await desktopPage.goto(`http://localhost:${PORT}`);

    // Wait for connection
    await desktopPage.waitForSelector('#terminal');
    await desktopPage.waitForTimeout(1000);

    // Create session and start terminal with explicit geometry from desktop
    await desktopPage.evaluate(() => {
      window.app.send({ type: 'create_session', name: 'Geometry Test' });
    });
    await desktopPage.waitForTimeout(1000);
    await desktopPage.evaluate(() => {
      window.app.send({ type: 'start_terminal', cols: 140, rows: 45 });
    });

    // Wait for terminal output to be active
    await desktopPage.waitForTimeout(3000);

    // Verify desktop is geometry owner and capture created sessionId
    const desktopStatus = await desktopPage.evaluate(() => {
      return {
        sessionId: window.app?.currentClaudeSessionId,
        isOwner: window.app?._geometryIsOwner,
        applied: window.app?._geometryApplied,
        presentation: window.app?._geometryPresentation,
      };
    });
    console.log('Desktop status:', desktopStatus);
    assert(desktopStatus.sessionId, 'Desktop session ID must exist');
    assert.strictEqual(desktopStatus.isOwner, true);
    assert(desktopStatus.applied.cols > 100);

    // 2. Open iPhone 16 mobile context joining the same session
    const iPhone16 = devices['iPhone 16'];
    const phoneContext = await browser.newContext({
      ...iPhone16,
      viewport: { width: 393, height: 659 },
    });
    const phonePage = await phoneContext.newPage();
    await phonePage.goto(`http://localhost:${PORT}`);

    // Wait for connection and switch/join the desktop session
    await phonePage.waitForSelector('#terminal');
    await phonePage.waitForTimeout(1000);
    await phonePage.evaluate((sid) => {
      window.app.sessionTabManager.switchToTab(sid);
    }, desktopStatus.sessionId);

    await phonePage.waitForTimeout(2500);

    // Check phone initial geometry state (should be non-owner with regime 'pan' or 'scale')
    const phoneInitial = await phonePage.evaluate(() => {
      const fitBtn = document.getElementById('fitScreenBtn');
      return {
        isOwner: window.app?._geometryIsOwner,
        applied: window.app?._geometryApplied,
        presentation: window.app?._geometryPresentation,
        fitBtnVisible: fitBtn ? fitBtn.style.display !== 'none' : false,
      };
    });
    console.log('Phone initial status:', phoneInitial);
    assert.strictEqual(phoneInitial.isOwner, false);
    assert.strictEqual(phoneInitial.fitBtnVisible, true);

    // Save screenshot of scaled/panned non-owner state with Fit Screen button
    const screenshotsDir = path.join(__dirname, '..', '.claude-images');
    fs.mkdirSync(screenshotsDir, { recursive: true });
    await phonePage.screenshot({
      path: path.join(screenshotsDir, 'iphone16-non-owner-pan.png'),
    });

    // 3. Test explicit "Fit Screen" button click transfers ownership
    await phonePage.click('#fitScreenBtn');
    await phonePage.waitForTimeout(1500);

    const phoneAfterFit = await phonePage.evaluate(() => {
      const fitBtn = document.getElementById('fitScreenBtn');
      return {
        isOwner: window.app?._geometryIsOwner,
        applied: window.app?._geometryApplied,
        presentation: window.app?._geometryPresentation,
        fitBtnVisible: fitBtn ? fitBtn.style.display !== 'none' : false,
      };
    });
    console.log('Phone after Fit Screen:', phoneAfterFit);
    assert.strictEqual(phoneAfterFit.isOwner, true);
    assert(phoneAfterFit.applied.cols <= 50);
    assert.strictEqual(phoneAfterFit.presentation.regime, 'exact');
    assert.strictEqual(phoneAfterFit.fitBtnVisible, false);

    // Save screenshot of claimed iPhone 16 geometry
    await phonePage.screenshot({
      path: path.join(screenshotsDir, 'iphone16-owner-exact.png'),
    });

    // 4. Verify desktop became non-owner presenting phone's geometry
    const desktopAfterPhoneClaim = await desktopPage.evaluate(() => {
      const fitBtn = document.getElementById('fitScreenBtn');
      return {
        isOwner: window.app?._geometryIsOwner,
        applied: window.app?._geometryApplied,
        presentation: window.app?._geometryPresentation,
        fitBtnVisible: fitBtn ? fitBtn.style.display !== 'none' : false,
      };
    });
    console.log('Desktop after phone claim:', desktopAfterPhoneClaim);
    assert.strictEqual(desktopAfterPhoneClaim.isOwner, false);

    // 5. Test desktop typing re-claims ownership via deliberate input claim
    await desktopPage.click('#terminal');
    await desktopPage.keyboard.type('echo desktop\n');
    await desktopPage.waitForTimeout(1500);

    const desktopAfterTyping = await desktopPage.evaluate(() => {
      return {
        isOwner: window.app?._geometryIsOwner,
        applied: window.app?._geometryApplied,
        presentation: window.app?._geometryPresentation,
      };
    });
    console.log('Desktop after typing claim:', desktopAfterTyping);
    assert.strictEqual(desktopAfterTyping.isOwner, true);
    assert(desktopAfterTyping.applied.cols > 100);

    // 6. Test phone typing re-claims ownership via onData deliberate input claim
    await phonePage.click('#terminal');
    await phonePage.keyboard.type('ls\n');
    await phonePage.waitForTimeout(1500);

    const phoneAfterTyping = await phonePage.evaluate(() => {
      return {
        isOwner: window.app?._geometryIsOwner,
        applied: window.app?._geometryApplied,
        presentation: window.app?._geometryPresentation,
      };
    });
    console.log('Phone after typing claim:', phoneAfterTyping);
    assert.strictEqual(phoneAfterTyping.isOwner, true);
    assert(phoneAfterTyping.applied.cols <= 50);
    assert.strictEqual(phoneAfterTyping.presentation.regime, 'exact');

    await desktopContext.close();
    await phoneContext.close();
  });
});
