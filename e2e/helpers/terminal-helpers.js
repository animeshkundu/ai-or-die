/**
 * Wait for the app to finish initialization.
 * Checks that window.app exists and the terminal is created.
 * @param {import('@playwright/test').Page} page
 * @param {number} [timeoutMs=30000]
 */
async function waitForAppReady(page, timeoutMs = 30000) {
  await page.waitForFunction(
    () => window.app && window.app.terminal,
    { timeout: timeoutMs }
  );
}

/**
 * Wait for xterm.js to initialize and render.
 * Waits for the .xterm container (created by terminal.open()) rather than
 * the canvas, which may not render in headless Chrome on CI.
 * @param {import('@playwright/test').Page} page
 * @param {number} [timeoutMs=30000]
 */
async function waitForTerminalCanvas(page, timeoutMs = 30000) {
  await page.waitForSelector('[data-tid="terminal"] .xterm, #terminal .xterm', {
    state: 'attached',
    timeout: timeoutMs
  });
  await page.waitForFunction(
    () => {
      const term = window.app && window.app.terminal;
      return term && typeof term.cols === 'number' && term.cols > 0;
    },
    { timeout: timeoutMs }
  );
}

/**
 * Focus the terminal's hidden textarea so keyboard input goes to xterm.js.
 * @param {import('@playwright/test').Page} page
 */
async function focusTerminal(page) {
  await page.evaluate(() => {
    if (window.app && window.app.terminal) {
      window.app.terminal.focus();
    }
  });
  // Verify focus landed on the xterm textarea
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return el && el.classList.contains('xterm-helper-textarea');
  });
  if (!focused) {
    // Fallback: click the terminal area to trigger focus
    await page.click('#terminal .xterm-screen');
    await page.waitForTimeout(100);
  }
}

/**
 * Type text into the terminal with per-character delay for reliability.
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 */
async function typeInTerminal(page, text) {
  await focusTerminal(page);
  await page.keyboard.type(text, { delay: 30 });
}

/**
 * Press a key or key combination in the terminal.
 * @param {import('@playwright/test').Page} page
 * @param {string} key - e.g. 'Enter', 'Control+c', 'Shift+Enter'
 */
async function pressKey(page, key) {
  await focusTerminal(page);
  await page.keyboard.press(key);
}

/**
 * Read terminal buffer content via xterm.js API.
 * This is the only reliable way to read canvas-rendered terminal text.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>}
 */
async function readTerminalContent(page) {
  return page.evaluate(() => {
    const term = window.app && window.app.terminal;
    if (!term) return '';
    const buffer = term.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n');
  });
}

/**
 * Wait for specific text to appear in the terminal buffer.
 * Uses page.waitForFunction for efficient polling.
 * @param {import('@playwright/test').Page} page
 * @param {string} text - Text to search for
 * @param {number} [timeoutMs=15000]
 */
async function waitForTerminalText(page, text, timeoutMs = 15000) {
  await page.waitForFunction(
    (searchText) => {
      const term = window.app && window.app.terminal;
      if (!term) return false;
      const buffer = term.buffer.active;
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line && line.translateToString(true).includes(searchText)) {
          return true;
        }
      }
      return false;
    },
    text,
    { timeout: timeoutMs, polling: 200 }
  );
}

/**
 * Get terminal dimensions from xterm.js.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{cols: number, rows: number}>}
 */
async function getTerminalDimensions(page) {
  return page.evaluate(() => {
    const term = window.app && window.app.terminal;
    if (!term) return { cols: 0, rows: 0 };
    return { cols: term.cols, rows: term.rows };
  });
}

/**
 * Setup WebSocket message logging and console log capture on a page.
 * Must be called BEFORE page.goto() to capture the initial WebSocket.
 * @param {import('@playwright/test').Page} page
 */
function setupPageCapture(page) {
  page._wsMessages = [];
  page._consoleLogs = [];

  page.on('websocket', (ws) => {
    ws.on('framesent', (frame) => {
      try { page._wsMessages.push({ dir: 'sent', ...JSON.parse(frame.payload) }); } catch {}
    });
    ws.on('framereceived', (frame) => {
      try { page._wsMessages.push({ dir: 'recv', ...JSON.parse(frame.payload) }); } catch {}
    });
  });

  page.on('console', (msg) => {
    page._consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
  });
}

/**
 * Attach debug artifacts on test failure.
 * Call this in afterEach.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').TestInfo} testInfo
 */
async function attachFailureArtifacts(page, testInfo) {
  if (testInfo.status !== testInfo.expectedStatus) {
    const termContent = await readTerminalContent(page).catch(() => '[unable to read terminal]');
    await testInfo.attach('terminal-buffer', { body: termContent, contentType: 'text/plain' });
    await testInfo.attach('websocket-log', {
      body: JSON.stringify(page._wsMessages || [], null, 2),
      contentType: 'application/json'
    });
    await testInfo.attach('console-log', {
      body: (page._consoleLogs || []).join('\n'),
      contentType: 'text/plain'
    });
    await testInfo.attach('screenshot', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png'
    });
  }
}

/**
 * Wait for the WebSocket to be connected.
 * The app connects during init() but it may take time on CI.
 * @param {import('@playwright/test').Page} page
 * @param {number} [timeoutMs=15000]
 */
async function waitForWebSocket(page, timeoutMs = 15000) {
  await page.waitForFunction(
    () => window.app && window.app.socket && window.app.socket.readyState === 1, // WebSocket.OPEN
    { timeout: timeoutMs }
  );
}

/**
 * Join a pre-created session and start a terminal tool.
 * Waits for the WebSocket to be connected (app.init() now connects early),
 * then joins and starts the terminal.
 * @param {import('@playwright/test').Page} page
 * @param {string} sessionId
 */
async function joinSessionAndStartTerminal(page, sessionId) {
  // app.init() connects the WebSocket early, so just wait for it
  await waitForWebSocket(page, 20000);

  await page.evaluate((sid) => {
    window.app.send({ type: 'join_session', sessionId: sid });
  }, sessionId);

  await page.waitForFunction(
    () => window.app.currentClaudeSessionId != null,
    { timeout: 15000 }
  );

  await page.evaluate(() => {
    window.app.startToolSession('terminal');
  });

  await page.waitForFunction(() => {
    const overlay = document.getElementById('overlay');
    return !overlay || overlay.style.display === 'none';
  }, { timeout: 30000 });

  // Drain initial shell output
  await page.waitForTimeout(5000);
}

/**
 * Wait for a specific WebSocket message type to appear in page._wsMessages.
 * Polls until the message is found or timeout is reached.
 * @param {import('@playwright/test').Page} page
 * @param {string} dir - 'sent' or 'recv'
 * @param {string} type - message type to wait for
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<object>} the matched message
 */
async function waitForWsMessage(page, dir, type, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const msg = page._wsMessages.find(m => m.dir === dir && m.type === type);
    if (msg) return msg;
    await page.waitForTimeout(100);
  }
  return null;
}

module.exports = {
  waitForAppReady,
  waitForTerminalCanvas,
  focusTerminal,
  typeInTerminal,
  pressKey,
  readTerminalContent,
  waitForTerminalText,
  getTerminalDimensions,
  setupPageCapture,
  attachFailureArtifacts,
  waitForWebSocket,
  waitForWsMessage,
  joinSessionAndStartTerminal,
};
