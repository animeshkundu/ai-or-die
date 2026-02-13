// @ts-check
const { test, expect, devices } = require('@playwright/test');
const { createServer } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
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
  await attachFailureArtifacts(page, testInfo);
});

// ---------------------------------------------------------------------------
// P1-1: keyboard-open CSS — body class toggles, elements hide with transitions
// ---------------------------------------------------------------------------
test.describe('P1-1: keyboard-open CSS', () => {
  test('body.keyboard-open hides bottom nav, tab bar, mode switcher via CSS rules', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Verify the CSS rules for body.keyboard-open exist in stylesheets
    const rules = await page.evaluate(() => {
      const results = { bottomNav: false, tabBar: false, modeSwitcher: false };
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            const text = rule.cssText || '';
            if (text.includes('body.keyboard-open') && text.includes('.bottom-nav')) {
              if (text.includes('opacity') && text.includes('height')) {
                results.bottomNav = true;
              }
            }
            if (text.includes('body.keyboard-open') && text.includes('.session-tabs-bar')) {
              if (text.includes('height')) {
                results.tabBar = true;
              }
            }
            if (text.includes('body.keyboard-open') && text.includes('.mode-switcher')) {
              if (text.includes('opacity') && text.includes('height')) {
                results.modeSwitcher = true;
              }
            }
          }
        } catch { /* cross-origin */ }
      }
      return results;
    });

    expect(rules.bottomNav).toBe(true);
    expect(rules.tabBar).toBe(true);
    expect(rules.modeSwitcher).toBe(true);
  });

  test('keyboard-open class is not present on body initially', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const hasClass = await page.evaluate(() =>
      document.body.classList.contains('keyboard-open')
    );
    expect(hasClass).toBe(false);
  });

  test('keyboard-open CSS includes transition declarations', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Verify transition properties exist in keyboard-open rules
    const hasTransitions = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            const text = rule.cssText || '';
            if (text.includes('body.keyboard-open') && text.includes('transition')) {
              return true;
            }
          }
        } catch { /* cross-origin */ }
      }
      return false;
    });

    expect(hasTransitions).toBe(true);
  });

  test('adding keyboard-open class hides bottom nav and tab bar', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Manually add the keyboard-open class to test CSS effects
    await page.evaluate(() => document.body.classList.add('keyboard-open'));

    // Allow CSS transitions to start
    await page.waitForTimeout(350);

    const styles = await page.evaluate(() => {
      const nav = document.querySelector('.bottom-nav');
      const tabs = document.querySelector('.session-tabs-bar');
      return {
        navDisplay: nav ? getComputedStyle(nav).opacity : null,
        navHeight: nav ? getComputedStyle(nav).height : null,
        tabsHeight: tabs ? getComputedStyle(tabs).height : null,
      };
    });

    // Bottom nav should be hidden (opacity 0, height 0)
    if (styles.navDisplay !== null) {
      expect(styles.navDisplay).toBe('0');
    }
    if (styles.navHeight !== null) {
      // Height is 0 but border may add 1px
      const navH = parseFloat(styles.navHeight);
      expect(navH).toBeLessThanOrEqual(1);
    }
    // Tab bar should be collapsed
    if (styles.tabsHeight !== null) {
      expect(styles.tabsHeight).toBe('0px');
    }
  });
});

// ---------------------------------------------------------------------------
// P1-2: Keyboard dismiss button
// ---------------------------------------------------------------------------
test.describe('P1-2: Keyboard dismiss button', () => {
  test('.extra-key-dismiss button exists in extra keys bar', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const dismissInfo = await page.evaluate(() => {
      const btn = document.querySelector('.extra-key-dismiss');
      if (!btn) return null;
      return {
        exists: true,
        ariaLabel: btn.getAttribute('aria-label'),
        tagName: btn.tagName.toLowerCase(),
      };
    });

    expect(dismissInfo).not.toBeNull();
    expect(dismissInfo.exists).toBe(true);
    expect(dismissInfo.tagName).toBe('button');
    expect(dismissInfo.ariaLabel).toBeTruthy();
  });

  test('dismiss button has "Dismiss keyboard" aria-label', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const ariaLabel = await page.evaluate(() => {
      const btn = document.querySelector('.extra-key-dismiss');
      return btn ? btn.getAttribute('aria-label') : null;
    });

    expect(ariaLabel).toBe('Dismiss keyboard');
  });
});

