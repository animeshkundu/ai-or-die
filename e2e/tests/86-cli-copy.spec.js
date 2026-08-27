// @ts-check
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForWebSocket,
  waitForTerminalCanvas,
  waitForTerminalText,
} = require('../helpers/terminal-helpers');

const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/fake-cli-copy.js');
const TOOLS = [
  { id: 'claude', label: 'Claude Code', marker: 'COPY_E2E_CLAUDE_CLI' },
  { id: 'copilot', label: 'GitHub Copilot', marker: 'COPY_E2E_COPILOT_CLI' },
];

// Keep copy assertions on the live page API, not a stale service-worker cache.
test.use({ permissions: [], serviceWorkers: 'block' });

let server;
let port;
let url;
const activeSessionIds = new Set();
const secondaryPages = new Set();

function getTool(toolId) {
  const tool = TOOLS.find((candidate) => candidate.id === toolId);
  if (!tool) throw new Error(`Unknown copy fixture tool: ${toolId}`);
  return tool;
}

function expectedFixtureText(toolId) {
  const tool = getTool(toolId);
  const wrapped = `${tool.marker}_WRAPPED_${'0123456789abcdef'.repeat(24)}`;
  return `${tool.label} CLI fixture ready\n${wrapped}\n${tool.marker}_ANSI_FULL_SCREEN`;
}

function configureFakeBridge(bridge, toolId) {
  bridge.command = process.execPath;
  bridge._prefixArgs = [FIXTURE_PATH, toolId];
  bridge._commandReady = Promise.resolve();
  bridge._availableCache = true;
  bridge._availableCacheTime = Date.now();
}

async function stubClipboard(page) {
  await page.evaluate(() => {
    const state = { attempts: 0, completed: 0, text: null, error: null };
    const writeText = (text) => new Promise((resolve, reject) => {
      state.attempts += 1;
      if (typeof text !== 'string') {
        state.error = `clipboard.writeText expects a string, got ${typeof text}`;
        reject(new TypeError(state.error));
        return;
      }
      // Complete on a later task so callers must await the write.
      setTimeout(() => {
        state.text = text;
        state.completed += 1;
        resolve();
      }, 0);
    });
    const readText = () => Promise.resolve(state.text || '');

    let installed = false;
    let installError = null;
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText, readText },
        configurable: true,
      });
      installed = !!(navigator.clipboard
        && navigator.clipboard.writeText === writeText
        && navigator.clipboard.readText === readText);
    } catch (error) {
      installError = error;
    }
    if (!installed && navigator.clipboard) {
      try {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          value: writeText,
          configurable: true,
        });
        Object.defineProperty(navigator.clipboard, 'readText', {
          value: readText,
          configurable: true,
        });
        installed = navigator.clipboard.writeText === writeText
          && navigator.clipboard.readText === readText;
      } catch (error) {
        installError = error;
      }
    }
    if (!installed) {
      throw new Error(`Unable to install clipboard stub: ${installError ? installError.message : 'unknown error'}`);
    }
    window.__cliClipboard = state;
  });
}

async function waitForClipboardWrite(page) {
  await expect.poll(() => page.evaluate(() => window.__cliClipboard || null), {
    timeout: 5000,
  }).toMatchObject({ attempts: 1, completed: 1, error: null });
}

async function waitForStartedFrame(page, startIndex, toolId, sessionId) {
  const type = `${toolId}_started`;
  await expect.poll(() => (page._wsMessages || []).slice(startIndex).find((message) =>
    message.dir === 'recv' && message.type === type
  ) || null, { timeout: 10000 }).toMatchObject({
    type,
    sessionId,
    workingDir: expect.any(String),
  });
}

async function startTool(page, sessionId, toolId) {
  await page.waitForFunction(
    () => window.app && window.app.sessionTabManager
      && window.app.socket && window.app.socket.readyState === 1,
    { timeout: 20000 }
  );
  await page.evaluate(async (sid) => window.app.joinSession(sid), sessionId);

  const startIndex = (page._wsMessages || []).length;
  await page.evaluate((id) => window.app.startToolSession(id), toolId);
  await expect.poll(() => (page._wsMessages || []).slice(startIndex).some((message) =>
    message.dir === 'sent' && message.type === `start_${toolId}`
  ), { timeout: 10000 }).toBe(true);
  // An outbound request is insufficient. Require the received acknowledgement.
  await waitForStartedFrame(page, startIndex, toolId, sessionId);
  await page.waitForFunction(() => {
    const overlay = document.getElementById('overlay');
    return !overlay || overlay.style.display === 'none';
  }, { timeout: 30000 });
}

