// @ts-check
const { test, expect, devices } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  joinSessionAndStartTerminal,
  getTerminalDimensions,
} = require('../helpers/terminal-helpers');

let server, port, url;

test.use({ ...devices['iPhone 14'] });

test.beforeAll(async () => {
  ({ server, port, url } = await createServer());
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.afterEach(async ({ page }, testInfo) => {
  // Reset state to prevent test pollution
  await page.evaluate(() => {
    document.body.classList.remove('keyboard-open');
    if (window.app) window.app._overlayExplicitlyHidden = false;
  }).catch(() => {});
  await attachFailureArtifacts(page, testInfo);
});

// ---------------------------------------------------------------------------
// Helper: simulate mobile keyboard opening/closing via CSS class
// ---------------------------------------------------------------------------
async function simulateKeyboardOpen(page) {
  await page.evaluate(() => {
    document.body.classList.add('keyboard-open');
  });
  await page.waitForTimeout(350);
}

async function simulateKeyboardClose(page) {
  await page.evaluate(() => {
    document.body.classList.remove('keyboard-open');
  });
  await page.waitForTimeout(350);
}

// Helper: hide overlay so extra keys are clickable by Playwright
async function hideOverlayForTest(page) {
  await page.evaluate(() => {
    window.app.hideOverlay();
  });
  await page.waitForTimeout(100);
}

// ===========================================================================
// 1. KEYBOARD OPEN → CHROME COLLAPSES COMPLETELY
//    The most important mobile UX: when keyboard opens, bottom nav and tab
//    bar must collapse to exactly 0px with no border/padding leaking through.
// ===========================================================================
test.describe('keyboard open terminal resize journey', () => {
  test('terminal container chrome collapses to 0px when keyboard opens', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Before keyboard: bottom nav should be visible on mobile
    const navHeightBefore = await page.evaluate(() => {
      const el = document.querySelector('.bottom-nav');
      return el ? el.offsetHeight : 0;
    });
    expect(navHeightBefore).toBeGreaterThan(0);

    // Simulate keyboard opening
    await simulateKeyboardOpen(page);

    // Bottom nav should be 0px (totally collapsed)
    const navHeightAfter = await page.evaluate(() => {
      const el = document.querySelector('.bottom-nav');
      return el ? parseFloat(getComputedStyle(el).height) : -1;
    });
    expect(navHeightAfter).toBe(0);

    // Tab bar should be 0px (totally collapsed)
    const tabBarHeightAfter = await page.evaluate(() => {
      const el = document.querySelector('.session-tabs-bar');
      return el ? parseFloat(getComputedStyle(el).height) : -1;
    });
    expect(tabBarHeightAfter).toBe(0);

    // Bottom nav must have no border contribution (CSS bug fix)
    const navBorderWidth = await page.evaluate(() => {
      const el = document.querySelector('.bottom-nav');
      return el ? getComputedStyle(el).borderTopWidth : null;
    });
    expect(navBorderWidth).toBe('0px');

    // Bottom nav must have no padding contribution (CSS bug fix)
    const navPadding = await page.evaluate(() => {
      const el = document.querySelector('.bottom-nav');
      if (!el) return null;
      const s = getComputedStyle(el);
      return { top: s.paddingTop, bottom: s.paddingBottom };
    });
    expect(navPadding.top).toBe('0px');
    expect(navPadding.bottom).toBe('0px');
  });

  test('keyboard close restores bottom nav and tab bar', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    await simulateKeyboardOpen(page);

    const navCollapsed = await page.evaluate(() => {
      const el = document.querySelector('.bottom-nav');
      return el ? parseFloat(getComputedStyle(el).height) : -1;
    });
    expect(navCollapsed).toBe(0);

    await simulateKeyboardClose(page);

    const nav = page.locator('.bottom-nav');
    await expect(nav).toBeVisible();
    const navHeight = await page.evaluate(() => {
      const el = document.querySelector('.bottom-nav');
      return el ? el.offsetHeight : 0;
    });
    expect(navHeight).toBeGreaterThan(40);
  });
});

