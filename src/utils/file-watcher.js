// src/utils/file-watcher.js — chokidar wrapper per ADR-0017.
//
// Why a wrapper module: keeps chokidar's API surface + cross-platform
// quirk handling (macOS FSEvents, Linux inotify, WSL2 polling fallback)
// behind a small contract that the SSE endpoint depends on. Per ADR-0017's
// "Why chokidar" section, chokidar normalizes platform behaviour we'd
// otherwise have to chase ourselves.
//
// Public API:
//   const FileWatcher = require('./file-watcher');
//   const w = new FileWatcher(rootDir, {
//     debounceMs: 100,
//     ignorePatterns: ['node_modules', '.git', ...],
//     hashable: (path) => boolean,    // optional; gates hash computation
//   });
//   w.on('event', ({type, path, mtime, hash}) => { ... });
//   w.on('error', (err) => { ... });
//   w.on('ready', () => { ... });
//   await w.start();
//   // ... later ...
//   await w.close();
//
// Event shape (ADR-0017 §Event payload):
//   { type: 'add'|'change'|'unlink', path: <abs forward-slashed>,
//     mtime: <ms>, hash?: <md5> }
//
// Coalescing (ADR-0017 §Event coalescing):
//   100ms debounce per path. Multiple events on the same path within the
//   window collapse to ONE event. Different event types on the same path
//   in-window: keep the LATEST (e.g. add then change → emit one change;
//   add then unlink → emit one unlink — captures the user-visible end state).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// Lazy require chokidar so test environments without it (or environments
// that load this module just to introspect) don't pay the import cost.
let _chokidar = null;
function _getChokidar() {
  if (!_chokidar) _chokidar = require('chokidar');
  return _chokidar;
}

// Default ignore patterns mirror the /api/search --exclude-dir list. These
// are heavy directories that flood the watcher with events the user almost
// never cares about. Operators can override per-instance via opts.ignorePatterns.
const DEFAULT_IGNORE = [
  /(^|[\/\\])\.git([\/\\]|$)/,
  /(^|[\/\\])node_modules([\/\\]|$)/,
  /(^|[\/\\])\.venv([\/\\]|$)/,
  /(^|[\/\\])\.next([\/\\]|$)/,
  /(^|[\/\\])dist([\/\\]|$)/,
  /(^|[\/\\])\.DS_Store$/,
];

// Per ADR-0017 §Event payload — hash only for text files ≤ 5 MB. Larger or
// suspected-binary files get the event without a hash; the client falls back
// to GET /api/files/content + hash compare on demand.
const HASH_MAX_BYTES = 5 * 1024 * 1024;

function normalizePath(p) {
  // ADR-0017 says emit forward slashes for cross-platform consistency
  // (matches the rest of /api/files/* convention).
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

/**
 * Compute MD5 of a file synchronously, returning null on any error or if
 * the file exceeds HASH_MAX_BYTES. Sync because we're already in a debounced
 * emit callback — moving it to async would complicate event ordering for
 * negligible benefit at file sizes that pass the size cap.
 */
function _hashFileSync(absPath) {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > HASH_MAX_BYTES) return null;
    const data = fs.readFileSync(absPath);
    return crypto.createHash('md5').update(data).digest('hex');
  } catch (_) {
    return null;
  }
}

class FileWatcher extends EventEmitter {
  /**
   * @param {string} rootDir absolute, pre-validated directory to watch
   * @param {object} [opts]
   *   - debounceMs: number      (default 100, per ADR-0017)
   *   - ignorePatterns: Array   (default DEFAULT_IGNORE)
   *   - includeHash: boolean    (default true; turn off for tests)
   *   - awaitWriteFinish: object|false (default tuned values)
   */
  constructor(rootDir, opts) {
    super();
    if (!rootDir || typeof rootDir !== 'string') {
      throw new TypeError('FileWatcher: rootDir must be a non-empty string');
    }
    opts = opts || {};
    this._rootDir = path.resolve(rootDir);
    this._debounceMs = typeof opts.debounceMs === 'number' ? opts.debounceMs : 100;
    this._ignorePatterns = opts.ignorePatterns || DEFAULT_IGNORE;
    this._includeHash = opts.includeHash !== false;
    // Tuned per the team-lead vs default trade-off discussion: chokidar's
    // default 300+100ms is too slow for "agent finishes write → user sees
    // refresh" UX. 80+30 → ~110ms latency, still avoids mid-write reads.
    this._awaitWriteFinish = opts.awaitWriteFinish !== undefined
      ? opts.awaitWriteFinish
      : { stabilityThreshold: 80, pollInterval: 30 };

    this._watcher = null;
    this._closed = false;
    // Per-path debounce timers + the latest event-type to emit on flush.
    // Map<path, { type, timer }>.
    this._pendingEvents = new Map();
  }

