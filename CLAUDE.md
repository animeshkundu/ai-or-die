# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Web is a web-based interface for the Claude Code CLI that enables browser-based access with multi-session support and real-time streaming capabilities. The application provides a terminal emulator interface through xterm.js with WebSocket communication for real-time interaction.

The project uses the **Cortex** agent infrastructure for AI-assisted development. See `AGENTS.md` for the full team roster and handoff protocol.

## Agent Infrastructure

### Agent Personas
Agent definitions are mirrored in two locations for tool compatibility:
- `.github/agents/` -- for GitHub Copilot and GitHub-native tooling
- `.claude/agents/` -- for Claude Code

Available agents: **Architect**, **Engineer**, **QA Reviewer**, **Troubleshooter**, **Researcher**.

### Documentation-Driven Workflow
Before starting any task, consult the relevant documentation:
- `docs/agent-instructions/` -- Philosophy, research guidelines, testing standards, tooling conventions
- `docs/adrs/` -- Architecture Decision Records (check before proposing new patterns)
- `docs/specs/` -- Component specifications (read before implementing, update after changing behavior)
- `docs/architecture/` -- System diagrams and component overviews
- `docs/history/` -- Incident post-mortems and debugging notes

### Mandatory Rules
1. **Spec updates with code changes**: When code behavior changes, the corresponding spec in `docs/specs/` must be updated in the same commit or PR.
2. **ADR compliance**: Never contradict an accepted ADR. To change direction, write a new ADR that supersedes the old one.
3. **Cross-platform support**: All code must work on both Windows and Linux. Use `path.join()` for file paths, provide `.sh` and `.ps1` script variants, and test on both platforms in CI.
4. **Test coverage**: Every feature and bug fix requires tests. No exceptions.

## Common Commands

```bash
# Install dependencies
npm install

# Start development server (with extra logging)
npm run dev

# Start production server
npm start

# Start with custom port
npm start -- --port 8080

# Start with authentication
npm start -- --auth your-token

# Start with HTTPS
npm start -- --https --cert cert.pem --key key.pem

# Run tests
npm test

# Run validation (Linux/macOS)
bash scripts/validate.sh

# Run validation (Windows PowerShell)
powershell scripts/validate.ps1
```

## Architecture

### Core Components

**Server Layer (src/server.js)**
- Express server handling REST API and WebSocket connections
- Session persistence via SessionStore (saves to ~/.claude-code-web/sessions.json)
- Authentication middleware with rate limiting
- Folder mode for working directory selection
- Auto-save sessions every 30 seconds

**Claude Bridge (src/claude-bridge.js)**
- Manages Claude CLI process spawning using node-pty
- Handles multiple concurrent Claude sessions
- Process lifecycle management (start, stop, resize)
- Output buffering for reconnection support
- Searches for Claude CLI in multiple standard locations

**Session Management**
- Persistent sessions survive server restarts
- Multi-browser support - same session accessible from different devices
- Session data includes: ID, name, working directory, output buffer, creation time
- Sessions auto-save and can be manually deleted

**Client Architecture (src/public/)**
- **app.js**: Main interface controller, terminal setup, WebSocket management
- **session-manager.js**: Session tab UI, notifications, multi-session handling
- **plan-detector.js**: Detects Claude plan mode and provides approval UI
- **auth.js**: Client-side authentication handling
- **service-worker.js**: PWA support for offline capabilities

### WebSocket Protocol

The application uses WebSocket for real-time bidirectional communication:
- `create_session`: Initialize new Claude session
- `join_session`: Connect to existing session
- `leave_session`: Disconnect without stopping Claude
- `start_claude`: Launch Claude CLI in session
- `input`: Send user input to Claude
- `resize`: Adjust terminal dimensions
- `stop`: Terminate Claude process

### Security Features
- Optional token-based authentication (Bearer token or query parameter)
- Rate limiting (100 requests/minute per IP by default)
- Path validation to prevent directory traversal
- HTTPS support with SSL certificates

## Key Implementation Details

- Claude CLI discovery attempts multiple paths including ~/.claude/local/claude
- Sessions persist to disk at ~/.claude-code-web/sessions.json
- Output buffer maintains last 1000 lines for reconnection
- Terminal uses xterm-256color with full ANSI color support
- Folder browser restricts access to base directory and subdirectories only
- Mobile-responsive design with touch-optimized controls

## Coding Style

- Language: Node.js (CommonJS modules)
- Indentation: 2 spaces
- Quotes: single quotes
- Semicolons: required
- File naming: kebab-case for modules, PascalCase for classes, camelCase for functions/variables
- Tests: `*.test.js` in the `test/` directory
- Commits: Conventional Commits format (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`)
