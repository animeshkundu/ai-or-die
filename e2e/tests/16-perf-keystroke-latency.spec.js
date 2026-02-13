/**
 * Performance benchmark: measures actual keystroke round-trip latency
 * under heavy output load in a real browser via Playwright.
 *
 * Simulates Claude-level heavy streaming (~500KB/sec ANSI-rich output)
 * and measures whether keystrokes are still responsive.
 *
 * Run locally:
 *   npx playwright test e2e/tests/16-perf-keystroke-latency.spec.js --reporter=list
 */
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  waitForTerminalText,
  pressKey,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

test.describe('Performance: keystroke latency under heavy output', () => {
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

  test('keystroke echo under Claude-level heavy streaming', async ({ page }) => {
    test.setTimeout(120000);

    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, `Perf_${Date.now()}`);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);

    // Wait for shell prompt to appear (PowerShell startup can take several seconds)
    await page.waitForFunction(() => {
      const term = window.app && window.app.terminal;
      if (!term) return false;
      const buf = term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString(true).trim().length > 0) return true;
      }
      return false;
    }, { timeout: 10000 }).catch(() => {});

    // Verify terminal is alive by checking the shell printed something
    const termAlive = await page.evaluate(() => {
      const term = window.app && window.app.terminal;
      if (!term) return false;
      const buffer = term.buffer.active;
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line && line.translateToString(true).trim().length > 0) return true;
      }
      return false;
    });
    expect(termAlive).toBe(true);

    // Start HEAVY output generator simulating Claude planning output.
    // Uses node for cross-platform compatibility.
    // 2000 lines of ANSI-rich content at 1ms intervals = ~500KB/sec for ~2 seconds
    const floodCmd = `node -e "let i=0;const iv=setInterval(()=>{if(i++>=2000){clearInterval(iv);return}console.log('\\x1b[1m\\x1b[34m## Step '+i+': Analyzing deps\\x1b[0m');console.log('\\x1b[2m  Resolving: '+'x'.repeat(150)+'\\x1b[0m')},1)"`;

    // Send via WebSocket for precise control
    await page.evaluate((cmd) => {
      window.app.send({ type: 'input', data: cmd + '\r' });
    }, floodCmd);

    // Wait for flood to start
    await waitForTerminalText(page, 'Step 1', 15000);
    await page.waitForTimeout(300); // Let it ramp up

    // Measure keystroke latency while flood is running
    const probeCount = 15;
    const latencies = [];

    for (let i = 0; i < probeCount; i++) {
      const marker = `KP${Date.now()}${i}`;
      const tSend = Date.now();

      // Send keystroke probe via WebSocket (bypasses Playwright keyboard delays)
      await page.evaluate((m) => {
        window.app.send({ type: 'input', data: `echo ${m}\r` });
      }, marker);

      // Wait for marker to appear in the xterm buffer
      try {
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
          marker,
          { timeout: 10000, polling: 25 }  // Poll every 25ms for precision
        );
        const latency = Date.now() - tSend;
        latencies.push(latency);
      } catch {
        latencies.push(10000); // Timeout
      }

      // Random delay between probes: 50-200ms
      await page.waitForTimeout(50 + Math.random() * 150);
    }

    // Wait for flood to finish
    await waitForTerminalText(page, 'Step 2000', 30000);

    // Compute statistics
    const valid = latencies.filter(l => l < 10000);
    const sorted = [...valid].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const max = sorted[sorted.length - 1] || 0;
    const min = sorted[0] || 0;
    const avg = valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : 0;
    const timeouts = latencies.filter(l => l >= 10000).length;

    // Report results
    console.log('\n========================================');
    console.log(' KEYSTROKE LATENCY UNDER HEAVY OUTPUT');
    console.log('========================================');
    console.log(`Flood: ~500KB/sec ANSI-rich (2000 lines, 1ms interval)`);
    console.log(`Probes: ${probeCount} (${valid.length} completed, ${timeouts} timed out)`);
    console.log(`Latencies: ${latencies.map(l => l >= 10000 ? 'TIMEOUT' : l + 'ms').join(', ')}`);
    console.log(`p50: ${p50}ms  |  p95: ${p95}ms  |  max: ${max}ms  |  min: ${min}ms  |  avg: ${avg}ms`);
    console.log('========================================\n');

    // Attach as test artifact for CI comparison
    test.info().annotations.push({
      type: 'perf-results',
      description: JSON.stringify({ p50, p95, max, min, avg, timeouts, samples: valid.length })
    });

    // Assertions
    expect(valid.length).toBeGreaterThanOrEqual(5); // At least 5 probes completed
    expect(p50).toBeLessThan(500); // p50 under 500ms — meaningful regression guard
  });
});
