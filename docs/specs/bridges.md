# Bridge Specification

Bridges manage the spawning, I/O, and lifecycle of CLI agent processes via `node-pty`. Each bridge class owns a `Map<sessionId, BridgeSession>` of active pty sessions.

---

## Common Interface

Every bridge implements the same public API:

| Method | Signature | Description |
|--------|-----------|-------------|
| `startSession` | `(sessionId, options) => Promise<BridgeSession>` | Spawn the CLI process in a pty and wire up output/exit/error callbacks. Throws if `sessionId` already exists. |
| `sendInput` | `(sessionId, data) => Promise<void>` | Write raw data to the pty stdin. Throws if session is missing or inactive. |
| `resize` | `(sessionId, cols, rows) => Promise<void>` | Resize the pty dimensions. Logs a warning on failure instead of throwing. |
| `stopSession` | `(sessionId) => Promise<void>` | Send `SIGTERM`; after a 5-second grace period, send `SIGKILL`. Removes the session from the internal Map. |
| `getSession` | `(sessionId) => BridgeSession \| undefined` | Return the raw session object. |
| `getAllSessions` | `() => Array<{ id, workingDir, created, active }>` | List all sessions with metadata. |
| `cleanup` | `() => Promise<void>` | Stop all active sessions. |

### BridgeSession Object

```js
{
  process: IPty,          // node-pty process handle
  workingDir: string,     // cwd the process was started in
  created: Date,
  active: boolean,
  killTimeout: Timeout|null  // handle for the SIGKILL escalation timer
}
```

### startSession Options

```js
{
  workingDir: string,                  // defaults to process.cwd()
  dangerouslySkipPermissions: boolean, // defaults to false (Claude/Codex only)
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

## Planned Bridges

The following bridges are planned but not yet implemented. They should follow the same common interface described above.

### BaseBridge (Planned)

A shared base class that extracts the duplicated logic from ClaudeBridge, CodexBridge, and AgentBridge:

- Cross-platform command discovery (`find*Command`, `commandExists`)
- Session lifecycle management (`startSession`, `stopSession`, `sendInput`, `resize`)
- Output buffering with configurable limits
- Kill timeout escalation (SIGTERM then SIGKILL after 5s)
- PTY environment setup

Each concrete bridge would extend `BaseBridge` and provide:
- `commandSearchPaths` -- ordered array of paths to search
- `fallbackCommand` -- default command name
- `buildArgs(options)` -- returns the CLI arguments array
- `onDataHook(data, buffer)` -- optional per-bridge output processing (e.g., trust prompt handling)

### CopilotBridge (Planned)

- Command: `copilot`
- Installation: `npm install -g @github/copilot`
- Search paths: standard locations following the same pattern as existing bridges

### GeminiBridge (Planned)

- Command: `gemini`
- Installation: `npm install -g @google/gemini-cli`
- Search paths: standard locations following the same pattern as existing bridges

### TerminalBridge (Planned)

Opens a raw shell session rather than an AI agent.

- Linux/macOS: spawns `$SHELL` (defaults to `/bin/bash`)
- Windows: spawns `powershell.exe` or `cmd.exe`
- No `dangerouslySkipPermissions` or AI-specific flags
- Useful for running manual commands alongside agent sessions
