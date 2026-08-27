// @ts-check

// Wide touch copy regression. Split view is width-gated, so this project uses
// touch input at a viewport wide enough for two panes.
// The copy actions themselves are always driven through real locator taps; the
// page evaluates below are limited to clipboard setup and state inspection.
// The split setup also uses the production tab-drag gesture, matching a user's
// route to split view rather than invoking a private copy helper.
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  waitForTerminalCanvas,
} = require('../helpers/terminal-helpers');

// The dedicated project also sets this, but keep the test contract explicit if
// the spec is run with an ad-hoc Playwright project.
test.use({ serviceWorkers: 'block', permissions: [] });

test.describe('wide touch active-pane copy', () => {
  let server;
  let port;
  let url;
  const secondaryPages = new Set();
  const activeSessionIds = new Set();

  // Each test owns a fresh server so mobile tab overflow from a prior test
  // cannot hide the next test's newly created sessions.
  test.beforeEach(async () => {
    ({ server, port, url } = await createServer());
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
    for (const otherPage of secondaryPages) {
      await otherPage.close().catch(() => {});
    }
    secondaryPages.clear();
    for (const sessionId of activeSessionIds) {
      await server.stopToolSession(sessionId).catch(() => {});
    }
    activeSessionIds.clear();
    if (server) {
      await server.close();
      server = null;
    }
  });

  test.afterAll(async () => {
    if (server) await server.close();
  });

  async function openSession(page, sessionId) {
    setupPageCapture(page);
    await page.goto(url);
    await waitForAppReady(page, 20000);
    await waitForWebSocket(page, 15000);
    await waitForTerminalCanvas(page, 20000);

    const tab = page.locator(`#session-tab-${sessionId}`);
    await expect(tab).toBeVisible({ timeout: 10000 });
    await tab.tap();
    await page.waitForFunction(
      (sid) => window.app && window.app.currentClaudeSessionId === sid,
      sessionId,
      { timeout: 15000 }
    );

    const card = page.locator('#toolCards .tool-card[data-tool="terminal"]');
    await expect(card).toBeVisible({ timeout: 10000 });
    const start = (page._wsMessages || []).length;
    await card.tap();
    await expect.poll(() => (page._wsMessages || []).slice(start).find((message) =>
      message.dir === 'sent' && message.type === 'start_terminal'
    ) || null, { timeout: 10000 }).toBeTruthy();
    await expect.poll(() => (page._wsMessages || []).slice(start).find((message) =>
      message.dir === 'recv' && message.type === 'terminal_started'
        && message.sessionId === sessionId
    ) || null, { timeout: 15000 }).toBeTruthy();
    await page.waitForFunction(() => {
      const overlay = document.getElementById('overlay');
      return !overlay || overlay.style.display === 'none';
    }, { timeout: 30000 });
    activeSessionIds.add(sessionId);
  }

  async function waitForMarker(page, marker, splitIndex = null) {
    await page.waitForFunction(({ value, index }) => {
      const app = window.app;
      const terminal = index == null
        ? app && app.terminal
        : app && app.splitContainer && app.splitContainer.splits
          && app.splitContainer.splits[index]
          && app.splitContainer.splits[index].terminal;
      if (!terminal || !terminal.buffer || !terminal.buffer.active) return false;
      const buffer = terminal.buffer.active;
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line && line.translateToString(true).includes(value)) return true;
      }
      return false;
    }, { value: marker, index: splitIndex }, { timeout: 15000 });
  }

  async function writeMarker(page, marker, splitIndex = null) {
    const terminal = splitIndex == null
      ? page.locator('#terminal .xterm-screen')
      : page.locator(`.split-pane[data-split-index="${splitIndex}"] .xterm-screen`);
    await expect(terminal).toBeVisible({ timeout: 10000 });
    await terminal.tap();
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press('Enter');
    await waitForMarker(page, marker, splitIndex);
  }

  async function rightSplitIndex(page, sessionId) {
    return page.evaluate((sid) => {
      const splits = window.app && window.app.splitContainer
        && window.app.splitContainer.splits;
      return Array.isArray(splits)
        ? splits.findIndex((split) => split && split.sessionId === sid)
        : -1;
    }, sessionId);
  }

  async function createWideSplit(page, rightSessionId) {
    const width = await page.evaluate(() => window.innerWidth);
    expect(width, 'the touch project must retain a split-capable width').toBeGreaterThanOrEqual(700);

    // Drive the production tab-drag route to split view. The copy controls are
    // activated separately through real locator taps below.
    const tab = page.locator(`#session-tab-${rightSessionId}`);
    const target = page.locator('#terminalContainer');
    await expect(tab).toBeVisible({ timeout: 10000 });
    await expect(target).toBeVisible({ timeout: 10000 });
    const box = await target.boundingBox();
    expect(box).toBeTruthy();
    await tab.dragTo(target, {
      targetPosition: { x: Math.max(1, box.width - 12), y: box.height / 2 },
    });

    await page.waitForFunction((sid) => {
      const splitContainer = window.app && window.app.splitContainer;
      return !!(splitContainer && splitContainer.enabled
        && Array.isArray(splitContainer.splits)
        && splitContainer.splits.some((split) => split && split.sessionId === sid
          && split.terminal && split.socket && split.socket.readyState === WebSocket.OPEN));
    }, rightSessionId, { timeout: 20000 });

    const splitIndex = await rightSplitIndex(page, rightSessionId);
    expect(splitIndex).toBeGreaterThanOrEqual(0);
    const splitPane = page.locator(`.split-pane[data-split-index="${splitIndex}"]`);
    await expect(splitPane).toBeVisible({ timeout: 10000 });
    // A real touch on the pane establishes the active copy target after the
    // production split has connected. No copy helper or synthetic click runs.
    await splitPane.tap();
    await page.waitForFunction((index) => {
      const splitContainer = window.app && window.app.splitContainer;
      return !!(splitContainer && splitContainer.activeSplitIndex === index);
    }, splitIndex, { timeout: 10000 });
  }

  async function installClipboard(page) {
    await page.evaluate(() => {
      const state = { attempts: 0, completed: 0, text: null, error: null };
      const writeText = (text) => new Promise((resolve, reject) => {
        state.attempts += 1;
        if (typeof text !== 'string') {
          state.error = `clipboard.writeText expects a string, got ${typeof text}`;
          reject(new TypeError(state.error));
          return;
        }
        setTimeout(() => {
          state.text = text;
          state.completed += 1;
          resolve();
        }, 0);
      });

      let installed = false;
      let installError = null;
      try {
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText },
          configurable: true,
        });
        installed = !!(navigator.clipboard && navigator.clipboard.writeText === writeText);
      } catch (error) {
        installError = error;
      }
      if (!installed && navigator.clipboard) {
        try {
          Object.defineProperty(navigator.clipboard, 'writeText', {
            value: writeText,
            configurable: true,
          });
          installed = navigator.clipboard.writeText === writeText;
        } catch (error) {
          installError = error;
        }
      }
      if (!installed) {
        throw new Error(`Unable to install clipboard stub: ${installError ? installError.message : 'unknown error'}`);
      }
      window.__wideTouchClipboard = state;
    });
  }

  async function paneGeometry(page) {
    return page.evaluate(() => {
      const app = window.app;
      const splitContainer = app && app.splitContainer;
      return {
        main: app && app.terminal
          ? { cols: app.terminal.cols, rows: app.terminal.rows }
          : null,
        splits: splitContainer && Array.isArray(splitContainer.splits)
          ? splitContainer.splits.map((split) => split && split.terminal
            ? { cols: split.terminal.cols, rows: split.terminal.rows }
            : null)
          : null,
      };
    });
  }

  async function copyState(page) {
    return page.evaluate(() => {
      const active = document.activeElement;
      return {
        clipboard: window.__wideTouchClipboard
          ? {
            attempts: window.__wideTouchClipboard.attempts,
            completed: window.__wideTouchClipboard.completed,
            text: window.__wideTouchClipboard.text,
            error: window.__wideTouchClipboard.error,
          }
          : null,
        keyboardOpen: document.body.classList.contains('keyboard-open'),
        inKeyboardTransition: !!(window.app && window.app._inKeyboardTransition),
        terminalHeight: document.getElementById('terminal')?.style.height || '',
        activeSplitIndex: window.app && window.app.splitContainer
          ? window.app.splitContainer.activeSplitIndex
          : null,
        focusedXterm: !!(active && (active.classList.contains('xterm-helper-textarea')
          || active.closest('.xterm'))),
        focusDescription: active
          ? (active.id || active.className || active.tagName)
          : null,
      };
    });
  }

  async function prepareSplit(page, mainSessionId, rightSessionId) {
    await openSession(page, mainSessionId);
    await writeMarker(page, `WIDE_TOUCH_MAIN_${mainSessionId.slice(0, 8)}`);

    const otherPage = await page.context().newPage();
    secondaryPages.add(otherPage);
    await openSession(otherPage, rightSessionId);

    // The secondary page starts the right session only. Return the primary page
    // to its left session through the visible tab control before creating split.
    const mainTab = page.locator(`#session-tab-${mainSessionId}`);
    await expect(mainTab).toBeVisible({ timeout: 10000 });
    await mainTab.tap();
    await page.waitForFunction((sid) => window.app
      && window.app.currentClaudeSessionId === sid, mainSessionId, { timeout: 10000 });
    await createWideSplit(page, rightSessionId);
    const mainMarker = `WIDE_TOUCH_MAIN_${mainSessionId.slice(0, 8)}`;
    const rightMarker = `WIDE_TOUCH_RIGHT_${rightSessionId.slice(0, 8)}`;
    const rightIndex = await rightSplitIndex(page, rightSessionId);
    expect(rightIndex).toBeGreaterThanOrEqual(0);
    await writeMarker(page, rightMarker, rightIndex);
    await page.waitForFunction((index) => {
      const splitContainer = window.app && window.app.splitContainer;
      return !!(splitContainer && splitContainer.activeSplitIndex === index);
    }, rightIndex, { timeout: 10000 });

    const source = await page.evaluate((index) => {
      const app = window.app;
      const read = (terminal) => {
        if (!terminal || !terminal.buffer || !terminal.buffer.active) return '';
        const buffer = terminal.buffer.active;
        const lines = [];
        for (let i = 0; i < buffer.length; i++) {
          const line = buffer.getLine(i);
          if (line) lines.push(line.translateToString(true));
        }
        return lines.join('\n');
      };
      return {
        main: read(app && app.terminal),
        right: read(app && app.splitContainer && app.splitContainer.splits[index]
          && app.splitContainer.splits[index].terminal),
      };
    }, rightIndex);
    expect(source.main).toContain(mainMarker);
    expect(source.right).toContain(rightMarker);
    expect(source.right).not.toContain(mainMarker);

    return { mainMarker, rightMarker };
  }

  // A layout viewport resize can expose the extra-key bar before the delayed
  // visualViewport resize has reached ViewportRegime. Wait for the intended
  // keyboard-open state, the production bar class, and an unchanged viewport /
  // layout sample for 400ms while the transition flag is clear. A one-shot
  // `!_inKeyboardTransition` check can observe the pre-resize false value and
  // race the later production callback on a busy CI runner.
  async function waitForKeyboardSettled(page) {
    await page.waitForFunction(() => {
      const app = window.app;
      const bar = document.querySelector('.extra-keys-bar');
      const viewport = window.visualViewport;
      const terminal = document.getElementById('terminal');
      const state = {
        keyboardOpen: document.body.classList.contains('keyboard-open'),
        barVisible: !!(bar && bar.classList.contains('visible')),
        inKeyboardTransition: !!(app && app._inKeyboardTransition),
        viewportHeight: viewport ? viewport.height : null,
        viewportWidth: viewport ? viewport.width : null,
        terminalHeight: terminal ? terminal.style.height : '',
      };
      const sample = JSON.stringify(state);
      const previous = window.__wideTouchKeyboardSettle;
      if (!previous || previous.sample !== sample || state.inKeyboardTransition
          || !state.keyboardOpen || !state.barVisible) {
        window.__wideTouchKeyboardSettle = { sample, settledAt: 0 };
        return false;
      }
      const settledAt = previous.settledAt || performance.now();
      window.__wideTouchKeyboardSettle = { sample, settledAt };
      return performance.now() - settledAt >= 400;
    }, { timeout: 10000 });
  }

  test('keys-panel Copy screen follows the active right split', async ({ page }) => {
    const mainSessionId = await createSessionViaApi(port, 'wide-touch-keys-main');
    const rightSessionId = await createSessionViaApi(port, 'wide-touch-keys-right');
    const { mainMarker, rightMarker } = await prepareSplit(page, mainSessionId, rightSessionId);
    await installClipboard(page);

    const beforeGeometry = await paneGeometry(page);
    const launcher = page.locator('#keysPanelBtn');
    await expect(launcher).toBeVisible({ timeout: 10000 });
    await launcher.tap();
    await expect(page.locator('#keysPanel')).toHaveClass(/keys-panel--open/);

    const copyButton = page.locator('.keys-panel__util-btn');
    await expect(copyButton).toBeVisible();
    const beforeCopy = await copyState(page);
    await copyButton.tap();
    await expect.poll(() => page.evaluate(() => window.__wideTouchClipboard), {
      timeout: 5000,
    }).toMatchObject({ attempts: 1, completed: 1, error: null });

    const after = await copyState(page);
    expect(after.clipboard.text).toContain(rightMarker);
    expect(after.clipboard.text).not.toContain(mainMarker);
    expect(after.clipboard.text).not.toContain('\x1b');
    expect(after.activeSplitIndex).toBe(1);
    expect(after.focusedXterm).toBe(beforeCopy.focusedXterm);
    expect(after.keyboardOpen).toBe(beforeCopy.keyboardOpen);
    expect(after.inKeyboardTransition).toBe(false);
    expect(after.terminalHeight).toBe(beforeCopy.terminalHeight);
    expect(await paneGeometry(page)).toEqual(beforeGeometry);
  });

  test('extra-keys Cp follows the active right split', async ({ page }) => {
    const mainSessionId = await createSessionViaApi(port, 'wide-touch-extra-main');
    const rightSessionId = await createSessionViaApi(port, 'wide-touch-extra-right');
    const { mainMarker, rightMarker } = await prepareSplit(page, mainSessionId, rightSessionId);
    await installClipboard(page);

    // A real viewport resize drives the production visualViewport keyboard
    // controller in headless Chromium. It shows the extra-key bar without
    // calling its helper or mutating style/display from the test.
    // Keep the split-capable width unchanged while shrinking height. Changing
    // width here would look like rotation to ViewportRegime and reset its
    // keyboard baseline instead of entering Compose mode.
    await page.setViewportSize({ width: 800, height: 400 });
    const bar = page.locator('.extra-keys-bar');
    await expect(bar).toBeVisible({ timeout: 10000 });
    await waitForKeyboardSettled(page);
    const beforeGeometry = await paneGeometry(page);
    const before = await copyState(page);
    const copyButton = bar.locator('button.extra-key-clipboard').filter({ hasText: 'Cp' }).first();
    await expect(copyButton).toBeVisible();
    await expect(copyButton).toBeEnabled();
    await expect(copyButton).toHaveAttribute('aria-label', 'Cp');
    const beforeCopy = await copyState(page);
    await copyButton.tap();
    await expect.poll(() => page.evaluate(() => window.__wideTouchClipboard), {
      timeout: 5000,
    }).toMatchObject({ attempts: 1, completed: 1, error: null });

    const after = await copyState(page);
    expect(after.clipboard.text).toContain(rightMarker);
    expect(after.clipboard.text).not.toContain(mainMarker);
    expect(after.clipboard.text).not.toContain('\x1b');
    expect(after.activeSplitIndex).toBe(1);
    expect(after.focusedXterm).toBe(beforeCopy.focusedXterm);
    expect(after.keyboardOpen).toBe(beforeCopy.keyboardOpen);
    expect(after.inKeyboardTransition).toBe(false);
    expect(after.terminalHeight).toBe(beforeCopy.terminalHeight);
    expect(await paneGeometry(page)).toEqual(beforeGeometry);
  });
});
