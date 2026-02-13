// @ts-check
const { test, expect, devices } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  waitForTerminalCanvas,
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
  await attachFailureArtifacts(page, testInfo);
});

// ---------------------------------------------------------------------------
// P0-1: Install button does not overlap bottom nav
// ---------------------------------------------------------------------------
test.describe('P0-1: Install button vs bottom nav overlap', () => {
  test('install button sits above the bottom nav at iPhone 14 viewport', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // The install button is dynamically created by the PWA beforeinstallprompt
    // handler. In CI there is no real install prompt, so we inject one to
    // validate the CSS positioning.
    await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.className = 'install-btn';
      btn.textContent = 'Install';
      btn.style.display = 'block';
      document.body.appendChild(btn);
    });

    const installBox = await page.evaluate(() => {
      const btn = document.querySelector('.install-btn');
      if (!btn) return null;
      const rect = btn.getBoundingClientRect();
      return { bottom: rect.bottom, top: rect.top };
    });

    const navBox = await page.evaluate(() => {
      const nav = document.querySelector('.bottom-nav');
      if (!nav) return null;
      const rect = nav.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });

    expect(installBox).not.toBeNull();
    expect(navBox).not.toBeNull();

    // Install button bottom must be above or at the bottom nav top
    // (no visual overlap)
    expect(installBox.bottom).toBeLessThanOrEqual(navBox.top + 1); // +1 for rounding
  });

  test('install button CSS bottom offset accounts for bottom nav height', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Inject a mock install button so CSS applies
    await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.className = 'install-btn';
      btn.textContent = 'Install';
      btn.style.display = 'block';
      document.body.appendChild(btn);
    });

    // At mobile viewport (max-width: 820px) the install button CSS sets
    // bottom: calc(52px + 20px + env(safe-area-inset-bottom, 0px))
    // which means the resolved bottom value should be >= 72px (52 + 20)
    const installBottom = await page.evaluate(() => {
      const btn = document.querySelector('.install-btn');
      if (!btn) return '';
      return getComputedStyle(btn).bottom;
    });

    const numericBottom = parseFloat(installBottom);
    expect(numericBottom).toBeGreaterThanOrEqual(72);
  });
});

// ---------------------------------------------------------------------------
// P0-2: Viewport meta tag
// ---------------------------------------------------------------------------
test.describe('P0-2: Viewport meta tag', () => {
  test('viewport meta includes viewport-fit=cover and interactive-widget=resizes-content', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);

    const content = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="viewport"]');
      return meta ? meta.getAttribute('content') : '';
    });

    expect(content).toContain('viewport-fit=cover');
    expect(content).toContain('interactive-widget=resizes-content');
  });

  test('maximum-scale is not 1.0 (WCAG compliance)', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);

    const maxScale = await page.evaluate(() => {
      const meta = document.querySelector('meta[name="viewport"]');
      if (!meta) return null;
      const content = meta.getAttribute('content') || '';
      const match = content.match(/maximum-scale\s*=\s*([\d.]+)/);
      return match ? parseFloat(match[1]) : null;
    });

    // maximum-scale must exist and be > 1.0 to not block user zoom
    expect(maxScale).not.toBeNull();
    expect(maxScale).toBeGreaterThan(1.0);
  });
});

