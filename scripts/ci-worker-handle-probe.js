#!/usr/bin/env node
'use strict';

// Diagnostic probe for "worker-N process did not exit within 300000ms after
// stop, force-killed it" — an intermittent Playwright failure on the Windows CI
// runners that reports NO failing assertions. The tests pass; the worker process
// simply refuses to exit, so something is holding the libuv loop open.
//
// Static reading has not answered it. The PTY console-list leak found earlier
// (a forked helper that throws plus a non-unref'd 5000ms timer, two handles per
// PTY kill) is real but CANNOT explain a 300-second hang: that timer is bounded
// at 5 seconds. So the cause is still unknown and needs to be observed on the
// runner rather than inferred.
//
// Loaded via NODE_OPTIONS=--require, so it attaches to EVERY process in the run,
// including each Playwright worker. It does nothing but report.
//
// Why an unref'd interval is the right shape:
//   - unref'd means it never keeps the loop alive, so it cannot cause the very
//     condition it is measuring, and a healthy worker exits exactly as before.
//   - but an unref'd timer still FIRES while the loop is alive for any other
//     reason — which is precisely the hang. So a stuck worker keeps printing,
//     and the last report before the force-kill names what is holding it.
//
// process.getActiveResourcesInfo() is the public API (Node 18.4+). It returns
// resource TYPE names, which is what identifies the culprit class.

const INTERVAL_MS = Number(process.env.HANDLE_PROBE_INTERVAL_MS || 30000);
const LABEL = process.env.HANDLE_PROBE_LABEL || 'handle-probe';

function snapshot() {
  let resources = [];
  try {
    if (typeof process.getActiveResourcesInfo === 'function') {
      resources = process.getActiveResourcesInfo();
    }
  } catch (_) { /* report nothing rather than throw inside a diagnostic */ }

  // Collapse to type -> count. The individual entries are not distinguishable
  // through this API, and the count per type is what points at a subsystem.
  const counts = Object.create(null);
  for (const r of resources) counts[r] = (counts[r] || 0) + 1;

  // Timers and TTYs are ambient in any Node process; what matters is which
  // types persist and grow. Print everything and let the reader judge.
  const parts = Object.keys(counts).sort().map((k) => `${k}=${counts[k]}`);
  const mem = process.memoryUsage();
  return `[${LABEL}] pid=${process.pid} uptime=${Math.round(process.uptime())}s `
    + `rss=${Math.round(mem.rss / 1048576)}MB active=${resources.length} `
    + `{${parts.join(' ') || 'none'}}`;
}

const timer = setInterval(() => {
  try { process.stderr.write(snapshot() + '\n'); } catch (_) { /* ignore */ }
}, INTERVAL_MS);
if (typeof timer.unref === 'function') timer.unref();

// One report as the process winds down. If this prints and the process still
// does not exit, whatever is listed here outlived every teardown hook.
process.on('beforeExit', () => {
  try { process.stderr.write(snapshot() + ' (beforeExit)\n'); } catch (_) { /* ignore */ }
});