async function openPage(page, sessionId) {
  setupPageCapture(page);
  await page.goto(url);
  await waitForAppReady(page, 20000);
  await waitForWebSocket(page);
  await waitForTerminalCanvas(page);
  activeSessionIds.add(sessionId);
}

async function getTerminalText(page, splitIndex = null) {
  return page.evaluate((index) => {
    const terminal = index == null
      ? window.app && window.app.terminal
      : window.app && window.app.splitContainer
        && window.app.splitContainer.splits[index]
        && window.app.splitContainer.splits[index].terminal;
    if (!terminal || !window.TerminalCopy
      || typeof window.TerminalCopy.getVisibleText !== 'function') return null;
    return window.TerminalCopy.getVisibleText(terminal);
  }, splitIndex);
}

async function waitForFixtureScreen(page, toolId, splitIndex = null) {
  const expected = expectedFixtureText(toolId);
  const expectedLines = expected.split('\n');
  // TerminalCopy joins xterm physical continuation rows back into logical lines.
  await expect.poll(async () => {
    const text = await getTerminalText(page, splitIndex);
    if (typeof text !== 'string') return false;
    return expectedLines.every((line) => text.includes(line))
      || (text.includes(expectedLines[0])
        && text.includes(expectedLines[1].slice(0, 32))
        && text.includes(expectedLines[2]));
  }, { timeout: 15000 }).toBe(true);
  return expected;
}

async function waitForWrappedRow(page, splitIndex = null) {
  await expect.poll(() => page.evaluate((index) => {
    const terminal = index == null
      ? window.app && window.app.terminal
      : window.app && window.app.splitContainer
        && window.app.splitContainer.splits[index]
        && window.app.splitContainer.splits[index].terminal;
    if (!terminal || !terminal.buffer || !terminal.buffer.active) return false;
    const buffer = terminal.buffer.active;
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line && line.isWrapped) return true;
    }
    return false;
  }, splitIndex), { timeout: 15000 }).toBe(true);
}

async function getWrapBoundary(page, splitIndex = null) {
  return page.evaluate((index) => {
    const terminal = index == null
      ? window.app && window.app.terminal
      : window.app && window.app.splitContainer
        && window.app.splitContainer.splits[index]
        && window.app.splitContainer.splits[index].terminal;
    if (!terminal || !terminal.buffer || !terminal.buffer.active) return null;
    const buffer = terminal.buffer.active;
    for (let i = 1; i < buffer.length; i++) {
      const previous = buffer.getLine(i - 1);
      const current = buffer.getLine(i);
      if (!previous || !current || !current.isWrapped) continue;
      const left = previous.translateToString(false).replace(/\s+$/, '');
      const right = current.translateToString(false).replace(/^\s+/, '');
      if (left.includes('_WRAPPED_') || right.includes('456789')) {
        return { left: left.slice(-16), right: right.slice(0, 16) };
      }
    }
    return null;
  }, splitIndex);
}

async function assertLogicalScreen(page, expected, splitIndex = null) {
  const text = await getTerminalText(page, splitIndex);
  expect(text).toBeTruthy();
  for (const line of expected.split('\n')) {
    expect(text).toContain(line);
  }
}

async function assertCopiedContent(page, expected, splitIndex = null) {
  await waitForClipboardWrite(page);
  const copied = await page.evaluate(() => window.__cliClipboard.text);
  // After core integration, TerminalCopy must return exact logical lines.
  expect(copied).toBe(expected);
  expect(copied).not.toContain('\x1b');

  // The fixture's long row is guaranteed to wrap physically. Its known marker
  // boundary must not become an artificial newline in copied logical text.
  const boundary = await getWrapBoundary(page, splitIndex);
  expect(boundary, 'fixture must contain a physical wrapped-row boundary').toBeTruthy();
  expect(copied).not.toContain(`${boundary.left}\n${boundary.right}`);
  expect(copied).not.toContain('0123\n456789');
  expect(copied).toContain(`${boundary.left}${boundary.right}`);

  await expect.poll(() => page.evaluate(() => ({
    attempts: window.__cliClipboard.attempts,
    completed: window.__cliClipboard.completed,
    error: window.__cliClipboard.error,
  })), { timeout: 5000 }).toEqual({ attempts: 1, completed: 1, error: null });
}

