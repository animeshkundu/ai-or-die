const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const CR = String.fromCharCode(13);

async function joinOnly(page, sessionId) {
  await page.waitForFunction(
    () => window.app && window.app.socket && window.app.socket.readyState === 1
  );
  await page.evaluate((id) => window.app.joinSession(id), sessionId);
  await page.waitForFunction(
    () => window.app && window.app.currentClaudeSessionId,
    null,
    { timeout: 20000 }
  );
}

async function setupTerminal(page, port, url, name) {
  const sessionId = await createSessionViaApi(port, name);
  await page.goto(url);
  await waitForAppReady(page);
  await waitForTerminalCanvas(page);
  await joinSessionAndStartTerminal(page, sessionId);
  await page.waitForFunction(
    () => window.app.fitCoordinator.getState('main').authoritative,
    null,
    { timeout: 20000 }
  );
  return sessionId;
}

async function ptyDims(page, tag) {
  const marker = `E2E_PTY_${tag}_${Date.now()}`;
  const command = process.platform === 'win32'
    ? `Write-Output "${marker}:$([Console]::WindowWidth)x$([Console]::WindowHeight)"`
    : `printf '${marker}:%sx%s\\n' "$(tput cols)" "$(tput lines)"`;
  await page.evaluate(({ command, cr }) => {
    window.app.send({ type: 'input', data: command + cr, claim: false });
  }, { command, cr: CR });
  const value = await page.waitForFunction((expected) => {
    const terminal = window.app && window.app.terminal;
    if (!terminal) return null;
    const buffer = terminal.buffer.active;
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (!line) continue;
      const text = line.translateToString(true);
      const match = text.match(new RegExp(`${expected}:(\\d+)x(\\d+)`));
      if (match && !text.includes('tput cols') && !text.includes('Console]::')) {
        return { cols: Number(match[1]), rows: Number(match[2]) };
      }
    }
    return null;
  }, marker, { timeout: 15000, polling: 50 });
  return value.jsonValue();
}

async function viewGeometry(page) {
  return page.evaluate(() => {
    const state = window.app.fitCoordinator.getState('main');
    return {
      terminal: { cols: window.app.terminal.cols, rows: window.app.terminal.rows },
      local: state.localCapacity,
      authoritative: state.authoritative,
      rendered: state.rendered,
      regime: document.getElementById('terminal').dataset.regime,
    };
  });
}