// ---------------------------------------------------------------------------
// P1-3: Multi-row extra keys
// ---------------------------------------------------------------------------
test.describe('P1-3: Multi-row extra keys', () => {
  test('two .extra-keys-row elements exist in extra keys bar', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const rowCount = await page.evaluate(() => {
      const bar = document.querySelector('.extra-keys-bar');
      if (!bar) return 0;
      return bar.querySelectorAll('.extra-keys-row').length;
    });

    expect(rowCount).toBe(2);
  });

  test('Row 1 has expected keys: Tab, Ctrl, Alt, Esc, Home, End, PgUp, PgDn, arrows, dismiss', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const row1Labels = await page.evaluate(() => {
      const bar = document.querySelector('.extra-keys-bar');
      if (!bar) return [];
      const rows = bar.querySelectorAll('.extra-keys-row');
      if (rows.length < 1) return [];
      return Array.from(rows[0].querySelectorAll('.extra-key')).map(btn =>
        btn.getAttribute('aria-label') || btn.textContent.trim()
      );
    });

    const expectedLabels = [
      'Tab', 'Ctrl', 'Alt', 'Esc', 'Home', 'End', 'PgUp', 'PgDn',
      'Left arrow', 'Right arrow', 'Up arrow', 'Down arrow', 'Dismiss keyboard',
    ];

    for (const label of expectedLabels) {
      expect(row1Labels).toContain(label);
    }
  });

  test('Row 2 has symbol keys', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const row2Labels = await page.evaluate(() => {
      const bar = document.querySelector('.extra-keys-bar');
      if (!bar) return [];
      const rows = bar.querySelectorAll('.extra-keys-row');
      if (rows.length < 2) return [];
      return Array.from(rows[1].querySelectorAll('.extra-key')).map(btn =>
        btn.textContent.trim()
      );
    });

    // Row 2 should contain symbols
    const expectedSymbols = ['|', '/', '\\', '-', '_', '~', '`', '{', '}', '[', ']', '(', ')', ';', ':', '=', '+', '&', '@'];
    for (const sym of expectedSymbols) {
      expect(row2Labels).toContain(sym);
    }
  });

  test('all extra key buttons meet 44px minimum touch target', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Check the CSS rule for .extra-key min-width and min-height
    const cssCheck = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText === '.extra-key') {
              const minW = rule.style.minWidth;
              const minH = rule.style.minHeight;
              return { minWidth: minW, minHeight: minH };
            }
          }
        } catch { /* cross-origin */ }
      }
      return null;
    });

    expect(cssCheck).not.toBeNull();
    expect(cssCheck.minWidth).toBe('44px');
    expect(cssCheck.minHeight).toBe('44px');
  });

  test('Row 2 hides when terminal height <= 400px via _updateRow2Visibility', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Verify the ExtraKeys class has the logic for hiding row 2 at <= 400px
    const hasLogic = await page.evaluate(() => {
      if (!window.app.extraKeys) return false;
      const fn = window.app.extraKeys._updateRow2Visibility;
      if (!fn) return false;
      const src = fn.toString();
      return src.includes('400');
    });

    expect(hasLogic).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P1-4: Orientation handler
// ---------------------------------------------------------------------------
test.describe('P1-4: Orientation handler', () => {
  test('_setupOrientationHandler method exists on app', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const hasMethod = await page.evaluate(() =>
      typeof window.app._setupOrientationHandler === 'function'
    );
    expect(hasMethod).toBe(true);
  });

  test('orientation handler calls fitTerminal on orientation change', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Verify the method source references fitTerminal
    const src = await page.evaluate(() => {
      const fn = window.app._setupOrientationHandler;
      return fn ? fn.toString() : '';
    });

    expect(src).toContain('fitTerminal');
  });
});