async function copyVisibleScreen(page) {
  const mobile = await page.evaluate(() => !!(window.app && window.app.isMobile));
  if (mobile) {
    const before = await page.evaluate(() => ({
      keyboardOpen: document.body.classList.contains('keyboard-open'),
      terminalHeight: document.getElementById('terminal')?.style.height || '',
    }));
    const launcher = page.locator('#keysPanelBtn');
    await expect(launcher).toBeVisible();
    await launcher.tap();
    await expect(page.locator('#keysPanel')).toHaveClass(/keys-panel--open/);

    const copyButton = page.locator('.keys-panel__util-btn');
    await expect(copyButton).toBeVisible();
    await copyButton.evaluate((button) => {
      window.__cliCopyEvents = [];
      for (const type of ['touchstart', 'touchend']) {
        button.addEventListener(type, () => window.__cliCopyEvents.push(type));
      }
    });
    await copyButton.tap();
    await expect.poll(() => page.evaluate(() => window.__cliCopyEvents || []), {
      timeout: 5000,
    }).toEqual(['touchstart', 'touchend']);
    await expect(page.locator('.toast--success .toast__msg')).toContainText('Copied screen');
    await expect.poll(() => page.evaluate(() => ({
      keyboardOpen: document.body.classList.contains('keyboard-open'),
      inKeyboardTransition: !!(window.app && window.app._inKeyboardTransition),
      terminalHeight: document.getElementById('terminal')?.style.height || '',
    })), { timeout: 5000 }).toEqual({ ...before, inKeyboardTransition: false });
    return true;
  }

  const terminalArea = page.locator(
    '[data-tid="terminal"] .xterm-screen, #terminal .xterm-screen'
  ).first();
  await terminalArea.click({ button: 'right', position: { x: 100, y: 50 } });
  const copyItem = page.locator('#termContextMenu [data-action="copy"]');
  await expect(copyItem).toBeVisible();
  await expect(copyItem).not.toHaveClass(/disabled/);
  await copyItem.click();
  await waitForClipboardWrite(page);
  // The clipboard write is the durable success signal. The badge is intentionally
  // transient and may be hidden by the time the async assertion runs.
  return false;
}

async function copySplitScreen(page, splitIndex) {
  const splitArea = page.locator(
    `.split-pane[data-split-index="${splitIndex}"] .xterm-screen`
  ).first();
  await expect(splitArea).toBeVisible();
  await splitArea.click({ button: 'right', position: { x: 80, y: 40 } });
  const copyItem = page.locator('#termContextMenu [data-action="copy"]');
  await expect(copyItem).toBeVisible();
  await expect(copyItem).not.toHaveClass(/disabled/);
  await copyItem.click();
}

async function captureEvidence(page, testInfo, toolId, mobile) {
  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach(`${toolId}-copy-${mobile ? 'mobile' : 'desktop'}`, {
    body: screenshot,
    contentType: 'image/png',
  });
  const evidenceDir = process.env.AIORDIE_CLI_COPY_SCREENSHOT_DIR;
  if (evidenceDir && testInfo.retry === 0) {
    await fs.promises.mkdir(evidenceDir, { recursive: true });
    await fs.promises.writeFile(path.join(evidenceDir, `${toolId}-copy.png`), screenshot);
  }
}

test.beforeAll(async () => {
  ({ server, port, url } = await createServer());
  configureFakeBridge(server.claudeBridge, 'claude');
  configureFakeBridge(server.copilotBridge, 'copilot');
});