test.describe('multi-viewer terminal geometry', () => {
  let server;
  let port;
  let url;

  test.beforeAll(async () => {
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close();
  });

  test('keeps every grid authoritative and restores a survivor after owner disconnect', async ({ browser }) => {
    const desktopContext = await browser.newContext({ viewport: DESKTOP });
    const phoneContext = await browser.newContext({
      viewport: PHONE,
      isMobile: true,
      hasTouch: true,
    });
    const desktop = await desktopContext.newPage();
    const phone = await phoneContext.newPage();
    try {
      const sessionId = await setupTerminal(desktop, port, url, 'multi-viewer geometry');
      await phone.goto(url);
      await waitForAppReady(phone);
      await waitForTerminalCanvas(phone);
      await joinOnly(phone, sessionId);

      const initialPty = await ptyDims(desktop, 'initial');
      const desktopInitial = await viewGeometry(desktop);
      const phoneInitial = await viewGeometry(phone);
      expect(desktopInitial.terminal).toEqual(initialPty);
      expect(phoneInitial.terminal).toEqual(initialPty);
      expect(phoneInitial.regime).toBe('pan');
      const phonePan = await phone.evaluate(() => ({
        viewportOverflowY: getComputedStyle(
          document.querySelector('#terminal .xterm-viewport')
        ).overflowY,
        status: (() => {
          const state = window.app.fitCoordinator.getState('main');
          window.app._updateTerminalControlStatus({
            ...state.authoritative,
            owner: null,
          });
          const element = document.getElementById('terminalControlStatus');
          const result = {
            hidden: element.hidden,
            owner: element.dataset.owner,
            text: element.textContent.trim(),
          };
          window.app._updateTerminalControlStatus(state.authoritative);
          return result;
        })(),
      }));
      expect(phonePan.viewportOverflowY).toBe('hidden');
      expect(phonePan.status.hidden).toBe(false);
      expect(phonePan.status.owner).toBe('vacant');
      expect(phonePan.status.text).toContain('control is available');

      await phone.evaluate((cr) => {
        window.app.send({ type: 'input', data: `printf 'PHONE_OWNER\\n'${cr}` });
      }, CR);
      await phone.waitForFunction(() => {
        const state = window.app.fitCoordinator.getState('main');
        return state.authoritative
          && state.localCapacity
          && state.authoritative.cols === state.localCapacity.cols;
      });
      const phoneOwnedPty = await ptyDims(phone, 'phone-owner');
      const desktopWhilePhoneOwns = await viewGeometry(desktop);
      const phoneOwned = await viewGeometry(phone);
      expect(desktopWhilePhoneOwns.terminal).toEqual(phoneOwnedPty);
      expect(phoneOwned.terminal).toEqual(phoneOwnedPty);

      await phoneContext.close();
      await desktop.waitForFunction(() => {
        const state = window.app.fitCoordinator.getState('main');
        return state.authoritative
          && state.localCapacity
          && state.authoritative.cols === state.localCapacity.cols
          && state.authoritative.rows === state.localCapacity.rows;
      });
      const restoredPty = await ptyDims(desktop, 'restored');
      const restored = await viewGeometry(desktop);
      expect(restored.terminal).toEqual(restoredPty);
      expect(restored.terminal).toEqual(restored.local);
      console.log('[terminal-geometry]', JSON.stringify({
        desktopInitial,
        phoneInitial,
        phoneOwned,
        desktopWhilePhoneOwns,
        restored,
      }));
    } finally {
      await phoneContext.close().catch(() => {});
      await desktopContext.close().catch(() => {});
    }
  });

  test('bounds idle resize attempts and exercises active owner advertisements', async ({ page }) => {
    const attempts = [];
    const dispose = server.terminalBridge.onResizeAttempt((event) => {
      attempts.push({ ...event, at: Date.now() });
    });

    try {
      await page.setViewportSize(DESKTOP);
      await setupTerminal(page, port, url, 'resize storm');
      const context = page.context();
      const second = await context.newPage();
      await second.setViewportSize(PHONE);
      await second.goto(url);
      await waitForAppReady(second);
      await waitForTerminalCanvas(second);
      const sessionId = await page.evaluate(() => window.app.currentClaudeSessionId);
      await joinOnly(second, sessionId);
      await page.waitForTimeout(2000);
      const idleStart = Date.now();
      await page.waitForTimeout(5000);
      const idleAttempts = attempts.filter((entry) => entry.at >= idleStart).length;
      expect(idleAttempts).toBeLessThanOrEqual(1);

      const owner = await page.evaluate(() => ({
        viewId: window.app.geometryViewId,
        local: window.app.fitCoordinator.getState('main').localCapacity,
      }));
      const activeStart = attempts.length;
      await page.evaluate(({ viewId, local }) => {
        for (let index = 0; index < 10; index++) {
          window.app.send({
            type: 'resize',
            viewId,
            cols: local.cols - (index % 2),
            rows: local.rows - (index % 3),
          });
        }
      }, owner);
      await page.waitForTimeout(500);
      const activeAttempts = attempts.length - activeStart;
      expect(activeAttempts).toBe(1);
      console.log('[terminal-resize-attempts]', JSON.stringify({
        idle: idleAttempts,
        active: activeAttempts,
      }));
    } finally {
      dispose();
    }
  });

  test('drains pre-frame output before applying authoritative geometry', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await setupTerminal(page, port, url, 'geometry client ordering');
    const result = await page.evaluate(() => {
      const order = [];
      const app = window.app;
      const originalFlush = app._flushWritesChunk.bind(app);
      const originalApply = app.fitCoordinator.applyAuthoritative.bind(app.fitCoordinator);
      app._pendingWrites.push(new TextEncoder().encode('queued-before-frame'));
      app._pendingWriteBytes += 'queued-before-frame'.length;
      app._flushWritesChunk = () => {
        order.push('output');
        return originalFlush();
      };
      app.fitCoordinator.applyAuthoritative = (...args) => {
        order.push('geometry');
        return originalApply(...args);
      };
      const current = app.fitCoordinator.getState('main').authoritative;
      app._applyGeometryFrame({
        ...current,
        revision: current.revision + 1,
      });
      app._flushWritesChunk = originalFlush;
      app.fitCoordinator.applyAuthoritative = originalApply;
      return order;
    });
    expect(result.slice(0, 2)).toEqual(['output', 'geometry']);
  });

  test('docked file browser never intersects the terminal while opening, dragging, or closing', async ({ page }) => {
    const attempts = [];
    const dispose = server.terminalBridge.onResizeAttempt((event) => attempts.push(event));
    await page.setViewportSize(DESKTOP);
    await setupTerminal(page, port, url, 'dock geometry');
    const before = await viewGeometry(page);
    await page.evaluate(() => window.app._ensureFileBrowser().open());
    await expect(page.locator('#fileBrowserPanel')).toBeVisible();
    const transformedAncestors = await page.locator('#fileBrowserDock').evaluate((dock) => {
      const violations = [];
      for (let node = dock.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.transform !== 'none'
            || style.filter !== 'none'
            || style.perspective !== 'none'
            || /paint/.test(style.contain || '')) {
          violations.push(node.id || node.className || node.tagName);
        }
      }
      return violations;
    });
    expect(transformedAncestors).toEqual([]);
    const samples = await page.evaluate(async () => {
      const result = [];
      for (let index = 0; index < 24; index++) {
        const terminal = document.getElementById('terminalContainer').getBoundingClientRect();
        const panel = document.getElementById('fileBrowserPanel').getBoundingClientRect();
        result.push(Math.max(0, Math.min(terminal.right, panel.right) - Math.max(terminal.left, panel.left)));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return result;
    });
    expect(Math.max(...samples)).toBe(0);
    const handlePlacement = await page.evaluate(() => {
      const terminal = document.getElementById('terminalContainer').getBoundingClientRect();
      const panel = document.getElementById('fileBrowserPanel').getBoundingClientRect();
      const handle = document.querySelector('.file-browser-resize-handle').getBoundingClientRect();
      return {
        startsAfterTerminal: handle.left >= terminal.right,
        insidePanelEdge: handle.left >= panel.left && handle.right <= panel.right,
      };
    });
    expect(handlePlacement).toEqual({
      startsAfterTerminal: true,
      insidePanelEdge: true,
    });

    const handle = page.locator('.file-browser-resize-handle');
    const box = await handle.boundingBox();
    const preDragWidth = await page.locator('#fileBrowserPanel').evaluate(
      (panel) => panel.getBoundingClientRect().width
    );
    await page.mouse.move(box.x + 2, box.y + 100);
    await page.mouse.down();
    await expect(handle).toHaveClass(/dragging/);
    await page.mouse.move(box.x - 140, box.y + 100, { steps: 12 });
    await page.mouse.up();
    await expect(handle).not.toHaveClass(/dragging/);
    await page.waitForFunction(() => {
      const panel = window.app._fileBrowserPanel;
      const rendered = panel._panelEl.getBoundingClientRect().width;
      return Math.abs(rendered - panel._userDockWidth) < 1;
    });
    const dragged = await page.evaluate(() => {
      const terminal = document.getElementById('terminalContainer').getBoundingClientRect();
      const panel = document.getElementById('fileBrowserPanel').getBoundingClientRect();
      return {
        overlap: Math.max(0, Math.min(terminal.right, panel.right) - Math.max(terminal.left, panel.left)),
        cols: window.app.terminal.cols,
        panelWidth: panel.width,
        userWidth: window.app._fileBrowserPanel._userDockWidth,
      };
    });
    expect(dragged.overlap).toBe(0);
    expect(dragged.cols).toBeLessThan(before.terminal.cols);
    expect(dragged.panelWidth).toBeGreaterThan(preDragWidth + 100);
    expect(dragged.userWidth).toBeCloseTo(dragged.panelWidth, 0);

    const keyboardResize = await page.evaluate(() => {
      const handle = document.querySelector('.file-browser-resize-handle');
      const beforeWidth = document.getElementById('fileBrowserPanel').getBoundingClientRect().width;
      handle.focus();
      handle.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true,
      }));
      return {
        beforeWidth,
        afterWidth: document.getElementById('fileBrowserPanel').getBoundingClientRect().width,
        role: handle.getAttribute('role'),
        orientation: handle.getAttribute('aria-orientation'),
        valueNow: Number(handle.getAttribute('aria-valuenow')),
        focused: document.activeElement === handle,
      };
    });
    expect(keyboardResize.role).toBe('separator');
    expect(keyboardResize.orientation).toBe('vertical');
    expect(keyboardResize.focused).toBe(true);
    expect(keyboardResize.valueNow).toBeGreaterThan(keyboardResize.beforeWidth);
    await page.waitForFunction(
      (width) => document.getElementById('fileBrowserPanel').getBoundingClientRect().width > width,
      keyboardResize.beforeWidth
    );

    await page.locator('#fileBrowserPanel').focus();
    const parentBefore = await page.evaluate(() => (
      document.getElementById('fileBrowserPanel').parentElement.id
    ));
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.waitForTimeout(300);
    await page.setViewportSize(DESKTOP);
    await page.waitForTimeout(300);
    const breakpointState = await page.evaluate(() => ({
      parent: document.getElementById('fileBrowserPanel').parentElement.id,
      focused: document.activeElement === document.getElementById('fileBrowserPanel'),
    }));
    expect(breakpointState).toEqual({ parent: parentBefore, focused: true });

    const composedWidth = await page.evaluate(() => {
      const panel = window.app._fileBrowserPanel;
      panel._panelEl.classList.add('editor-active');
      panel._adjustTerminal();
      const editorWidth = panel._panelEl.getBoundingClientRect().width;
      panel._panelEl.classList.remove('editor-active');
      panel._adjustTerminal();
      return {
        editorWidth,
        restoredWidth: panel._panelEl.getBoundingClientRect().width,
      };
    });
    expect(composedWidth.editorWidth).toBeGreaterThanOrEqual(keyboardResize.valueNow);
    expect(composedWidth.restoredWidth).toBeCloseTo(keyboardResize.valueNow, 0);

    await page.evaluate(() => window.app._fileBrowserPanel.close());
    await page.waitForFunction(
      (cols) => window.app.terminal.cols === cols,
      before.local.cols
    );
    const after = await viewGeometry(page);
    expect(after.terminal).toEqual(before.local);
    expect(attempts.length).toBeLessThanOrEqual(12);
    console.log('[terminal-dock-resize-attempts]', JSON.stringify({
      attempts: attempts.length,
    }));
    dispose();
  });

  test('split panes and reconnect advertise without layout claims', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const firstSession = await setupTerminal(page, port, url, 'split first');
    const secondSession = await createSessionViaApi(port, 'split second');
    const secondPage = await page.context().newPage();
    await secondPage.goto(url);
    await waitForAppReady(secondPage);
    await waitForTerminalCanvas(secondPage);
    await joinSessionAndStartTerminal(secondPage, secondSession);
    const replayReady = await page.evaluate(async (id) => {
      await window.app.splitContainer.createSplit(id);
      return window.app.splitContainer.splits.every((split) => !split._repainting);
    }, secondSession);
    expect(replayReady).toBe(true);
    await page.waitForFunction(() => {
      const splits = window.app.splitContainer && window.app.splitContainer.splits;
      return splits && splits.length === 2
        && splits.every((split) => split.app.fitCoordinator.getState(split._fitId)?.authoritative);
    });
    const splitState = await page.evaluate(() => window.app.splitContainer.splits.map((split) => {
      const state = window.app.fitCoordinator.getState(split._fitId);
      return {
        sessionId: split.sessionId,
        terminal: { cols: split.terminal.cols, rows: split.terminal.rows },
        authoritative: state.authoritative,
        local: state.localCapacity,
      };
    }));
    for (const split of splitState) {
      expect(split.terminal.cols).toBe(split.authoritative.cols);
      expect(split.terminal.rows).toBe(split.authoritative.rows);
    }
    const splitControls = await page.evaluate(() => window.app.splitContainer.splits.map((split) => {
      const state = window.app.fitCoordinator.getState(split._fitId);
      const owner = state.authoritative && state.authoritative.owner;
      const isOwner = !!(owner
        && owner.connectionId === split.connectionId
        && owner.viewId === split.geometryViewId);
      return {
        hidden: split._controlStatus.hidden,
        owner: split._controlStatus.dataset.owner,
        isOwner,
        text: split._controlStatus.textContent.trim(),
      };
    }));
    for (const control of splitControls) {
      expect(control.hidden).toBe(control.isOwner);
      expect(control.owner).toBe(control.isOwner ? 'local' : 'remote');
    }
    const remoteSplitIndex = splitControls.findIndex((control) => !control.isOwner);
    expect(remoteSplitIndex).toBeGreaterThanOrEqual(0);
    await page.evaluate((index) => {
      window.app.splitContainer.splits[index]._controlStatus.querySelector('button').click();
    }, remoteSplitIndex);
    await page.waitForFunction((index) => {
      const split = window.app.splitContainer.splits[index];
      const state = window.app.fitCoordinator.getState(split._fitId);
      return state.authoritative
        && state.authoritative.owner
        && state.authoritative.owner.connectionId === split.connectionId
        && state.authoritative.owner.viewId === split.geometryViewId;
    }, remoteSplitIndex);
    expect(await page.evaluate(
      (index) => window.app.splitContainer.splits[index]._controlStatus.hidden,
      remoteSplitIndex
    )).toBe(true);

    await page.evaluate(() => window.app.splitContainer.closeSplit());
    const expectedSession = await page.evaluate(() => window.app.currentClaudeSessionId);
    const priorConnection = await page.evaluate(() => window.app.connectionId);
    const beforeReconnect = await viewGeometry(page);
    await page.evaluate(() => {
      window.__reconnectGeometryFrames = [];
      const original = WebSocket.prototype.send;
      WebSocket.prototype.send = function (value) {
        try {
          const frame = JSON.parse(value);
          if (frame.type === 'resize' || frame.type === 'geometry_withdraw') {
            window.__reconnectGeometryFrames.push(frame);
          }
        } catch (_) {}
        return original.call(this, value);
      };
      // Exercise the same reconnect path as a detected dead connection. A
      // generic clean application close is deliberately not reconnectable.
      window.app.socket.close(4000, 'geometry reconnect probe');
    });
    await page.setViewportSize({ width: 1000, height: 720 });
    await page.waitForFunction(
      (prior) => window.app.connectionId && window.app.connectionId !== prior
        && window.app.currentClaudeSessionId,
      priorConnection,
      { timeout: 30000 }
    );
    await page.waitForFunction(() => {
      const state = window.app.fitCoordinator.getState('main');
      return state.authoritative && state.localCapacity
        && window.__reconnectGeometryFrames.some((frame) => frame.type === 'resize');
    });
    const reconnected = await viewGeometry(page);
    const pty = await ptyDims(page, 'reconnect');
    expect(reconnected.terminal).toEqual(pty);
    expect(reconnected.authoritative.cols).toBe(beforeReconnect.authoritative.cols);
    expect(reconnected.local.cols).not.toBe(reconnected.authoritative.cols);
    expect(await page.evaluate(() => (
      window.__reconnectGeometryFrames.every((frame) => frame.claim !== true)
    ))).toBe(true);
    expect(await page.evaluate(() => window.app.currentClaudeSessionId)).toBe(expectedSession);
    console.log('[terminal-split-reconnect]', JSON.stringify({ splitState, reconnected }));
    await secondPage.close();
  });
});