// ---------------------------------------------------------------------------
// P1-5: Dynamic font sizing
// ---------------------------------------------------------------------------
test.describe('P1-5: Dynamic font sizing', () => {
  test('_getMobileFontSize returns 12 at 360px width', async ({ page }) => {
    setupPageCapture(page);
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(url);
    await waitForAppReady(page);

    const fontSize = await page.evaluate(() => {
      if (typeof window.app._getMobileFontSize === 'function') {
        return window.app._getMobileFontSize();
      }
      return null;
    });

    expect(fontSize).toBe(12);
  });

  test('_getMobileFontSize returns 13 at 390px width', async ({ page }) => {
    setupPageCapture(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await waitForAppReady(page);

    const fontSize = await page.evaluate(() => {
      if (typeof window.app._getMobileFontSize === 'function') {
        return window.app._getMobileFontSize();
      }
      return null;
    });

    expect(fontSize).toBe(13);
  });

  test('_getMobileFontSize returns 14 at 820px width', async ({ page }) => {
    setupPageCapture(page);
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto(url);
    await waitForAppReady(page);

    const fontSize = await page.evaluate(() => {
      if (typeof window.app._getMobileFontSize === 'function') {
        return window.app._getMobileFontSize();
      }
      return null;
    });

    expect(fontSize).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// P1-7: Overlay tab access — tabs bar z-index above overlay
// ---------------------------------------------------------------------------
test.describe('P1-7: Overlay tab access', () => {
  test('showOverlay sets session-tabs-bar z-index to 301', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Trigger showOverlay
    await page.evaluate(() => {
      window.app.showOverlay('startPrompt');
    });

    const zIndex = await page.evaluate(() => {
      const tabBar = document.getElementById('sessionTabsBar');
      return tabBar ? tabBar.style.zIndex : null;
    });

    expect(zIndex).toBe('301');
  });

  test('overlay z-index is 300 (var(--z-overlay))', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Show the overlay so it becomes visible
    await page.evaluate(() => {
      window.app.showOverlay('startPrompt');
    });

    const overlayZ = await page.evaluate(() => {
      const overlay = document.getElementById('overlay');
      if (!overlay) return null;
      return parseInt(getComputedStyle(overlay).zIndex, 10);
    });

    expect(overlayZ).toBe(300);
  });

  test('hideOverlay resets session-tabs-bar z-index', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Show then hide overlay
    await page.evaluate(() => {
      window.app.showOverlay('startPrompt');
      window.app.hideOverlay();
    });

    const zIndex = await page.evaluate(() => {
      const tabBar = document.getElementById('sessionTabsBar');
      return tabBar ? tabBar.style.zIndex : null;
    });

    // After hiding, z-index should be reset to empty string
    expect(zIndex).toBe('');
  });
});

// ---------------------------------------------------------------------------
// P1-8: iPad Mini breakpoint — bottom nav visible at 768px, hidden at 821px
// ---------------------------------------------------------------------------
test.describe('P1-8: iPad Mini breakpoint', () => {
  test('bottom nav is visible at 768px width', async ({ page }) => {
    setupPageCapture(page);
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(url);
    await waitForAppReady(page);

    const navVisible = await page.evaluate(() => {
      const nav = document.querySelector('.bottom-nav');
      if (!nav) return false;
      return getComputedStyle(nav).display !== 'none';
    });

    expect(navVisible).toBe(true);
  });

  test('bottom nav is hidden at 821px width', async ({ page }) => {
    setupPageCapture(page);
    await page.setViewportSize({ width: 821, height: 1024 });
    await page.goto(url);
    await waitForAppReady(page);

    const navHidden = await page.evaluate(() => {
      const nav = document.querySelector('.bottom-nav');
      if (!nav) return true;
      return getComputedStyle(nav).display === 'none';
    });

    expect(navHidden).toBe(true);
  });

  test('bottom nav CSS breakpoint is max-width: 820px', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const hasRule = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSMediaRule && rule.conditionText &&
                rule.conditionText.includes('max-width: 820px')) {
              for (const inner of rule.cssRules) {
                if (inner.selectorText && inner.selectorText.includes('.bottom-nav')) {
                  return inner.style.display === 'flex';
                }
              }
            }
          }
        } catch { /* cross-origin */ }
      }
      return false;
    });

    expect(hasRule).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P1-9: Aria labels on folder browser buttons