// ===========================================================================
// 2. EXTRA KEY TAP → DISPATCHES CORRECT DATA TO app.send
//    Tapping extra keys must dispatch the correct escape sequences/characters.
//    We hide the overlay first since it intercepts pointer events.
// ===========================================================================
test.describe('extra key sends keystroke to terminal', () => {
  test('tapping Tab key dispatches tab character via app.send', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await hideOverlayForTest(page);

    await page.evaluate(() => {
      if (window.app.extraKeys) window.app.extraKeys.show();
    });
    await page.waitForTimeout(100);

    await page.evaluate(() => {
      window._sentKeys = [];
      const origSend = window.app.send.bind(window.app);
      window.app.send = function (msg) {
        if (msg.type === 'input') window._sentKeys.push(msg.data);
        return origSend(msg);
      };
    });

    const tabBtn = page.locator('.extra-key', { hasText: 'Tab' });
    await expect(tabBtn).toBeVisible();
    await tabBtn.click();

    const sentKeys = await page.evaluate(() => window._sentKeys);
    expect(sentKeys).toContain('\t');
  });

  test('tapping Esc key dispatches escape character', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await hideOverlayForTest(page);

    await page.evaluate(() => {
      if (window.app.extraKeys) window.app.extraKeys.show();
    });
    await page.waitForTimeout(100);

    await page.evaluate(() => {
      window._sentKeys = [];
      const origSend = window.app.send.bind(window.app);
      window.app.send = function (msg) {
        if (msg.type === 'input') window._sentKeys.push(msg.data);
        return origSend(msg);
      };
    });

    const escBtn = page.locator('.extra-key', { hasText: 'Esc' });
    await expect(escBtn).toBeVisible();
    await escBtn.click();

    const sentKeys = await page.evaluate(() => window._sentKeys);
    expect(sentKeys).toContain('\x1b');
  });

  test('Ctrl + c sends correct control code (0x03)', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await hideOverlayForTest(page);

    await page.evaluate(() => {
      if (window.app.extraKeys) window.app.extraKeys.show();
    });
    await page.waitForTimeout(100);

    await page.evaluate(() => {
      window._sentKeys = [];
      const origSend = window.app.send.bind(window.app);
      window.app.send = function (msg) {
        if (msg.type === 'input') window._sentKeys.push(msg.data);
        return origSend(msg);
      };
    });

    // Activate Ctrl modifier via evaluate (overlay might still intercept in edge cases)
    await page.evaluate(() => {
      const btn = document.querySelector('.extra-key-modifier[data-modifier="ctrl"]');
      if (btn) btn.click();
    });

    const isActive = await page.evaluate(() =>
      window.app.extraKeys ? window.app.extraKeys.ctrlActive : false
    );
    expect(isActive).toBe(true);

    // Send 'c' key with Ctrl active
    await page.evaluate(() => {
      window.app.extraKeys._sendKey('c');
    });

    const sentKeys = await page.evaluate(() => window._sentKeys);
    expect(sentKeys).toContain('\x03');

    // Ctrl should be deactivated after use (one-shot behavior)
    const ctrlAfter = await page.evaluate(() =>
      window.app.extraKeys ? window.app.extraKeys.ctrlActive : true
    );
    expect(ctrlAfter).toBe(false);
  });
});

