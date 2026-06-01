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

// Hard cap on the crashTimestamps array so a pathological 100/sec crash loop
// over an hour can't grow it to 360 k entries. 1024 is comfortably more than
// any realistic backoff cadence would produce in 1 h (even at tier-2's
// minimum 5-min cadence that's 12 entries/h; at tier-1's 60-s cadence it's
// 60/h). Trimming oldest-first preserves the most-recent-N invariant.
const CRASH_TIMESTAMPS_CAP         = parseInt(process.env.CRASH_TIMESTAMPS_CAP, 10)         || 1024;

const serverScript = process.env.SUPERVISOR_CHILD_SCRIPT
  || path.join(__dirname, 'ai-or-die.js');
const forwardedArgs = process.argv.slice(2);

let child = null;
let shuttingDown = false;
let spawnCount = 0;
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

  // Defence-in-depth cap (SUP-REL review). The time-window trim already
  // bounds the array to "crashes in the last hour"; this guards against
  // an extreme pathological case (e.g. CRASH_RESTART_DELAY_MS overridden
  // to 0 in a test, or a future env-var injection raising the window).
  // Keep the most-recent entries — classification only ever cares about
  // the head of the array.
  if (crashTimestamps.length > CRASH_TIMESTAMPS_CAP) {
    crashTimestamps = crashTimestamps.slice(-CRASH_TIMESTAMPS_CAP);
  }

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

  // Mark every spawn after the first as a supervised restart, so the child suppresses
  // browser auto-open (--open) on crash/memory restarts and only opens on first launch.
  const isRestart = spawnCount > 0;
  spawnCount += 1;

  child = spawn(process.execPath, nodeArgs, {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      SUPERVISED: '1',
      ...(isRestart ? { AOD_SUPERVISOR_RESTART: '1' } : {})
    }
  });

  // Flush a queued supervisor_warning into the new child's IPC channel.
  // SUP-REL review: the immediately-after-spawn `child.connected` is false
  // (the IPC handshake hasn't completed yet), so this block used to silently
  // drop the warning. Defer via the 'spawn' event, which Node fires AFTER
  // the child has been successfully spawned and the IPC channel is wired.
  // Future CLIENT-04 server-side wiring will then receive it deterministically.
  if (pendingWarning) {
    const warning = pendingWarning;
    pendingWarning = null;
    const flush = () => {
      try {
        if (child && child.connected) child.send(warning);
      } catch (_) { /* IPC may have closed between spawn and send — best-effort */ }
    };
    // Node ≥ 16: 'spawn' event fires once when spawn succeeds. If the child
    // already crashed before 'spawn' fires, we never send; that's correct
    // behaviour — the next-next child will get its own warning if the crash
    // sequence re-escalates.
    if (typeof child.once === 'function') {
      child.once('spawn', flush);
    } else {
      // Defensive: pre-Node-16 fallback (unsupported but harmless).
      process.nextTick(flush);
    }
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