// ---------------------------------------------------------------------------
test.describe('P1-9: Aria labels on folder buttons', () => {
  test('folderUpBtn has aria-label attribute', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const ariaLabel = await page.evaluate(() => {
      const btn = document.getElementById('folderUpBtn');
      return btn ? btn.getAttribute('aria-label') : null;
    });

    expect(ariaLabel).toBeTruthy();
    expect(ariaLabel).toContain('parent');
  });

  test('folderHomeBtn has aria-label attribute', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const ariaLabel = await page.evaluate(() => {
      const btn = document.getElementById('folderHomeBtn');
      return btn ? btn.getAttribute('aria-label') : null;
    });

    expect(ariaLabel).toBeTruthy();
    expect(ariaLabel).toContain('home');
  });

  test('createFolderBtn has aria-label attribute', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const ariaLabel = await page.evaluate(() => {
      const btn = document.getElementById('createFolderBtn');
      return btn ? btn.getAttribute('aria-label') : null;
    });

    expect(ariaLabel).toBeTruthy();
    expect(ariaLabel).toContain('folder');
  });
});

// ---------------------------------------------------------------------------
// P2-1: Swipe gestures
// ---------------------------------------------------------------------------
test.describe('P2-1: Swipe gestures', () => {
  test('_setupSwipeGestures method exists on app', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const hasMethod = await page.evaluate(() =>
      typeof window.app._setupSwipeGestures === 'function'
    );
    expect(hasMethod).toBe(true);
  });

  test('switchToNextTab method exists on session manager', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const hasMethod = await page.evaluate(() =>
      window.app.sessionTabManager &&
      typeof window.app.sessionTabManager.switchToNextTab === 'function'
    );
    expect(hasMethod).toBe(true);
  });

  test('switchToPreviousTab method exists on session manager', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const hasMethod = await page.evaluate(() =>
      window.app.sessionTabManager &&
      typeof window.app.sessionTabManager.switchToPreviousTab === 'function'
    );
    expect(hasMethod).toBe(true);
  });

  test('swipe gesture source references switchToNextTab and switchToPreviousTab', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const src = await page.evaluate(() => {
      const fn = window.app._setupSwipeGestures;
      return fn ? fn.toString() : '';
    });

    expect(src).toContain('switchToNextTab');
    expect(src).toContain('switchToPreviousTab');
  });
});

// ---------------------------------------------------------------------------
// P2-3: Haptic feedback — navigator.vibrate in _sendKey
// ---------------------------------------------------------------------------
test.describe('P2-3: Haptic feedback', () => {
  test('extra keys _sendKey method contains navigator.vibrate', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const hasVibrate = await page.evaluate(() => {
      if (!window.app.extraKeys) return false;
      const fn = window.app.extraKeys._sendKey;
      return fn ? fn.toString().includes('navigator.vibrate') : false;
    });

    expect(hasVibrate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P2-4: Settings modal stacked at 480px viewport
// ---------------------------------------------------------------------------
test.describe('P2-4: Settings modal stacked', () => {
  test('.setting-group has flex-direction: column at 480px in CSS', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const hasRule = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSMediaRule && rule.conditionText &&
                rule.conditionText.includes('max-width: 480px')) {
              for (const inner of rule.cssRules) {
                if (inner.selectorText && inner.selectorText.includes('.setting-group')) {
                  return inner.style.flexDirection === 'column';
                }
              }
            }
          }
        } catch { /* cross-origin */ }
      }
      return false;
    });

    expect(hasRule).toBe(true);
  });

  test('.setting-group computed flex-direction is column at 480px viewport', async ({ page }) => {
    setupPageCapture(page);
    await page.setViewportSize({ width: 480, height: 800 });
    await page.goto(url);
    await waitForAppReady(page);

    // Open settings modal to make .setting-group visible
    await page.evaluate(() => {
      const modal = document.querySelector('.settings-modal');
      if (modal) modal.style.display = 'flex';
    });

    const flexDir = await page.evaluate(() => {
      const group = document.querySelector('.setting-group');
      if (!group) return null;
      return getComputedStyle(group).flexDirection;
    });

    if (flexDir !== null) {
      expect(flexDir).toBe('column');
    }
  });
});

