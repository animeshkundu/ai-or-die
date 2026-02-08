# Install Advisor Specification

## Overview

The `InstallAdvisor` module (`src/install-advisor.js`) provides a centralized registry of CLI tool installation metadata and host prerequisite detection. It is used by the server to enrich the `/api/config` response and by the VS Code tunnel manager for install guidance.

## API

### `getInstallInfo(toolId)`

Returns structured install information for a tool, or `null` if the tool is unknown.

**Supported tools:** `claude`, `codex`, `gemini`, `copilot`, `vscode`

**Returns:**
```js
{
  name: string,           // Human-readable tool name
  methods: [{             // Available installation methods
    id: string,           // Method identifier (e.g., 'npm', 'snap', 'download')
    label: string,        // Human-readable label
    command: string|null, // Shell command to run (null for download-only)
    url: string|null,     // Download URL (for methods without a command)
    requiresNpm: boolean, // Whether npm must be available
    requiresGh: boolean,  // Whether gh CLI must be available
    note: string|null,    // Additional context about this method
  }],
  authSteps: [{           // Post-install authentication steps
    type: 'command'|'url'|'env'|'info',
    label: string,
    command: string|null,
    url: string|null,
    variable: string|null,
  }],
  docsUrl: string,        // Link to tool documentation
  verifyCommand: string,  // Command to verify installation
}
```

### `detectPrerequisites()`

Async. Detects npm/npx availability and npm global install mode.

**Returns:**
```js
{
  npm: {
    available: boolean,
    version: string|null,
    userMode: boolean,    // true if npm prefix is user-writable
    prefix: string|null,  // npm global prefix path
  },
  npx: { available: boolean },
}
```

Results are cached for 60 seconds.

### `getInstallInfoWithPrereqs(toolId)`

Async. Combines `getInstallInfo` with prerequisite detection. Each method gains `available` and `unavailableReason` fields.

### `clearPrerequisitesCache()`

Invalidates the cached prerequisites result.

## Server Integration

### `/api/config` Response

For unavailable tools, the `install` field is included:
```json
{
  "tools": {
    "claude": {
      "alias": "Claude",
      "available": false,
      "hasDangerousMode": true,
      "install": { "name": "Claude Code", "methods": [...], "authSteps": [...], "docsUrl": "..." }
    }
  },
  "prerequisites": { "npm": { "available": true, "userMode": true }, "npx": { "available": true } }
}
```

The `prerequisites` field is only included when at least one tool is unavailable.

### `POST /api/tools/:toolId/recheck`

Invalidates the bridge availability cache and re-runs command discovery. Returns `{ toolId, available }`.

### WebSocket: `open_install_terminal`

Starts a terminal session and pre-types (without executing) the install command for the specified tool. The user must press Enter to execute.

## VS Code Tunnel Integration

When the VS Code tunnel returns a `not_found` error, the response includes an `install` field with platform-specific download and PATH setup instructions. The client renders a rich install panel instead of a one-line error.

## Platform-Specific Notes

- **VS Code** cannot be installed via npm; uses platform-specific methods (snap, brew, winget, download)
- **npm** on Windows is a `.cmd` script; detection uses `exec` instead of `execFile` to handle this
- **npm prefix** analysis: user-mode if under `$HOME` (Linux) or `%APPDATA%` (Windows)
