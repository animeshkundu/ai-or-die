'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MODEL_ID = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';

const MODEL_FILES = [
  {
    name: 'encoder.int8.onnx',
    url: `https://huggingface.co/csukuangfj/${MODEL_ID}/resolve/main/encoder.int8.onnx`,
    expectedSize: 683671552,
    sha256: 'TODO_COMPUTE_HASH'
  },
  {
    name: 'decoder.int8.onnx',
    url: `https://huggingface.co/csukuangfj/${MODEL_ID}/resolve/main/decoder.int8.onnx`,
    expectedSize: 12582912,
    sha256: 'TODO_COMPUTE_HASH'
  },
  {
    name: 'joiner.int8.onnx',
    url: `https://huggingface.co/csukuangfj/${MODEL_ID}/resolve/main/joiner.int8.onnx`,
    expectedSize: 6710886,
    sha256: 'TODO_COMPUTE_HASH'
  },
  {
    name: 'tokens.txt',
    url: `https://huggingface.co/csukuangfj/${MODEL_ID}/resolve/main/tokens.txt`,
    expectedSize: 96256,
    sha256: 'TODO_COMPUTE_HASH'
  }
];

// Total model size across all files (~670MB)
const TOTAL_MODEL_SIZE = MODEL_FILES.reduce((sum, f) => sum + f.expectedSize, 0);

// Minimum free disk space required (model size + 100MB headroom)
const MIN_FREE_SPACE = TOTAL_MODEL_SIZE + 100 * 1024 * 1024;

class ModelManager {
  constructor(options = {}) {
    this.modelsDir = options.modelsDir ||
      path.join(os.homedir(), '.ai-or-die', 'models', MODEL_ID);
  }

  /**
   * Check whether all model files exist with correct sizes.
   */
  async isModelReady() {
    try {
      for (const file of MODEL_FILES) {
        const filePath = path.join(this.modelsDir, file.name);
        const stats = await fsp.stat(filePath);
        if (stats.size !== file.expectedSize) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Download any missing model files. Resumes interrupted downloads.
   * @param {function} [onProgress] - callback({ file, downloaded, total, fileIndex, fileCount })
   */
  async ensureModel(onProgress) {
    await this._checkDiskSpace();
    await fsp.mkdir(this.modelsDir, { recursive: true });

    for (let i = 0; i < MODEL_FILES.length; i++) {
      const file = MODEL_FILES[i];
      const destPath = path.join(this.modelsDir, file.name);

      // Skip files that already exist with the right size
      const exists = await this._verifyFile(destPath, file.expectedSize);
      if (exists) {
        if (onProgress) {
          onProgress({
            file: file.name,
            downloaded: file.expectedSize,
            total: file.expectedSize,
            fileIndex: i,
            fileCount: MODEL_FILES.length
          });
        }
        continue;
      }

      await this._downloadFile(file.url, destPath, file.expectedSize, (downloaded, total) => {
        if (onProgress) {
          onProgress({
            file: file.name,
            downloaded,
            total,
            fileIndex: i,
            fileCount: MODEL_FILES.length
          });
        }
      });

      // Verify downloaded file
      const valid = await this._verifyFile(destPath, file.expectedSize);
      if (!valid) {
        // Remove the bad file and throw
        try { await fsp.unlink(destPath); } catch { /* ignore */ }
        throw new Error(`Verification failed for ${file.name} after download`);
      }
    }
  }

  /**
   * Return the path to the model directory.
   */
  getModelPath() {
    return this.modelsDir;
  }

  /**
   * Download a single file with resume support.
   * Writes to a .incomplete temp file, renames on success.
   */
  async _downloadFile(url, destPath, expectedSize, onProgress) {
    const incompletePath = destPath + '.incomplete';
    let startByte = 0;

    // Check for a partial download to resume
    try {
      const stats = await fsp.stat(incompletePath);
      if (stats.size > 0 && stats.size < expectedSize) {
        startByte = stats.size;
      } else if (stats.size >= expectedSize) {
        // Incomplete file is already full size — remove and restart
        await fsp.unlink(incompletePath);
      }
    } catch {
      // No incomplete file, start fresh
    }

    const headers = {};
    if (startByte > 0) {
      headers['Range'] = `bytes=${startByte}-`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok && response.status !== 206) {
      throw new Error(`Download failed: HTTP ${response.status} for ${path.basename(destPath)}`);
    }

    // If server doesn't support range and we asked for a range, restart
    if (startByte > 0 && response.status !== 206) {
      startByte = 0;
      try { await fsp.unlink(incompletePath); } catch { /* ignore */ }
    }

    const body = response.body;
    if (!body) {
      throw new Error(`No response body for ${path.basename(destPath)}`);
    }

    const fileStream = fs.createWriteStream(incompletePath, {
      flags: startByte > 0 ? 'a' : 'w'
    });

    let downloaded = startByte;
    const reader = body.getReader();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        await new Promise((resolve, reject) => {
          fileStream.write(value, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        downloaded += value.byteLength;
        if (onProgress) {
          onProgress(downloaded, expectedSize);
        }
      }
    } finally {
      await new Promise((resolve) => fileStream.end(resolve));
    }

    // Atomic rename from .incomplete to final path
    await fsp.rename(incompletePath, destPath);
  }

  /**
   * Verify a file exists and matches the expected size.
   * When SHA-256 hashes are available (not TODO), also verifies the hash.
   */
  async _verifyFile(filePath, expectedSize) {
    try {
      const stats = await fsp.stat(filePath);
      if (stats.size !== expectedSize) {
        return false;
      }

      // Find the file entry to check for a real SHA-256
      const fileEntry = MODEL_FILES.find(f =>
        path.join(this.modelsDir, f.name) === filePath
      );

      if (fileEntry && fileEntry.sha256 && !fileEntry.sha256.startsWith('TODO')) {
        const hash = await this._computeSha256(filePath);
        if (hash !== fileEntry.sha256) {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Compute SHA-256 hash of a file.
   */
  async _computeSha256(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Check that sufficient disk space is available.
   * Uses fs.statfs() (Node 18.15+).
   */
  async _checkDiskSpace() {
    try {
      // Ensure parent directory exists so statfs has a valid path
      const parentDir = path.dirname(this.modelsDir);
      await fsp.mkdir(parentDir, { recursive: true });

      const stats = await fsp.statfs(parentDir);
      const freeBytes = stats.bfree * stats.bsize;

      if (freeBytes < MIN_FREE_SPACE) {
        const freeMB = Math.round(freeBytes / (1024 * 1024));
        const requiredMB = Math.round(MIN_FREE_SPACE / (1024 * 1024));
        throw new Error(
          `Insufficient disk space: ${freeMB}MB free, need ${requiredMB}MB for model download`
        );
      }
    } catch (err) {
      // If statfs is not supported, skip the check and let download fail naturally
      if (err.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' || err.code === 'ENOSYS') {
        return;
      }
      throw err;
    }
  }
}

module.exports = ModelManager;
module.exports.MODEL_ID = MODEL_ID;
module.exports.MODEL_FILES = MODEL_FILES;
module.exports.TOTAL_MODEL_SIZE = TOTAL_MODEL_SIZE;
