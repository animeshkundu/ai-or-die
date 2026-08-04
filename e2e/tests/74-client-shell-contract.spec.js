const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

test.describe('Terminal-first client shell contract', () => {
  let server;
  let port;
  let url;

  test.beforeAll(async () => {
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) await server.close();
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (page) await attachFailureArtifacts(page, testInfo);
  });

  async function setupPage(page) {
    await createSessionViaApi(port, 'Client shell contract');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await page.waitForFunction(() => window.app && window.app.currentClaudeSessionId);
  }

  test('file browser overlays without resizing and restores focus', async ({ page }) => {
    await setupPage(page);
    await page.evaluate(() => {
      window.__shellProbe = { resizeCalls: 0 };
      const original = window.app.terminal.resize.bind(window.app.terminal);
      window.app.terminal.resize = (...args) => {
        window.__shellProbe.resizeCalls++;
        return original(...args);
      };
    });

    const opener = page.locator('#browseFilesBtn:visible, #navFiles:visible').first();
    await opener.focus();
    const before = await page.evaluate(() => ({
      cols: window.app.terminal.cols,
      rows: window.app.terminal.rows,
    }));
    await opener.click();
    const panel = page.locator('#fileBrowserPanel');
    await expect(panel).toBeVisible();
    await expect(panel).toBeFocused();
    await page.waitForTimeout(350);

    await page.locator('.file-browser-item', { hasText: 'AGENTS.md' }).click();
    await expect(page.locator('.fb-preview-container')).toBeVisible();
    await expect(page.locator('.fb-preview-header')).toContainText('AGENTS.md');
    await expect(page.locator('.fb-preview-content')).toBeVisible();

    const during = await page.evaluate(() => ({
      cols: window.app.terminal.cols,
      rows: window.app.terminal.rows,
      resizeCalls: window.__shellProbe.resizeCalls,
    }));
    expect(during).toEqual({ ...before, resizeCalls: 0 });

    await page.keyboard.press('Escape');
    await expect(page.locator('.fb-file-list')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(opener).toBeFocused();
    expect(await page.evaluate(() => window.__shellProbe.resizeCalls)).toBe(0);
  });

  test('settings, command palette, input, and artifact chrome never resize the terminal', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setupPage(page);
    const result = await page.evaluate(async () => {
      let resizeCalls = 0;
      const terminal = window.app.terminal;
      const original = terminal.resize.bind(terminal);
      terminal.resize = (...args) => {
        resizeCalls++;
        return original(...args);
      };
      const before = { cols: terminal.cols, rows: terminal.rows };
      window.app.showSettings();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      window.app.hideSettings();
      if (window.app._inputOverlay) {
        window.app._inputOverlay.show();
        window.app._inputOverlay.hide();
      }
      const palette = window.commandPaletteManager && window.commandPaletteManager.ninja;
      if (palette) {
        palette.open();
        palette.close();
      }
      const sid = window.app.currentClaudeSessionId;
      if (window.app._artifactPanel && sid) {
        window.app._artifactPanel.open({ sessionId: sid, file: 'review.html' });
        window.app._artifactPanel.endReview({ sessionId: sid });
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        before,
        after: { cols: terminal.cols, rows: terminal.rows },
        resizeCalls,
      };
    });
    expect(result.after).toEqual(result.before);
    expect(result.resizeCalls).toBe(0);
  });

  test('fixed viewport fits are stable and never emit unsafe geometry', async ({ page }) => {
    await setupPage(page);
    const result = await page.evaluate(async () => {
      const sent = [];
      const originalSend = window.app.send.bind(window.app);
      window.app.send = (message) => {
        if (message && message.type === 'resize') sent.push(message);
        return originalSend(message);
      };
      const sizes = [];
      for (let i = 0; i < 3; i++) {
        window.app.fitTerminal({ forceSend: true });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        sizes.push([window.app.terminal.cols, window.app.terminal.rows]);
      }
      return { sizes, sent };
    });
    expect(new Set(result.sizes.map((size) => size.join('x'))).size).toBe(1);
    expect(result.sent.every((size) => size.cols >= 20 && size.rows >= 5)).toBeTruthy();
  });

  test('split creation and later viewport changes never send tiny PTY geometry', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const rightSessionId = await createSessionViaApi(port, 'Split geometry contract');
    await setupPage(page);
    const result = await page.evaluate(async (sessionId) => {
      const sent = [];
      const originalSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (payload) {
        if (typeof payload === 'string') {
          try {
            const message = JSON.parse(payload);
            if (message.type === 'resize') sent.push(message);
          } catch (_) {}
        }
        return originalSend.call(this, payload);
      };
      try {
        await window.app.splitContainer.createSplit(sessionId);
        await new Promise((resolve) => setTimeout(resolve, 500));
        window.dispatchEvent(new Event('resize'));
        await new Promise((resolve) => setTimeout(resolve, 250));
        const splitSizes = window.app.splitContainer.splits.map((split) => ({
          cols: split.terminal.cols,
          rows: split.terminal.rows,
        }));
        window.app.splitContainer.closeSplit();
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { sent, splitSizes };
      } finally {
        WebSocket.prototype.send = originalSend;
      }
    }, rightSessionId);
    expect(result.sent.length).toBeGreaterThan(0);
    expect(result.sent.every(({ cols, rows }) => cols >= 20 && rows >= 5)).toBeTruthy();
    expect(result.splitSizes.every(({ cols, rows }) => cols >= 20 && rows >= 5)).toBeTruthy();
  });

  test('reconnect during output preserves sequence, scroll position, and selection', async ({ page }) => {
    const sessionId = await createSessionViaApi(port, 'Reconnect contract');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await page.evaluate((sid) => window.app.sessionTabManager.switchToTab(sid), sessionId);
    await page.waitForFunction(
      (sid) => window.app.currentClaudeSessionId === sid
        && window.app.sessionTabManager.activeTabId === sid,
      sessionId
    );
    const marker = `RECONNECT_${Date.now()}`;
    await page.evaluate((prefix) => {
      const command = `node -e "let i=0;const t=setInterval(()=>{i++;console.log('${prefix}_'+String(i).padStart(3,'0'));if(i===240)clearInterval(t)},5)"`;
      window.app.send({ type: 'input', data: command + '\r' });
    }, marker);
    await page.waitForFunction(
      (prefix) => {
        const terminal = window.app && window.app.terminal;
        if (!terminal) return false;
        const buffer = terminal.buffer.active;
        for (let i = 0; i < buffer.length; i++) {
          if (buffer.getLine(i)?.translateToString(true).includes(prefix + '_040')) return true;
        }
        return false;
      },
      marker,
      { timeout: 15000 }
    );

    const before = await page.evaluate(() => {
      const terminal = window.app.terminal;
      terminal.scrollToTop();
      const buffer = terminal.buffer.active;
      let selected = '';
      for (let row = 0; row < buffer.length && !selected; row++) {
        const text = buffer.getLine(row)?.translateToString(true) || '';
        const start = text.search(/\S/);
        if (start >= 0) {
          terminal.select(start, row, Math.min(8, text.length - start));
          selected = terminal.getSelection();
        }
      }
      const socket = window.app.socket;
      window.__reconnectSocket = socket;
      window.__rejoinObserved = false;
      const originalHandleMessage = window.app.handleMessage.bind(window.app);
      window.app.handleMessage = (message) => {
        if (message && message.type === 'session_joined' && Array.isArray(message.outputBuffer)) {
          window.__rejoinObserved = true;
        }
        return originalHandleMessage(message);
      };
      socket.close(4000, 'reconnect contract');
      return { selected, viewportY: buffer.viewportY };
    });
    expect(before.selected).not.toBe('');

    await page.waitForFunction(
      () => window.app.socket !== window.__reconnectSocket
        && window.app.socket.readyState === WebSocket.OPEN,
      { timeout: 20000 }
    );
    await page.waitForFunction(() => window.__rejoinObserved, { timeout: 20000 });
    await page.waitForFunction(() => !window.app._joinRepaintInProgress, { timeout: 20000 });
    await page.waitForFunction(
      (prefix) => {
        const terminal = window.app && window.app.terminal;
        if (!terminal) return false;
        const buffer = terminal.buffer.active;
        for (let i = 0; i < buffer.length; i++) {
          if (buffer.getLine(i)?.translateToString(true).includes(prefix + '_240')) return true;
        }
        return false;
      },
      marker,
      { timeout: 30000 }
    );
    await page.waitForFunction(() => window.app._pendingWriteBytes === 0);
    await page.evaluate(() => new Promise((resolve) => window.app.terminal.write('', resolve)));

    const after = await page.evaluate((prefix) => {
      const terminal = window.app.terminal;
      const buffer = terminal.buffer.active;
      const sequencePattern = new RegExp(prefix + '_(\\d{3})', 'g');
      const rawCounts = {};
      for (const match of window.app._outputTail.matchAll(sequencePattern)) {
        rawCounts[match[1]] = (rawCounts[match[1]] || 0) + 1;
      }
      // What the user actually sees. The rendered buffer is the contract for
      // "no duplicated frames": counting occurrences in the raw byte stream
      // instead conflates client duplication with a legitimate PTY repaint --
      // Windows ConPTY re-emits the visible screen when the reconnecting client
      // sends its geometry, so ~one screenful of lines appears twice on the
      // wire while the rendered screen stays correct.
      const renderedCounts = {};
      let logical = '';
      const tally = (text) => {
        for (const match of text.matchAll(sequencePattern)) {
          renderedCounts[match[1]] = (renderedCounts[match[1]] || 0) + 1;
        }
      };
      for (let row = 0; row < buffer.length; row++) {
        const line = buffer.getLine(row);
        if (!line) continue;
        const text = line.translateToString(line.isWrapped ? false : true);
        if (line.isWrapped) {
          logical += text;
        } else {
          tally(logical);
          logical = text;
        }
      }
      tally(logical);
      return {
        rawCounts,
        renderedCounts,
        selected: terminal.getSelection(),
        viewportY: buffer.viewportY,
      };
    }, marker);
    // No output lost on the wire: every sequence number reached the client.
    expect(Object.keys(after.rawCounts)).toHaveLength(240);
    // No output lost on screen either -- without this the duplicate check below
    // would pass vacuously on a buffer that rendered nothing.
    expect(Object.keys(after.renderedCounts)).toHaveLength(240);
    // No duplicated frames on screen.
    const renderedDuplicates = Object.entries(after.renderedCounts)
      .filter(([, count]) => count !== 1);
    expect(renderedDuplicates, JSON.stringify(renderedDuplicates)).toEqual([]);
    expect(after.viewportY).toBe(before.viewportY);
    expect(after.selected).toBe(before.selected);
  });

  test('hidden-page watchdog pauses oversized output ingress', async ({ page }) => {
    await setupPage(page);
    await page.evaluate(() => {
      window.__flowControl = [];
      window.__flowRejoins = 0;
      const originalSend = window.app.send.bind(window.app);
      window.app.send = (message) => {
        if (message && message.type === 'flow_control') window.__flowControl.push(message.action);
        if (message && message.type === 'join_session') window.__flowRejoins++;
        return originalSend(message);
      };
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      window.app._pendingWriteBytes = 1024 * 1024 + 1;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => window.__flowControl.includes('pause'));
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      window.app._pendingWriteBytes = 0;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => window.__flowControl.includes('resume'));
    await page.waitForFunction(() => window.__flowRejoins > 0);
    await page.waitForFunction(() => !window.app._ingressPaused);
  });

  test('mobile safe-area and touch contracts are present', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await setupPage(page);
    const result = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const navFiles = document.getElementById('navFiles').getBoundingClientRect();
      return {
        safeAreas: ['--sa-top', '--sa-right', '--sa-bottom', '--sa-left']
          .map((name) => root.getPropertyValue(name).trim()),
        navFiles: { width: navFiles.width, height: navFiles.height },
        coarse: matchMedia('(pointer: coarse)').matches,
      };
    });
    expect(result.safeAreas.every(Boolean)).toBeTruthy();
    expect(result.navFiles.width).toBeGreaterThanOrEqual(44);
    expect(result.navFiles.height).toBeGreaterThanOrEqual(44);

    if (result.coarse) {
      // Force the transient banners into view so their controls are measured
      // too. The speech-model download banner only appears while a model is
      // downloading, so on a runner with warm model caches its dismiss button
      // would otherwise never be sampled -- that is how it shipped at 21x27.
      await page.evaluate(() => {
        for (const id of ['voiceDownloadBanner', 'stickyNotesDownloadBanner']) {
          const banner = document.getElementById(id);
          if (banner) banner.style.display = 'flex';
        }
      });
      const tooSmall = await page.locator(
        'button:visible, input:not([type="hidden"]):visible, select:visible, [role="button"]:visible, [role="tab"]:visible'
      ).evaluateAll((controls) => controls.map((control) => {
        const rect = control.getBoundingClientRect();
        return {
          label: control.getAttribute('aria-label') || control.textContent.trim().slice(0, 40),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }).filter(({ width, height }) => width < 44 || height < 44));
      expect(tooSmall, JSON.stringify(tooSmall)).toEqual([]);
      // Every control also needs an accessible name, not just a glyph.
      const unnamed = await page.locator('button:visible').evaluateAll((controls) => controls
        .filter((control) => !(control.getAttribute('aria-label') || '').trim()
          && !(control.getAttribute('title') || '').trim()
          && !/[a-z0-9]/i.test(control.textContent || ''))
        .map((control) => control.id || control.className));
      expect(unnamed, JSON.stringify(unnamed)).toEqual([]);
    }
  });

  test('mobile file browser contains the first reverse tab', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await setupPage(page);
    await page.evaluate(() => window.app.hideOverlay());
    await page.locator('#navFiles').click();
    const panel = page.locator('#fileBrowserPanel');
    await expect(panel).toBeFocused();
    await expect(page.locator('#app')).toHaveJSProperty('inert', true);
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.getElementById('fileBrowserPanel').contains(document.activeElement))).toBeTruthy();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page.locator('#app')).toHaveJSProperty('inert', false);
  });

  test('short landscape keeps the assistant chooser reachable', async ({ page }) => {
    await page.setViewportSize({ width: 852, height: 393 });
    await setupPage(page);
    const overlay = page.locator('#overlay');
    const firstCard = page.locator('.tool-card').first();
    const lastCard = page.locator('.tool-card').last();
    await expect(overlay).toBeVisible();
    await expect(firstCard).toBeVisible();
    await expect(page.locator('#installBtn')).toBeHidden();

    const bounds = await page.evaluate(() => ({
      contentTop: document.querySelector('.overlay-content').getBoundingClientRect().top,
      tabBottom: document.getElementById('sessionTabsBar').getBoundingClientRect().bottom,
    }));
    expect(bounds.contentTop).toBeGreaterThanOrEqual(bounds.tabBottom);
    await lastCard.scrollIntoViewIfNeeded();
    await expect(lastCard).toBeVisible();
  });
});