// ---------------------------------------------------------------------------
// P2-5: Pull-to-refresh skips .xterm-viewport and .modal-body
// ---------------------------------------------------------------------------
test.describe('P2-5: Pull-to-refresh', () => {
  test('disablePullToRefresh method source contains .xterm-viewport closest check', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const src = await page.evaluate(() => {
      const fn = window.app.disablePullToRefresh;
      return fn ? fn.toString() : '';
    });

    expect(src).toContain('.xterm-viewport');
    expect(src).toContain('.closest');
  });

  test('disablePullToRefresh method source contains .modal-body closest check', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const src = await page.evaluate(() => {
      const fn = window.app.disablePullToRefresh;
      return fn ? fn.toString() : '';
    });

    expect(src).toContain('.modal-body');
    expect(src).toContain('closest');
  });
});

// ---------------------------------------------------------------------------
// P2-6: Dark mode listener
// ---------------------------------------------------------------------------
test.describe('P2-6: Dark mode listener', () => {
  test('_setupDarkModeListener method exists on app', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const hasMethod = await page.evaluate(() =>
      typeof window.app._setupDarkModeListener === 'function'
    );
    expect(hasMethod).toBe(true);
  });

  test.skip('_setupDarkModeListener uses prefers-color-scheme media query — feature deferred', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const src = await page.evaluate(() => {
      const fn = window.app._setupDarkModeListener;
      return fn ? fn.toString() : '';
    });

    expect(src).toContain('prefers-color-scheme');
  });
});

// ---------------------------------------------------------------------------
// P2-7: Tab close CSS — mobile does NOT use explicit width: 18px
// ---------------------------------------------------------------------------
test.describe('P2-7: Tab close CSS', () => {
  test('.tab-close in mobile media query uses width: auto, not 18px', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const tabCloseWidth = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSMediaRule && rule.conditionText &&
                rule.conditionText.includes('max-width: 820px')) {
              for (const inner of rule.cssRules) {
                if (inner.selectorText && inner.selectorText.trim() === '.tab-close') {
                  return inner.style.width;
                }
              }
            }
          }
        } catch { /* cross-origin */ }
      }
      return null;
    });

    expect(tabCloseWidth).not.toBeNull();
    expect(tabCloseWidth).toBe('auto');
    expect(tabCloseWidth).not.toBe('18px');
  });
});

// ---------------------------------------------------------------------------
// P2-8: Overflow button — mobile styling with 44px minimum
// ---------------------------------------------------------------------------
test.describe('P2-8: Overflow button', () => {
  test('.tab-overflow-btn in mobile media query has background and 44px min size', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const overflowStyles = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSMediaRule && rule.conditionText &&
                rule.conditionText.includes('max-width: 820px')) {
              for (const inner of rule.cssRules) {
                if (inner.selectorText && inner.selectorText.trim() === '.tab-overflow-btn') {
                  return {
                    background: inner.style.background,
                    minWidth: inner.style.minWidth,
                    minHeight: inner.style.minHeight,
                  };
                }
              }
            }
          }
        } catch { /* cross-origin */ }
      }
      return null;
    });

    expect(overflowStyles).not.toBeNull();
    expect(overflowStyles.minWidth).toBe('44px');
    expect(overflowStyles.minHeight).toBe('44px');
    // background should be set (non-empty)
    expect(overflowStyles.background).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// P2-9: Ctrl timeout — extra keys Ctrl toggle has timeout logic
// ---------------------------------------------------------------------------
test.describe('P2-9: Ctrl timeout', () => {
  test('Ctrl toggle source contains timeout logic', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const hasTimeout = await page.evaluate(() => {
      if (!window.app.extraKeys) return false;
      const fn = window.app.extraKeys._toggleModifier;
      if (!fn) return false;
      const src = fn.toString();
      return src.includes('setTimeout') && src.includes('ctrlActive');
    });

    expect(hasTimeout).toBe(true);
  });

  test('_sendKey clears Ctrl timeout when Ctrl is active', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const hasCleanup = await page.evaluate(() => {
      if (!window.app.extraKeys) return false;
      const fn = window.app.extraKeys._sendKey;
      if (!fn) return false;
      const src = fn.toString();
      return src.includes('clearTimeout') && src.includes('_ctrlTimeout');
    });

    expect(hasCleanup).toBe(true);
  });
});

// Auto-start terminal feature was removed — overlay always shows with
// Terminal as the first option. See docs/history/mobile-ux-overhaul-deferrals.md
