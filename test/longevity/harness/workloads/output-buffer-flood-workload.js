'use strict';

const CircularBuffer = require('../../../../src/utils/circular-buffer');
const { Workload } = require('../workload');
const { sleep } = require('./_net');

class OutputBufferFloodWorkload extends Workload {
  constructor(opts = {}) {
    super({ name: 'output-buffer-flood', ...opts });
    this.sessionCount = opts.sessionCount || 4;
    this.targetBytesPerSecond = opts.targetBytesPerSecond || 4 * 1024 * 1024;
    this.chunkBytes = opts.chunkBytes || 64 * 1024;
    this._abort = false;
    this._loop = null;
    this._sessionIds = [];
    this._stats = { chunks: 0, bytes: 0, sessions: 0 };
  }

  describe() {
    return `output-buffer-flood: ${this.sessionCount} inactive-after-output sessions at ${(this.targetBytesPerSecond / 1048576).toFixed(1)} MiB/s`;
  }

  async start(ctx) {
    this._server = ctx.server;
    if (!this._server || !this._server.claudeSessions) {
      throw new Error('OutputBufferFloodWorkload: live server required');
    }
    this._abort = false;
    for (let index = 0; index < this.sessionCount; index++) {
      const id = `soak-output-buffer-${index}`;
      this._server.claudeSessions.set(id, {
        id,
        name: id,
        created: new Date(),
        lastActivity: new Date(),
        active: true,
        agent: 'terminal',
        workingDir: ctx.workDir,
        connections: new Set(),
        outputBuffer: new CircularBuffer(1000),
        priority: 'background',
        stickyNotesEnabled: false,
      });
      this._server._pushEvictionEntry(id);
      this._sessionIds.push(id);
    }
    this._stats.sessions = this._sessionIds.length;
    this._loop = this._run();
  }

  async stop() {
    this._abort = true;
    if (this._loop) await this._loop;
    // Deliberately retain the exited-session records until the runner takes its
    // terminal snapshot. Server shutdown owns final cleanup.
    for (const id of this._sessionIds) {
      const session = this._server.claudeSessions.get(id);
      if (session) session.active = false;
    }
  }

  stats() {
    return { ...super.stats(), ...this._stats };
  }

  async _run() {
    const chunksPerSecond = Math.max(1, Math.floor(this.targetBytesPerSecond / this.chunkBytes));
    const periodMs = Math.max(1, Math.floor(1000 / chunksPerSecond));
    let chunkIndex = 0;
    while (!this._abort) {
      const id = this._sessionIds[chunkIndex % this._sessionIds.length];
      const session = this._server.claudeSessions.get(id);
      if (session) {
        const prefix = `pty-batch-${chunkIndex}:`;
        session.outputBuffer.push(prefix + 'x'.repeat(this.chunkBytes - prefix.length));
        this._stats.chunks++;
        this._stats.bytes += this.chunkBytes;
      }
      chunkIndex++;
      await sleep(periodMs);
    }
  }
}

module.exports = { OutputBufferFloodWorkload };
