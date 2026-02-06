# Architecture Overview

Cortex is a Node.js web application that provides browser-based access to multiple AI CLI tools through a unified terminal interface. It wraps CLI processes (Claude, Codex, Copilot, Gemini, Terminal, and others) in pseudo-terminals and streams their I/O over WebSockets to xterm.js terminals running in the browser.

## System Architecture

```mermaid
graph TB
    subgraph Browser["Browser Client"]
        UI["app.js<br/>Main Interface Controller"]
        SM["session-manager.js<br/>Tab Management & Notifications"]
        PD["plan-detector.js<br/>Plan Mode Approval UI"]
        XT["xterm.js<br/>Terminal Emulator"]
        AUTH["auth.js<br/>Token Authentication"]
        SW["service-worker.js<br/>PWA / Offline Support"]
    end

    subgraph Transport["Transport Layer"]
        WS["WebSocket (ws)"]
        HTTP["Express HTTP API"]
    end

    subgraph Server["Server Layer"]
        SRV["ClaudeCodeWebServer<br/>src/server.js"]
        SS["SessionStore<br/>~/.claude-code-web/sessions.json"]
        UR["UsageReader<br/>~/.claude/projects/.../*.jsonl"]
        UA["UsageAnalytics<br/>Burn Rate & Predictions"]
    end

    subgraph Bridges["Bridge Layer"]
        CB["ClaudeBridge<br/>src/claude-bridge.js"]
        XB["CodexBridge<br/>src/codex-bridge.js"]
        CPB["CopilotBridge<br/>src/copilot-bridge.js"]
        GB["GeminiBridge<br/>src/gemini-bridge.js"]
        TB["TerminalBridge<br/>src/terminal-bridge.js"]
    end

    subgraph CLIs["CLI Processes (node-pty)"]
        CLAUDE["claude CLI"]
        CODEX["codex CLI"]
        COPILOT["copilot CLI"]
        GEMINI["gemini CLI"]
        TERMINAL["terminal CLI"]
    end

    UI <--> WS
    SM <--> UI
    PD <--> UI
    XT <--> UI
    AUTH --> HTTP
    AUTH --> WS

    WS <--> SRV
    HTTP <--> SRV

    SRV --> SS
    SRV --> UR
    SRV --> UA
    SRV --> CB
    SRV --> XB
    SRV --> CPB
    SRV --> GB
    SRV --> TB

    CB <--> CLAUDE
    XB <--> CODEX
    CPB <--> COPILOT
    GB <--> GEMINI
    TB <--> TERMINAL
```

## Component Relationships

```mermaid
graph LR
    subgraph Entry["Entry Point"]
        BIN["bin/cortex.js<br/>Commander.js CLI"]
    end

    subgraph Core["Core Server"]
        SRV["ClaudeCodeWebServer"]
    end

    subgraph Persistence["Persistence"]
        SS["SessionStore"]
    end

    subgraph Analytics["Usage Analytics"]
        UR["UsageReader"]
        UA["UsageAnalytics"]
    end

    subgraph Bridges["Bridges"]
        CB["ClaudeBridge"]
        XB["CodexBridge"]
        CPB["CopilotBridge"]
        GB["GeminiBridge"]
        TB["TerminalBridge"]
    end

    BIN -->|"startServer(options)"| SRV
    SRV -->|"saves/loads sessions"| SS
    SRV -->|"reads JSONL logs"| UR
    SRV -->|"burn rate, predictions"| UA
    SRV -->|"spawns claude"| CB
    SRV -->|"spawns codex"| XB
    SRV -->|"spawns copilot"| CPB
    SRV -->|"spawns gemini"| GB
    SRV -->|"spawns terminal"| TB
```

## Data Flow

### User Input Flow

```mermaid
sequenceDiagram
    participant User as Browser User
    participant XT as xterm.js
    participant WS as WebSocket
    participant SRV as Server
    participant Bridge as Bridge (Claude/Codex/Copilot/Gemini/Terminal)
    participant PTY as node-pty Process

    User->>XT: Types in terminal
    XT->>WS: {type: "input", data: keystrokes}
    WS->>SRV: handleMessage()
    SRV->>SRV: Validate session membership
    SRV->>Bridge: sendInput(sessionId, data)
    Bridge->>PTY: process.write(data)
```

