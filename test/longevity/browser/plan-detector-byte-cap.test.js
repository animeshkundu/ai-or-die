// @ts-check
/**
 * CLIENT-01 regression — plan-detector byte cap.
 *
 * Confirms the in-browser PlanDetector buffer is bounded by bytes (not
 * item count) so a long-lived tab cannot accumulate ~80 MB of retained
 * string memory under sustained heavy PTY output.
 *
 * Pre-fix behaviour: outputBuffer.length capped at ~5000 entries while
 * actual in-memory bytes grew without bound (entries could be 8 KB+).
 * Post-fix behaviour: bufferBytes <= maxBufferBytes (8 MB default).
 *
 * This spec was authored to FAIL on plan-detector.js prior to the
 * CLIENT-01 commit (no `bufferBytes` field; cap measured in items).
 *
 * Ports: createServer uses port 0 → OS-assigned high port (>32K).
 * Never touch port 7777.
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const {
  createServer,
  createSessionViaApi,
} = require(path.join(__dirname, '..', '..', '..', 'e2e', 'helpers', 'server-factory'));
const {
  setupPageCapture,
  attachFailureArtifacts,
  waitForAppReady,
  waitForTerminalCanvas,
  joinSessionAndStartTerminal,
} = require(path.join(__dirname, '..', '..', '..', 'e2e', 'helpers', 'terminal-helpers'));

let server, port, url;

test.beforeAll(async () => {
  ({ server, port, url } = await createServer());
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.afterEach(async ({ page }, testInfo) => {
  await attachFailureArtifacts(page, testInfo);
});

test.describe('CLIENT-01 — plan-detector byte cap', () => {
  test('keeps bufferBytes under maxBufferBytes after 100 MB of synthetic chunks', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, 'plan-detector-byte-cap');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    const result = await page.evaluate(() => {
      const pd = window.app && window.app.planDetector;
      if (!pd) return { error: 'planDetector not attached to window.app' };

      // Sanity: confirm the new byte-cap fields exist (pre-fix this is
      // undefined and the assertion below fires).
      const initialHasBufferBytes = typeof pd.bufferBytes === 'number';
      const initialMaxBufferBytes = pd.maxBufferBytes;

      pd.setTool(null); // reset
      pd.startMonitoring();

      // Push 100 MB total in 8 KB chunks. We deliberately avoid any
      // trigger keyword so processOutput stays on the fast path
      // (push + cap check, no full-buffer scan).
      const chunk = 'x'.repeat(8 * 1024);
      const targetBytes = 100 * 1024 * 1024;
      const iters = Math.ceil(targetBytes / chunk.length);
      for (let i = 0; i < iters; i++) pd.processOutput(chunk);

      // Recompute the live sum to verify accounting integrity.
      const recomputed = pd.outputBuffer.reduce((n, e) => n + e.data.length, 0);

      return {
        initialHasBufferBytes,
        initialMaxBufferBytes,
        bufferBytes: pd.bufferBytes,
        bufferLength: pd.outputBuffer.length,
        recomputed,
        totalPushed: iters,
      };
    });

    expect(result.error).toBeUndefined();
    expect(result.initialHasBufferBytes).toBe(true);
    expect(typeof result.initialMaxBufferBytes).toBe('number');
    expect(result.initialMaxBufferBytes).toBeGreaterThan(0);

    // Hard cap holds under 100 MB of synthetic input.
    expect(result.bufferBytes).toBeLessThanOrEqual(result.initialMaxBufferBytes);

    // Accounting invariant: bufferBytes equals the sum of live data.length.
    expect(result.bufferBytes).toBe(result.recomputed);

    // We must have evicted most of what we pushed.
    expect(result.bufferLength).toBeLessThan(result.totalPushed / 2);
  });
});
