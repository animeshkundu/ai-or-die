'use strict';

/**
 * Reusable disk-rotation utility for append-only files.
 *
 * Two primitives:
 *
 *   - compactJsonlFile(srcPath, opts)
 *       Atomically gzips srcPath -> srcPath + '.gz' using the same
 *       durable-write recipe as src/utils/session-store.js
 *       (temp + fsync + rename + dir-fsync on POSIX). Skips on Windows
 *       directory-fsync (NTFS journal handles it). Cleans up the
 *       original on success. Best-effort .tmp cleanup on failure.
 *
 *   - pruneOldFiles(dirPath, pattern, opts)
 *       Lists files in dirPath matching `pattern`, sorts by mtime
 *       (oldest first), unlinks any older than `maxAgeMs` while
 *       preserving the latest `preserveLatestN`.
 *
 * Both primitives are non-blocking (await-based) and tolerate ENOENT
 * gracefully. They DO NOT throw on common transient errors — they
 * return a `{ ok, error }` shape so the caller can decide.
 *
 * Cross-platform notes:
 *   - On Windows, `fs.rename` of the gzipped output to its final
 *     location fails with EBUSY/EPERM if the source file is still
 *     held open by another process (the Claude CLI). The fallback
 *     path uses copyFile + unlink with 3-attempt retry.
 *   - Directory fsync after rename is a POSIX-only durability
 *     primitive; Node EPERMs on a Windows directory handle.
 *
 * See docs/specs/disk-budget.md and docs/audits/disk-usage-analytics-jsonl.md.
 */

const fs = require('fs').promises;
const fssync = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const IS_WINDOWS = process.platform === 'win32';

/**
 * Best-effort fsync of a path that may or may not be a directory.
 * Swallows EPERM/EISDIR/EINVAL/EBADF — those are the expected refusals
 * on exotic filesystems (procfs, FUSE) or on Windows directory handles.
 */
async function _fsyncBestEffort(targetPath, mode = 'r') {
    let handle = null;
    try {
        handle = await fs.open(targetPath, mode);
        await handle.sync();
        return { ok: true };
    } catch (err) {
        if (err && /^(EPERM|EISDIR|EINVAL|EBADF|ENOENT)$/.test(err.code)) {
            return { ok: false, error: err, ignorable: true };
        }
        return { ok: false, error: err };
    } finally {
        if (handle) {
            try { await handle.close(); } catch (_) { /* best effort */ }
        }
    }
}

/**
 * Atomically rename src -> dest with Windows EBUSY fallback.
 * On Windows, if `rename` fails with EBUSY/EPERM/EACCES, falls back
 * to copyFile + unlink with up to 3 attempts (50/200/1000 ms backoff).
 */
async function _atomicMove(src, dest) {
    try {
        await fs.rename(src, dest);
        return { ok: true };
    } catch (err) {
        if (!IS_WINDOWS || !/^(EBUSY|EPERM|EACCES)$/.test(err.code)) {
            return { ok: false, error: err };
        }
    }
    // Windows-only EBUSY fallback: copyFile + unlink, with retry.
    const backoffMs = [50, 200, 1000];
    let lastErr = null;
    for (const wait of backoffMs) {
        try {
            await fs.copyFile(src, dest);
            try { await fs.unlink(src); } catch (_) { /* best effort */ }
            return { ok: true };
        } catch (err) {
            lastErr = err;
            if (!/^(EBUSY|EPERM|EACCES)$/.test(err.code)) break;
            await new Promise(r => setTimeout(r, wait));
        }
    }
    return { ok: false, error: lastErr };
}

/**
 * Gzip srcPath in place to srcPath + '.gz' using the durable-write
 * recipe. Removes the original on success. Idempotent: if srcPath
 * does not exist but srcPath.gz does, returns { ok: true, skipped: true }.
 *
 * @param {string} srcPath  Path to a .jsonl (or any append-only) file.
 * @param {object} [opts]   Reserved for future extension.
 * @returns {Promise<{ok: boolean, bytesIn?: number, bytesOut?: number,
 *                    error?: Error, skipped?: boolean}>}
 */
