const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const CircularBuffer = require('./circular-buffer');

const MAX_BUFFER_BYTES_PER_SESSION = 512 * 1024; // 512KB per-session byte cap

class SessionStore {
    constructor(options) {
        options = options || {};
        // Store sessions in user's home directory (or custom path for testing)
        this.storageDir = options.storageDir || path.join(os.homedir(), '.ai-or-die');
        this.sessionsFile = path.join(this.storageDir, 'sessions.json');
        this._dirty = false;
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

            // Write to a temporary file first, then rename (atomic operation)
            // Use restrictive permissions (owner-only) since output may contain secrets.
            // Note: mode 0o600 is silently ignored on Windows (which uses ACLs instead
            // of Unix permissions). The file inherits the user's default ACL, which is
            // acceptable but not explicitly enforced.
            const tempFile = `${this.sessionsFile}.tmp`;
            // JSON.stringify is CPU-bound; yield to pending I/O before serializing
            const jsonStr = await new Promise(resolve => setImmediate(() => resolve(JSON.stringify(data))));
            await fs.writeFile(tempFile, jsonStr, { mode: 0o600 });
            // Ensure directory still exists before rename (handles race conditions)
            await fs.mkdir(this.storageDir, { recursive: true });
            await fs.rename(tempFile, this.sessionsFile);
            this._dirty = false;

            return true;
        } catch (error) {
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