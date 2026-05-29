# Bridge Specification

Bridges manage the spawning, I/O, and lifecycle of CLI agent processes via `node-pty`. Each bridge class owns a `Map<sessionId, BridgeSession>` of active pty sessions.

---

## Common Interface

Every bridge implements the same public API:

| Method | Signature | Description |
|--------|-----------|-------------|
| `startSession` | `(sessionId, options) => Promise<BridgeSession>` | Spawn the CLI process in a pty and wire up output/exit/error callbacks. Throws if `sessionId` already exists. |
| `sendInput` | `(sessionId, data) => Promise<void>` | Write data to the pty stdin with chunked writes. Large inputs (> 4096 bytes) are split into 4096-byte chunks with 10ms inter-chunk delays to prevent ConPTY buffer overflow. Writes are serialized per-session via `writeQueue`. Throws if session is missing or inactive. |
| `resize` | `(sessionId, cols, rows) => Promise<void>` | Resize the pty dimensions. Logs a warning on failure instead of throwing. |
| `stopSession` | `(sessionId) => Promise<void>` | Send `SIGTERM`; after a 5-second grace period, send `SIGKILL`. Removes the session from the internal Map. |
| `getSession` | `(sessionId) => BridgeSession \| undefined` | Return the raw session object. |
| `getAllSessions` | `() => Array<{ id, workingDir, created, active }>` | List all sessions with metadata. |
| `cleanup` | `() => Promise<void>` | Stop all active sessions. |

### BridgeSession Object

```js
{
  process: IPty,              // node-pty process handle
  workingDir: string,         // cwd the process was started in
  created: Date,
  active: boolean,
  killTimeout: Timeout|null,  // handle for the SIGKILL escalation timer
  writeQueue: Promise<void>   // serialization chain for chunked PTY writes
}
```

### startSession Options

```js
{
  workingDir: string,                  // defaults to process.cwd()
  dangerouslySkipPermissions: boolean, // defaults to false (Claude, Codex, Copilot, Gemini)
  cols: number,                        // defaults to 80
  rows: number,                        // defaults to 24
  onOutput: (data: string) => void,
  onExit: (code: number, signal: number) => void,
  onError: (error: Error) => void,
  cols: number,                        // defaults to 80
  rows: number                         // defaults to 24
}
```

### PTY Environment

All bridges spawn with these environment variables:

```
TERM=xterm-256color
FORCE_COLOR=1
COLORTERM=truecolor
```

The pty name is set to `xterm-color`.

### Command Discovery

Each bridge's constructor calls `findCommand()` which iterates through platform-specific candidate paths. Discovery works differently depending on whether the candidate is an absolute path or a bare command name:

- **Absolute paths:** Checked via `fs.existsSync()` only. On Windows, candidates are expanded with `.exe` and `.cmd` suffixes (e.g., `C:\Users\foo\.claude\local\claude` also checks `claude.exe` and `claude.cmd`).
- **Bare command names:** Checked via `commandExists()`, which runs `which` (Linux/macOS) or `where` (Windows) with a 5-second timeout to prevent hangs on systems with large PATH or network-mapped drives.

The first match wins. If none are found, a fallback default command name is used (e.g., `'claude'`).

### Spawn Watchdog

After a PTY process is spawned, a 30-second watchdog timer starts. If no data, exit, or error event fires within that period, the process is killed and an error is reported to the caller. This prevents zombie processes on Windows where ConPTY initialization can hang silently. The watchdog is cleared on the first `onData`, `onExit`, or `on('error')` event.

### Availability Check

`isAvailable()` returns `true` if the resolved command differs from the fallback default (meaning a specific path was found), or if the fallback command exists on PATH. The server checks `isAvailable()` before attempting to spawn a tool session, returning an immediate error to the client if the CLI is not installed.

The result is cached for 60 seconds (`_availableCache` / `_availableCacheTime`) to avoid repeated synchronous `where`/`which` calls that block the Node.js event loop. On Windows, `where.exe` can take several seconds when scanning large PATH variables or network-mapped drives, which would stall all WebSocket message processing during concurrent session starts.

---

## ClaudeBridge

Source: `src/claude-bridge.js`

### Command Search Paths

```
/home/ec2-user/.claude/local/claude
claude                                (PATH lookup)
claude-code                           (PATH lookup)
~/.claude/local/claude
~/.local/bin/claude
/usr/local/bin/claude
/usr/bin/claude
```

Fallback: `'claude'`

### CLI Arguments

| Flag | Condition |
|------|-----------|
| `--dangerously-skip-permissions` | When `options.dangerouslySkipPermissions` is `true` |

### Trust Prompt Auto-Accept

The bridge monitors output for the string `"Do you trust the files in this folder?"`. On first detection, it sends `\r` (Enter) after a 500ms delay to auto-confirm the default trust option. This is tracked via a `trustPromptHandled` boolean to prevent duplicate submissions.

### Output Buffer

A rolling `dataBuffer` (max 10,000 chars, trimmed to last 5,000) is maintained for trust prompt detection. This buffer is internal to the bridge and separate from the server-level `outputBuffer`.

---

## CodexBridge

Source: `src/codex-bridge.js`

### Command Search Paths

```
~/.codex/local/codex
codex                    (PATH lookup)
codex-code               (PATH lookup)
~/.local/bin/codex
/usr/local/bin/codex
/usr/bin/codex
```

Fallback: `'codex'`

### CLI Arguments

| Flag | Condition |
|------|-----------|
| `--dangerously-bypass-approvals-and-sandbox` | When `options.dangerouslySkipPermissions` is `true` |

