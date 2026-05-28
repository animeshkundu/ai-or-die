#!/usr/bin/env node

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { RESTART_EXIT_CODE } = require('../src/restart-manager');

// ---------------------------------------------------------------------------
// Tunables — all overridable via env vars so the regression test can shrink
// the windows from hours/minutes to ms. See docs/audits/proc-supervisor-breaker.md
// for the rationale behind every default.
// ---------------------------------------------------------------------------

const RESTART_DELAY_MS         = parseInt(process.env.RESTART_DELAY_MS, 10)         || 1000;     // clean RESTART_EXIT_CODE respawn
const CRASH_RESTART_DELAY_MS   = parseInt(process.env.CRASH_RESTART_DELAY_MS, 10)   || 3000;     // normal crash respawn
const SHUTDOWN_TIMEOUT_MS      = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10)      || 10000;    // SIGINT/SIGTERM hard-kill fallback

// Tier 1 — tight crash loop. 3 crashes in 30 s historically tripped a hard
// process.exit(1). The fix replaces that with an extended restart delay
// (and a loud log) so the daemon ALWAYS comes back; permanent halt strands
// the user's single browser session with no way to recover short of SSH.
const CIRCUIT_BREAKER_WINDOW_MS    = parseInt(process.env.CIRCUIT_BREAKER_WINDOW_MS, 10)    || 30000;   // 30 s
const CIRCUIT_BREAKER_MAX_CRASHES  = parseInt(process.env.CIRCUIT_BREAKER_MAX_CRASHES, 10)  || 3;
const TIER1_RESTART_DELAY_MS       = parseInt(process.env.TIER1_RESTART_DELAY_MS, 10)       || 60000;   // 1 min

// Tier 2 — sustained slow churn. The old breaker missed this entirely:
// a server that crashed once every 31 s respawned forever at the normal
// cadence, masking the underlying bug. Tier 2 catches 5 crashes in 1 h
// and slows respawn to 5 min, dropping log volume by ~100×.
const SUSTAINED_CRASH_WINDOW_MS    = parseInt(process.env.SUSTAINED_CRASH_WINDOW_MS, 10)    || 3600000; // 1 h
const SUSTAINED_CRASH_MAX          = parseInt(process.env.SUSTAINED_CRASH_MAX, 10)          || 5;
const TIER2_RESTART_DELAY_MS       = parseInt(process.env.TIER2_RESTART_DELAY_MS, 10)       || 300000;  // 5 min

const serverScript = process.env.SUPERVISOR_CHILD_SCRIPT
  || path.join(__dirname, 'ai-or-die.js');
const forwardedArgs = process.argv.slice(2);

let child = null;
let shuttingDown = false;
let crashTimestamps = [];
let pendingRestartTimer = null;

// Queued IPC message delivered to the NEXT spawned child once its IPC channel
// is open. Used to forward tier-2 escalation downstream so the in-process
// server can surface it to the browser ("supervisor is throttling restarts").
let pendingWarning = null;

// Test-only: when SUPERVISOR_ESCALATION_OBSERVER=1, the supervisor emits a
// {type:'supervisor_escalation', tier, count, ...} IPC message to ITS parent
// after each classification, so a regression test can deterministically watch
// tier transitions without parsing log strings. Production runs leave it null.
let escalationObserver = process.env.SUPERVISOR_ESCALATION_OBSERVER === '1'
  ? (info) => { try { if (process.send) process.send({ type: 'supervisor_escalation', ...info }); } catch (_) {} }
  : null;

function classifyCrash(now) {
  // Trim to the longer of the two windows so the array stays bounded.
  const cutoff = now - Math.max(CIRCUIT_BREAKER_WINDOW_MS, SUSTAINED_CRASH_WINDOW_MS);
  crashTimestamps = crashTimestamps.filter((t) => t >= cutoff);

  const inSustained = crashTimestamps.filter((t) => now - t < SUSTAINED_CRASH_WINDOW_MS).length;
  const inTight     = crashTimestamps.filter((t) => now - t < CIRCUIT_BREAKER_WINDOW_MS).length;

  // Higher tier wins.
  if (inSustained >= SUSTAINED_CRASH_MAX) {
    return { tier: 2, count: inSustained, windowMs: SUSTAINED_CRASH_WINDOW_MS, delayMs: TIER2_RESTART_DELAY_MS };
  }
  if (inTight >= CIRCUIT_BREAKER_MAX_CRASHES) {
    return { tier: 1, count: inTight, windowMs: CIRCUIT_BREAKER_WINDOW_MS, delayMs: TIER1_RESTART_DELAY_MS };
  }
  return { tier: 0, count: inTight, windowMs: CIRCUIT_BREAKER_WINDOW_MS, delayMs: CRASH_RESTART_DELAY_MS };
}

