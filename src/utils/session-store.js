const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const CircularBuffer = require('./circular-buffer');

const MAX_BUFFER_BYTES_PER_SESSION = 512 * 1024; // 512KB per-session byte cap

class SessionStore {
    constructor(options) {
        options = options || {};
        // Store sessions in user's home directory (or custom path for testing)
        this.storageDir = options.storageDir
            || process.env.AI_OR_DIE_SESSION_DIR
            || path.join(os.homedir(), '.ai-or-die');
        this.sessionsFile = path.join(this.storageDir, 'sessions.json');
        this._dirty = false;
        // DISK-03: surface the last save error to the server so it can
        // open the disk-full circuit breaker on ENOSPC without the
        // caller having to wrap saveSessions. Null after a successful
        // save; otherwise an Error-shaped object carrying .code.
        this._lastSaveError = null;
        this.initializeStorage();
    }

    markDirty() {
        this._dirty = true;
    }

    /**
     * Trim an array of output lines to fit within MAX_BUFFER_BYTES_PER_SESSION.
     * Keeps the most recent lines (end of array) and drops the oldest.
     */
    _capBufferByBytes(lines) {
        let totalBytes = 0;
        // Walk backwards from the end (newest lines) summing byte lengths
        let startIndex = lines.length;
        for (let i = lines.length - 1; i >= 0; i--) {
            const lineBytes = Buffer.byteLength(lines[i] || '', 'utf8');
            if (totalBytes + lineBytes > MAX_BUFFER_BYTES_PER_SESSION) break;
            totalBytes += lineBytes;
            startIndex = i;
        }
        return startIndex === 0 ? lines : lines.slice(startIndex);
    }

    async initializeStorage() {
        try {
            // Create storage directory if it doesn't exist
            await fs.mkdir(this.storageDir, { recursive: true });
        } catch (error) {
            console.error('Failed to create storage directory:', error);
        }
    }

    async saveSessions(sessions) {
        if (!this._dirty) return true;

        try {
            // Ensure storage directory exists
            await fs.mkdir(this.storageDir, { recursive: true });

            // Convert Map to array for JSON serialization
            const sessionsArray = Array.from(sessions.entries()).map(([id, session]) => ({
                id,
                name: session.name || 'Unnamed Session',
                created: session.created || new Date(),
                lastActivity: session.lastActivity || new Date(),
                workingDir: session.workingDir || process.cwd(),
                active: false, // Always set to false when saving (processes won't persist)
                wasActive: session.active || false, // Preserve active state for restart awareness
                agent: session.agent || null, // Which tool was running (claude, codex, etc.)
                outputBuffer: (session.outputBuffer && typeof session.outputBuffer.slice === 'function')
                    ? this._capBufferByBytes(session.outputBuffer.slice(-1000)) : [], // Keep last 1000 lines, capped at 512KB
                connections: [], // Clear connections (they won't persist)
                lastAccessed: session.lastAccessed || Date.now(),
                // Session-specific usage tracking
                sessionStartTime: session.sessionStartTime || null,
                sessionUsage: session.sessionUsage || {
                    requests: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheTokens: 0,
                    totalCost: 0,
                    models: {}
                },
                tempImages: Array.isArray(session.tempImages) ? session.tempImages : []
            }));

            const data = {
                version: '1.0',
                savedAt: new Date().toISOString(),
                sessions: sessionsArray
            };

            // Atomic, durable write — see docs/audits/disk-atomic-write.md (DISK-01).
            //
            // The standard POSIX recipe is:
            //   1. open(temp, O_WRONLY|O_CREAT|O_TRUNC, 0o600)
            //   2. write(jsonStr)
            //   3. fsync(tempFd)         <- DURABILITY of file contents
            //   4. close(tempFd)
            //   5. rename(temp, target)  <- ATOMICITY of swap (rename(2))
            //   6. fsync(dirFd)          <- DURABILITY of the rename
            //
            // Use restrictive permissions (owner-only) since output may contain
            // secrets. Note: mode 0o600 is silently ignored on Windows (which
            // uses ACLs instead of Unix permissions); the file inherits the
            // user's default ACL, which is acceptable.
            //
            // On Windows we skip the directory fsync: NTFS journal +
            // MoveFileExW(REPLACE_EXISTING) provide the equivalent guarantee,
            // and Node's fsync on a directory handle returns EPERM there.
            const tempFile = `${this.sessionsFile}.tmp`;

            // Opportunistic cleanup of a stale .tmp from a prior aborted run.
            // Defense-in-depth — the writeFile below would overwrite anyway,
            // but an explicit unlink keeps any partial bytes from a disk-full
            // mid-write off disk while we re-write.
            try { await fs.unlink(tempFile); } catch (_) { /* ENOENT ok */ }

            // JSON.stringify is CPU-bound; yield to pending I/O before serializing.
            const jsonStr = await new Promise(resolve => setImmediate(() => resolve(JSON.stringify(data))));

            // Step 1–4: write + fsync + close the temp file via an explicit
            // FileHandle so we can call .sync() before closing.
            let tempHandle = null;
            try {
                tempHandle = await fs.open(tempFile, 'w', 0o600);
                await tempHandle.writeFile(jsonStr);
                await tempHandle.sync(); // fsync data + metadata
            } finally {
                if (tempHandle) {
                    try { await tempHandle.close(); } catch (_) { /* best effort */ }
                }
            }

            // Step 5: atomic swap. On POSIX this is rename(2); on Windows
            // libuv maps fs.rename to MoveFileExW with MOVEFILE_REPLACE_EXISTING,
            // which is atomic on the NTFS journal for same-volume moves.
            await fs.rename(tempFile, this.sessionsFile);

            // Step 6: fsync the parent directory so the rename itself is
            // durable. POSIX-only; skipped on Windows (see above).
            if (process.platform !== 'win32') {
                let dirHandle = null;
                try {
                    dirHandle = await fs.open(this.storageDir, 'r');
                    await dirHandle.sync();
                } catch (dirErr) {
                    // Some filesystems (procfs, some FUSE mounts) refuse fsync
                    // on directory handles with EINVAL / EISDIR / EBADF.
                    // Best-effort: the rename has been issued; durability is
                    // a best-effort guarantee on those exotic mounts.
                } finally {
                    if (dirHandle) {
                        try { await dirHandle.close(); } catch (_) { /* best effort */ }
                    }
                }
            }

            this._dirty = false;
            this._lastSaveError = null;
            return true;
        } catch (error) {
            this._lastSaveError = error;
            console.error('Failed to save sessions:', error.message);
            return false;
        }
    }