async function compactJsonlFile(srcPath, _opts = {}) {
    const destPath = srcPath + '.gz';
    const tmpPath = destPath + '.tmp';

    // Idempotency check: src absent + dest present == already compacted.
    let srcStat = null;
    try {
        srcStat = await fs.stat(srcPath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            // Maybe a prior run already compacted.
            try {
                await fs.access(destPath);
                return { ok: true, skipped: true };
            } catch (_) {
                return { ok: false, error: err };
            }
        }
        return { ok: false, error: err };
    }

    // Clean any orphan tmp from a prior aborted run.
    try { await fs.unlink(tmpPath); } catch (_) { /* ENOENT ok */ }

    let bytesOut = 0;
    try {
        // Write via a plain fs.createWriteStream so the stream closes
        // its own fd on end. Then open a fresh handle to fsync the
        // bytes to platter before we publish via rename.
        const writeStream = fssync.createWriteStream(tmpPath, { mode: 0o600 });
        const readStream = fssync.createReadStream(srcPath);
        const gzip = zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED });

        writeStream.on('finish', () => {
            bytesOut = writeStream.bytesWritten;
        });

        await pipeline(readStream, gzip, writeStream);

        // Fsync the now-closed tmp file via a fresh read handle.
        // (Opening 'r+' would also work but 'r' is sufficient since the
        // OS-level dirty-page flush is what we're forcing.)
        const fsyncHandle = await fs.open(tmpPath, 'r+');
        try {
            await fsyncHandle.sync();
        } finally {
            await fsyncHandle.close().catch(() => {});
        }
    } catch (err) {
        try { await fs.unlink(tmpPath); } catch (_) {}
        return { ok: false, error: err };
    }

    // Atomic move tmp -> dest (with Windows EBUSY fallback).
    const moveResult = await _atomicMove(tmpPath, destPath);
    if (!moveResult.ok) {
        try { await fs.unlink(tmpPath); } catch (_) {}
        return { ok: false, error: moveResult.error };
    }

    // Durability of the rename (POSIX only).
    if (!IS_WINDOWS) {
        await _fsyncBestEffort(path.dirname(destPath), 'r');
    }

    // Unlink the original now that the gzipped copy is durable.
    try {
        await fs.unlink(srcPath);
    } catch (err) {
        // Best-effort: the source might be locked on Windows by the
        // CLI's open append handle. The gzipped copy is durable; the
        // next sweep will retry the unlink. Log under debug only.
        if (!IS_WINDOWS || !/^(EBUSY|EPERM|EACCES)$/.test(err.code)) {
            return { ok: false, error: err, bytesIn: srcStat.size, bytesOut };
        }
    }

    return { ok: true, bytesIn: srcStat.size, bytesOut };
}

/**
 * Prune files in dirPath matching `pattern` (RegExp) that are older
 * than `maxAgeMs`, while preserving the most recent `preserveLatestN`.
 *
 * @param {string} dirPath
 * @param {RegExp} pattern    Filename pattern (NOT full-path).
 * @param {object} opts
 * @param {number} opts.maxAgeMs        Files older than this are eligible.
 * @param {number} [opts.preserveLatestN=1]  Newest N files always kept.
 * @returns {Promise<{ok: boolean, pruned: string[], skipped: string[], error?: Error}>}
 */
async function pruneOldFiles(dirPath, pattern, opts) {
    const maxAgeMs = opts && opts.maxAgeMs;
    if (typeof maxAgeMs !== 'number' || maxAgeMs < 0) {
        return { ok: false, pruned: [], skipped: [], error: new Error('maxAgeMs required (positive number)') };
    }
    const preserveLatestN = (opts && opts.preserveLatestN) || 1;

    let entries;
    try {
        entries = await fs.readdir(dirPath);
    } catch (err) {
        if (err.code === 'ENOENT') return { ok: true, pruned: [], skipped: [] };
        return { ok: false, pruned: [], skipped: [], error: err };
    }

    const matches = [];
    for (const name of entries) {
        if (!pattern.test(name)) continue;
        const full = path.join(dirPath, name);
        try {
            const st = await fs.stat(full);
            if (!st.isFile()) continue;
            matches.push({ path: full, mtimeMs: st.mtimeMs });
        } catch (_) { /* skip racy unlinks */ }
    }

    matches.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

    const pruned = [];
    const skipped = [];
    const now = Date.now();

    for (let i = 0; i < matches.length; i++) {
        const { path: full, mtimeMs } = matches[i];
        if (i < preserveLatestN) {
            skipped.push(full);
            continue;
        }
        if ((now - mtimeMs) <= maxAgeMs) {
            skipped.push(full);
            continue;
        }
        try {
            await fs.unlink(full);
            pruned.push(full);
        } catch (_) { /* best effort */ }
    }

    return { ok: true, pruned, skipped };
}

module.exports = {
    compactJsonlFile,
    pruneOldFiles,
    _atomicMove,           // exported for testing
    _fsyncBestEffort,      // exported for testing
};
