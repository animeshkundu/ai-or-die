const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const CircularBuffer = require('./circular-buffer');

const MAX_BUFFER_BYTES_PER_SESSION = 512 * 1024; // 512KB per-session byte cap

/**
 * Migrate a persisted sticky note to the v2 shape:
 *   { title, goal, done[], remaining[], updates:[{text,at}], rev, ... }
 * Legacy notes used { progress[], waitingOn[] } and had no updates log.
 * @param {object|null} note
 * @returns {object|null}
 */
function migrateStickyNote(note) {
    if (!note || typeof note !== 'object') return note || null;
    // Already v2 (has any of the new fields) — pass through, ensuring updates[].
    if ('updates' in note || 'done' in note || 'remaining' in note) {
        if (!Array.isArray(note.updates)) note.updates = [];
        return note;
    }
    // Legacy { title, goal, progress[], waitingOn[] } → v2.
    return {
        title: note.title || '',
        goal: note.goal || '',
        done: Array.isArray(note.progress) ? note.progress : [],
        remaining: Array.isArray(note.waitingOn) ? note.waitingOn : [],
        updates: [],
        rev: note.rev || 0,
        updatedAt: note.updatedAt || null,
        status: note.status || 'idle',
        error: note.error || null,
    };
}

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
        // DISK-04b: monotonically increasing counter of saveSessions()
        // calls that returned false. Surfaced in _collectDiagnostics so
        // the soak harness (and operators grepping the diagnostics log)
        // can drift-watch for new concurrency / I/O regressions without
        // coupling to a specific log-line format. Pre-fix the DISK-04
        // rename race would increment this by 5–10 per 2-min soak; post-
        // fix it should stay at 0. Other increment sources: ENOSPC,
        // EBUSY on Windows, EACCES, EIO — any I/O failure path through
        // _saveSessionsLocked's catch block.
        this._saveFailureCount = 0;
        // DISK-01 follow-up (SOAK-reported race): serialize concurrent
        // saveSessions() calls. The 30 s autosave can overlap with
        // explicit saves from session-create/delete, beforeExit, and
        // SIGINT/SIGTERM handlers. Two concurrent writers both produce
        // a `.tmp` and race on rename — the loser ENOENTs because the
        // winner's rename removed the tmp. Chain via promise so each
        // call waits for the prior in-flight save to settle before
        // entering the write critical section.
        this._inFlightSave = Promise.resolve();
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

    /**
     * HOT-10: streaming JSON serializer that chunks `data.sessions` by
     * entry, stringifying each one in its own tick and yielding
     * (`await setImmediate()`) between entries. The total wall is
     * comparable to bare `JSON.stringify(data)` (the per-entry stringify
     * work doesn't disappear), but the main thread is INTERRUPTIBLE
     * every per-session-stringify (~1–10 ms on a 512 KB buffer) instead
     * of locked for 50–200 ms.
     *
     * Output is byte-identical to `JSON.stringify(data)` for the data
     * shape `_saveSessionsLocked` produces:
     *   `{ version, savedAt, sessions: [...] }`
     * where every session is a plain JS object (no nested
     * non-serializable values, no `toJSON` overrides we depend on).
     *
     * Sanity-asserted by `test/longevity/event-loop/hot-05-sessionstore-stringify.test.js`
     * which verifies the assertion-on-disk and the resulting parse
     * round-trip. Also defensive against `data.sessions` not being an
     * array — falls back to bare `JSON.stringify` for that path so
     * future callers can't trip a silent shape regression.
     *
     * See docs/audits/hot-05-sessionstore-stringify.md.
     */
    async _serializeDataStreamed(data) {
        if (!data || !Array.isArray(data.sessions)) {
            // Defensive fallback: shape doesn't match what we expect.
            // Yield once, then bare-stringify (same shape as pre-HOT-10).
            return await new Promise((resolve) =>
                setImmediate(() => resolve(JSON.stringify(data))));
        }

        // Build the envelope around the sessions array. Per-session
        // entries get stringified one-at-a-time with yields between.
        const sessionsArray = data.sessions;
        const envelope = { ...data, sessions: [] };
        // Stringify the empty-sessions envelope FIRST so we know the
        // exact bracket layout. JSON.stringify({sessions:[]}) yields
        // `..."sessions":[]...` — we splice the per-session strings
        // between the brackets.
        const envelopeStr = JSON.stringify(envelope);
        const emptyArrayMarker = '"sessions":[]';
        const splitAt = envelopeStr.lastIndexOf(emptyArrayMarker);
        if (splitAt < 0) {
            // Defensive: envelope shape didn't produce the expected
            // marker. Fall back to bare stringify.
            return await new Promise((resolve) =>
                setImmediate(() => resolve(JSON.stringify(data))));
        }
        const prefix = envelopeStr.slice(0, splitAt) + '"sessions":[';
        const suffix = ']' + envelopeStr.slice(splitAt + emptyArrayMarker.length);

        // Build the inner per-session JSON strings with per-session yields.
        const parts = [prefix];
        for (let i = 0; i < sessionsArray.length; i++) {
            if (i > 0) parts.push(',');
            parts.push(JSON.stringify(sessionsArray[i]));
            // Yield to the event loop between entries. setImmediate fires
            // AFTER pending I/O on the current tick — gives PTY data,
            // WS frames, heartbeat ticks a chance to run between session
            // serializations.
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setImmediate(resolve));
        }
        parts.push(suffix);

        // Final concatenation is itself O(total bytes) and runs on the
        // main thread, but string concat in V8 is heavily optimized
        // (rope strings) — empirically ~5 ms for 25 MB on modern
        // hardware. Well under the 50 ms loop-block budget.
        return parts.join('');
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

        // DISK-01 follow-up (SOAK-reported race): chain onto any prior
        // in-flight save so two callers don't both writeFile() the same
        // `.tmp` and race on rename. We attach to the prior promise but
        // swallow its rejection — the prior save's failure is its own
        // problem, not ours; we still want to run.
        const prior = this._inFlightSave;
        let release;
        this._inFlightSave = new Promise((resolve) => { release = resolve; });
        try {
            await prior.catch(() => {});
            return await this._saveSessionsLocked(sessions);
        } finally {
            release();
        }
    }

    async _saveSessionsLocked(sessions) {
        // Re-check dirty after acquiring the lock: a prior save in the
        // queue may have already flushed our state. (Cheap; no-op fast path.)
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
                tempImages: Array.isArray(session.tempImages) ? session.tempImages : [],
                // Sticky-note (local-LLM summary) state. Persist the generated
                // content + the resolved enable preference + manual-rename flag;
                // never persist the runtime summariser/terminal state.
                stickyNote: session.stickyNote || null,
                // The claude sessionId (JSONL basename) this note belongs to, so
                // the durable per-claude-session note store can be rebuilt after a
                // restart and resume when that session reopens.
                stickyClaudeSessionId: session.stickyClaudeSessionId || null,
                // The claude sessionId pinned via the github-router SessionStart
                // hook sidecar (terminal tabs). Persisted so the ownership
                // reservation (_ownedClaudeSessions) survives a restart; the
                // durable note itself resumes via stickyClaudeSessionId above.
                claudePinnedSessionId: session.claudePinnedSessionId || null,
                autoTitle: session.autoTitle || null,
                nameIsUserSet: session.nameIsUserSet || false,
                stickyNotesEnabled: session.stickyNotesEnabled !== false
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

            // JSON.stringify a 25–50 MB sessions array would block the
            // main thread for 50–200 ms (HOT-05). The yield-then-stringify
            // pattern only frees the loop BEFORE the work; once
            // JSON.stringify starts, V8 is locked.
            //
            // HOT-10: build the JSON envelope incrementally — stringify
            // each session entry on its own tick, yielding via
            // `await setImmediate()` between entries. Per-session
            // stringify is bounded at ≤ 512 KB (MAX_BUFFER_BYTES_PER_SESSION
            // cap on the outputBuffer slice), so each tick blocks
            // < 10 ms on modern hardware regardless of total session count.
            // See docs/audits/hot-05-sessionstore-stringify.md.
            const jsonStr = await this._serializeDataStreamed(data);

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
            this._saveFailureCount++;
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
                    stickyNote: migrateStickyNote(session.stickyNote),
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
module.exports.migrateStickyNote = migrateStickyNote;