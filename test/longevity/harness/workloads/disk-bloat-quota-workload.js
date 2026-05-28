'use strict';

/**
 * DiskBloatQuotaWorkload (SOAK-05e — DISK-03 lane)
 *
 * Floods the harness's storage dir until > 90% of `AIORDIE_DISK_QUOTA_MB`
 * is consumed. Exercises:
 *   - DISK-03's ENOSPC circuit breaker
 *   - `disk.quota_used_pct` / `disk.circuit_breaker_open` observability
 *   - The `disk_full` WS broadcast (audited via diagnostics counters)
 *
 * IMPORTANT: this workload deliberately trips the breaker. The GateEvaluator
 * must be invoked with `thresholds: { disk_breaker_allow_trip: true }` for
 * the `disk.circuit_breaker` and `disk.quota` gates to report informational
 * rather than failing. The CLI sets that automatically when this workload
 * appears in `--workloads=`.
 *
 * To use a low quota in test (so the breaker trips fast), the operator runs:
 *   AIORDIE_DISK_QUOTA_MB=50 npm run soak -- --workloads=disk-bloat-quota
 * The env var is server-side; this workload doesn't set it (would race the
 * server constructor).
 */

const fs = require('fs');
const path = require('path');

const { Workload } = require('../workload');
const { sleep } = require('./_net');

class DiskBloatQuotaWorkload extends Workload {
  constructor(opts = {}) {
    super({ name: 'disk-bloat-quota', ...opts });
    this.fileSizeBytes = opts.fileSizeBytes || 256 * 1024;     // 256 KB per file
    this.filesPerSecond = opts.filesPerSecond || 8;            // ~2 MB/s
    this.targetUsedMb = opts.targetUsedMb || null;             // stop after this
    this._abort = false;
    this._loop = null;
    this._dir = null;
    this._stats = { files: 0, bytes: 0, errors: 0, enospc: 0 };
  }
  describe() {
    return `disk-bloat-quota: ${this.filesPerSecond} files/s × ${this.fileSizeBytes}B (=${(this.filesPerSecond * this.fileSizeBytes / 1024 / 1024).toFixed(1)}MB/s)`;
  }
  async start(ctx) {
    this._abort = false;
    // Bloat under storageDir so DISK-03's quota check (rooted at
    // ~/.ai-or-die equivalent = storageDir for tests) sees the growth.
    this._dir = path.join(ctx.storageDir || ctx.workDir, 'bloat-quota');
    fs.mkdirSync(this._dir, { recursive: true });
    this._buf = Buffer.alloc(this.fileSizeBytes, 0x42);
    this._loop = this._run();
    this.emit('start', {
      fileSizeBytes: this.fileSizeBytes,
      filesPerSecond: this.filesPerSecond,
      dir: this._dir,
    });
  }
  async stop() {
    this._abort = true;
    if (this._loop) { try { await this._loop; } catch (_) { /* ignore */ } this._loop = null; }
    // Clean up the bloat — DISK-03 fix may have refused subsequent writes,
    // but the files we wrote DO exist on disk and we should remove them.
    if (this._dir) {
      try { fs.rmSync(this._dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
    this.emit('stop', this._stats);
  }
  stats() { return { ...super.stats(), ...this._stats }; }

  async _run() {
    const period = Math.max(1, Math.floor(1000 / this.filesPerSecond));
    let i = 0;
    while (!this._abort) {
      const fname = path.join(this._dir, `bloat-${i.toString().padStart(6, '0')}.bin`);
      try {
        fs.writeFileSync(fname, this._buf);
        this._stats.files++;
        this._stats.bytes += this._buf.length;
        if (this.targetUsedMb !== null && (this._stats.bytes / 1024 / 1024) >= this.targetUsedMb) {
          this.emit('quota_target_hit', { used_mb: this._stats.bytes / 1024 / 1024 });
          // Stop generating more bloat once we've hit the target; the
          // sampler keeps observing the breaker behavior over the rest of
          // the soak.
          this._abort = true;
          break;
        }
      } catch (err) {
        if (err.code === 'ENOSPC') {
          this._stats.enospc++;
          // Briefly back off — the breaker may reset shortly.
          await sleep(500);
        } else {
          this._stats.errors++;
        }
      }
      i++;
      await sleep(period);
    }
  }
}

module.exports = { DiskBloatQuotaWorkload };