test.afterEach(async ({ page }, testInfo) => {
  await attachFailureArtifacts(page, testInfo);
  for (const otherPage of secondaryPages) {
    await otherPage.close().catch((error) => console.warn('Failed to close copy test page:', error.message));
  }
  secondaryPages.clear();
  for (const sessionId of activeSessionIds) {
    await server.stopToolSession(sessionId).catch((error) => console.warn('Failed to stop copy test session:', error.message));
  }
  activeSessionIds.clear();
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.describe('CLI-specific terminal copy', () => {
  for (const tool of TOOLS) {
    test(`${tool.label} output copies as exact logical lines`, async ({ page }, testInfo) => {
      test.setTimeout(90000);
      const sessionId = await createSessionViaApi(port, `cli-copy-${tool.id}`);
      await openPage(page, sessionId);
      await stubClipboard(page);
      await startTool(page, sessionId, tool.id);
      await waitForTerminalText(page, tool.marker, 15000);
      await waitForTerminalText(page, `${tool.marker}_ANSI_FULL_SCREEN`, 15000);
      const expected = await waitForFixtureScreen(page, tool.id);
      await assertLogicalScreen(page, expected);
      await waitForWrappedRow(page);
      await page.evaluate(() => window.app.terminal.clearSelection());
      const mobile = await copyVisibleScreen(page);
      await assertCopiedContent(page, expected);
      await captureEvidence(page, testInfo, tool.id, mobile);
    });
  }

  test('command palette copy follows the active split terminal', async ({ page, context }) => {
    test.setTimeout(120000);
    const mainSession = await createSessionViaApi(port, 'cli-copy-palette-main');
    const splitSession = await createSessionViaApi(port, 'cli-copy-palette-right');
    await openPage(page, mainSession);
    test.skip(await page.evaluate(() => !!(window.app && window.app.isMobile)), 'split view is desktop-only');
    await stubClipboard(page);
    await startTool(page, mainSession, 'claude');
    await waitForFixtureScreen(page, 'claude');

    const secondPage = await context.newPage();
    secondaryPages.add(secondPage);
    await openPage(secondPage, splitSession);
    await startTool(secondPage, splitSession, 'copilot');
    await waitForFixtureScreen(secondPage, 'copilot');

    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForFunction(() => window.app && window.app.splitContainer, null, { timeout: 10000 });
    await page.evaluate(async (sid) => window.app.splitContainer.createSplit(sid), splitSession);
    await page.waitForFunction((sid) => {
      const sc = window.app && window.app.splitContainer;
      return !!(sc && sc.enabled && sc.splits && sc.splits[1]
        && sc.splits[1].sessionId === sid && sc.splits[1].socket
        && sc.splits[1].terminal);
    }, splitSession, { timeout: 15000 });
    // Wait for the split's replay before checking the source buffers, so a late
    // session_joined reset cannot erase the fixture output under test.
    await waitForFixtureScreen(page, 'copilot', 1);

    const nonce = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const markers = {
      main: `PALETTE_MAIN_${nonce}`,
      right: `PALETTE_RIGHT_${nonce}`,
    };
    // Seed unique sentinels in the hidden single-pane terminal, the visible
    // left split, and the visible right split after replay. The palette must
    // choose the right pane, not pass because a static fixture marker happens
    // to exist in an unrelated buffer.
    await page.evaluate(({ main, right }) => {
      const app = window.app;
      app.terminal.write(`\x1b[2J\x1b[H${main}\r\n`);
      app.splitContainer.splits[0].terminal.write(`\x1b[2J\x1b[H${main}\r\n`);
      app.splitContainer.splits[1].terminal.write(`\x1b[2J\x1b[H${right}\r\n`);
    }, markers);
    await expect.poll(() => page.evaluate(() => ({
      main: window.TerminalCopy.getBufferText(window.app.terminal),
      left: window.TerminalCopy.getBufferText(window.app.splitContainer.splits[0].terminal),
      right: window.TerminalCopy.getBufferText(window.app.splitContainer.splits[1].terminal),
    })), { timeout: 15000 }).toMatchObject({
      main: expect.stringContaining(markers.main),
      left: expect.stringContaining(markers.main),
      right: expect.stringContaining(markers.right),
    });
    const sourceBuffers = await page.evaluate(() => ({
      main: window.TerminalCopy.getBufferText(window.app.terminal),
      left: window.TerminalCopy.getBufferText(window.app.splitContainer.splits[0].terminal),
      right: window.TerminalCopy.getBufferText(window.app.splitContainer.splits[1].terminal),
    }));
    expect(sourceBuffers.main).not.toContain(markers.right);
    expect(sourceBuffers.left).not.toContain(markers.right);
    expect(sourceBuffers.right).not.toContain(markers.main);

    await page.waitForFunction(() => window.app.splitContainer.activeSplitIndex === 1, null, {
      timeout: 10000,
    });
    await page.keyboard.press('Control+k');
    const paletteInput = page.locator('ninja-keys input[type="text"]').first();
    await expect(paletteInput).toBeVisible({ timeout: 10000 });
    await paletteInput.fill('Copy Terminal Output');
    await expect(paletteInput).toHaveValue('Copy Terminal Output');
    const paletteAction = page.getByText('Copy Terminal Output', { exact: true });
    await expect(paletteAction).toBeVisible({ timeout: 10000 });
    await paletteInput.press('Enter');
    await waitForClipboardWrite(page);
    const copied = await page.evaluate(() => window.__cliClipboard.text);
    expect(copied).toContain(markers.right);
    expect(copied).not.toContain(markers.main);
  });

  test('split-pane context copy attributes to the pane terminal', async ({ page, context }) => {
    test.setTimeout(120000);
    const mainSession = await createSessionViaApi(port, 'cli-copy-split-main');
    const splitSession = await createSessionViaApi(port, 'cli-copy-split-right');
    await openPage(page, mainSession);
    test.skip(await page.evaluate(() => !!(window.app && window.app.isMobile)), 'split view is desktop-only');
    await stubClipboard(page);
    await startTool(page, mainSession, 'claude');
    await waitForFixtureScreen(page, 'claude');

    const secondPage = await context.newPage();
    secondaryPages.add(secondPage);
    await openPage(secondPage, splitSession);
    await startTool(secondPage, splitSession, 'copilot');
    await waitForFixtureScreen(secondPage, 'copilot');

    await page.setViewportSize({ width: 1600, height: 900 });
    await page.waitForFunction(() => window.app && window.app.splitContainer, null, { timeout: 10000 });
    await page.evaluate(async (sid) => window.app.splitContainer.createSplit(sid), splitSession);
    await page.waitForFunction((sid) => {
      const sc = window.app && window.app.splitContainer;
      return !!(sc && sc.enabled && sc.splits && sc.splits[1]
        && sc.splits[1].sessionId === sid && sc.splits[1].socket
        && sc.splits[1].terminal);
    }, splitSession, { timeout: 15000 });

    const splitIndex = await page.evaluate((sid) =>
      window.app.splitContainer.splits.findIndex((split) => split.sessionId === sid), splitSession);
    expect(splitIndex).toBe(1);
    await waitForWrappedRow(page, splitIndex);
    const splitMarker = `COPY_SPLIT_RIGHT_${Date.now()}`;
    const mainMarker = getTool('claude').marker;
    await page.evaluate(({ index, marker }) => {
      const split = window.app.splitContainer.splits[index];
      split.terminal.write(`\x1b[2J\x1b[H${marker}\r\n`);
    }, { index: splitIndex, marker: splitMarker });
    await page.waitForFunction(({ index, marker }) => {
      const split = window.app.splitContainer.splits[index];
      if (!split || !split.terminal || !split.terminal.buffer) return false;
      const buffer = split.terminal.buffer.active;
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line && line.translateToString(true).includes(marker)) return true;
      }
      return false;
    }, { index: splitIndex, marker: splitMarker }, { timeout: 15000 });

    // Keep the foreground session on the left. The context-menu resolver must
    // copy the right pane's buffer rather than the app-global active session.
    await page.evaluate((sid) => { window.app.currentClaudeSessionId = sid; }, mainSession);
    await copySplitScreen(page, splitIndex);
    await waitForClipboardWrite(page);
    const copied = await page.evaluate(() => window.__cliClipboard.text);
    expect(copied).toContain(splitMarker);
    expect(copied).not.toContain(mainMarker);
    expect(copied).not.toContain('\x1b');
  });
});