    async loadSessions() {
        try {
            // Check if sessions file exists
            await fs.access(this.sessionsFile);
            
            const data = await fs.readFile(this.sessionsFile, 'utf8');
            
            // Check if file is empty or just whitespace
            if (!data || !data.trim()) {
                console.log('Sessions file is empty, starting fresh');
                return new Map();
            }
            
            let parsed;
            try {
                parsed = JSON.parse(data);
            } catch (parseError) {
                console.error('Sessions file is corrupted, starting fresh:', parseError.message);
                // Try to backup the corrupted file
                try {
                    await fs.rename(this.sessionsFile, `${this.sessionsFile}.corrupted.${Date.now()}`);
                } catch (renameError) {
                    // Ignore rename errors
                }
                return new Map();
            }
            
            // Validate parsed data structure
            if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
                console.log('Invalid sessions file format, starting fresh');
                return new Map();
            }
            
            // Check if data is recent (within last 7 days)
            if (parsed.savedAt) {
                const savedAt = new Date(parsed.savedAt);
                const now = new Date();
                const daysSinceSave = (now - savedAt) / (1000 * 60 * 60 * 24);
                
                if (daysSinceSave > 7) {
                    console.log('Sessions are too old, starting fresh');
                    return new Map();
                }
            }

            // Convert array back to Map
            const sessions = new Map();
            for (const session of parsed.sessions) {
                if (!session || !session.id) continue; // Skip invalid sessions
                
                // Restore session with default values for runtime properties
                sessions.set(session.id, {
                    ...session,
                    created: session.created ? new Date(session.created) : new Date(),
                    lastActivity: session.lastActivity ? new Date(session.lastActivity) : new Date(),
                    active: false,
                    connections: new Set(),
                    outputBuffer: CircularBuffer.fromArray(session.outputBuffer || [], 1000),
                    maxBufferSize: 1000,
                    // Restore usage data if available (saved under sessionUsage key)
                    sessionUsage: session.sessionUsage || null
                });
            }

            console.log(`Restored ${sessions.size} sessions from disk`);
            return sessions;
        } catch (error) {
            // File doesn't exist or other errors, return empty Map
            if (error.code !== 'ENOENT') {
                console.error('Failed to load sessions:', error.message);
            }
            return new Map();
        }
    }

    async clearOldSessions() {
        try {
            await fs.unlink(this.sessionsFile);
            console.log('Cleared old sessions');
            return true;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('Failed to clear sessions:', error);
            }
            return false;
        }
    }

    async getSessionMetadata() {
        try {
            await fs.access(this.sessionsFile);
            const stats = await fs.stat(this.sessionsFile);
            const data = await fs.readFile(this.sessionsFile, 'utf8');
            const parsed = JSON.parse(data);
            
            return {
                exists: true,
                savedAt: parsed.savedAt,
                sessionCount: parsed.sessions ? parsed.sessions.length : 0,
                fileSize: stats.size,
                version: parsed.version
            };
        } catch (error) {
            return {
                exists: false,
                error: error.message
            };
        }
    }
}

module.exports = SessionStore;