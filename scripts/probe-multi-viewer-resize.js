#!/usr/bin/env node
'use strict';

// Multi-viewer terminal geometry probe.
//
// ADR-0046 makes FitCoordinator the sole owner of resize on the CLIENT, but it
// only ever reasons about ONE browser. The server (src/server.js 'resize' case)
// applies whatever geometry any member connection sends straight to the PTY and
// does not tell the other viewers, so a PTY has one size while N viewers each
// believe their own.
//
// This measures what actually happens when a desktop and a phone are attached
// to the SAME session, which is the "moving desktop -> iphone and back" case.
//
// The PTY's true width is read from the shell itself rather than inferred, so
// the numbers are the ones the running program actually sees.
//
// Usage: node scripts/probe-multi-viewer-resize.js

const path = require('path');
const { chromium } = require('playwright');
const {
  createServer, createSessionViaApi,
} = require(path.join(__dirname, '..', 'e2e', 'helpers', 'server-factory'));
const {
  waitForAppReady, waitForTerminalCanvas, joinSessionAndStartTerminal,
} = require(path.join(__dirname, '..', 'e2e', 'helpers', 'terminal-helpers'));

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };   // iPhone 14 Pro CSS px
const CR = String.fromCharCode(13);

const results = [];
function record(scenario, detail, ok) {
  results.push({ scenario, detail, ok });
  const tag = ok === true ? '  OK  ' : ok === false ? ' FAIL ' : ' ---- ';
  console.log(`[${tag}] ${scenario}\n         ${detail}`);
}

// xterm's own view of its grid, per page.
async function xtermDims(page) {
  return page.evaluate(() => {
    const t = window.app && window.app.terminal;
    return t ? { cols: t.cols, rows: t.rows } : null;
  });
}

// Ask the shell what IT thinks the terminal is. This is the number that decides
// how the running program wraps, so it is the only authoritative one.
async function ptyDims(page, tag) {
  const marker = `PTYSZ_${tag}_${Date.now()}`;
  await page.evaluate(({ m, cr }) => {
    window.app.send({
      type: 'input',
      data: `echo "${m}:$([Console]::WindowWidth)x$([Console]::WindowHeight)"` + cr,
    });
  }, { m: marker, cr: CR });

  try {
    const text = await page.waitForFunction((m) => {
      const b = window.app.terminal.buffer.active;
      for (let i = 0; i < b.length; i++) {
        const l = b.getLine(i);
        if (!l) continue;
        const s = l.translateToString(true);
        // Skip the echoed command itself; match only the produced output.
        const hit = s.match(new RegExp(m + ':(\\d+)x(\\d+)'));
        if (hit && !s.includes('WindowWidth')) return hit[0];
      }
      return null;
    }, marker, { timeout: 15000, polling: 50 });
    const raw = await text.jsonValue();
    const m = raw.match(/:(\d+)x(\d+)/);
    return { cols: parseInt(m[1], 10), rows: parseInt(m[2], 10) };
  } catch (_) {
    return null;
  }
}

async function joinOnly(page, sessionId) {
  await page.waitForFunction(
    () => window.app && window.app.sessionTabManager
      && window.app.socket && window.app.socket.readyState === 1,
    { timeout: 20000 }
  );
  await page.evaluate(async (sid) => { await window.app.joinSession(sid); }, sessionId);
  await page.waitForTimeout(2500); // let FitCoordinator measure + send
}