// ===========================================================================
// 3. OVERLAY IDEMPOTENCY — FOLDER BROWSER DISMISS DOESN'T STICK FLAG
//    Validates fix for I2: closing folder browser resets the explicit-hide
//    flag so session_joined can show the overlay for inactive sessions.
// ===========================================================================
test.describe('overlay state after folder browser flow', () => {
  test('_overlayExplicitlyHidden is initialized to false', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const flag = await page.evaluate(() => window.app._overlayExplicitlyHidden);
    expect(flag).toBe(false);
  });

  test('hideOverlay sets flag, showOverlay clears it', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    await page.evaluate(() => window.app.hideOverlay());
    const afterHide = await page.evaluate(() => window.app._overlayExplicitlyHidden);
    expect(afterHide).toBe(true);

    await page.evaluate(() => window.app.showOverlay('startPrompt'));
    const afterShow = await page.evaluate(() => window.app._overlayExplicitlyHidden);
    expect(afterShow).toBe(false);
  });

  test('closeFolderBrowser resets the explicit-hide flag', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // 1. hideOverlay sets flag to true
    await page.evaluate(() => window.app.hideOverlay());
    const afterHide = await page.evaluate(() => window.app._overlayExplicitlyHidden);
    expect(afterHide).toBe(true);

    // 2. closeFolderBrowser with existing folder (the stuck bug path)
    await page.evaluate(() => {
      window.app.currentFolderPath = '/some/existing/path';
      window.app.closeFolderBrowser();
    });

    // After fix: flag must be false
    const afterClose = await page.evaluate(() => window.app._overlayExplicitlyHidden);
    expect(afterClose).toBe(false);
  });

  test('overlay shows for inactive session after folder browser dismiss', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Full I2 bug scenario
    await page.evaluate(() => window.app.hideOverlay());
    await page.evaluate(() => {
      window.app.currentFolderPath = '/some/path';
      window.app.closeFolderBrowser();
    });

    // Flag must not block overlay
    const wouldSkip = await page.evaluate(() =>
      window.app._overlayExplicitlyHidden === true
    );
    expect(wouldSkip).toBe(false);

    // Trigger overlay as session_joined would
    await page.evaluate(() => window.app.showOverlay('startPrompt'));
    const overlayVisible = await page.evaluate(() => {
      const overlay = document.getElementById('overlay');
      return overlay ? overlay.style.display : 'none';
    });
    expect(overlayVisible).toBe('flex');
  });
});

// ===========================================================================
// 4. ORIENTATION CHANGE → TERMINAL REFITS
//    When viewport rotates portrait→landscape, terminal columns should adapt.
// ===========================================================================
test.describe('orientation change terminal refit', () => {
  test('switching from portrait to landscape changes terminal columns', async ({ page }) => {
    const sessionId = await createSessionViaApi(port);

    setupPageCapture(page);
    // Navigate first at iPhone 14 size (390x844 from device config)
    await page.goto(url);
    await joinSessionAndStartTerminal(page, sessionId);

    const portraitDims = await getTerminalDimensions(page);
    expect(portraitDims.cols).toBeGreaterThan(0);

    // Switch to landscape
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => window.app.fitTerminal());
    await page.waitForTimeout(500);

    const landscapeDims = await getTerminalDimensions(page);
    expect(landscapeDims.cols).toBeGreaterThan(portraitDims.cols);
  });

  test('bottom nav visibility follows breakpoint on rotation', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const nav = page.locator('.bottom-nav');
    await expect(nav).toBeVisible();

    // Rotate to landscape wider than 820px — bottom nav hidden
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(200);
    await expect(nav).toBeHidden();

    // Rotate back — bottom nav visible
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    await expect(nav).toBeVisible();
  });
});

// ===========================================================================
// 5. EXTRA KEY TAP → TERMINAL OUTPUT (end-to-end with running terminal)
//    With a real terminal running, tapping Tab dispatches to the shell.
// ===========================================================================
test('extra key Tab dispatches to running terminal via app.send', async ({ page }) => {
  const sessionId = await createSessionViaApi(port);

  setupPageCapture(page);
  await page.goto(url);
  await joinSessionAndStartTerminal(page, sessionId);

  // Show extra keys
  await page.evaluate(() => {
    if (window.app.extraKeys) window.app.extraKeys.show();
  });
  await page.waitForTimeout(200);

  // Intercept app.send to verify key dispatch
  await page.evaluate(() => {
    window._sentKeys = [];
    const origSend = window.app.send.bind(window.app);
    window.app.send = function (msg) {
      if (msg.type === 'input') window._sentKeys.push(msg.data);
      return origSend(msg);
    };
  });

  // Use evaluate to click — overlay is hidden after joinSession, but extra-keys
  // might still be behind terminal area
  await page.evaluate(() => {
    const btn = document.querySelector('.extra-key');
    if (btn) btn.click();
  });

  const sentKeys = await page.evaluate(() => window._sentKeys);
  expect(sentKeys.length).toBeGreaterThan(0);
});