### Output Broadcast Flow

```mermaid
sequenceDiagram
    participant PTY as node-pty Process
    participant Bridge as Bridge
    participant SRV as Server
    participant WS1 as WebSocket Client A
    participant WS2 as WebSocket Client B

    PTY->>Bridge: onData(output)
    Bridge->>SRV: onOutput callback
    SRV->>SRV: Append to session outputBuffer
    SRV->>SRV: broadcastToSession()
    par Broadcast to all connected clients
        SRV->>WS1: {type: "output", data: output}
        SRV->>WS2: {type: "output", data: output}
    end
```

### Session Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Created: create_session
    Created --> Joined: join_session
    Joined --> AgentRunning: start_claude / start_codex / start_copilot / start_gemini / start_terminal
    AgentRunning --> AgentRunning: input / output
    AgentRunning --> Stopped: stop / exit
    Stopped --> AgentRunning: start_claude / start_codex / start_copilot / start_gemini / start_terminal
    Joined --> Left: leave_session
    Left --> Joined: join_session
    Joined --> Deleted: DELETE /api/sessions/:id
    Stopped --> Deleted: DELETE /api/sessions/:id
    Deleted --> [*]
```

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **CLI Entry** | Commander.js | Parse command-line arguments (`--port`, `--auth`, `--https`, etc.) |
| **HTTP Server** | Express 4.x | REST API, static file serving, authentication middleware |
| **WebSocket** | ws 8.x | Bidirectional real-time communication between browser and server |
| **PTY** | node-pty 1.x | Spawn CLI tools in pseudo-terminals with full ANSI/256-color support |
| **Terminal UI** | xterm.js | Browser-based terminal emulator with fit addon and web links |
| **Session IDs** | uuid v4 | Unique identifiers for sessions and WebSocket connections |
| **Tunneling** | devtunnel CLI | Optional public tunnel for remote access |
| **CORS** | cors | Cross-origin request handling |
| **PWA** | Service Worker | Progressive Web App support for offline/installable experience |

## Key Design Decisions

### 1. Bridge-per-CLI Architecture

Each supported CLI tool has its own bridge class that extends `BaseBridge` (`ClaudeBridge`, `CodexBridge`, `CopilotBridge`, `GeminiBridge`, `TerminalBridge`). All bridges share an identical interface (`startSession`, `sendInput`, `resize`, `stopSession`, `cleanup`), making it straightforward to add new tools. The server routes messages to the correct bridge based on the `session.agent` field.

### 2. Session-Centric Model

Sessions are the central organizing concept. A session represents a working directory plus an optional running CLI process. Multiple WebSocket connections can join the same session simultaneously, enabling multi-device access to the same terminal. Sessions persist to disk (`~/.claude-code-web/sessions.json`) and survive server restarts, though the CLI processes themselves do not persist.

### 3. Output Buffering for Reconnection

Each session maintains a rolling output buffer (last 1000 lines). When a client joins an existing session, the server replays the last 200 lines from the buffer, allowing the user to see recent context without needing the CLI process to re-emit output.

### 4. node-pty over child_process

The application uses `node-pty` instead of `child_process.spawn` because CLI tools like Claude Code produce rich terminal output (ANSI escape codes, 256-color sequences, cursor movement). A real pseudo-terminal is required to faithfully capture and replay this output. The PTY is configured with `xterm-256color` TERM and `truecolor` COLORTERM.

### 5. Authentication by Default

The server generates a random authentication token on startup if none is provided. All HTTP endpoints (except `/auth-status`) and WebSocket connections require this token. This prevents accidental exposure of the terminal interface, which has full access to the underlying CLI tools.

### 6. Path Validation and Sandboxing

The folder browser and working directory selection enforce that all paths remain within the base directory where the server was started (`process.cwd()`). Directory traversal attempts are rejected at both the API and session creation levels.

### 7. Graceful Shutdown with Escalation

When stopping a CLI process, the server sends `SIGTERM` first, then escalates to `SIGKILL` after a 5-second timeout if the process has not exited. This matches standard Unix process management and gives CLI tools a chance to clean up.

### 8. Auto-Save with Atomic Writes

Sessions are automatically saved to disk every 30 seconds. The save operation writes to a temporary file first, then renames it atomically to prevent corruption from interrupted writes. Sessions older than 7 days are discarded on load.