  /**
   * Start the underlying chokidar watcher. Resolves when chokidar's 'ready'
   * fires (initial scan complete) or rejects on error.
   */
  async start() {
    if (this._closed) throw new Error('FileWatcher: cannot start a closed watcher');
    if (this._watcher) return;          // idempotent

    const chokidar = _getChokidar();

    this._watcher = chokidar.watch(this._rootDir, {
      persistent: true,
      // Initial scan: skip — we only emit on changes after start. The
      // client gets initial directory state via the existing /api/files
      // endpoint per ADR-0017's "no synthetic initial event" decision.
      ignoreInitial: true,
      ignored: this._ignorePatterns,
      followSymlinks: false,            // defence against symlink-loop floods
      awaitWriteFinish: this._awaitWriteFinish,
      // Disable atomic-write detection's vim/emacs heuristics; we want raw
      // events with our own debounce, not chokidar's heuristic guesses.
      atomic: false,
      // depth: undefined → unbounded subtree (per ADR-0017 §Per-session
      // scoping; ignore patterns prevent the heavy-dir flood).
    });

    this._watcher.on('add', (p) => this._enqueue('add', p));
    this._watcher.on('change', (p) => this._enqueue('change', p));
    this._watcher.on('unlink', (p) => this._enqueue('unlink', p));
    this._watcher.on('error', (err) => {
      // Don't propagate every errno — chokidar emits transient
      // permission errors on some directory walks. Surface but don't crash.
      this.emit('error', err);
    });

    // Wait for chokidar's initial scan to finish before resolving start().
    await new Promise((resolve, reject) => {
      const onReady = () => { cleanup(); resolve(); };
      const onError = (err) => { cleanup(); reject(err); };
      const cleanup = () => {
        this._watcher.off('ready', onReady);
        this._watcher.off('error', onError);
      };
      this._watcher.once('ready', onReady);
      this._watcher.once('error', onError);
    });

    this.emit('ready');
  }

  /**
   * Enqueue an event for a path. If a pending event exists, the new
   * event-type wins (latest semantics — see class header comment).
   */
  _enqueue(type, absPath) {
    if (this._closed) return;

    const pending = this._pendingEvents.get(absPath);
    if (pending) {
      // Update to latest event type; keep the timer running.
      pending.type = type;
      return;
    }

    const timer = setTimeout(() => {
      this._pendingEvents.delete(absPath);
      this._flush(type, absPath);
    }, this._debounceMs);
    // Don't keep the event loop alive solely for a watcher debounce — the
    // surrounding HTTP server's keep-alive drives the lifetime.
    if (timer.unref) timer.unref();
    this._pendingEvents.set(absPath, { type, timer });
  }

  /**
   * Build the SSE-bound event payload and emit it. Hash is computed only
   * for `change` events on text files within HASH_MAX_BYTES (per ADR-0017).
   */
  _flush(_initialType, absPath) {
    if (this._closed) return;
    // Re-read the latest pending type from the map in case it was updated
    // while the timer was waiting (defensive — _enqueue updates in place
    // so the entry's `type` is current).
    const finalType = this._pendingEvents.get(absPath)?.type || _initialType;

    let mtime = null;
    let hash = null;
    if (finalType !== 'unlink') {
      try {
        const st = fs.statSync(absPath);
        mtime = st.mtimeMs;
        if (this._includeHash && finalType === 'change' && st.isFile() && st.size <= HASH_MAX_BYTES) {
          hash = _hashFileSync(absPath);
        }
      } catch (_) { /* file may have been removed in the debounce window */ }
    }

    const payload = {
      type: finalType,
      path: normalizePath(absPath),
      mtime: mtime,
    };
    if (hash) payload.hash = hash;

    this.emit('event', payload);
  }

  /**
   * Close the underlying chokidar watcher and release its kernel-level
   * resources (FSEvents on macOS, inotify on Linux, RDC on Windows).
   * Idempotent — calling twice is a no-op.
   *
   * ADR-0017 §Cleanup: must be called when the last EventSource subscribed
   * to this watcher disconnects. The HTTP layer wires this via req.on('close').
   */
  async close() {
    if (this._closed) return;
    this._closed = true;
    // Cancel any pending debounced emits.
    for (const { timer } of this._pendingEvents.values()) {
      clearTimeout(timer);
    }
    this._pendingEvents.clear();
    if (this._watcher) {
      try { await this._watcher.close(); } catch (_) {}
      this._watcher = null;
    }
    this.emit('close');
  }

  // Test helpers — exposed for unit tests, not part of the public contract.
  get _isClosed() { return this._closed; }
  get _isWatching() { return !!this._watcher; }
}

module.exports = FileWatcher;
module.exports.DEFAULT_IGNORE = DEFAULT_IGNORE;
module.exports.HASH_MAX_BYTES = HASH_MAX_BYTES;