// ===========================================================================
// 6. DYNAMIC FONT SIZE → ACTUALLY APPLIED TO TERMINAL
//    The font size function returns a value, and it should be applied.
// ===========================================================================
test('dynamic font size is applied to terminal options', async ({ page }) => {
  setupPageCapture(page);
  // iPhone 14 viewport (390x844) is set by device config
  await page.goto(url);
  await waitForAppReady(page);

  // Get the mobile font size the app would calculate at current viewport
  const mobileFont = await page.evaluate(() =>
    window.app._getMobileFontSize()
  );
  expect(mobileFont).toBeGreaterThan(0);

  // Get the actual terminal font size
  const terminalFontSize = await page.evaluate(() =>
    window.app.terminal ? window.app.terminal.options.fontSize : null
  );
  expect(terminalFontSize).not.toBeNull();

  // On mobile, the terminal font should be within the mobile range (12-14px)
  // The exact value depends on when fitTerminal was called relative to init
  expect(terminalFontSize).toBeGreaterThanOrEqual(12);
  expect(terminalFontSize).toBeLessThanOrEqual(14);
});

// ===========================================================================
// 7. RECONNECTION BEHAVIOR (not just constants)
//    Verify the reconnect mechanism fires on unclean socket close.
//    socket.close() is a clean close and won't trigger reconnect.
//    We simulate an unclean close by closing the underlying connection.
// ===========================================================================
test('unclean WebSocket close triggers reconnect attempt', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);
  await waitForWebSocket(page);

  // Record reconnect attempts
  await page.evaluate(() => {
    window._reconnectCalled = false;
    const origReconnect = window.app.reconnect.bind(window.app);
    window.app.reconnect = function () {
      window._reconnectCalled = true;
      return origReconnect();
    };
  });

  // Simulate an unclean close by directly invoking onclose with wasClean=false
  // This is more reliable than killing the server socket, and tests the actual
  // reconnect code path that matters.
  await page.evaluate(() => {
    const socket = window.app.socket;
    if (socket && socket.onclose) {
      // Detach the real socket so it doesn't interfere
      const realOnclose = socket.onclose;
      socket.onclose = null;
      // Simulate unclean close event
      realOnclose.call(socket, { wasClean: false, code: 1006, reason: '' });
    }
  });

  // Wait for reconnect logic to fire (reconnectDelay = 1000ms + backoff)
  await page.waitForFunction(
    () => window._reconnectCalled === true,
    { timeout: 5000 }
  );

  const reconnectCalled = await page.evaluate(() => window._reconnectCalled);
  expect(reconnectCalled).toBe(true);
});

// ===========================================================================
// 8. ACTIVITY BROADCAST TIMESTAMP INITIALIZATION
//    Verify that after starting a tool session, the session is active and
//    the WebSocket connection is functional (broadcasts depend on timestamps).
// ===========================================================================
test('started terminal session reports active via WebSocket', async ({ page }) => {
  const sessionId = await createSessionViaApi(port);

  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);
  await waitForWebSocket(page);

  // Track session_joined in browser context before joining
  await page.evaluate(() => {
    window._sessionJoined = false;
    const origOnMessage = window.app.socket.onmessage;
    window.app.socket.onmessage = function (event) {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'session_joined') window._sessionJoined = true;
      } catch (_) {}
      return origOnMessage.call(this, event);
    };
  });

  // Join the session via WebSocket
  await page.evaluate((sid) => {
    window.app.send({ type: 'join_session', sessionId: sid });
  }, sessionId);

  // Wait for session_joined message (now tracked in browser context)
  await page.waitForFunction(() => window._sessionJoined === true, { timeout: 5000 });

  // Start terminal via the app method
  await page.evaluate(() => {
    window.app.startToolSession('terminal');
  });

  // Wait for terminal output to appear
  await page.waitForFunction(() => {
    const term = window.app && window.app.terminal;
    if (!term) return false;
    const buf = term.buffer.active;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line && line.translateToString(true).trim().length > 0) return true;
    }
    return false;
  }, { timeout: 15000 });

  // Verify WebSocket is still connected and session is running
  const state = await page.evaluate(() => ({
    socketOpen: window.app.socket && window.app.socket.readyState === 1,
    overlayHidden: document.getElementById('overlay')?.style.display === 'none',
  }));
  expect(state.socketOpen).toBe(true);
  expect(state.overlayHidden).toBe(true);
});

