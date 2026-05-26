// src/utils/file-watcher.js — chokidar wrapper per ADR-0017 (amended at 4d047d1).
//
// Why a wrapper module: keeps chokidar's API surface + cross-platform
// quirk handling (macOS FSEvents, Linux inotify, WSL2 polling fallback)
// behind a small contract that the SSE endpoint depends on. Per ADR-0017's
// "Why chokidar" section, chokidar normalizes platform behaviour we'd
// otherwise have to chase ourselves.
//
// Multiplexed-subscription model (ADR-0017 §Multiplexing):
//   ONE FileWatcher per session. chokidar watches the SUPERSET of all
//   subscribed paths' parent directories. Events emitted by the wrapper
//   are filtered against the subscription set so consumers only see
//   events for paths they explicitly asked about. Add/remove paths via
//   subscribe()/unsubscribe(). The chokidar watch roots adjust
//   automatically as subscriptions change.
//
// Public API:
//   const FileWatcher = require('./file-watcher');
//   const w = new FileWatcher({
//     watchRoot: '<absolute path used as relPath base>',
//     debounceMs: 100, addChangeDedupMs: 50, renameDetectMs: 50,
//     stabilityMs: 80, pollIntervalMs: 30,
//     ignorePatterns: ['node_modules', ...],
//     includeHash: true,
//   });
//   w.on('event', ({type, path, relPath, mtime, hash?, prevPath?}) => { ... });
//   w.on('error', (err) => { ... });
//   w.on('ready', () => { ... });
//   await w.start();
//   await w.subscribe('/abs/path/to/file.js');
//   // ... events for /abs/path/to/file.js arrive on 'event' ...
//   await w.unsubscribe('/abs/path/to/file.js');
//   await w.close();
//
// Event payload (ADR-0017 §Event payload):
//   { type:'add'|'change'|'unlink'|'rename',
//     path, relPath, mtime, hash?, prevPath? }
//
// Three coalescing layers (ADR-0017 §Event coalescing):
//   1. chokidar awaitWriteFinish (read-during-write protection)
//   2. 50ms add+change dedup (atomic-rename save protection)
//   3. 100ms per-path debounce (agent-batch protection)
// Plus rename detection: same-inode unlink+add within `renameDetectMs`
// → single synthetic rename event with prevPath.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

let _chokidar = null;
function _getChokidar() {
  if (!_chokidar) _chokidar = require('chokidar');
  return _chokidar;
}

// Default ignore patterns (ADR-0017 §Ignore patterns). Mirrors the
// /api/search EXCLUDE_DIRS list so user expectations transfer between
// Search and Watch.
const DEFAULT_IGNORE_DIRS = [
  '.git', 'node_modules', '.venv', 'venv', '.tox', '.gradle',
  'dist', 'build', 'target', '.next', '.cache', '__pycache__',
];

