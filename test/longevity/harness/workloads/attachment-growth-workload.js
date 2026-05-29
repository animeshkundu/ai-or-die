'use strict';

/**
 * AttachmentGrowthWorkload
 *
 * Preload a target directory with N pre-existing files (HOT-04: the
 * `_attachmentDirBytes` synchronous `readdirSync + statSync` loop), then
 * trigger uploads at a probe rate to surface any per-upload re-scan cost.
 *
 * We don't actually have a /api/files/attachments POST endpoint at the same
 * URL shape on every release — to keep this workload portable we instead:
 *   1. Preload the work-dir with N files in `.ai-or-die-attachments/`-style
 *      subdir (the default base used internally).
 *   2. Hit a HEAD-equivalent: GET /api/files?path=<workDir> at the probe
 *      rate, which forces the directory enumeration code path used by the
 *      attachment workflow.
 *
 * This is a coarse probe — if SUP-HOT supplies a more precise endpoint
 * later (e.g. exposes `_attachmentDirBytes` via an internal handle), this
 * workload's `_probe()` can be replaced.
 */
const fs = require('fs');
const path = require('path');

const { Workload } = require('../workload');
const { httpRequest, sleep } = require('./_net');

class AttachmentGrowthWorkload extends Workload {
  constructor(opts = {}) {
    super({ name: 'attachment-growth', ...opts });
    // Default 100-file preload for smoke; plan-spec stress is 1000 (opt-in).
    this.preloadCount = opts.preloadCount || 100;
    this.probesPerSecond = opts.probesPerSecond || 5;
    this.fileSizeBytes = opts.fileSizeBytes || 1024;
    this._abort = false;
    this._loop = null;
    this._dir = null;
    this._stats = { probes: 0, errors: 0 };
  }
  describe() {
    return `attachment-growth: ${this.preloadCount} files preloaded, ${this.probesPerSecond}probes/s`;
  }
  async start(ctx) {
    this._abort = false;
    this._baseUrl = ctx.baseUrl;
    this._dir = path.join(ctx.workDir, 'attachments');
    fs.mkdirSync(this._dir, { recursive: true });
    const buf = Buffer.alloc(this.fileSizeBytes, 0x41);
    for (let i = 0; i < this.preloadCount; i++) {
      const fname = path.join(this._dir, `att-${i.toString().padStart(5, '0')}.bin`);
      fs.writeFileSync(fname, buf);
    }
    this._loop = this._run();
    this.emit('start', { preloadCount: this.preloadCount, dir: this._dir });
  }
  async stop() {
    this._abort = true;
    if (this._loop) { try { await this._loop; } catch (_) { /* ignore */ } this._loop = null; }
    if (this._dir) {
      try { fs.rmSync(this._dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      this._dir = null;
    }
    this.emit('stop', this._stats);
  }
  stats() { return { ...super.stats(), ...this._stats }; }

  async _run() {
    const period = Math.max(1, Math.floor(1000 / this.probesPerSecond));
    while (!this._abort) {
      try {
        const url = `${this._baseUrl}/api/files?path=${encodeURIComponent(this._dir)}`;
        const res = await httpRequest('GET', url, { timeoutMs: 5000 });
        if (res.statusCode === 200) this._stats.probes++;
        else this._stats.errors++;
      } catch (_) {
        this._stats.errors++;
      }
      await sleep(period);
    }
  }
}

module.exports = { AttachmentGrowthWorkload };