// ---------------------------------------------------------------------------
// P0-9: New session button touch targets
// ---------------------------------------------------------------------------
test.describe('P0-9: New session button touch targets', () => {
  test('tab-new-main and tab-new-dropdown meet 44px minimum via pointer:coarse rule', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Playwright does not emulate pointer:coarse in computed styles, so we
    // verify the CSS rule exists in the stylesheet rather than reading
    // computed style. We check the raw CSS text of the loaded stylesheets.
    const hasCoarseRule = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSMediaRule && rule.conditionText &&
                rule.conditionText.includes('pointer: coarse')) {
              const innerText = rule.cssText;
              if (innerText.includes('tab-new-main') &&
                  innerText.includes('tab-new-dropdown') &&
                  innerText.includes('44px')) {
                return true;
              }
            }
          }
        } catch {
          // Cross-origin stylesheets will throw; skip them
        }
      }
      return false;
    });

    expect(hasCoarseRule).toBe(true);
  });

  test('tab-new-main button exists and is rendered in DOM', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const btnInfo = await page.evaluate(() => {
      const btn = document.querySelector('.tab-new-main');
      if (!btn) return null;
      const rect = btn.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });

    expect(btnInfo).not.toBeNull();
    expect(btnInfo.width).toBeGreaterThan(0);
    expect(btnInfo.height).toBeGreaterThan(0);
  });

  test('tab-new-dropdown button exists and is rendered in DOM', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const btnInfo = await page.evaluate(() => {
      const btn = document.querySelector('.tab-new-dropdown');
      if (!btn) return null;
      const rect = btn.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });

    expect(btnInfo).not.toBeNull();
    expect(btnInfo.width).toBeGreaterThan(0);
    expect(btnInfo.height).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// P0-6: fitTerminal mobile adjustments — columns
// ---------------------------------------------------------------------------
test.describe('P0-6: fitTerminal mobile column adjustment', () => {
  test('terminal columns >= 40 at iPhone 14 (390px) width', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'fit-cols-iphone14');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const dims = await getTerminalDimensions(page);
    // At 390px with no scrollbar subtraction on mobile, expect >= 40 cols
    expect(dims.cols).toBeGreaterThanOrEqual(40);
    // Should still be in mobile range (not desktop-level 80+)
    expect(dims.cols).toBeLessThan(80);
  });

  test('app detects mobile so colAdjust is 0', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Verify the code path: on mobile, isMobile is true so colAdjust = 0
    const isMobile = await page.evaluate(() => window.app.isMobile);
    expect(isMobile).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P0-5: Context menu renders as bottom sheet on mobile
// ---------------------------------------------------------------------------
test.describe('P0-5: Context menu bottom sheet on mobile', () => {
  test('context menu CSS rule applies bottom-sheet layout at max-width 768px', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Verify the mobile media query CSS rule for .term-context-menu
    const hasBottomSheetRule = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSMediaRule && rule.conditionText &&
                rule.conditionText.includes('max-width: 820px')) {
              for (const innerRule of rule.cssRules) {
                if (innerRule.selectorText &&
                    innerRule.selectorText.includes('.term-context-menu')) {
                  const style = innerRule.style;
                  return {
                    position: style.position,
                    bottom: style.bottom,
                    left: style.left,
                    right: style.right,
                    minWidth: style.minWidth,
                  };
                }
              }
            }
          }
        } catch {
          // Cross-origin stylesheets will throw
        }
      }
      return null;
    });

    expect(hasBottomSheetRule).not.toBeNull();
    expect(hasBottomSheetRule.position).toBe('fixed');
    expect(hasBottomSheetRule.bottom).toBe('0px');
    expect(hasBottomSheetRule.left).toBe('0px');
    expect(hasBottomSheetRule.right).toBe('0px');
    expect(hasBottomSheetRule.minWidth).toBe('100%');
  });

  test('context menu element exists in DOM with correct structure', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const menuInfo = await page.evaluate(() => {
      const menu = document.getElementById('termContextMenu');
      if (!menu) return null;
      return {
        exists: true,
        hasClass: menu.classList.contains('term-context-menu'),
        itemCount: menu.querySelectorAll('.ctx-item').length,
      };
    });

    expect(menuInfo).not.toBeNull();
    expect(menuInfo.hasClass).toBe(true);
    expect(menuInfo.itemCount).toBeGreaterThan(0);
  });

  test('triggering contextmenu on mobile shows menu as bottom sheet', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'ctx-menu-mobile');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForWebSocket(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Dispatch a contextmenu event on the terminal area
    await page.evaluate(() => {
      const xtermScreen = document.querySelector('.xterm-screen');
      if (xtermScreen) {
        xtermScreen.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 100,
          clientY: 100,
        }));
      }
    });

    await page.waitForTimeout(300);

    // Verify the context menu became visible
    const menuVisible = await page.evaluate(() => {
      const menu = document.getElementById('termContextMenu');
      if (!menu) return false;
      return menu.style.display === 'block';
    });

    expect(menuVisible).toBe(true);

    // On mobile, the menu should be positioned as a bottom sheet:
    // the CSS media query sets bottom:0, left:0, right:0
    const computedStyles = await page.evaluate(() => {
      const menu = document.getElementById('termContextMenu');
      if (!menu) return null;
      const cs = getComputedStyle(menu);
      return {
        position: cs.position,
        bottom: cs.bottom,
      };
    });

    expect(computedStyles).not.toBeNull();
    expect(computedStyles.position).toBe('fixed');
    // Bottom should resolve to 0px (the media query rule)
    expect(computedStyles.bottom).toBe('0px');
  });
});

