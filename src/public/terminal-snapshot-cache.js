'use strict';

/**
 * TerminalSnapshotCache — instant, faithful per-tab terminal repaint.
 *
 * Problem it solves: there is ONE shared xterm terminal for all tabs. On tab
 * switch the terminal is repainted only by the server round-trip
 * (join_session -> session_joined), so until that lands the previous tab's
 * content lingers. This cache paints the target tab's last rendered view
 * INSTANTLY from a client-side snapshot, decoupled from the round-trip; the
 * server reply then reconciles authoritatively.
 *
 * Fidelity: snapshots are produced by xterm's serialize addon, which emits the
 * already-rendered buffer with absolute SGR + a final cursor-positioning
 * sequence. Writing that into a freshly-cleared terminal reproduces the screen
 * faithfully (cursor + colors), unlike a plain-text dump.
 *
 * Tiers:
 *   - Tier 1 (in-memory Map): authoritative for the instant paint, synchronous.
 *   - Tier 2 (IndexedDB): survives a page reload. Throttled writes, LRU-bounded.
 *
 * Robustness: every IndexedDB call is guarded; on any failure the cache runs
 * MEMORY-ONLY (instant in-session switching still works, only reload-restore is
 * lost) and never throws into the caller's switch/render path. Setting
 * maxLines to 0 disables capture + paint entirely (a pure pass-through).
 */
