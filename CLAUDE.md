# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Code Web is a web-based interface for the Claude Code CLI that enables browser-based access with multi-session support and real-time streaming capabilities. The application provides a terminal emulator interface through xterm.js with WebSocket communication for real-time interaction.

The project uses the **ai-or-die** agent infrastructure for AI-assisted development. See `AGENTS.md` for the full team roster and handoff protocol.

### Primary deployment target

**Windows 11 is the primary deployment target for both the server (Node.js process) and the client (browser).** All design decisions, default configurations, regression-test coverage, and bug-fix priority must lead with Windows 11 + PowerShell 7 / `cmd.exe` correctness. macOS and Linux are first-class secondary targets (CI runs both), but anywhere a tradeoff arises, **Windows wins by default**.

Practical implications:
- Cross-platform path handling (`path.join`, separators) is mandatory but the test corpus must include Windows-specific shapes: drive letters (`C:\`, `C:/`, `/C:/`), UNC (`\\server\share`), 8.3 short names (`C:\Users\RUNNER~1\...`), `\\?\` long-path prefix.
- `validatePath` and any sandbox boundary check must canonicalize via `realpathSync.native` (handles 8.3 expansion) AND strip `\\?\` prefix BEFORE lexical compare; do this on BOTH sides.
- Native subprocesses (`@vscode/ripgrep`, node-pty, `git`, `lsof`, `pwsh.exe` vs `powershell.exe`) require Windows-specific binary detection + argv shapes.
- Shells: PowerShell 7 (`pwsh.exe`) is preferred but not always present; `powershell.exe` (Windows PowerShell 5.1) ships in box and is the safe fallback; `cmd.exe` cannot emit OSC 7 from `prompt` and should surface a switch-to-PowerShell hint instead of "install the hook."
- OSC 7 / live-CWD: cmd.exe users need a different UX than POSIX shell users; gracefully degrade.
- Output paths returned to the client should be normalized to forward slashes for consistency; storage form is whatever the platform produces.

## Agent Infrastructure

### Agent Personas
Agent definitions are mirrored in two locations for tool compatibility:
- `.github/agents/` -- for GitHub Copilot and GitHub-native tooling
- `.claude/agents/` -- for Claude Code

Available agents: **Architect**, **Engineer**, **QA Reviewer**, **Troubleshooter**, **Researcher**.

### Documentation-Driven Workflow
Before starting any task, consult the relevant documentation:
- `docs/agent-instructions/` -- Agent workflow guides:
  - `00-philosophy.md` -- Core principles
  - `01-research-and-web.md` -- Research guidelines
  - `02-testing-and-validation.md` -- Testing standards
  - `03-tooling-and-pipelines.md` -- Tooling conventions
  - `04-handoff-protocol.md` -- How to leave the repo clean for the next agent
  - `05-defensive-coding.md` -- Error prevention, cross-platform traps
  - `06-local-first-then-ci.md` -- Local-first testing; CI as cross-platform verification, E2E debugging, performance budget
  - `07-docs-hygiene.md` -- Keeping documentation in sync
  - `08-multi-agent-consultation.md` -- When and how to consult expert subagents
- `docs/adrs/` -- Architecture Decision Records (check before proposing new patterns)
- `docs/specs/` -- Component specifications (read before implementing, update after changing behavior)
- `docs/architecture/` -- System diagrams and component overviews
- `docs/history/` -- Solved problems and debugging notes (check before debugging any issue)

### Mandatory Rules
1. **Spec updates with code changes**: When code behavior changes, the corresponding spec in `docs/specs/` must be updated in the same commit or PR.
2. **ADR compliance**: Never contradict an accepted ADR. To change direction, write a new ADR that supersedes the old one.
3. **Cross-platform support, Windows-first**: All code must work on Windows 11 + macOS + Linux. **Windows is the primary target — when a tradeoff arises, Windows wins.** Use `path.join()` for file paths; provide `.sh` and `.ps1` script variants; canonicalize paths via `realpathSync.native` + `\\?\` strip BEFORE any lexical compare; CI runs all three OS in matrix; the Windows tests are the gate, not the optional pass.
4. **Test coverage**: Every feature and bug fix requires tests. No exceptions.
5. **Local-first testing**: All tests (unit + integration + e2e for the surface you changed) must pass locally before pushing. CI on GitHub Actions runs the same suites on Windows + Linux + clean-checkout `npm ci` as the final cross-platform verification gate. Local-pass is necessary but not sufficient — CI green is the merge gate. See `docs/agent-instructions/06-local-first-then-ci.md`.
6. **Document what you solve**: Every solved problem goes in `docs/history/`. LLMs don't carry memories — written docs are the only institutional memory.
7. **Consult before committing**: For significant decisions, spawn expert subagents (architect, principal engineer, lead QA, PM, designer, user researcher) in parallel. See `docs/agent-instructions/08-multi-agent-consultation.md`.

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
- **sticky-note-card.js**: Per-tab local-LLM session summary card (see ADR-0022, `docs/specs/sticky-notes.md`)

**Sticky Notes (local-LLM session summaries)**
- Server: `src/sticky-note-{engine,worker,summarizer,transcript,prompt}.js`, `src/utils/{secret-redact,gguf-model-manager}.js`. A worker-thread `node-llama-cpp` (Liquid LFM2-2.6B) summarises each AI tab's claude JSONL transcript into a per-tab note + auto tab title. ON by default; `--no-sticky-notes` disables. Degrades to `unavailable` if the model/binding is missing. See ADR-0022, ADR-0023 (model bake-off) and `docs/specs/sticky-notes.md`.

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
