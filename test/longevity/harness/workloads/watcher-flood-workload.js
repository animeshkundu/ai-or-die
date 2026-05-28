'use strict';

/**
 * WatcherFloodWorkload
 *
 * Drive 100 create/change/unlink ops/sec against N watched subdirs of the
 * workDir. Subscribes via `/api/files/watch` so the chokidar fan-out is
 * actually exercised (raw fs writes without a subscriber would not stress
 * the watcher pipeline at all).
 *
 * Stresses HOT-02 (`_hashFileSync` sync read on the event-loop) and the
 * narrowed-chokidar depth:0 behavior on the watcher fan-out.
 */
const fs = require('fs');
const path = require('path');

const { Workload } = require('../workload');
const { httpRequest, sleep } = require('./_net');

class WatcherFloodWorkload extends Workload {
  constructor(opts = {}) {
    super({ name: 'watcher-flood', ...opts });
    this.dirCount = opts.dirCount || 5;
    this.opsPerSecond = opts.opsPerSecond || 100;
    this.includeHashMix = opts.includeHashMix !== false; // default true
    this._abort = false;
    this._loop = null;
    this._subscribedSessionIds = [];
    this._stats = { creates: 0, modifies: 0, deletes: 0, errors: 0 };
    this._dirs = [];
  }
  describe() {
    return `watcher-flood: ${this.opsPerSecond}ops/s across ${this.dirCount} dirs, includeHash mix=${this.includeHashMix}`;
  }
  async start(ctx) {
    this._abort = false;
    this._baseUrl = ctx.baseUrl;
    // Create N watched subdirs under workDir.
    for (let i = 0; i < this.dirCount; i++) {
      const d = path.join(ctx.workDir, `watch-${i}`);
      fs.mkdirSync(d, { recursive: true });
      this._dirs.push(d);
    }
    // Subscribe via the public API for each dir. Subscriptions are keyed by
    // sessionId; we mint synthetic IDs.
    for (let i = 0; i < this._dirs.length; i++) {
      const sessionId = `soak-watcher-${i}`;
      try {
        await httpRequest('POST', `${ctx.baseUrl}/api/files/watch/subscribe`, {
          body: {
            sessionId,
            path: this._dirs[i],
            includeHash: this.includeHashMix ? (i % 2 === 0) : false,
          },
        });
        this._subscribedSessionIds.push(sessionId);
      } catch (err) {
        this.emit('subscribe_error', { dir: this._dirs[i], error: err.message });
      }
    }
    this._loop = this._run();
    this.emit('start', { dirs: this._dirs.length, subscriptions: this._subscribedSessionIds.length });
  }
  async stop() {
    this._abort = true;
    if (this._loop) { try { await this._loop; } catch (_) { /* ignore */ } this._loop = null; }
    for (const sid of this._subscribedSessionIds) {
      try {
        await httpRequest('POST', `${this._baseUrl}/api/files/watch/unsubscribe`, {
          body: { sessionId: sid },
        });
      } catch (_) { /* ignore */ }
    }
    this._subscribedSessionIds = [];
    // Tear down the temp dirs (workDir cleanup also handles this, but be tidy).
    for (const d of this._dirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
    this._dirs = [];
    this.emit('stop', this._stats);
  }
  stats() { return { ...super.stats(), ...this._stats }; }

  async _run() {
    const period = Math.max(1, Math.floor(1000 / this.opsPerSecond));
    let i = 0;
    while (!this._abort) {
      const dir = this._dirs[i % this._dirs.length];
      const fname = path.join(dir, `f-${(i % 1000).toString().padStart(4, '0')}.txt`);
      const op = ['create', 'modify', 'delete'][i % 3];
      try {
        if (op === 'create') {
          fs.writeFileSync(fname, `init ${i}\n`);
          this._stats.creates++;
        } else if (op === 'modify') {
          fs.appendFileSync(fname, `mod ${i}\n`);
          this._stats.modifies++;
        } else {
          try { fs.unlinkSync(fname); this._stats.deletes++; } catch (_) { /* may not exist on first rotation */ }
        }
      } catch (err) {
        this._stats.errors++;
      }
      i++;
      await sleep(period);
    }
  }
}

module.exports = { WatcherFloodWorkload };