// ---------------------------------------------------------------------------
// P0-7: Network reconnection constants
// ---------------------------------------------------------------------------
test.describe('P0-7: Network reconnection constants', () => {
  test('maxReconnectAttempts is 10', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const maxAttempts = await page.evaluate(() => window.app.maxReconnectAttempts);
    expect(maxAttempts).toBe(10);
  });

  test('reconnectDelay is 1000ms', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const delay = await page.evaluate(() => window.app.reconnectDelay);
    expect(delay).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Voice fix: voice input session tracking properties
// ---------------------------------------------------------------------------
test.describe('Voice fix: voice input session tracking', () => {
  test('_deliverVoiceTranscription method exists on app', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const hasMethod = await page.evaluate(() =>
      typeof window.app._deliverVoiceTranscription === 'function'
    );
    expect(hasMethod).toBe(true);
  });

  test('_voiceRecordingSessionId is referenced in the transcription method', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // The property is set dynamically during recording flow. We verify
    // the code path is wired correctly by checking the method source.
    const methodReferencesProperty = await page.evaluate(() => {
      const fn = window.app._deliverVoiceTranscription;
      return fn ? fn.toString().includes('_voiceRecordingSessionId') : false;
    });

    expect(methodReferencesProperty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P0-4: Keyboard detection threshold and _keyboardOpen flag
// ---------------------------------------------------------------------------
test.describe('P0-4: Keyboard detection', () => {
  test('_keyboardOpen property exists after extra keys setup', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // On mobile with visualViewport available, _keyboardOpen should be
    // initialized to false by _setupExtraKeys
    const keyboardState = await page.evaluate(() => {
      if (!window.app.isMobile) return { skip: true };
      return {
        skip: false,
        exists: '_keyboardOpen' in window.app,
        value: window.app._keyboardOpen,
      };
    });

    if (!keyboardState.skip) {
      expect(keyboardState.exists).toBe(true);
      expect(keyboardState.value).toBe(false);
    }
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
});

// ---------------------------------------------------------------------------
// P0-3: text-size-adjust CSS property on body
// ---------------------------------------------------------------------------
test.describe('P0-3: text-size-adjust', () => {
  test('body has text-size-adjust: 100% in stylesheet rules', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    // Check the raw CSS rule since computed style may not report
    // text-size-adjust in all browser engines. We verify the rule exists.
    const cssRulePresent = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.selectorText === 'body' || rule.selectorText === 'html, body') {
              const text = rule.cssText;
              if (text.includes('text-size-adjust: 100%') ||
                  text.includes('-webkit-text-size-adjust: 100%')) {
                return true;
              }
            }
          }
        } catch {
          // Cross-origin stylesheets
        }
      }
      return false;
    });

    expect(cssRulePresent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-device: verify core mobile detection across viewports
// ---------------------------------------------------------------------------
test.describe('Cross-device mobile detection', () => {
  test('app detects mobile correctly at iPhone 14 viewport', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const viewport = page.viewportSize();
    expect(viewport.width).toBeLessThan(500);

    const isMobile = await page.evaluate(() => window.app.isMobile);
    expect(isMobile).toBe(true);
  });

  test('bottom nav is visible at mobile viewport', async ({ page }) => {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page);

    const navVisible = await page.evaluate(() => {
      const nav = document.querySelector('.bottom-nav');
      if (!nav) return false;
      const cs = getComputedStyle(nav);
      return cs.display !== 'none';
    });

    expect(navVisible).toBe(true);
  });
});
