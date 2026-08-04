#!/usr/bin/env node
'use strict';

// Tests the specific hypothesis that Windows CI failures in
// e2e/tests/02-terminal-io.spec.js:54 are the tracked Windows shell-latency
// defect surfacing, rather than a flaky test.
//
// The test does:
//   typeInTerminal(`echo <M>_LINE1 && echo <M>_LINE2`); pressKey(Enter)
//   waitForTerminalText(<M>_LINE1, 15000)
//   waitForTerminalText(<M>_LINE2,  5000)   <-- the 5s clock starts AFTER LINE1
//
// `&&` in PowerShell 7 is a pipeline chain operator, so those are TWO separate
// command executions. The second budget therefore has to cover a whole extra
// `echo` round-trip. Measured on Windows (scripts/probe-shell-rtt.js) a single
// echo round-trip is 450-580ms p50, p95 620-780ms, with idle outliers past 3s.
//
// This measures the LINE1->LINE2 gap directly, many times, and reports how it
// sits against the 5000ms budget. If the tail approaches or crosses 5s, the
// test is under-provisioned against real measured platform behaviour and the CI
// failure is the defect reporting itself.
//
// Usage: node scripts/probe-multiline-gap.js [iterations]

const path = require('path');
const { chromium } = require('playwright');
const {
  createServer, createSessionViaApi,
} = require(path.join(__dirname, '..', 'e2e', 'helpers', 'server-factory'));
const {
  waitForAppReady, waitForTerminalCanvas, joinSessionAndStartTerminal,
} = require(path.join(__dirname, '..', 'e2e', 'helpers', 'terminal-helpers'));

const N = parseInt(process.argv[2], 10) || 25;
const LINE2_BUDGET = 5000;
const CR = String.fromCharCode(13);

function stats(v) {
  const ok = v.filter((x) => x != null).sort((a, b) => a - b);
  if (!ok.length) return null;
  const at = (p) => ok[Math.min(ok.length - 1, Math.floor(ok.length * p))];
  return { p50: at(0.5), p90: at(0.9), p95: at(0.95), p99: at(0.99), max: ok[ok.length - 1], min: ok[0], n: ok.length };
}

async function main() {
  const { server, port, url } = await createServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const seeText = (m, budget) => page.waitForFunction((s) => {
    const b = window.app && window.app.terminal && window.app.terminal.buffer.active;
    if (!b) return false;
    for (let i = 0; i < b.length; i++) {
      const l = b.getLine(i);
      if (l && l.translateToString(true).includes(s)) return true;
    }
    return false;
  }, m, { timeout: budget, polling: 25 });

  try {
    const sessionId = await createSessionViaApi(port, 'multiline-gap');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await page.waitForTimeout(4000);

    const toLine1 = [];
    const gap = [];
    let line2Timeouts = 0;

    for (let i = 0; i < N; i++) {
      const marker = `IO_MULTI_${Date.now()}_${i}`;
      const tSend = Date.now();
      await page.evaluate(({ m, cr }) => {
        window.app.send({ type: 'input', data: `echo ${m}_LINE1 && echo ${m}_LINE2` + cr });
      }, { m: marker, cr: CR });

      try {
        await seeText(`${marker}_LINE1`, 15000);
      } catch (_) {
        toLine1.push(null); gap.push(null); continue;
      }
      const tL1 = Date.now();
      toLine1.push(tL1 - tSend);

      try {
        await seeText(`${marker}_LINE2`, LINE2_BUDGET);
        gap.push(Date.now() - tL1);
      } catch (_) {
        gap.push(null);
        line2Timeouts++;
      }
      await page.waitForTimeout(120);
    }

    const s1 = stats(toLine1);
    const s2 = stats(gap);
    console.log(`\n=== multi-line gap probe (platform=${process.platform}, n=${N}) ===\n`);
    if (s1) console.log(`  send -> LINE1   p50 ${s1.p50}ms  p90 ${s1.p90}ms  p95 ${s1.p95}ms  max ${s1.max}ms   (budget 15000ms)`);
    if (s2) console.log(`  LINE1 -> LINE2  p50 ${s2.p50}ms  p90 ${s2.p90}ms  p95 ${s2.p95}ms  max ${s2.max}ms   (budget ${LINE2_BUDGET}ms)`);
    console.log(`  LINE2 exceeded its ${LINE2_BUDGET}ms budget: ${line2Timeouts}/${N}`);
    console.log(`\n  raw gaps: ${gap.map((g) => (g == null ? 'TIMEOUT' : g)).join(', ')}`);
    if (s2) {
      const headroom = (LINE2_BUDGET / s2.max).toFixed(1);
      console.log(`\n  worst observed gap uses 1/${headroom} of the budget.`);
    }
    console.log('');
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
