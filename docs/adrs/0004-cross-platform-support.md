# ADR-0004: Cross-Platform Support (Windows + Linux)

## Status

**Accepted**

## Date

2025-07-15

## Context

The original codebase was written with Linux (and macOS) as the sole target. Several patterns in the code are not portable:

1. **`process.env.HOME`** -- undefined on Windows, where the equivalent is `process.env.USERPROFILE` or `os.homedir()`.
2. **`which` for command discovery** -- Windows uses `where.exe` instead.
3. **Hardcoded Unix paths** -- e.g. `/usr/local/bin/claude`, `/home/ec2-user/.claude/local/claude`.
4. **`node-pty` defaults** -- Linux uses the Unix PTY subsystem; Windows requires ConPTY (available since Windows 10 version 1809).
5. **Default shell** -- the bridges implicitly assume `/bin/bash` or similar; Windows should default to PowerShell (`pwsh` or `powershell.exe`).

Users on Windows (especially WSL2 and native Windows with `node-pty` ConPTY support) have reported install and runtime failures stemming from these assumptions.

## Decision

Introduce platform detection at the `BaseBridge` level (see ADR-0001) with the following changes:

### Command Discovery

```js
const os = require('os');
const { execFileSync } = require('child_process');

function commandExists(binary) {
  const checker = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    execFileSync(checker, [binary], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
```

### Home Directory

Replace all uses of `process.env.HOME` with `os.homedir()`, which returns the correct value on every platform.

### Search Paths

Each bridge's `binaryNames` list includes both Unix and Windows variants:

```js
// ClaudeBridge
binaryNames: [
  'claude',
  path.join(os.homedir(), '.claude', 'local', 'claude'),   // Unix
  path.join(os.homedir(), '.claude', 'local', 'claude.exe'), // Windows
  '/usr/local/bin/claude',
]
```

Non-existent paths are silently skipped during discovery.

### PTY Configuration

```js
const ptyOptions = {
  name: process.platform === 'win32' ? 'conpty' : 'xterm-256color',
  cols: options.cols || 80,
  rows: options.rows || 24,
  cwd: options.workingDir,
  env: process.env,
  ...(process.platform === 'win32' && { useConpty: true }),
};
```

### Default Shell (generic terminal bridge)

For the planned generic terminal tool, the default shell is:

- **Windows**: `pwsh.exe` (PowerShell 7+), falling back to `powershell.exe`, then `cmd.exe`.
- **Linux/macOS**: `$SHELL`, falling back to `/bin/bash`, then `/bin/sh`.

## Consequences

### Positive

- The application works out of the box on Windows 10 1809+ (with ConPTY) and all supported Linux distributions.
- WSL2 users can run the server natively on Windows or inside the WSL2 VM -- both paths work.
- CI can run a test matrix across `ubuntu-latest` and `windows-latest` to catch regressions.

### Negative

- Windows ConPTY has known quirks with certain escape sequences; some terminal rendering may differ from Unix.
- `node-pty` native compilation on Windows requires build tools (Visual Studio Build Tools or `windows-build-tools`), which adds install friction.
- Testing surface area doubles -- every bridge test must pass on both platforms.

### Neutral

- macOS support comes for free since it shares the Unix PTY path; no additional work is needed.
- The `--tunnel` feature (Dev Tunnels) already supports both platforms, so no tunnel-specific changes are required.