function logEscalation(decision) {
  if (decision.tier === 2) {
    console.error(
      `\n[supervisor] ⚠ TIER 2 ESCALATION: ${decision.count} crashes within ` +
      `${Math.round(decision.windowMs / 60000)}m. Throttling restart to ` +
      `${Math.round(decision.delayMs / 60000)}m. Underlying defect is likely real — ` +
      `inspect server logs.\n`
    );
  } else if (decision.tier === 1) {
    console.error(
      `\n[supervisor] ⚠ TIER 1 ESCALATION: ${decision.count} crashes within ` +
      `${Math.round(decision.windowMs / 1000)}s. Throttling restart to ` +
      `${Math.round(decision.delayMs / 1000)}s.\n`
    );
  }
}

function startServer() {
  pendingRestartTimer = null;
  const nodeArgs = ['--expose-gc', serverScript, ...forwardedArgs];

  child = spawn(process.execPath, nodeArgs, {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, SUPERVISED: '1' }
  });

  // Flush a queued supervisor_warning into the new child's IPC channel.
  // Best-effort: if the child hasn't yet installed an IPC listener, the
  // message is buffered by Node until it does (or dropped on early exit).
  if (pendingWarning && child.connected) {
    try { child.send(pendingWarning); } catch (_) { /* IPC race during spawn — ignore */ }
    pendingWarning = null;
  }

  child.on('exit', (code, signal) => {
    child = null;

    if (shuttingDown) {
      process.exit(0);
      return;
    }

    if (code === 0) {
      // Clean shutdown — don't restart
      console.log('[supervisor] Server exited cleanly');
      process.exit(0);
      return;
    }

    if (code === RESTART_EXIT_CODE) {
      // Restart requested — quick restart, don't count as crash
      console.log(`[supervisor] Restart requested, respawning in ${RESTART_DELAY_MS}ms...`);
      pendingRestartTimer = setTimeout(startServer, RESTART_DELAY_MS);
      return;
    }

    // Unexpected exit — classify against both windows.
    const now = Date.now();
    crashTimestamps.push(now);
    const decision = classifyCrash(now);

    if (decision.tier > 0) {
      logEscalation(decision);
      // Queue a downstream warning so the next-spawned server can surface
      // it to the browser UI. (Receiver-side wiring is a future task — for
      // now this is a no-op on the child side but adds zero risk.)
      pendingWarning = {
        type: 'supervisor_warning',
        tier: decision.tier,
        crashes: decision.count,
        windowMs: decision.windowMs,
        nextDelayMs: decision.delayMs,
      };
    }

    if (escalationObserver) escalationObserver(decision);

    const exitInfo = signal ? `signal ${signal}` : `code ${code}`;
    console.warn(
      `[supervisor] Server exited unexpectedly (${exitInfo}), restarting in ` +
      `${decision.delayMs}ms... (crash ${decision.count} in ` +
      `${Math.round(decision.windowMs / 1000)}s window, tier ${decision.tier})`
    );
    pendingRestartTimer = setTimeout(startServer, decision.delayMs);
  });

  child.on('error', (err) => {
    // Spawn errors (ENOENT, EACCES) — the child process failed to launch.
    // Port-in-use (EADDRINUSE) errors surface as child exit codes, not here.
    console.error('[supervisor] Failed to spawn server:', err.message);
  });
}

function shutdownGracefully() {
  if (shuttingDown) return;
  shuttingDown = true;

  // Cancel any pending restart timer to prevent spawning a new child during shutdown
  if (pendingRestartTimer) {
    clearTimeout(pendingRestartTimer);
    pendingRestartTimer = null;
  }

  if (!child) {
    process.exit(0);
    return;
  }

  // Send shutdown via IPC (works on Windows, unlike SIGINT)
  try {
    child.send({ type: 'shutdown' });
  } catch (_) {
    // IPC channel may be closed
  }

  // Fallback: force kill after timeout
  const killTimer = setTimeout(() => {
    console.warn('[supervisor] Server did not exit within timeout, force killing');
    // child may be null if exit handler fired between IPC send and this timer
    if (child) {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }
    setTimeout(() => process.exit(1), 1000);
  }, SHUTDOWN_TIMEOUT_MS);
  killTimer.unref();
}

process.on('SIGINT', shutdownGracefully);
// SIGTERM is not available on Windows; IPC message (below) is the Windows shutdown path
process.on('SIGTERM', shutdownGracefully);
// Allow test harness to trigger shutdown via IPC
process.on('message', (msg) => {
  if (msg && msg.type === 'shutdown') shutdownGracefully();
});

startServer();
