'use strict';

/**
 * Append-only JSONL writer with periodic flush.
 *
 * One record per line, no array wrapping — so a long-running soak can be
 * tail-followed with `tail -F`, and partial writes recoverable line-by-line.
 *
 * Lifecycle:
 *   const w = new JsonlWriter(absPath);
 *   await w.open();
 *   w.write(obj);   // synchronous push into buffer; flushed periodically + on close
 *   await w.close();
 */
const fs = require('fs');
const path = require('path');

class JsonlWriter {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.flushIntervalMs = options.flushIntervalMs || 1000;
    this.flushAfterBytes = options.flushAfterBytes || 64 * 1024;
    this._fd = null;
    this._pending = [];
    this._pendingBytes = 0;
    this._flushTimer = null;
    this._closed = false;
  }

  async open() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // 'a' = append, create if missing. Sync to keep open semantics simple.
    this._fd = fs.openSync(this.filePath, 'a');
    this._flushTimer = setInterval(() => {
      this._flush().catch(err => {
        // Don't crash the soak on a transient EIO; log + continue.
        process.stderr.write(`[soak/jsonl] flush failed: ${err.message}\n`);
      });
    }, this.flushIntervalMs);
    // Keep the interval from blocking event-loop exit if the harness is
    // killed mid-run.
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  /**
   * Append a record. Synchronous to the caller; bytes are buffered and
   * fsync'd on the next flush tick. The record is serialized synchronously
   * (so the caller can mutate the object afterwards without aliasing).
   */
  write(record) {
    if (this._closed) {
      throw new Error('JsonlWriter: write after close');
    }
    const line = JSON.stringify(record) + '\n';
    this._pending.push(line);
    this._pendingBytes += Buffer.byteLength(line, 'utf8');
    if (this._pendingBytes >= this.flushAfterBytes) {
      // fire-and-forget; flush errors surface via stderr
      this._flush().catch(err => {
        process.stderr.write(`[soak/jsonl] flush failed: ${err.message}\n`);
      });
    }
  }

  async _flush() {
    if (!this._fd || this._pending.length === 0) return;
    const chunk = this._pending.join('');
    this._pending = [];
    this._pendingBytes = 0;
    await new Promise((resolve, reject) => {
      fs.write(this._fd, chunk, (err) => err ? reject(err) : resolve());
    });
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    await this._flush();
    if (this._fd != null) {
      await new Promise((resolve) => fs.close(this._fd, () => resolve()));
      this._fd = null;
    }
  }
}

module.exports = JsonlWriter;
