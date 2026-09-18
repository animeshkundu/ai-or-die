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
          env: {
            ...process.env,
            ...env,
            SUPERVISED: '1',
          },
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

      // Persistent (not once): a stray early frame must not consume the
      // waiter and drop a later READY on the floor (same race as
      // _requestReply guards against).
      const onMessage = (msg) => {
        if (!msg || msg.type !== ipc.MSG.READY) return;
        if (settled) return;
        settled = true;
        try { proc.removeListener('message', onMessage); } catch (_) { /* ignore */ }
        clearTimeout(timer);
        record.pid = msg.pid || proc.pid || null;
        record.version = msg.version || null;
        resolve(record);
      };
      const onExit = () => {
        if (settled) return;
        settled = true;
        try { proc.removeListener('message', onMessage); } catch (_) { /* ignore */ }
        clearTimeout(timer);
        reject(new Error(`server exited before READY (${binary})`));
      };
      proc.on('message', onMessage);
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
      // Persistent (not once): a stray frame (e.g. a late pty_unregister)
      // must not consume the waiter and turn a clean shutdown into a
      // SIGKILL-via-timeout.
      const onMessage = (msg) => {
        if (msg && msg.type === ipc.MSG.SHUTDOWN_COMPLETE) {
          try { record.proc.removeListener('message', onMessage); } catch (_) { /* ignore */ }
          clearTimeout(timer);
          done(true);
        }
      };
      const onExit = () => { clearTimeout(timer); done(true); };
      try {
        record.proc.on('message', onMessage);
        record.proc.once('exit', onExit);
        record.proc.send(ipc.shutdown(reason));
      } catch (_) {
        try { record.proc.removeListener('message', onMessage); } catch (_) { /* ignore */ }
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
   *
   * Port takeover (avoids the two-servers-one-port collision): when the
   * public port is known (opts.port, else parsed from --port/-p in args),
   * the new Server boots on an EPHEMERAL port first, then:
   *   old release_port (stops accepting; existing conns stay) ->
   *   new listen_port (binds the real port) ->
   *   graceful shutdown of old -> promote.
   * Rollback at every step: release failure keeps old fully live;
   * takeover failure re-binds old before giving up. Without a known port,
   * falls back to the legacy direct swap.
   */
  async swapServer(newBinary, args = [], env = {}, opts = {}) {
    if (!this.isRunning()) {
      const record = await this.spawnServer(newBinary, args, env);
      this.current = record;
      return { swapped: true, fresh: true, version: record.version };
    }
    const port = opts.port || ServerManager.portFromArgs(args);
    const oldRecord = this.current;
    const oldPid = oldRecord.pid;
    // Boot the candidate on an ephemeral port when we plan a takeover so it
    // never collides with the live server during validation.
    const spawnArgs = port ? ServerManager.argsWithPort(args, 0) : args;
    let newRecord = null;
    try {
      newRecord = await this.spawnServer(newBinary, spawnArgs, env);
    } catch (err) {
      return { swapped: false, reason: 'spawn_failed', error: err && err.message };
    }
    // Wire supervisor event handlers (pty_register/unregister, exit guard)
    // IMMEDIATELY so adopt-respawn registrations during the swap attribute
    // to the new server — not to the still-current old one.
    if (opts && typeof opts.onRecord === 'function') {
      try { opts.onRecord(newRecord); } catch (_) { /* ignore */ }
    }
    const killNew = () => { try { newRecord.proc.kill('SIGKILL'); } catch (_) { /* ignore */ } };

    // Handoff descriptors -> new server.
    const descriptors = this._ptyManager
      ? this._ptyManager.describeForHandoff(oldPid)
      : [];
    const handoffOk = await this._requestHandoff(newRecord, descriptors);
    if (!handoffOk) {
      killNew();
      return { swapped: false, reason: 'handoff_failed' };
    }

    // Move ownership records BEFORE killing old (crash-safe order:
    // if old dies now, reapServer would otherwise reap live PTYs).
    if (this._ptyManager && oldPid && newRecord.pid) {
      this._ptyManager.transferOwnership(oldPid, newRecord.pid);
    }

    if (port) {
      // Old stops accepting; its existing connections ride out shutdown.
      const released = await this._request(
        oldRecord, { type: 'release_port' }, 'port_released', 10000
      );
      if (!released) {
        killNew();
        return { swapped: false, reason: 'release_failed' };
      }
      // The old server replies the moment it STOPS ACCEPTING, but the
      // kernel frees the listen socket asynchronously. Poll until a fresh
      // connect is refused before handing the port to the new server —
      // otherwise its bind races the old teardown and takes EADDRINUSE.
      const freed = await ServerManager.waitPortFree(port, 10000);
      if (!freed) {
        try { oldRecord.proc.send({ type: 'listen_port', port }); } catch (_) { /* ignore */ }
        killNew();
        return { swapped: false, reason: 'port_not_freed' };
      }
      // New binds the real port. On failure, re-bind old (full rollback —
      // the old server never stopped serving existing connections).
      const taken = await this._requestReply(
        newRecord, { type: 'listen_port', port }, 'listen_port_ok', 15000,
        'listen_port_failed'
      );
      // NOTE: a listen_port_failed reply is truthy — match its type, and
      // surface its error text for diagnostics.
      if (!taken || taken.type !== 'listen_port_ok') {
        try { oldRecord.proc.send({ type: 'listen_port', port }); } catch (_) { /* ignore */ }
        killNew();
        return {
          swapped: false,
          reason: 'port_takeover_failed',
          detail: (taken && taken.error) || 'no reply within timeout',
        };
      }
    }

    // The swap is now decided: the new server is validated, owns the PTY
    // records, and (port path) serves the public port. Before tearing the
    // old server down, offer the caller a last word with the living old
    // child — used by the Supervisor to deliver the update_apply_response
    // to the HTTP client that triggered the apply. That client is pinned to
    // the OLD server's socket, so answering after its shutdown would hang
    // up. The beat after the hook lets the old child flush the response
    // (LAN RTT) before its graceful shutdown begins. Never throws.
    if (opts && typeof opts.onPreShutdown === 'function') {
      try {
        await opts.onPreShutdown({
          swapped: true,
          fresh: false,
          version: newRecord.version,
          ptys: descriptors.length,
          portTakeover: !!port,
        });
      } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Graceful shutdown of old, then promote.
    await this.gracefulShutdown(oldRecord, 'update');
    try {
      if (oldRecord.proc.exitCode === null) oldRecord.proc.kill('SIGKILL');
    } catch (_) { /* already gone */ }
    this.current = newRecord;
    return {
      swapped: true,
      fresh: false,
      version: newRecord.version,
      ptys: descriptors.length,
      portTakeover: !!port,
    };
  }

  _requestHandoff(newRecord, descriptors) {
    return this._request(newRecord, ipc.handoffStart(descriptors), ipc.MSG.HANDOFF_COMPLETE, this._handoffTimeoutMs);
  }

  /** Boolean wrapper over _requestReply. Never throws. */
  _request(record, sendMsg, okType, timeoutMs) {
    return this._requestReply(record, sendMsg, okType, timeoutMs).then((msg) => !!msg);
  }

  /**
   * Generic IPC round-trip resolving with the reply frame, or false on
   * timeout/send failure. An explicit failType frame (e.g.
   * listen_port_failed) also settles immediately so the caller can report
   * the remote error instead of waiting out the timeout. Never throws.
   */
  _requestReply(record, sendMsg, okType, timeoutMs, failType) {
    return new Promise((resolve) => {
      let settled = false;
      const cleanup = () => {
        try { record.proc.removeListener('message', onMessage); } catch (_) { /* ignore */ }
      };
      const done = (reply) => { if (!settled) { settled = true; cleanup(); resolve(reply); } };
      const timer = setTimeout(() => done(false), timeoutMs);
      if (timer.unref) timer.unref();
      // Persistent listener + explicit removal: `once` would be consumed
      // by the FIRST frame of any type (e.g. an adopt-respawn
      // pty_register racing the reply) and drop the reply on the floor.
      const onMessage = (msg) => {
        if (!msg) return;
        if (msg.type === okType || (failType && msg.type === failType)) {
          try { record.proc.removeListener('message', onMessage); } catch (_) { /* ignore */ }
          clearTimeout(timer);
          done(msg);
        }
      };
      try {
        record.proc.on('message', onMessage);
        record.proc.send(sendMsg);
      } catch (_) {
        try { record.proc.removeListener('message', onMessage); } catch (_) { /* ignore */ }
        clearTimeout(timer);
        done(false);
      }
    });
  }

  /**
   * Resolve when nothing accepts on 127.0.0.1:port (ECONNREFUSED), false on
   * timeout. A successful connect means the old listener is still bound.
   */
  static waitPortFree(port, timeoutMs = 10000) {
    const net = require('net');
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const probe = () => {
        let settled = false;
        let socket;
        try {
          socket = net.connect(port, '127.0.0.1');
        } catch (_) {
          return resolve(true); // invalid port shape counts as free
        }
        const done = (free) => {
          if (settled) return;
          settled = true;
          try { socket.destroy(); } catch (_) { /* ignore */ }
          if (free) return resolve(true);
          if (Date.now() >= deadline) return resolve(false);
          setTimeout(probe, 200);
        };
        socket.once('connect', () => done(false));
        socket.once('error', () => done(true));
      };
      probe();
    });
  }

  /** Extract the public port from --port/-p args. Null when absent/invalid. */
  static portFromArgs(args) {
    if (!Array.isArray(args)) return null;
    for (let i = 0; i < args.length - 1; i += 1) {
      if (args[i] === '--port' || args[i] === '-p') {
        const n = parseInt(args[i + 1], 10);
        if (Number.isFinite(n) && n > 0 && n < 65536) return n;
      }
    }
    return null;
  }

  /** Return a copy of args with the --port/-p value replaced (appended if absent). */
  static argsWithPort(args, port) {
    const out = Array.isArray(args) ? args.slice() : [];
    for (let i = 0; i < out.length - 1; i += 1) {
      if (out[i] === '--port' || out[i] === '-p') {
        out[i + 1] = String(port);
        return out;
      }
    }
    out.push('--port', String(port));
    return out;
  }
}

module.exports = { ServerManager };