### Notes

- No trust prompt handling (Codex does not prompt for folder trust).
- Maintains an internal `dataBuffer` (same 10,000/5,000 limits) for future prompt detection.

---

## AgentBridge

Source: `src/agent-bridge.js`

### Command Search Paths

```
~/.cursor/local/cursor-agent
cursor-agent             (PATH lookup)
~/.local/bin/cursor-agent
/usr/local/bin/cursor-agent
/usr/bin/cursor-agent
```

Fallback: `'cursor-agent'`

### CLI Arguments

None. The agent is spawned with an empty args array.

### Notes

- No `dangerouslySkipPermissions` option. The AgentBridge `startSession` does not destructure or use that option.
- Maintains an internal `dataBuffer` (same 10,000/5,000 limits) for future prompt detection.

---

## BaseBridge (Implemented)

A shared base class that all bridges extend (`src/base-bridge.js`):

- Cross-platform command discovery (`find*Command`, `commandExists`)
- Session lifecycle management (`startSession`, `stopSession`, `sendInput`, `resize`)
- Output buffering with configurable limits
- Kill timeout escalation (SIGTERM then SIGKILL after 5s)
- PTY environment setup
- **Chunked PTY writes**: `sendInput` splits data > `PTY_WRITE_CHUNK_SIZE` (4096 bytes) into chunks with `PTY_WRITE_CHUNK_DELAY_MS` (10ms) inter-chunk delays. A per-session `writeQueue` (Promise chain) serializes concurrent writes to prevent interleaving.

Each concrete bridge extends `BaseBridge` and provides:
- `commandSearchPaths` -- ordered array of paths to search
- `fallbackCommand` -- default command name
- `buildArgs(options)` -- returns the CLI arguments array
- `processOutput(sessionId, ptyProcess, dataBuffer)` -- optional per-bridge output processing (e.g., trust prompt handling)

## Planned Bridges

The following bridges are planned but not yet implemented:

### CopilotBridge

- Command: `copilot`
- Installation: `npm install -g @github/copilot`, `winget install GitHub.Copilot`
- Dangerous flag: `--yolo` (auto-approve all tool executions)
- Search paths: standard locations following the same pattern as existing bridges

### GeminiBridge

- Command: `gemini`
- Installation: `npm install -g @google/gemini-cli`
- Dangerous flag: `--yolo` (disable sandbox, auto-approve commands)
- Search paths: standard locations following the same pattern as existing bridges

### TerminalBridge

Opens a raw shell session rather than an AI agent.

- Linux/macOS: spawns `$SHELL` (defaults to `/bin/bash`)
- Windows: spawns PowerShell 7 (`pwsh`) or falls back to `$COMSPEC`
- Async shell resolution via `resolveFullPathAsync()`
- No `dangerouslySkipPermissions` or AI-specific flags
- Useful for running manual commands alongside agent sessions
- **Live CWD tracking via OSC 7** (per [ADR-0019](../adrs/0019-osc7-cwd-tracking.md)). `TerminalBridge` overrides `startSession`, `stopSession`, and `cleanup` to install a per-session [`Osc7Parser`](../../src/osc7-parser.js) instance and to wrap the caller's `onOutput` so each PTY chunk is fed through the parser **before** being forwarded to xterm.js. The parser matches `\x1b]7;file://<host><path>\x07` (and the `\x1b\\`-terminated variant), passes the URI through `url.fileURLToPath()`, runs the resolved path through the caller-supplied `validatePath` callback, and on change updates `session.liveCwd` and broadcasts `{ type: 'cwd_changed', sessionId, cwd, prev, source: 'osc7' }` over WebSocket. The OSC bytes are not stripped from the output forwarded to xterm.js. Buffer-boundary safety: the parser keeps a 4 KB per-session pending buffer so sequences split across PTY chunks reassemble correctly. Parser exceptions are caught defensively so a malformed sequence never blocks output forwarding. The per-session parser, hooks (`onCwdChange` + `validatePath`), and cached `liveCwd` are torn down in `stopSession` and `cleanup`. **Validation cost dedupe (two-level, HOT-06):** before calling `validatePath`, the bridge consults (1) a per-session `_lastRawOsc7` string-identity fast-path that absorbs the steady-state same-cwd-every-keystroke case, and (2) a process-wide `_osc7ValidationCache` (LRU bounded at 256 entries, 5 s TTL, keyed by raw OSC 7 string) that absorbs multi-tab same-cwd and intra-session alternating-cwd workloads. Both VALID and INVALID validation results are cached so out-of-sandbox paths stop paying syscalls on every emission. The process-wide cache survives `stopSession`/`_uninstallOsc7State` (intentionally — multi-tab same-cwd should pay validation exactly once across all tabs) and is cleared on full `bridge.cleanup()`. See `docs/audits/hot-01-osc7-dedupe.md`.

The other bridges (`ClaudeBridge`, `CodexBridge`, `CopilotBridge`, `GeminiBridge`) inherit `BaseBridge` unchanged — they install no OSC 7 parser, never emit `cwd_changed` frames, and `session.liveCwd` is `undefined` for their sessions. Those CLIs do not `chdir` their host process, so the on-disk `cwd` is not a useful signal. Subclass-override ownership (rather than a `parsesOsc7`-style flag plumbed through `BaseBridge`) makes this a hard structural property: a future bridge subclass can't accidentally turn parsing on by misconfiguring a flag — it has to reach for the same override pattern `TerminalBridge` uses.
