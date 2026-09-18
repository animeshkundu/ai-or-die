'use strict';

// ServerManager — spawn / shutdown / seamless-swap the Server child.
//
// The Server is a stateless frontend: all PTY lifecycles live in the
// PtyManager (supervisor-owned), all session bytes live in
// ~/.ai-or-die/sessions.json. Swapping the binary therefore never kills a
// session process; it only moves WS connections and metadata.
//
// Swap sequence (see ipc-protocol.js):
//   1. spawnServer(newBinary) -> wait READY (SERVER_READY_TIMEOUT_MS)
//   2. HANDOFF_START(old PTY descriptors) -> new Server
//   3. wait HANDOFF_COMPLETE (HANDOFF_TIMEOUT_MS)
//   4. gracefulShutdown(old Server, 'update') -> SHUTDOWN_COMPLETE / timeout
//   5. kill old Server; transfer PTY ownership records; promote new Server
// Any failure before step 4 keeps the old Server live (rollback = kill new).

const { spawn } = require('child_process');
const ipc = require('./ipc-protocol');
const {
  SERVER_READY_TIMEOUT_MS,
  HANDOFF_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
} = require('./constants');

class ServerManager {
  constructor(options = {}) {
    this._spawn = options.spawn || spawn;
    this._ptyManager = options.ptyManager || null;
    this._logger = options.logger || console;
    this._readyTimeoutMs = options.readyTimeoutMs || SERVER_READY_TIMEOUT_MS;
    this._handoffTimeoutMs = options.handoffTimeoutMs || HANDOFF_TIMEOUT_MS;
    this._shutdownGraceMs = options.shutdownGraceMs || SHUTDOWN_GRACE_MS;
    this.current = null; // { proc, pid, binary, version }
  }

  isRunning() {
    return !!(this.current && this.current.proc && !this.current.proc.killed);
  }

  spawnServer(binary, args = [], env = {}) {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = this._spawn(process.execPath, [binary, ...args], {
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          env: { ...process.env, ...env, SUPERVISED: '1' },
        });
      } catch (err) {
        return reject(err);
      }
      const record = { proc, pid: proc.pid || null, binary, version: null };
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
        reject(new Error(`server READY timeout after ${this._readyTimeoutMs}ms (${binary})`));
      }, this._readyTimeoutMs);
      if (timer.unref) timer.unref();

      const onMessage = (msg) => {
        if (!msg || msg.type !== ipc.MSG.READY) return;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.pid = msg.pid || proc.pid || null;
        record.version = msg.version || null;
        resolve(record);
      };
      const onExit = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`server exited before READY (${binary})`));
      };
      proc.once('message', onMessage);
      proc.once('exit', onExit);
      proc.once('error', onExit);
    });
  }

  gracefulShutdown(record, reason = 'restart') {
    if (!record || !record.proc) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const timer = setTimeout(() => {
        try { record.proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
        done(false);
      }, this._shutdownGraceMs);
      if (timer.unref) timer.unref();
      const onMessage = (msg) => {
        if (msg && msg.type === ipc.MSG.SHUTDOWN_COMPLETE) {
          clearTimeout(timer);
          done(true);
        }
      };
      const onExit = () => { clearTimeout(timer); done(true); };
      try {
        record.proc.once('message', onMessage);
        record.proc.once('exit', onExit);
        record.proc.send(ipc.shutdown(reason));
      } catch (_) {
        clearTimeout(timer);
        done(false);
      }
    });
  }

  /**
   * Seamless binary swap. PTY processes stay alive throughout: ownership
   * records move AFTER the new Server confirms HANDOFF_COMPLETE, and the
   * old Server is only killed after it confirms SHUTDOWN_COMPLETE (or the
   * grace timeout, in which case it is SIGKILLed — PTYs survive because the
   * supervisor owns them, not the server).
   */
  async swapServer(newBinary, args = [], env = {}) {
    if (!this.isRunning()) {
      const record = await this.spawnServer(newBinary, args, env);
      this.current = record;
      return { swapped: true, fresh: true, version: record.version };
    }
    const oldRecord = this.current;
    const oldPid = oldRecord.pid;
    let newRecord = null;
    try {
      newRecord = await this.spawnServer(newBinary, args, env);
    } catch (err) {
      return { swapped: false, reason: 'spawn_failed', error: err && err.message };
    }

    // Step 2+3: handoff descriptors -> new server.
    const descriptors = this._ptyManager
      ? this._ptyManager.describeForHandoff(oldPid)
      : [];
    const handoffOk = await this._requestHandoff(newRecord, descriptors);
    if (!handoffOk) {
      try { newRecord.proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
      return { swapped: false, reason: 'handoff_failed' };
    }

    // Step 4: move ownership records BEFORE killing old (crash-safe order:
    // if old dies now, reapServer would otherwise reap live PTYs).
    if (this._ptyManager && oldPid && newRecord.pid) {
      this._ptyManager.transferOwnership(oldPid, newRecord.pid);
    }

    // Step 5: graceful shutdown of old, then promote.
    await this.gracefulShutdown(oldRecord, 'update');
    try {
      if (oldRecord.proc.exitCode === null) oldRecord.proc.kill('SIGKILL');
    } catch (_) { /* already gone */ }
    this.current = newRecord;
    return { swapped: true, fresh: false, version: newRecord.version, ptys: descriptors.length };
  }

  _requestHandoff(newRecord, descriptors) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      const timer = setTimeout(() => done(false), this._handoffTimeoutMs);
      if (timer.unref) timer.unref();
      const onMessage = (msg) => {
        if (msg && msg.type === ipc.MSG.HANDOFF_COMPLETE) {
          clearTimeout(timer);
          done(true);
        }
      };
      try {
        newRecord.proc.once('message', onMessage);
        newRecord.proc.send(ipc.handoffStart(descriptors));
      } catch (_) {
        clearTimeout(timer);
        done(false);
      }
    });
  }
}

module.exports = { ServerManager };
