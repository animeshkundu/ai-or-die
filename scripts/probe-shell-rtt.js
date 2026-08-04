#!/usr/bin/env node
'use strict';

// Minimal, UNINSTRUMENTED A/B for the question behind
// e2e/tests/16-perf-keystroke-latency.spec.js: does the output flood actually
// degrade interactive round-trip, or is the measured latency the inherent cost
// of the probe itself?
//
// Answer, measured n=20 per phase across three runs on Windows:
//   idle p50 526ms / flood p50 510ms  -> 0.97x
//   idle p50 451ms / flood p50 460ms  -> 1.02x
//   idle p50 577ms / flood p50 552ms  -> 0.96x
// The flood does not move p50. That ~450-580ms is PowerShell parsing and
// executing `echo`, which is why an absolute `p50 < 500ms` assertion was below
// the platform's own floor and could only pass by luck.
//
// The flood DOES cause real damage in the tail: probes at flood onset
// reproducibly read 10000, 10000, 7099 before settling. That stall is the real
// defect and is tracked separately.
//
// Deliberately carries NO instrumentation. An earlier version tapped
// Playwright's websocket frame events; routing every frame through CDP inflated
// the idle baseline from 74ms to 681ms, i.e. the instrument changed the thing it
// measured. Nothing here touches app internals.
//
// Usage: node scripts/probe-shell-rtt.js [samplesPerPhase]

const path = require('path');
const { chromium } = require('playwright');
const {
  createServer, createSessionViaApi,
} = require(path.join(__dirname, '..', 'e2e', 'helpers', 'server-factory'));
const {
  waitForAppReady, waitForTerminalCanvas, joinSessionAndStartTerminal,
} = require(path.join(__dirname, '..', 'e2e', 'helpers', 'terminal-helpers'));

const N = parseInt(process.argv[2], 10) || 20;
const TIMEOUT = 10000;
const CR = String.fromCharCode(13);

function stats(values) {
  const ok = values.filter((v) => v < TIMEOUT).sort((a, b) => a - b);
  const to = values.length - ok.length;
  if (!ok.length) return { p50: 0, p95: 0, min: 0, max: 0, to };
  return {
    p50: ok[Math.floor(ok.length * 0.5)],
    p95: ok[Math.min(ok.length - 1, Math.floor(ok.length * 0.95))],
    min: ok[0],
    max: ok[ok.length - 1],
    to,
  };
}

function show(label, s, raw) {
  console.log(
    `  ${label.padEnd(20)} p50 ${String(s.p50).padStart(5)}ms  `
    + `p95 ${String(s.p95).padStart(5)}ms  min ${String(s.min).padStart(5)}ms  `
    + `max ${String(s.max).padStart(5)}ms  stalls ${s.to}/${raw.length}`
  );
}

async function main() {
  const { server, port, url } = await createServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  async function probe(prefix, i) {
    const marker = `${prefix}${Date.now()}${i}`;
    const t0 = Date.now();
    await page.evaluate(({ m, cr }) => {
      window.app.send({ type: 'input', data: 'echo ' + m + cr });
    }, { m: marker, cr: CR });
    try {
      await page.waitForFunction((m) => {
        const b = window.app.terminal.buffer.active;
        for (let i = 0; i < b.length; i++) {
          const l = b.getLine(i);
          if (l && l.translateToString(true).includes(m)) return true;
        }
        return false;
      }, marker, { timeout: TIMEOUT, polling: 25 });
      return Date.now() - t0;
    } catch (_) { return TIMEOUT; }
  }

  try {
    const sessionId = await createSessionViaApi(port, 'rtt-probe');
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    await page.waitForTimeout(4000);

    // Discard the first few: shell warm-up is not what is being compared.
    for (let i = 0; i < 3; i++) await probe('WARM', i);

    const idle = [];
    for (let i = 0; i < N; i++) {
      idle.push(await probe('ID', i));
      await page.waitForTimeout(50 + Math.random() * 150);
    }

    const floodCmd = `node -e "let i=0;const iv=setInterval(()=>{if(i++>=4000){clearInterval(iv);return}console.log('\\x1b[1m\\x1b[34m## Step '+i+': Analyzing deps\\x1b[0m');console.log('\\x1b[2m  Resolving: '+'x'.repeat(150)+'\\x1b[0m')},1)"`;
    await page.evaluate(({ cmd, cr }) => {
      window.app.send({ type: 'input', data: cmd + cr });
    }, { cmd: floodCmd, cr: CR });
    await page.waitForFunction(() => {
      const b = window.app.terminal.buffer.active;
      for (let i = 0; i < b.length; i++) {
        const l = b.getLine(i);
        if (l && l.translateToString(true).includes('Step 1')) return true;
      }
      return false;
    }, null, { timeout: 20000 });
    await page.waitForTimeout(300);

    const flood = [];
    for (let i = 0; i < N; i++) {
      flood.push(await probe('FL', i));
      await page.waitForTimeout(50 + Math.random() * 150);
    }

    const si = stats(idle);
    const sf = stats(flood);
    console.log(`\n=== shell round-trip A/B (platform=${process.platform}, n=${N} each) ===\n`);
    show('IDLE (no flood)', si, idle);
    show('UNDER FLOOD', sf, flood);
    console.log(`\n  flood/idle p50 ratio: ${si.p50 ? (sf.p50 / si.p50).toFixed(2) : 'n/a'}x`);
    console.log('  raw idle :', idle.join(', '));
    console.log('  raw flood:', flood.join(', '));
    console.log('\n  A ratio near 1x means the flood is not moving p50 and the probe is');
    console.log('  measuring shell command round-trip. Look at the tail for the real defect.\n');
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