(function (global) {
  const DB_NAME = 'cc-terminal-cache';
  const DB_VERSION = 1;
  const STORE = 'snapshots';
  const PER_RECORD_CAP_BYTES = 256 * 1024; // skip persisting anything larger (keep in memory only)
  const TOTAL_BUDGET_BYTES = 6 * 1024 * 1024; // LRU-evict oldest beyond this
  const PERSIST_DEBOUNCE_MS = 1000;

  const byteLen = (s) => {
    try { return (typeof TextEncoder !== 'undefined') ? new TextEncoder().encode(s).length : (s ? s.length : 0); }
    catch (_) { return s ? s.length : 0; }
  };

  class TerminalSnapshotCache {
    constructor({ terminal, serializeAddon, maxLines = 500 } = {}) {
      this.terminal = terminal;
      this.serializeAddon = serializeAddon || null;
      this.maxLines = Number.isFinite(maxLines) ? maxLines : 500;
      this._mem = new Map(); // sessionId -> { text, cols, updatedAt, bytes }
      this._lastPainted = null; // last text written via paintCached/reconcile
      this._db = null;
      this._persistDisabled = false;
      this._dirty = new Set();
      this._persistTimer = null;
      this._ready = false;
    }

    /** Open IndexedDB and hydrate the in-memory map. Never throws. */
    async init() {
      if (this._ready) return;
      this._ready = true;
      if (typeof indexedDB === 'undefined') { this._persistDisabled = true; return; }
      try {
        this._db = await this._openDb();
        await this._hydrateFromDisk();
        // Persist any snapshots captured before the DB finished opening — their
        // _schedulePersist() no-opped while _db was still null.
        if (this._dirty.size > 0) this._schedulePersist();
      } catch (err) {
        // Private mode / blocked / corrupt — degrade to memory-only.
        this._persistDisabled = true;
        this._db = null;
        try { console.warn('[snapshot-cache] persistence disabled (memory-only):', err && err.message); } catch (_) {}
      }
    }

    _openDb() {
      return new Promise((resolve, reject) => {
        let req;
        try { req = indexedDB.open(DB_NAME, DB_VERSION); }
        catch (e) { reject(e); return; }
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'sessionId' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
        req.onblocked = () => reject(new Error('indexedDB blocked'));
      });
    }

    async _hydrateFromDisk() {
      if (!this._db) return;
      const records = await this._txAll();
      for (const r of records) {
        if (r && r.sessionId && typeof r.text === 'string') {
          // Don't let a stale persisted record overwrite a fresher in-memory
          // snapshot that was captured before this async hydrate completed.
          const existing = this._mem.get(r.sessionId);
          if (existing && (existing.updatedAt || 0) >= (r.updatedAt || 0)) continue;
          this._mem.set(r.sessionId, {
            text: r.text,
            cols: r.cols || 0,
            updatedAt: r.updatedAt || 0,
            bytes: r.bytes || byteLen(r.text),
          });
        }
      }
    }

    _txAll() {
      return new Promise((resolve, reject) => {
        try {
          const tx = this._db.transaction(STORE, 'readonly');
          const req = tx.objectStore(STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error || new Error('getAll failed'));
        } catch (e) { reject(e); }
      });
    }

    setMaxLines(n) {
      const v = parseInt(n, 10);
      if (Number.isFinite(v) && v >= 0) this.maxLines = v;
    }

    /** True if there is a cached snapshot for this session. */
    has(sessionId) {
      return !!sessionId && this._mem.has(sessionId);
    }

    /**
     * Serialize the CURRENT terminal screen and store it under sessionId.
     * Call this for the tab that is currently shown (active/outgoing), never
     * per output frame — only when the screen has settled or on switch-away.
     */
    capture(sessionId) {
      if (!sessionId || this.maxLines <= 0 || !this.serializeAddon || !this.terminal) return;
      let text;
      try {
        text = this.serializeAddon.serialize({ scrollback: this.maxLines });
      } catch (err) {
        try { console.warn('[snapshot-cache] serialize failed:', err && err.message); } catch (_) {}
        return;
      }
      if (typeof text !== 'string' || text.length === 0) return;
      const bytes = byteLen(text);
      this._mem.set(sessionId, {
        text,
        cols: (this.terminal.cols | 0) || 0,
        updatedAt: this._now(),
        bytes,
      });
      // Bound the in-memory tier in EVERY mode. The persist path's eviction is
      // skipped when persistence is disabled or the DB isn't open yet, so
      // memory-only / private-mode would otherwise grow unbounded.
      this._evictLruOverBudget();
      this._dirty.add(sessionId);
      this._schedulePersist();
    }

    /**
     * Instantly repaint the terminal from the cached snapshot for sessionId.
     * Returns true if it painted, false if there was no entry (caller then
     * relies on the server repaint). maxLines === 0 disables (returns false).
     */
    paintCached(sessionId) {
      if (!sessionId || this.maxLines <= 0 || !this.terminal) return false;
      const entry = this._mem.get(sessionId);
      if (!entry || !entry.text) return false;
      try {
        this.terminal.clear();
        this.terminal.write(entry.text);
        this._lastPainted = entry.text;
        return true;
      } catch (err) {
        try { console.warn('[snapshot-cache] paint failed:', err && err.message); } catch (_) {}
        return false;
      }
    }

    /** Drop the cached snapshot for a deleted session (memory + disk). */
    evict(sessionId) {
      if (!sessionId) return;
      this._mem.delete(sessionId);
      this._dirty.delete(sessionId);
      this._deleteFromDisk(sessionId);
    }

    /** Remove cached snapshots for sessions that no longer exist. */
    pruneOrphans(liveIds) {
      let live;
      try { live = new Set(liveIds || []); } catch (_) { return; }
      for (const id of Array.from(this._mem.keys())) {
        if (!live.has(id)) this.evict(id);
      }
    }

    // ---- persistence internals (all guarded; never throw to callers) ----

    _now() {
      // Date.now() is fine in the browser; only the workflow sandbox forbids it.
      try { return Date.now(); } catch (_) { return 0; }
    }

    _schedulePersist() {
      if (this._persistDisabled || !this._db) return;
      if (this._persistTimer) return;
      this._persistTimer = setTimeout(() => {
        this._persistTimer = null;
        this._persistNow();
      }, PERSIST_DEBOUNCE_MS);
    }

    async _persistNow() {
      if (this._persistDisabled || !this._db) { this._dirty.clear(); return; }
      // Enforce the total byte budget by evicting oldest entries first.
      this._evictLruOverBudget();
      const ids = Array.from(this._dirty);
      this._dirty.clear();
      for (const id of ids) {
        const entry = this._mem.get(id);
        if (!entry) { this._deleteFromDisk(id); continue; }
        // Too large to persist: keep it in memory, but drop any stale on-disk
        // copy so a reload doesn't hydrate an older snapshot for this session.
        if (entry.bytes > PER_RECORD_CAP_BYTES) { this._deleteFromDisk(id); continue; }
        try { await this._putOnDisk(id, entry); }
        catch (err) {
          // Quota exceeded: evict half by age, retry once, then disable persistence.
          if (err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''))) {
            this._evictLruHalf();
            try { await this._putOnDisk(id, this._mem.get(id)); }
            catch (_) { this._persistDisabled = true; }
          } else {
            try { console.warn('[snapshot-cache] persist failed:', err && err.message); } catch (_) {}
          }
        }
      }
    }

    _evictLruOverBudget() {
      let total = 0;
      for (const e of this._mem.values()) total += e.bytes || 0;
      if (total <= TOTAL_BUDGET_BYTES) return;
      const byAge = Array.from(this._mem.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      for (const [id, e] of byAge) {
        if (total <= TOTAL_BUDGET_BYTES) break;
        total -= e.bytes || 0;
        this._mem.delete(id);
        this._dirty.delete(id);
        this._deleteFromDisk(id);
      }
    }

    _evictLruHalf() {
      const byAge = Array.from(this._mem.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      const drop = Math.ceil(byAge.length / 2);
      for (let i = 0; i < drop; i++) {
        const id = byAge[i][0];
        this._mem.delete(id);
        this._dirty.delete(id);
        this._deleteFromDisk(id);
      }
    }

    _putOnDisk(sessionId, entry) {
      return new Promise((resolve, reject) => {
        if (!this._db || !entry) { resolve(); return; }
        try {
          const tx = this._db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put({
            sessionId,
            text: entry.text,
            cols: entry.cols,
            updatedAt: entry.updatedAt,
            bytes: entry.bytes,
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('put failed'));
          tx.onabort = () => reject(tx.error || new Error('put aborted'));
        } catch (e) { reject(e); }
      });
    }

    _deleteFromDisk(sessionId) {
      if (this._persistDisabled || !this._db) return;
      try {
        const tx = this._db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(sessionId);
      } catch (_) { /* best-effort */ }
    }
  }

  global.TerminalSnapshotCache = TerminalSnapshotCache;
  // CommonJS export for unit tests (Node/mocha) — harmless in the browser.
  if (typeof module !== 'undefined' && module.exports) module.exports = TerminalSnapshotCache;
})(typeof window !== 'undefined' ? window : globalThis);
