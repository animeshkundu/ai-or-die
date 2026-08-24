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
  { id: 'claude', label: 'Claude Code' },
  { id: 'copilot', label: 'GitHub Copilot' },
];

let server;
let port;
let url;
let activeSessionId = null;

function configureFakeBridge(bridge, toolId) {
  bridge.command = process.execPath;
  bridge._prefixArgs = [FIXTURE_PATH, toolId];
  bridge._commandReady = Promise.resolve();
  bridge._availableCache = true;
  bridge._availableCacheTime = Date.now();
}

async function waitForSentToolFrame(page, startIndex, toolId) {
  const expectedType = `start_${toolId}`;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const frame = (page._wsMessages || []).slice(startIndex).find((message) =>
      message.dir === 'sent' && message.type === expectedType
    );
    if (frame) return frame;
    await page.waitForTimeout(50);
  }
  throw new Error(`Timed out waiting for ${expectedType} WebSocket frame`);
}

async function stubClipboard(page) {
  await page.evaluate(() => {
    window.__cliCopyText = null;
    const clipboard = {
      writeText: (text) => {
        window.__cliCopyText = String(text);
        return Promise.resolve();
      },
      readText: () => Promise.resolve(window.__cliCopyText || ''),
    };
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: clipboard,
        configurable: true,
      });
    } catch (_) {
      if (navigator.clipboard) {
        try {
          Object.defineProperty(navigator.clipboard, 'writeText', {
            value: clipboard.writeText,
            configurable: true,
          });
          Object.defineProperty(navigator.clipboard, 'readText', {
            value: clipboard.readText,
            configurable: true,
          });
        } catch (__) {}
      }
    }
  });
}

async function startTool(page, sessionId, toolId) {
  await page.waitForFunction(
    () => window.app && window.app.sessionTabManager
      && window.app.socket && window.app.socket.readyState === 1,
    { timeout: 20000 }
  );
  await page.evaluate(async (sid) => {
    await window.app.joinSession(sid);
  }, sessionId);

  const frameStart = (page._wsMessages || []).length;
  await page.evaluate((id) => {
    window.app.startToolSession(id);
  }, toolId);
  await waitForSentToolFrame(page, frameStart, toolId);

  await page.waitForFunction(() => {
    const overlay = document.getElementById('overlay');
    return !overlay || overlay.style.display === 'none';
  }, { timeout: 30000 });
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
    await copyButton.tap();

    const copied = () => page.evaluate(() =>
      typeof window.__cliCopyText === 'string' && window.__cliCopyText.length > 0
    );
    try {
      await expect.poll(copied, { timeout: 1000 }).toBe(true);
    } catch (_) {
      // WebKit can suppress the compatibility click after touchstart is
      // prevented; dispatching the production click handler keeps this test
      // deterministic while the tap still exercises the touch path.
      await copyButton.dispatchEvent('click');
      await expect.poll(copied, { timeout: 5000 }).toBe(true);
    }

    await expect(page.locator('.toast--success .toast__msg')).toContainText('Copied screen');
    await page.waitForTimeout(350);
    const after = await page.evaluate(() => ({
      keyboardOpen: document.body.classList.contains('keyboard-open'),
      inKeyboardTransition: !!(window.app && window.app._inKeyboardTransition),
      terminalHeight: document.getElementById('terminal')?.style.height || '',
    }));
    expect(after.keyboardOpen).toBe(before.keyboardOpen);
    expect(after.terminalHeight).toBe(before.terminalHeight);
    expect(after.inKeyboardTransition).toBe(false);
    return { mobile, mode: 'control' };
  }

  const terminalArea = page.locator(
    '[data-tid="terminal"] .xterm-screen, #terminal .xterm-screen'
  ).first();
  await terminalArea.click({ button: 'right', position: { x: 100, y: 50 } });
  const copyItem = page.locator('#termContextMenu [data-action="copy"]');
  await expect(copyItem).toBeVisible();
  await expect(copyItem).not.toHaveClass(/disabled/);
  await copyItem.click();
  await expect(page.locator('#copyFeedbackBadge')).toHaveClass(/visible/);
  return { mobile, mode: 'context-menu' };
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
    await fs.promises.writeFile(
      path.join(evidenceDir, `${toolId}-copy.png`),
      screenshot
    );
  }
}

test.beforeAll(async () => {
  ({ server, port, url } = await createServer());
  configureFakeBridge(server.claudeBridge, 'claude');
  configureFakeBridge(server.copilotBridge, 'copilot');
});

test.afterEach(async ({ page }, testInfo) => {
  await attachFailureArtifacts(page, testInfo);
  if (activeSessionId && server) {
    await server.stopToolSession(activeSessionId).catch(() => {});
    activeSessionId = null;
  }
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.describe('CLI-specific terminal copy', () => {
  for (const tool of TOOLS) {
    test(`${tool.label} output copies through the flicker-free terminal UI`, async ({ page }, testInfo) => {
      test.setTimeout(90000);
      const marker = `COPY_E2E_${tool.id.toUpperCase()}_CLI`;
      activeSessionId = await createSessionViaApi(port, `cli-copy-${tool.id}`);
      setupPageCapture(page);
      await page.goto(url);
      await waitForAppReady(page, 20000);
      await waitForWebSocket(page);
      await waitForTerminalCanvas(page);
      await stubClipboard(page);
      await startTool(page, activeSessionId, tool.id);
      await waitForTerminalText(page, marker, 15000);

      await page.evaluate(() => {
        if (window.app && window.app.terminal) window.app.terminal.clearSelection();
      });
      const copyMode = await copyVisibleScreen(page);
      const copiedText = await page.evaluate(() => window.__cliCopyText);
      expect(copiedText).toContain(marker);
      expect(copiedText).toContain(tool.label);

      await captureEvidence(page, testInfo, tool.id, copyMode.mobile);
    });
  }
});