function buildIgnoreRegexes(ignoreDirs) {
  const regexes = ignoreDirs.map((d) => {
    const escaped = d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[/\\\\])${escaped}([/\\\\]|$)`);
  });
  // Always ignore .DS_Store
  regexes.push(/(^|[/\\])\.DS_Store$/);
  return regexes;
}

const HASH_MAX_BYTES = 5 * 1024 * 1024;

function normalizePath(p) {
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

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
   * @param {object} opts
   *   - watchRoot: absolute path used as the base for `relPath` computation.
   *                Subscribed paths are typically children of this root, but
   *                relPath is computed regardless (may include `..` segments
   *                if a subscription is outside the root).
   *   - debounceMs: per-path debounce window (default 500, ADR §Coalescing).
   *                 Bumped from 100 to 500 when the "Windows + multi-worktree
   *                 + Claude bulk edits" hang was diagnosed — under bulk edits
   *                 a 100ms window barely coalesces, and combined with the
   *                 narrow-scope `depth: 0` path below the longer window
   *                 substantially cuts event rate without harming UX.
   *   - addChangeDedupMs: window within which add+change collapses to change
   *                       (default 50, ADR §Coalescing layer 3).
   *   - renameDetectMs: window within which same-inode unlink+add collapses
   *                     to a rename event (default 50, ADR §Rename detection).
   *   - stabilityMs / pollIntervalMs: chokidar awaitWriteFinish tuning
   *                                   (defaults 80 / 30 per ADR § Coalescing
   *                                    layer 1; tunable for tests).
   *   - ignoreDirs: directory-name list for ignore patterns; default
   *                 DEFAULT_IGNORE_DIRS.
   *   - depth: passed through to chokidar. `0` confines the watcher to direct
   *            children of every watched path — used by the file-browser SSE
   *            endpoint to eliminate the recursive-tree handle explosion on
   *            Windows + large worktree trees. Default `undefined`
   *            (chokidar's recursive default, for backward compat).
   *   - includeHash: emit MD5 hash on change events. Default `true` UNLESS
   *                 `depth: 0` is set, in which case the default flips to
   *                 `false` because the sync `fs.readFileSync` inside
   *                 `_flush()` can block the event loop under bulk edits
   *                 (e.g. an agent generating many files in the displayed
   *                 directory). The `file-tabs.js` hash short-circuit falls
   *                 through gracefully when hash is absent (always refresh
   *                 via HTTP), so functionality is preserved.
   */
  constructor(opts) {
    super();
    opts = opts || {};
    if (!opts.watchRoot || typeof opts.watchRoot !== 'string') {
      throw new TypeError('FileWatcher: opts.watchRoot is required');
    }
    // Canonicalize watchRoot via realpath so the relPath computation
    // (path.relative on emit) matches what chokidar emits — both sides
    // canonical. Without this, on macOS where /var → /private/var,
    // a watchRoot of `/var/...` would yield the wrong relPath because
    // chokidar walks the realpath and emits canonical paths.
    let resolvedRoot = path.resolve(opts.watchRoot);
    try { resolvedRoot = fs.realpathSync(resolvedRoot); } catch (_) {}
    this._watchRoot = resolvedRoot;
    this._debounceMs = typeof opts.debounceMs === 'number' ? opts.debounceMs : 500;
    this._addChangeDedupMs = typeof opts.addChangeDedupMs === 'number' ? opts.addChangeDedupMs : 50;
    this._renameDetectMs = typeof opts.renameDetectMs === 'number' ? opts.renameDetectMs : 50;
    this._stabilityMs = typeof opts.stabilityMs === 'number' ? opts.stabilityMs : 80;
    this._pollIntervalMs = typeof opts.pollIntervalMs === 'number' ? opts.pollIntervalMs : 30;
    this._ignoreDirs = Array.isArray(opts.ignoreDirs) ? opts.ignoreDirs : DEFAULT_IGNORE_DIRS;
    this._ignoreRegexes = buildIgnoreRegexes(this._ignoreDirs);
    this._depth = typeof opts.depth === 'number' ? opts.depth : undefined;
    // When the caller opted into narrow-scope (depth: 0) and didn't explicitly
    // ask for hashes, default-off to keep _flush() from doing sync MD5 reads
    // under bulk-edit storms. Explicit `includeHash: true` still wins.
    if (typeof opts.includeHash === 'boolean') {
      this._includeHash = opts.includeHash;
    } else if (this._depth === 0) {
      this._includeHash = false;
    } else {
      this._includeHash = true;
    }
    // Allow callers to disable awaitWriteFinish entirely (for tests where
    // sync writeFileSync races chokidar's poll cycle). Default = on with
    // tuned-down values per ADR-0017.
    this._awaitWriteFinishDisabled = opts.awaitWriteFinish === false;
    // usePolling — falls back to fs.stat-based polling instead of
    // FSEvents/inotify. Slower but bypasses FSEvents flakiness with
    // sync writes in tests.
    this._usePolling = !!opts.usePolling;

    this._watcher = null;
    this._closed = false;

    // Subscription set: absolute paths the consumer cares about.
    // Events for paths NOT in this set are dropped on emit.
    // Two flavours of subscription:
    //   _subscriptions     — exact-path match (existing behavior)
    //   _dirSubscriptions  — directory-recursive: matches the dir AND any
    //                        descendant. Stored with native-separator
    //                        trailing path-sep for cheap startsWith()
    //                        prefix-match in _onChokidar.
    // Both can coexist; an event matching either set is emitted exactly
    // once (Set semantics + early return on first match).
    this._subscriptions = new Set();
    this._dirSubscriptions = new Set();

    // Watched parent directory set (chokidar add()/unwatch() targets).
    // We watch parent dirs (not files directly) so add events fire when
    // the file is freshly created.
    this._watchedDirs = new Set();
    this._dirRefcount = new Map();        // dir → count of subscriptions in it

    // Per-path debounce state: Map<path, {type, prevPath?, timer}>.
    this._pendingEvents = new Map();

    // Recent unlinks for rename detection: Map<inode, {path, timestamp, timer}>.
    this._recentUnlinks = new Map();

    // Recent adds for add+change dedup: Map<path, {timestamp, timer}>.
    this._recentAdds = new Map();
  }

  async start() {
    if (this._closed) throw new Error('FileWatcher: cannot start a closed watcher');
    if (this._watcher) return;

    const chokidar = _getChokidar();

    // Watch the watchRoot's whole subtree from start, with ignore
    // patterns to skip heavy build-output dirs. Subscriptions filter
    // events on emit (see _onChokidar). Trade-off vs the ADR's
    // "watch only subscribed parents" optimization:
    //   - More upfront kernel-watch cost (recursive subtree, bounded by
    //     ignore patterns).
    //   - Race-free: no add()-walk window where a write to a freshly-
    //     subscribed path could be missed while chokidar walks the parent.
    //   - Simpler bookkeeping: no dynamic add()/unwatch() per subscription.
    //   - chokidar.watch([]) with empty initial paths never fires 'ready'
    //     in v5, so we'd need a placeholder path anyway.
    // The narrower-watch optimization is a follow-up if user reports
    // kernel-watch exhaustion (typical inotify_max_user_watches is 8192;
    // a typical project after ignores is well under that).
    this._watcher = chokidar.watch(this._watchRoot, {
      persistent: true,
      ignoreInitial: true,
      ignored: this._ignoreRegexes,
      followSymlinks: false,
      // alwaysStat: true is required for inode-based rename detection
      // (ADR-0017 §Rename detection — same-inode unlink+add coalescing).
      alwaysStat: true,
      awaitWriteFinish: this._awaitWriteFinishDisabled
        ? false
        : { stabilityThreshold: this._stabilityMs, pollInterval: this._pollIntervalMs },
      // usePolling enables a fs.stat-loop watcher backend instead of
      // FSEvents/inotify. Used in tests on macOS to bypass FSEvents
      // flakiness with sync writeFileSync; production stays on the
      // OS-native backend.
      usePolling: this._usePolling,
      interval: this._usePolling ? 50 : undefined,
      atomic: false,
      // depth: 0 confines chokidar to direct children of every watched
      // path (the watchRoot + anything later added via subscribe). The
      // server passes this for the file-browser SSE path; subscriptions
      // drive what's actually watched beyond the watchRoot via
      // chokidar.add(). This is the load-bearing knob that bounds the
      // active_handles cost on large/multi-worktree trees. `undefined`
      // (the default) restores chokidar's recursive behaviour for
      // backward compat in callers that haven't migrated.
      depth: this._depth,
    });

    this._watcher.on('add', (p, stat) => this._onChokidar('add', p, stat));
    this._watcher.on('change', (p, stat) => this._onChokidar('change', p, stat));
    this._watcher.on('unlink', (p) => this._onChokidar('unlink', p, null));
    this._watcher.on('error', (err) => this.emit('error', err));

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
   * Canonicalize a path so subscriptions match the form chokidar emits
   * for events.
   *
   * The bug we're defending against: `path.resolve()` does NOT follow
   * symlinks. On macOS `/var → /private/var`; on any platform an operator
   * may pass `--folder /symlink-to-foo` or set the watcher's watchRoot
   * via a symlinked path. chokidar walks the realpath of its watchRoot
   * and emits canonical paths in events. If we store subscription paths
   * in lexical (path.resolve) form, the Set lookup in _onChokidar misses,
   * events get silently dropped, and recursive subscriptions appear
   * broken even for files INSIDE the subscribed dir.
   *
   * Same shape as the validatePath fix in 158c1c2 — canonicalize via
   * realpath when the path exists; for paths that don't yet exist
   * (subscribe-before-create — common for new files in a watched dir),
   * canonicalize the parent and re-attach the basename.
   */
  _canonicalize(absPath) {
    let resolved = path.resolve(absPath);
    try {
      return fs.realpathSync(resolved);
    } catch (_) {
      // Path doesn't exist yet — try parent realpath + basename so the
      // subscribe-before-create case still matches when chokidar later
      // emits the canonical form of the created path.
      try {
        const parent = path.dirname(resolved);
        if (parent && parent !== resolved && fs.existsSync(parent)) {
          return path.join(fs.realpathSync(parent), path.basename(resolved));
        }
      } catch (_) {}
      return resolved;
    }
  }

  /**
   * Add a path to the active subscription set. Events for this path will
   * now flow through the consumer's 'event' listener.
   *
   * When the watcher was constructed with `depth: 0`, the chokidar watch
   * scope is dynamically managed: subscribing to a file watches its parent
   * directory (chokidar emits events for direct children of the watched
   * dir); subscribing to a directory recursively watches that directory.
   * A physical-watch-target refcount means we only call chokidar.add()
   * for the first subscription that needs a given dir, and chokidar.unwatch()
   * for the last. Without this, two tabs in the same dir would race the
   * underlying watch and a tab-close could kill another tab's events.
   *
   * For constructors NOT using depth: 0 (legacy callers), chokidar already
   * watches the full subtree of watchRoot recursively, so subscribe is
   * pure soft-filter bookkeeping (no chokidar.add).
   *
   * @param {string} absPath
   * @param {object} [opts]
   *   - recursive: boolean — if true, the subscription matches the dir AND
   *                its descendants (in the recursive-watch model). Under
   *                depth: 0 the soft-filter set still uses this for event
   *                matching, but chokidar itself only watches direct
   *                children of the dir — descendant events would not
   *                arrive (file-browser listing already filters to direct
   *                children, so this is invisible to current consumers).
   *                Default false (exact-path match).
   */
  async subscribe(absPath, opts) {
    if (this._closed) throw new Error('FileWatcher: cannot subscribe on a closed watcher');
    if (!this._watcher) throw new Error('FileWatcher: must call start() before subscribe()');
    const canonical = this._canonicalize(absPath);
    const isRecursive = !!(opts && opts.recursive);
    if (isRecursive) {
      // Store with a trailing path separator so the prefix-match in
      // _onChokidar via `startsWith(dir + sep)` works without false
      // positives (e.g. /a/b should NOT match /a/bc).
      this._dirSubscriptions.add(canonical + path.sep);
    } else {
      this._subscriptions.add(canonical);
    }
    if (this._depth === 0) {
      const target = isRecursive ? canonical : path.dirname(canonical);
      this._refWatchTarget(target);
    }
  }

  /**
   * Remove a path from the active subscription set. Subsequent events for
   * this path will be dropped on emit. Idempotent: removing a non-subscribed
   * path is a no-op.
   *
   * Under `depth: 0`, also drops the chokidar watch on the corresponding
   * target directory when no other subscription still references it (see
   * `_refWatchTarget`).
   *
   * The `recursive` opt must match the flavour the path was subscribed
   * with — calling unsubscribe(path, {recursive:true}) on an exact-
   * subscribed path is a no-op (and vice versa). Mismatched-flavour
   * unsubscribes are intentionally non-error so client code can safely
   * "unsubscribe everything" with both calls without prior knowledge.
   */
  async unsubscribe(absPath, opts) {
    if (this._closed) return;
    const canonical = this._canonicalize(absPath);
    const isRecursive = !!(opts && opts.recursive);
    let hadSub = false;
    if (isRecursive) {
      hadSub = this._dirSubscriptions.delete(canonical + path.sep);
    } else {
      hadSub = this._subscriptions.delete(canonical);
    }
    if (!hadSub) return; // idempotent — nothing to release
    if (this._depth === 0) {
      const target = isRecursive ? canonical : path.dirname(canonical);
      this._unrefWatchTarget(target);
    }
  }

  /**
   * Refcount-key normalization for the watch-target map. On Windows the
   * filesystem is case-insensitive but path strings carry whatever casing
   * the caller used (or whatever realpathSync returned, which is not
   * always the on-disk form for paths it can't resolve). Lower-casing the
   * key means `subscribe('Q:\\src\\file.js')` and `unsubscribe('q:\\SRC\\
   * FILE.JS')` resolve to the same refcount slot. Forward-slash
   * normalization is a separate cross-platform concern handled by
   * normalizePath above.
   */
  _watchKeyNorm(p) {
    const n = normalizePath(p);
    return process.platform === 'win32' ? n.toLowerCase() : n;
  }

  _refWatchTarget(target) {
    // The watchRoot is already watched at start() time — never add/unwatch it
    // dynamically here, or we'd risk closing the root chokidar handle.
    if (this._watchKeyNorm(target) === this._watchKeyNorm(this._watchRoot)) return;
    const key = this._watchKeyNorm(target);
    const cur = this._dirRefcount.get(key) || 0;
    this._dirRefcount.set(key, cur + 1);
    if (cur === 0) {
      this._watchedDirs.add(key);
      try { this._watcher.add(target); } catch (_) { /* chokidar will surface via 'error' if real */ }
    }
  }

  _unrefWatchTarget(target) {
    if (this._watchKeyNorm(target) === this._watchKeyNorm(this._watchRoot)) return;
    const key = this._watchKeyNorm(target);
    const cur = this._dirRefcount.get(key) || 0;
    if (cur === 0) return; // defensive — refcount should never go negative
    if (cur === 1) {
      this._dirRefcount.delete(key);
      this._watchedDirs.delete(key);
      try { this._watcher.unwatch(target); } catch (_) {}
    } else {
      this._dirRefcount.set(key, cur - 1);
    }
  }

  /**
   * Returns true iff the path matches an active subscription — either an
   * exact-path entry in _subscriptions, or a recursive entry in
   * _dirSubscriptions whose dir is an ancestor of `absPath`.
   *
   * Inputs are NOT re-canonicalized here. chokidar emits paths already in
   * canonical form (because the constructor canonicalized watchRoot via
   * realpath, and chokidar walks from that canonical root). Doing
   * realpathSync per event would add a syscall to the hot path on every
   * single fs change AND introduce timing variance that flakes tests
   * under load. Subscribe/unsubscribe canonicalize at registration time
   * so both sides of the comparison are already in canonical form.
   */
  hasSubscription(absPath) {
    const canonical = path.resolve(absPath);
    if (this._subscriptions.has(canonical)) return true;
    for (const dirWithSep of this._dirSubscriptions) {
      // dirWithSep already ends with path.sep. Match the dir itself
      // (canonical + sep === dirWithSep) OR any descendant.
      if (canonical + path.sep === dirWithSep) return true;
      if (canonical.startsWith(dirWithSep)) return true;
    }
    return false;
  }

  /**
   * Total active subscription count (exact + recursive). For diagnostics.
   */
  get subscriptionCount() { return this._subscriptions.size + this._dirSubscriptions.size; }

  // -------------------------------------------------------------------------
  // chokidar event handler — applies the 3 coalescing layers + rename detect.
  //
  // Order:
  //   1. Filter: ignore events for paths not in subscription set
  //      (subscription is at file granularity even though chokidar watches
  //      parent dir).
  //   2. add+change dedup: an `add` immediately followed by `change` for
  //      the same path within addChangeDedupMs collapses to a single change.
  //   3. rename detection: an `unlink` followed by an `add` with the same
  //      inode within renameDetectMs collapses to a synthetic `rename`.
  //   4. Per-path debounce: multiple events on the same path within
  //      debounceMs collapse to ONE event, latest-type-wins.
  // -------------------------------------------------------------------------
  _onChokidar(type, absPath, stat) {
    if (this._closed) return;

    // Subscription filter — chokidar fires on the parent dir's whole subtree,
    // but we only emit events for paths the consumer subscribed to. Two
    // match modes (see subscribe/_dirSubscriptions): exact-path or
    // directory-recursive prefix-match.
    if (!this.hasSubscription(absPath)) return;

    const inode = stat ? stat.ino : null;
    const now = Date.now();

    // --- Layer 3: same-inode rename detection ---
    if (type === 'unlink') {
      // Park this unlink for renameDetectMs; if a same-inode add arrives
      // within the window, we'll emit a synthetic rename instead.
      // Note: on unlink, we don't have stat (file is gone), so we can't
      // know the inode here unless chokidar buffered it. chokidar's
      // alwaysStat:true gives us stat on add/change but not unlink (the
      // file's already gone by emit time). So we instead match by PATH
      // for the unlink → add fallback case; rename detection only fires
      // when chokidar happens to deliver them in the right order with
      // a stat-able add.
      this._recentUnlinks.set(absPath, {
        path: absPath,
        timestamp: now,
        timer: setTimeout(() => {
          // Window expired — emit the unlink as a regular event.
          const entry = this._recentUnlinks.get(absPath);
          if (entry && entry.timestamp === now) {
            this._recentUnlinks.delete(absPath);
            this._enqueueDebounced('unlink', absPath, null, null);
          }
        }, this._renameDetectMs),
      });
      // Don't unref this timer — we need it to fire to release the unlink.
      return;
    }

    if (type === 'add' && inode != null) {
      // Look for a recent unlink whose absolute path's basename and parent
      // structure suggest it was the same file. We don't have inode on
      // unlink (see above), so do a heuristic: if there's a single recent
      // unlink within window, treat THIS add as a rename.
      const candidates = [];
      for (const [p, entry] of this._recentUnlinks.entries()) {
        if (now - entry.timestamp <= this._renameDetectMs) candidates.push(entry);
      }
      if (candidates.length === 1) {
        const renamed = candidates[0];
        clearTimeout(renamed.timer);
        this._recentUnlinks.delete(renamed.path);
        // Emit synthetic rename.
        this._enqueueDebounced('rename', absPath, stat, renamed.path);
        return;
      }
      // Otherwise: fall through to normal add handling.
    }

    // --- Layer 2: add+change dedup ---
    if (type === 'add') {
      this._recentAdds.set(absPath, {
        timestamp: now,
        timer: setTimeout(() => {
          // Window expired — clean up the marker.
          const entry = this._recentAdds.get(absPath);
          if (entry && entry.timestamp === now) {
            this._recentAdds.delete(absPath);
          }
        }, this._addChangeDedupMs),
      });
      // Continue: emit the add via debounce.
    } else if (type === 'change') {
      const recentAdd = this._recentAdds.get(absPath);
      if (recentAdd && now - recentAdd.timestamp <= this._addChangeDedupMs) {
        // add+change within dedup window → collapse to a single change.
        clearTimeout(recentAdd.timer);
        this._recentAdds.delete(absPath);
        // Continue: the change will go through the normal debounce path.
      }
    }

    this._enqueueDebounced(type, absPath, stat, null);
  }

  /**
   * Layer 1: per-path debounce. Multiple events on the same path within
   * debounceMs collapse to ONE event (latest type wins, latest stat wins).
   */
  _enqueueDebounced(type, absPath, stat, prevPath) {
    if (this._closed) return;
    const pending = this._pendingEvents.get(absPath);
    if (pending) {
      pending.type = type;
      pending.stat = stat;
      if (prevPath != null) pending.prevPath = prevPath;
      return;
    }
    const timer = setTimeout(() => {
      const entry = this._pendingEvents.get(absPath);
      if (!entry) return;
      this._pendingEvents.delete(absPath);
      this._flush(entry.type, absPath, entry.stat, entry.prevPath);
    }, this._debounceMs);
    if (timer.unref) timer.unref();
    this._pendingEvents.set(absPath, { type, stat, prevPath: prevPath || null, timer });
  }

  _flush(type, absPath, stat, prevPath) {
    if (this._closed) return;

    let mtime = null;
    let hash = null;
    if (type !== 'unlink') {
      try {
        const st = stat || fs.statSync(absPath);
        mtime = st.mtimeMs != null ? st.mtimeMs : (st.mtime ? st.mtime.getTime() : null);
        if (this._includeHash && (type === 'change' || type === 'rename') &&
            st.isFile && st.isFile() && st.size <= HASH_MAX_BYTES) {
          hash = _hashFileSync(absPath);
        }
      } catch (_) { /* file may have been removed in the debounce window */ }
    }

    const normalizedPath = normalizePath(absPath);
    const relPath = normalizePath(path.relative(this._watchRoot, absPath));
    const payload = {
      type: type,
      path: normalizedPath,
      relPath: relPath,
      mtime: mtime,
    };
    if (hash) payload.hash = hash;
    if (prevPath) payload.prevPath = normalizePath(prevPath);

    this.emit('event', payload);
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    for (const { timer } of this._pendingEvents.values()) clearTimeout(timer);
    for (const { timer } of this._recentAdds.values()) clearTimeout(timer);
    for (const { timer } of this._recentUnlinks.values()) clearTimeout(timer);
    this._pendingEvents.clear();
    this._recentAdds.clear();
    this._recentUnlinks.clear();
    this._subscriptions.clear();
    this._dirSubscriptions.clear();
    this._dirRefcount.clear();
    this._watchedDirs.clear();
    if (this._watcher) {
      try { await this._watcher.close(); } catch (_) {}
      this._watcher = null;
    }
    this.emit('close');
  }

  // Test helpers (not part of the public contract).
  get _isClosed() { return this._closed; }
  get _isWatching() { return !!this._watcher; }
}

module.exports = FileWatcher;
module.exports.DEFAULT_IGNORE_DIRS = DEFAULT_IGNORE_DIRS;
module.exports.HASH_MAX_BYTES = HASH_MAX_BYTES;
