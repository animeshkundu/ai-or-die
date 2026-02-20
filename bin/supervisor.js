#!/usr/bin/env node

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const { RESTART_EXIT_CODE } = require('../src/restart-manager');

const RESTART_DELAY_MS = 1000;
const CRASH_RESTART_DELAY_MS = 3000;
const CIRCUIT_BREAKER_WINDOW_MS = 30000;
const CIRCUIT_BREAKER_MAX_CRASHES = 3;
const SHUTDOWN_TIMEOUT_MS = 10000;

const serverScript = process.env.SUPERVISOR_CHILD_SCRIPT
  || path.join(__dirname, 'ai-or-die.js');
const forwardedArgs = process.argv.slice(2);

let child = null;
let shuttingDown = false;
let crashTimestamps = [];

function startServer() {
  const nodeArgs = ['--expose-gc', serverScript, ...forwardedArgs];

  child = spawn(process.execPath, nodeArgs, {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, SUPERVISED: '1' }
  });

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
      setTimeout(startServer, RESTART_DELAY_MS);
      return;
    }

    // Unexpected exit — check circuit breaker
    const now = Date.now();
    crashTimestamps.push(now);
    // Remove timestamps outside the window
    crashTimestamps = crashTimestamps.filter(t => now - t < CIRCUIT_BREAKER_WINDOW_MS);

    if (crashTimestamps.length >= CIRCUIT_BREAKER_MAX_CRASHES) {
      console.error(`[supervisor] Circuit breaker: ${CIRCUIT_BREAKER_MAX_CRASHES} crashes within ${CIRCUIT_BREAKER_WINDOW_MS / 1000}s. Stopping.`);
      process.exit(1);
      return;
    }

    const exitInfo = signal ? `signal ${signal}` : `code ${code}`;
    console.warn(`[supervisor] Server exited unexpectedly (${exitInfo}), restarting in ${CRASH_RESTART_DELAY_MS}ms... (crash ${crashTimestamps.length}/${CIRCUIT_BREAKER_MAX_CRASHES})`);
    setTimeout(startServer, CRASH_RESTART_DELAY_MS);
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
    try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    setTimeout(() => process.exit(1), 1000);
  }, SHUTDOWN_TIMEOUT_MS);
  killTimer.unref();
}

process.on('SIGINT', shutdownGracefully);
process.on('SIGTERM', shutdownGracefully);
// Allow test harness to trigger shutdown via IPC
process.on('message', (msg) => {
  if (msg && msg.type === 'shutdown') shutdownGracefully();
});

startServer();
