'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Single-file GGUF model manager for the local sticky-note summariser.
//
// Mirrors src/utils/model-manager.js (the STT one) but for ONE configurable
// GGUF file. Default is Liquid LFM2-2.6B (Q4_K_M) from the ungated LiquidAI
// repo. It was chosen over Gemma 3 1B/4B and Qwen3-4B by a bake-off across real
// claude JSONL transcripts (see ADR-0023): the 1B produced snake_case/frozen
// done-remaining and ~35% empty updates, while LFM2-2.6B yields concrete,
// forward-looking notes with zero empty updates at ~half the latency of the 4B
// models. Swap `model` (or pass `--sticky-notes-model <url>`) to use a different
// GGUF; LFM2-1.2B is the lighter ungated alternative.

const DEFAULT_MODEL = {
  id: 'LFM2-2.6B-Q4_K_M',
  file: 'LFM2-2.6B-Q4_K_M.gguf',
  // Pinned to an immutable commit revision (not the mutable `main` ref) AND
  // SHA-256-verified before load — a tampered/replaced file is refused.
  url: 'https://huggingface.co/LiquidAI/LFM2-2.6B-GGUF/resolve/a759abdc5955d4ca97763e5cb7ff3940589ba898/LFM2-2.6B-Q4_K_M.gguf',
  expectedSize: 1563668704,
  sha256: '384bc877b6c37064982f96885bef69e4475919f5969218ed4e3b9399ae0340df', // verified before load; refuses a swapped same-size file
};

class GgufModelManager {
  constructor(options = {}) {
    this.model = Object.assign({}, DEFAULT_MODEL, options.model || {});
    this.modelsDir =
      options.modelsDir || path.join(os.homedir(), '.ai-or-die', 'models', this.model.id);
    // model file + headroom
    this._minFreeSpace = (this.model.expectedSize || 0) + 200 * 1024 * 1024;
  }

  getModelFile() {
    return path.join(this.modelsDir, this.model.file);
  }

  async isModelReady() {
    return this._verifyFile(this.getModelFile());
  }

  /**
   * Download the model if missing/corrupt. Resumes interrupted downloads and
   * re-downloads once on a failed verification.
   * @param {function} [onProgress] - ({ file, downloaded, total, fileIndex, fileCount, percent })
   */
  async ensureModel(onProgress) {
    if (await this._verifyFile(this.getModelFile())) {
      this._emitDone(onProgress);
      return;
    }
    await this._checkDiskSpace();
    await fsp.mkdir(this.modelsDir, { recursive: true });

    const dest = this.getModelFile();
    for (let attempt = 0; attempt < 2; attempt++) {
      await this._downloadFile(this.model.url, dest, this.model.expectedSize, (downloaded, total) => {
        if (onProgress) {
          onProgress({
            file: this.model.file,
            downloaded,
            total,
            fileIndex: 0,
            fileCount: 1,
            percent: total ? Math.min(100, Math.round((downloaded / total) * 100)) : 0,
          });
        }
      });
      if (await this._verifyFile(dest)) {
        this._emitDone(onProgress);
        return;
      }
      // Corrupt: drop it and retry once from scratch.
      try {
        await fsp.unlink(dest);
      } catch {
        /* ignore */
      }
    }
    throw new Error(`Verification failed for ${this.model.file} after download`);
  }

  _emitDone(onProgress) {
    if (onProgress) {
      onProgress({
        file: this.model.file,
        downloaded: this.model.expectedSize,
        total: this.model.expectedSize,
        fileIndex: 0,
        fileCount: 1,
        percent: 100,
      });
    }
  }

  async _downloadFile(url, destPath, expectedSize, onProgress) {
    const incompletePath = destPath + '.incomplete';
    let startByte = 0;

    try {
      const stats = await fsp.stat(incompletePath);
      if (expectedSize && stats.size > 0 && stats.size < expectedSize) {
        startByte = stats.size;
      } else if (expectedSize && stats.size >= expectedSize) {
        await fsp.unlink(incompletePath);
      }
    } catch {
      /* no partial file */
    }

    const headers = {};
    if (startByte > 0) headers['Range'] = `bytes=${startByte}-`;

    const response = await fetch(url, { headers });
    if (!response.ok && response.status !== 206) {
      throw new Error(`Download failed: HTTP ${response.status} for ${path.basename(destPath)}`);
    }
    if (startByte > 0 && response.status !== 206) {
      startByte = 0;
      try {
        await fsp.unlink(incompletePath);
      } catch {
        /* ignore */
      }
    }

    const body = response.body;
    if (!body) throw new Error(`No response body for ${path.basename(destPath)}`);

    const fileStream = fs.createWriteStream(incompletePath, { flags: startByte > 0 ? 'a' : 'w' });
    let downloaded = startByte;
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await new Promise((resolve, reject) => {
          fileStream.write(value, (err) => (err ? reject(err) : resolve()));
        });
        downloaded += value.byteLength;
        if (onProgress) onProgress(downloaded, expectedSize);
      }
    } finally {
      await new Promise((resolve) => fileStream.end(resolve));
    }

    await fsp.rename(incompletePath, destPath);
  }

  async _verifyFile(filePath) {
    try {
      const stats = await fsp.stat(filePath);
      if (this.model.expectedSize && stats.size !== this.model.expectedSize) return false;
      if (this.model.sha256) {
        const hash = await this._computeSha256(filePath);
        if (hash !== this.model.sha256) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  _computeSha256(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (c) => hash.update(c));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  async _checkDiskSpace() {
    try {
      const parentDir = path.dirname(this.modelsDir);
      await fsp.mkdir(parentDir, { recursive: true });
      const stats = await fsp.statfs(parentDir);
      const freeBytes = stats.bfree * stats.bsize;
      if (freeBytes < this._minFreeSpace) {
        const freeMB = Math.round(freeBytes / (1024 * 1024));
        const reqMB = Math.round(this._minFreeSpace / (1024 * 1024));
        throw new Error(`Insufficient disk space: ${freeMB}MB free, need ${reqMB}MB for model download`);
      }
    } catch (err) {
      if (err.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' || err.code === 'ENOSYS') return;
      throw err;
    }
  }
}

module.exports = GgufModelManager;
module.exports.DEFAULT_MODEL = DEFAULT_MODEL;