async function main() {
  const { server, port, url } = await createServer();
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ viewport: DESKTOP });
  const ctxB = await browser.newContext({ viewport: PHONE, isMobile: false });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    const sessionId = await createSessionViaApi(port, 'multi-viewer');

    // --- Scenario 1: desktop alone ---------------------------------------
    await pageA.goto(url);
    await waitForAppReady(pageA);
    await waitForTerminalCanvas(pageA);
    await joinSessionAndStartTerminal(pageA, sessionId);
    await pageA.waitForTimeout(1500);

    const aAlone = await xtermDims(pageA);
    const ptyAlone = await ptyDims(pageA, 'A1');
    record(
      '1. desktop alone',
      `xterm=${aAlone.cols}x${aAlone.rows}  pty=${ptyAlone ? ptyAlone.cols + 'x' + ptyAlone.rows : 'UNREADABLE'}`,
      ptyAlone ? ptyAlone.cols === aAlone.cols : null
    );

    // --- Scenario 2: phone joins the same session ------------------------
    await pageB.goto(url);
    await waitForAppReady(pageB);
    await waitForTerminalCanvas(pageB);
    await joinOnly(pageB, sessionId);

    const bDims = await xtermDims(pageB);
    const aAfterB = await xtermDims(pageA);
    const ptyAfterB = await ptyDims(pageA, 'A2');

    record(
      '2. phone joined - phone consistent with PTY?',
      `phone xterm=${bDims ? bDims.cols + 'x' + bDims.rows : 'n/a'}  pty=${ptyAfterB ? ptyAfterB.cols + 'x' + ptyAfterB.rows : 'UNREADABLE'}`,
      ptyAfterB && bDims ? ptyAfterB.cols === bDims.cols : null
    );
    record(
      '2b. phone joined - DESKTOP still consistent with PTY?',
      `desktop xterm=${aAfterB.cols}x${aAfterB.rows}  pty=${ptyAfterB ? ptyAfterB.cols + 'x' + ptyAfterB.rows : 'UNREADABLE'}`
      + (ptyAfterB && aAfterB.cols !== ptyAfterB.cols
        ? `  <-- desktop renders ${aAfterB.cols} cols but program wraps at ${ptyAfterB.cols}` : ''),
      ptyAfterB ? ptyAfterB.cols === aAfterB.cols : null
    );

    // --- Scenario 3: does the desktop ever recover on its own? -----------
    await pageA.waitForTimeout(4000);
    const ptySettle = await ptyDims(pageA, 'A3');
    const aSettle = await xtermDims(pageA);
    record(
      '3. after 4s settle - desktop self-heals?',
      `desktop xterm=${aSettle.cols}x${aSettle.rows}  pty=${ptySettle ? ptySettle.cols + 'x' + ptySettle.rows : 'UNREADABLE'}`,
      ptySettle ? ptySettle.cols === aSettle.cols : null
    );

    // --- Scenario 4: phone leaves; does desktop reclaim its geometry? ----
    await ctxB.close();
    await pageA.waitForTimeout(4000);
    const ptyAfterLeave = await ptyDims(pageA, 'A4');
    const aAfterLeave = await xtermDims(pageA);
    record(
      '4. phone disconnected - desktop reclaims geometry?',
      `desktop xterm=${aAfterLeave.cols}x${aAfterLeave.rows}  pty=${ptyAfterLeave ? ptyAfterLeave.cols + 'x' + ptyAfterLeave.rows : 'UNREADABLE'}`,
      ptyAfterLeave ? ptyAfterLeave.cols === aAfterLeave.cols : null
    );

    // --- Scenario 5: plain desktop window resize (single viewer) ---------
    await pageA.setViewportSize({ width: 1000, height: 720 });
    await pageA.waitForTimeout(2500);
    const aResized = await xtermDims(pageA);
    const ptyResized = await ptyDims(pageA, 'A5');
    record(
      '5. desktop browser resized (sole viewer)',
      `xterm=${aResized.cols}x${aResized.rows}  pty=${ptyResized ? ptyResized.cols + 'x' + ptyResized.rows : 'UNREADABLE'}`,
      ptyResized ? ptyResized.cols === aResized.cols : null
    );

    console.log('\n=== SUMMARY ===');
    const failed = results.filter((r) => r.ok === false);
    const unknown = results.filter((r) => r.ok === null);
    for (const r of results) {
      console.log(`  ${r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'UNKNOWN'}  ${r.scenario}`);
    }
    console.log(`\n  ${results.length - failed.length - unknown.length} pass, ${failed.length} fail, ${unknown.length} unknown\n`);
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
