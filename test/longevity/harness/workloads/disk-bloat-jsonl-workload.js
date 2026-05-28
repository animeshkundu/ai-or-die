'use strict';

/**
 * DiskBloatJsonlWorkload (SOAK-05e — DISK-02 lane)
 *
 * Floods a fake `~/.claude/projects/<proj>/` tree with synthetic JSONL
 * entries at ~10 MB/s. Exercises:
 *   - UsageReader / UsageAnalytics append paths
 *   - DISK-02's `compactStale()` rotation triggers
 *   - `disk.usage_mb` growth observability via /api/diagnostics
 *
 * Uses a per-soak tmpdir for `claudeProjectsPath` so the operator's real
 * `~/.claude/projects/` is never touched. SUP-DISK confirmed UsageReader
 * accepts `{claudeProjectsPath: <dir>}` from commit d388cc7.
 *
 * Note on integration: this workload writes JSONL files directly, then
 * (optionally) pokes the server's UsageReader so it re-scans. The audit
 * gap DISK-02 is fixing lives in the server-side rotation; our job is to
 * generate the files at a rate that triggers the rotation cadence and
 * let the diagnostics gate `disk.bytes_used` measure whether rotation
 * keeps up.
 */

const fs = require('fs');
const path = require('path');

const { Workload } = require('../workload');
const { sleep } = require('./_net');

const SAMPLE_USAGE_LINE = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-05-28T04:00:00.000Z',
  message: {
    id: 'msg_'.padEnd(64, 'x'),
    role: 'assistant',
    content: [{ type: 'text', text: 'x'.repeat(2400) }],
    usage: { input_tokens: 1500, output_tokens: 800 },
  },
}) + '\n';

class DiskBloatJsonlWorkload extends Workload {
  constructor(opts = {}) {
    super({ name: 'disk-bloat-jsonl', ...opts });
    // Smoke-friendly defaults; stress profile = 10MB/s, 4 projects.
    this.projectCount = opts.projectCount || 2;
    this.targetBytesPerSecond = opts.targetBytesPerSecond || 1 * 1024 * 1024; // 1 MB/s default
    this.linesPerWrite = opts.linesPerWrite || 8;
    this._abort = false;
    this._loop = null;
    this._stats = { writes: 0, bytes: 0, errors: 0 };
  }
  describe() {
    return `disk-bloat-jsonl: ${this.projectCount} projects × ~${(this.targetBytesPerSecond / 1024 / 1024).toFixed(1)}MB/s`;
  }
  async start(ctx) {
    this._abort = false;
    // Per SUP-DISK: route via a per-soak fake claude-projects dir so the
    // operator's real ~/.claude/projects/ is never touched.
    this._claudeProjectsDir = path.join(ctx.workDir, 'fake-claude-projects');
    fs.mkdirSync(this._claudeProjectsDir, { recursive: true });
    this._files = [];
    for (let i = 0; i < this.projectCount; i++) {
      const projDir = path.join(this._claudeProjectsDir, `proj-${i}`);
      fs.mkdirSync(projDir, { recursive: true });
      this._files.push(path.join(projDir, 'usage.jsonl'));
    }
    this._loop = this._run();
    this.emit('start', {
      projectCount: this.projectCount,
      targetBps: this.targetBytesPerSecond,
      dir: this._claudeProjectsDir,
    });
  }
  async stop() {
    this._abort = true;
    if (this._loop) { try { await this._loop; } catch (_) { /* ignore */ } this._loop = null; }
    // Don't rm the dir — let the server-controller's tmpRoot cleanup get it.
    this.emit('stop', this._stats);
  }
  stats() { return { ...super.stats(), ...this._stats }; }

  async _run() {
    const bytesPerWrite = SAMPLE_USAGE_LINE.length * this.linesPerWrite;
    const writesPerSecond = Math.max(1, Math.floor(this.targetBytesPerSecond / bytesPerWrite));
    const periodMs = Math.max(1, Math.floor(1000 / writesPerSecond));
    let i = 0;
    while (!this._abort) {
      const target = this._files[i % this._files.length];
      const chunk = SAMPLE_USAGE_LINE.repeat(this.linesPerWrite);
      try {
        // Append, not stream — UsageReader re-opens the file on each pass.
        fs.appendFileSync(target, chunk);
        this._stats.writes++;
        this._stats.bytes += chunk.length;
      } catch (err) {
        this._stats.errors++;
      }
      i++;
      // Yield every write so the diagnostics sampler still runs.
      await sleep(periodMs);
    }
  }
}

module.exports = { DiskBloatJsonlWorkload };