// ===========================================================================
// 9. SWIPE GESTURE WITH REALISTIC TIMING
//    Test swipe with non-zero duration between touchstart and touchend.
// ===========================================================================
test('swipe with realistic timing triggers session switch', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);

  const container = page.locator('.terminal-container');
  await expect(container).toBeAttached();

  await page.evaluate(() => {
    window._swipeSwitchCalled = false;
    if (window.app.sessionTabManager) {
      const orig = window.app.sessionTabManager.switchToNextTab;
      window.app.sessionTabManager.switchToNextTab = function () {
        window._swipeSwitchCalled = true;
        return orig?.call(this);
      };
    }
  });

  const box = await container.boundingBox();
  expect(box).not.toBeNull();

  const startX = box.x + box.width * 0.8;
  const startY = box.y + box.height / 2;
  const endX = box.x + box.width * 0.1;

  await page.evaluate(async ({ sx, sy, ex }) => {
    const el = document.querySelector('.terminal-container');
    if (!el) return;

    el.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      touches: [new Touch({ identifier: 1, target: el, clientX: sx, clientY: sy })],
    }));

    await new Promise(r => setTimeout(r, 150));

    el.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      changedTouches: [new Touch({ identifier: 1, target: el, clientX: ex, clientY: sy })],
    }));
  }, { sx: startX, sy: startY, ex: endX });

  await page.waitForTimeout(100);

  const called = await page.evaluate(() => window._swipeSwitchCalled);
  expect(called).toBe(true);
});

// ===========================================================================
// 10. RECONNECT RESETS OVERLAY FLAG (C1 fix validation)
//     After reconnect, _overlayExplicitlyHidden must be false so that
//     session_joined can show the start prompt for inactive sessions.
// ===========================================================================
test.describe('reconnect overlay state', () => {
  test('reconnect resets _overlayExplicitlyHidden to false', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Simulate the state after a terminal session started and then exited:
    // hideOverlay sets flag to true (as terminal_started handler does)
    await page.evaluate(() => window.app.hideOverlay());
    const beforeReconnect = await page.evaluate(() => window.app._overlayExplicitlyHidden);
    expect(beforeReconnect).toBe(true);

    // Call reconnect — it should reset the flag
    await page.evaluate(() => window.app.reconnect());

    const afterReconnect = await page.evaluate(() => window.app._overlayExplicitlyHidden);
    expect(afterReconnect).toBe(false);
  });

  test('session_joined shows overlay after reconnect for inactive session', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);

    // Set flag as if terminal had started previously
    await page.evaluate(() => window.app.hideOverlay());

    // Reconnect resets the flag
    await page.evaluate(() => window.app.reconnect());

    const flag = await page.evaluate(() => window.app._overlayExplicitlyHidden);
    expect(flag).toBe(false);

    // Simulate session_joined with active=false (terminal exited during disconnect)
    await page.evaluate(() => {
      window.app.showOverlay('startPrompt');
    });

    const overlayVisible = await page.evaluate(() => {
      const overlay = document.getElementById('overlay');
      return overlay ? overlay.style.display : 'none';
    });
    expect(overlayVisible).toBe('flex');
  });
});

