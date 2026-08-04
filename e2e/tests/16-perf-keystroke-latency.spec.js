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

    // Wait for shell prompt to appear (PowerShell startup can be slow)
    await page.waitForTimeout(4000);

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

    // One probe: send `echo <marker>` and time until the marker is visible in
    // the xterm buffer.
    //
    // NOTE this is a SHELL COMMAND round-trip, not a raw keystroke echo. That
    // distinction is the whole reason this test was rewritten: the command has
    // to be parsed and executed by the shell, and on Windows/PowerShell that
    // alone costs 450-580ms with no streaming whatsoever (measured n=20 across
    // three runs; see scripts/probe-shell-rtt.js).
    const probeOnce = async (prefix, i) => {
      const marker = `${prefix}${Date.now()}${i}`;
      const tSend = Date.now();
      await page.evaluate((m) => {
        window.app.send({ type: 'input', data: `echo ${m}\r` });
      }, marker);
      try {
        await page.waitForFunction((searchText) => {
          const term = window.app && window.app.terminal;
          if (!term) return false;
          const buffer = term.buffer.active;
          for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i);
            if (line && line.translateToString(true).includes(searchText)) return true;
          }
          return false;
        }, marker, { timeout: 10000, polling: 25 });
        return Date.now() - tSend;
      } catch {
        return 10000;
      }
    };

    const summarize = (values) => {
      const valid = values.filter((l) => l < 10000);
      const sorted = [...valid].sort((a, b) => a - b);
      return {
        p50: sorted[Math.floor(sorted.length * 0.5)] || 0,
        p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0,
        max: sorted[sorted.length - 1] || 0,
        min: sorted[0] || 0,
        stalls: values.filter((l) => l >= 10000).length,
        samples: valid.length,
      };
    };

    // ---- Phase 1: BASELINE on an idle shell, before any flood.
    // This is what makes the assertion below platform-independent. The previous
    // version asserted an absolute `p50 < 500ms`, which is BELOW the measured
    // idle floor on Windows — it could only ever pass by luck, and did.
    const baseline = [];
    for (let i = 0; i < 8; i++) {
      baseline.push(await probeOnce('BL', i));
      await page.waitForTimeout(50 + Math.random() * 100);
    }
    const base = summarize(baseline);

    // ---- Phase 2: the same probe under heavy streaming.
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
      latencies.push(await probeOnce('KP', i));
      // Random delay between probes: 50-200ms
      await page.waitForTimeout(50 + Math.random() * 150);
    }

    // Wait for flood to finish
    await waitForTerminalText(page, 'Step 2000', 30000);

    const load = summarize(latencies);
    const ratio = base.p50 ? load.p50 / base.p50 : 0;

    // Report results
    console.log('\n========================================');
    console.log(' KEYSTROKE LATENCY UNDER HEAVY OUTPUT');
    console.log('========================================');
    console.log(`Flood: ~500KB/sec ANSI-rich (2000 lines, 1ms interval)`);
    console.log(`Baseline (idle): p50 ${base.p50}ms | p95 ${base.p95}ms | max ${base.max}ms | stalls ${base.stalls}/8`);
    console.log(`Under flood    : p50 ${load.p50}ms | p95 ${load.p95}ms | max ${load.max}ms | stalls ${load.stalls}/${probeCount}`);
    console.log(`Latencies: ${latencies.map(l => l >= 10000 ? 'TIMEOUT' : l + 'ms').join(', ')}`);
    console.log(`Degradation ratio (flood p50 / idle p50): ${ratio.toFixed(2)}x`);
    console.log('========================================\n');

    test.info().annotations.push({
      type: 'perf-results',
      description: JSON.stringify({ baseline: base, underFlood: load, ratio: Number(ratio.toFixed(2)) })
    });

    // Assertions.
    //
    // This used to be `expect(p50).toBeLessThan(500)`. That bound is BELOW the
    // platform's own floor for what this probe measures: it sends a whole shell
    // command, and PowerShell parsing + executing `echo` costs 450-580ms on
    // Windows with no streaming at all (n=20, three runs — the measured
    // flood/idle p50 ratios were 0.97x, 1.02x and 0.96x). So the old assertion
    // was not a regression guard, it was a coin flip on shell speed, and it
    // passed locally at 481ms purely by luck.
    //
    // What this test is FOR is whether heavy streaming degrades interactivity.
    // Comparing against a baseline measured in the same run on the same machine
    // states exactly that, and is immune to how fast the shell or runner is.
    expect(base.samples).toBeGreaterThanOrEqual(5);
    expect(load.samples).toBeGreaterThanOrEqual(5);
    expect(ratio).toBeLessThan(2.5);

    // KNOWN OPEN DEFECT, deliberately not gated here: when a flood STARTS there
    // is a 7-10s stall before interactivity recovers (raw samples reproducibly
    // begin 10000, 10000, 7099 then settle to ~450-620ms). The previous version
    // hid this — it computed p50 over `latencies.filter(l => l < 10000)`, so the
    // stalls were dropped before any statistic was taken.
    //
    // It is surfaced rather than asserted because gating it today would only
    // hold CI red without fixing anything; the fix belongs in its own change.
    // Add the tail assertion here once that lands.
    if (load.stalls > base.stalls) {
      console.warn(
        `::warning::flood-onset stall: ${load.stalls} probe(s) exceeded 10s under flood `
        + `vs ${base.stalls} idle. Known open defect — do not silence, fix the stall.`
      );
    }
  });
});