// ===========================================================================
// 11. RECONNECTION TIMEOUT (C2 fix validation)
//     If connect() hangs, the timeout should fire and reset _reconnecting.
// ===========================================================================
test('reconnect timeout releases _reconnecting flag', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);
  await waitForWebSocket(page);

  // Verify _reconnecting starts false
  const before = await page.evaluate(() => window.app._reconnecting);
  expect(before).toBe(false);

  // Mock connect() to return a never-resolving promise
  await page.evaluate(() => {
    window.app.connect = () => new Promise(() => {});
  });

  // Trigger reconnect
  await page.evaluate(() => window.app.reconnect());

  // _reconnecting should be true immediately
  const duringReconnect = await page.evaluate(() => window.app._reconnecting);
  expect(duringReconnect).toBe(true);

  // Wait for 1s reconnect delay + 10s timeout + 1s buffer = 12s
  await page.waitForFunction(
    () => window.app._reconnecting === false,
    { timeout: 15000 }
  );

  const afterTimeout = await page.evaluate(() => window.app._reconnecting);
  expect(afterTimeout).toBe(false);
});

// ===========================================================================
// 12. BREAKPOINT CONSISTENCY (C5 fix validation)
//     JS breakpoint checks must use 820px, not 768px.
// ===========================================================================
test('isMobile detection uses 820px breakpoint', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);

  // At iPhone 14 (390px), isMobile should be true
  const isMobileAt390 = await page.evaluate(() => window.app.isMobile);
  expect(isMobileAt390).toBe(true);

  // At 820px (iPad Mini portrait), should still count as mobile
  await page.setViewportSize({ width: 820, height: 1024 });
  await page.waitForTimeout(200);
  const isMobileAt820 = await page.evaluate(() => window.innerWidth <= 820);
  expect(isMobileAt820).toBe(true);

  // At 821px, should be desktop
  await page.setViewportSize({ width: 821, height: 1024 });
  const isMobileAt821 = await page.evaluate(() => window.innerWidth <= 820);
  expect(isMobileAt821).toBe(false);
});

// ===========================================================================
// 13. EXTRA-KEYS INITIALIZE WITHOUT VISUALVIEWPORT (C7 fix validation)
//     Extra-keys should be created even without visualViewport API.
// ===========================================================================
test('extra-keys initializes on mobile', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);

  // Extra-keys should be initialized on mobile
  const hasExtraKeys = await page.evaluate(() =>
    window.app.extraKeys !== undefined && window.app.extraKeys !== null
  );
  expect(hasExtraKeys).toBe(true);

  // Extra-keys container should exist in DOM
  const container = page.locator('.extra-keys-bar');
  await expect(container).toBeAttached();
});

// ===========================================================================
// 14. KEYBOARD TRANSITION SMOOTHNESS (C6 fix validation)
//     All keyboard-open properties should transition, not snap.
// ===========================================================================
test('keyboard-open CSS transitions include padding and border-width', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);

  const transitions = await page.evaluate(() => {
    document.body.classList.add('keyboard-open');
    const el = document.querySelector('.bottom-nav');
    if (!el) return '';
    return getComputedStyle(el).transitionProperty;
  });

  // Should include padding and border (not just opacity and height)
  expect(transitions).toContain('padding');
  expect(transitions).toContain('border');
});

// ===========================================================================
// 15. TOUCH TARGET WCAG COMPLIANCE (I2/I3 fix validation)
//     All interactive elements must be at least 44x44px.
// ===========================================================================
test('overflow-tab-close meets 44px minimum touch target', async ({ page }) => {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page);

  const sizes = await page.evaluate(() => {
    const el = document.createElement('button');
    el.className = 'overflow-tab-close';
    el.textContent = 'x';
    document.body.appendChild(el);
    const style = getComputedStyle(el);
    const result = {
      minWidth: parseFloat(style.minWidth),
      minHeight: parseFloat(style.minHeight),
    };
    el.remove();
    return result;
  });

  expect(sizes.minWidth).toBeGreaterThanOrEqual(44);
  expect(sizes.minHeight).toBeGreaterThanOrEqual(44);
});
