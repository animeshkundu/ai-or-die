# Copilot Instructions for ai-or-die

ai-or-die is a browser-based universal AI coding terminal. It spawns Claude, Copilot, Gemini, Codex, and raw terminal sessions via node-pty, streams output over WebSocket to an xterm.js frontend, and persists sessions to disk. Requires Node.js 22+.

## Commands

```bash
npm install            # install dependencies
npm test               # run all Mocha unit tests
npm run dev            # start dev server with verbose logging (port 7777)
npx mocha --exit test/claude-bridge.test.js   # run a single test file

# E2E (Playwright — validated on CI, not locally)
npm run test:browser                                    # all E2E projects
npx playwright test --config e2e/playwright.config.js --project golden-path  # single project

# Validation (tests + doc structure check)
powershell scripts/validate.ps1   # Windows
bash scripts/validate.sh          # Linux/macOS

# Build standalone binary (SEA)
npm run build:sea
```

## Testing Philosophy

**CI is the only authority.** All testing happens on GitHub Actions runners — never locally. A feature is not done until its E2E tests pass on CI. Local results do not count.

**E2E tests are the source of truth.** Unit tests verify isolated logic; E2E tests prove the whole system (server, WebSocket, terminal, browser UI) actually works. Every new feature needs E2E coverage. Every bug fix needs a regression E2E test.

**The workflow:** write code → push → `gh pr create --draft` → CI runs (~5-7 min, 16 parallel jobs: 8 types × ubuntu + windows) → read results → fix → push again. Use `gh run watch` to monitor.

**Long E2E waits indicate bugs.** If a test needs generous timeouts to pass, the product code is too slow. Tighten timeouts to catch performance regressions — tests should reflect realistic user expectations.

**Performance budget:** No single CI job may exceed 7 minutes.

### E2E Test Numbering

| Range | Category | Playwright Project |
|-------|----------|--------------------|
| `01` | Golden path (fresh user flow) | `golden-path` |
| `02-05` | Core (terminal I/O, clipboard, context menu, tabs) | `functional-core` |
| `06-07, 09-*` | Extended (large paste, vim, image paste, bg notifications) | `functional-extended` |
| `08` | Mobile portrait (iPhone 14, Pixel 7) | `mobile-iphone`, `mobile-pixel` |
| `09-visual-*` | Screenshot regression | `visual-regression` |
| `10-15` | New features (command palette, search, themes, fonts, file browser) | `new-features` |
| `16-19` | Integrations (tunnels, install panel, notifications) | `integrations` |
| `20-21` | Voice (input, real pipeline) | `voice-e2e`, `voice-real-pipeline` |
| `30-36` | Power user flows | `power-user-flows` |
| `37-39` | Mobile flows (iPhone SE, iPhone 14, Pixel 7) | `mobile-flows` |
| `40-49` | UI features (focus trap, shortcuts, settings, voice settings) | `ui-features` |

New tests take the next available number in the appropriate range. Register in `e2e/playwright.config.js` and update the CI job in `.github/workflows/ci.yml` if the regex doesn't already match.

### E2E Helpers

Tests use shared helpers — don't reimplement these:

- **`e2e/helpers/server-factory.js`** — `createServer()` starts a test server; `createSessionViaApi(port, name)` creates a session via REST
- **`e2e/helpers/terminal-helpers.js`** — `waitForAppReady()`, `waitForTerminalCanvas()`, `typeInTerminal()`, `waitForTerminalText()`, `readTerminalContent()`, `pressKey()`, `setupPageCapture()`, `attachFailureArtifacts()`, `joinSessionAndStartTerminal()`

### CI Failure Debugging

Each browser job uploads artifacts on failure (14-day retention): Playwright traces (DOM snapshots, network, console at each step), screenshots, terminal buffer content, and WebSocket message logs. Download with `gh run download <run-id>` and view traces with `npx playwright show-trace <path>`.

- Fails on Windows only → path handling, ConPTY buffering, `where` vs `which`, line endings
- Fails on Linux only → permissions, case-sensitive filenames, missing system deps
- Fails on both → real application bug

## Architecture

```
bin/ai-or-die.js          CLI entry point (commander)
    └─► src/server.js      Express + WebSocket server (ClaudeCodeWebServer class)
           ├─► src/*-bridge.js   One bridge per AI tool, all extend BaseBridge
           ├─► src/utils/        SessionStore, CircularBuffer, file-utils, auth
           ├─► src/tunnel-manager.js / vscode-tunnel.js   Dev Tunnel integration
           └─► src/stt-engine.js + stt-worker.js          Local speech-to-text
src/public/                Vanilla JS client (no framework, no bundler)
    ├─► app.js             Main controller, terminal setup, WebSocket
    ├─► session-manager.js Tab UI, multi-session handling
    └─► service-worker.js  PWA offline support
```

**Bridge pattern**: Every AI tool bridge extends `BaseBridge` (`src/base-bridge.js`). BaseBridge handles PTY spawning, async command discovery, chunked writes (4KB/10ms for ConPTY), and output buffering. To add a new tool: create `src/yourname-bridge.js` extending BaseBridge, register in `src/server.js` via `getBridgeForAgent()`, add a `start_yourtool` WebSocket handler. The UI auto-generates tool cards from `/api/config`. See `docs/architecture/bridge-pattern.md`.

**WebSocket protocol**: Messages use a `type` field — `create_session`, `join_session`, `start_claude`, `input`, `resize`, `stop`, etc. Full protocol spec in `docs/architecture/websocket-protocol.md`. Sessions persist to `~/.ai-or-die/sessions.json` via SessionStore with auto-save every 30s. Output buffered in CircularBuffer(1000 lines).

**Client**: Vanilla JS, no framework, no build step. CSS uses custom properties from `src/public/tokens.css`. PWA with service worker (network-first caching).

## Code Conventions

- **CommonJS modules** — `require()`/`module.exports`, no ESM
- 2-space indent, single quotes, semicolons required
- File naming: `kebab-case.js` for modules, PascalCase for classes, camelCase for functions/variables
- Unit tests: `test/*.test.js` using Mocha + Node `assert`. Mock process spawns — no real CLI invocations
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`)

## Cross-Platform Rules

All code must work on Windows (ConPTY) and Linux:
- `path.join()` for file paths — never hardcode `/` or `\`
- `os.homedir()` for home directory — never `process.env.HOME`
- Shell scripts must have both `.sh` and `.ps1` variants
- Bridge command discovery uses platform-specific paths (`commandPaths.linux` / `commandPaths.win32`)
- Writes >4KB can overflow the ConPTY buffer — use chunked writes with delays (see `base-bridge.js`)
- Windows may echo PTY input back and inject `\r\n` — use `.includes()` or `.trim()` for output matching, never exact string comparison

## Documentation Contract

Documentation is not optional — stale docs are treated as bugs.

- **Specs** (`docs/specs/`): When code behavior changes, the spec MUST be updated in the same commit. If the spec says X and the code says Y, the code is wrong until the spec is deliberately updated.
- **ADRs** (`docs/adrs/`): Check before proposing new patterns. Never edit an accepted ADR — write a new one that supersedes it (template: `docs/adrs/0000-template.md`).
- **History** (`docs/history/`): Check before debugging any issue — the solution may already be documented. After fixing a non-trivial bug, add an entry with: what happened, root cause, fix, and what to watch for.
- **Agent instructions** (`docs/agent-instructions/`): Philosophy, research guidelines, testing standards, defensive coding, CI workflow, docs hygiene, multi-agent consultation.

### Pre-Commit Checklist

1. Did I change behavior? → Update spec in `docs/specs/`
2. Did I make an architectural decision? → Write ADR in `docs/adrs/`
3. Did I fix a non-trivial bug? → Add entry to `docs/history/`
4. Did I introduce a new pattern? → Document in `docs/architecture/`

## Defensive Coding

- **Validate at boundaries**: Every REST handler, WebSocket message handler, and bridge method must validate inputs before processing. Check that sessionId exists, dimensions are positive integers, required message fields are present.
- **Error messages are UI**: Every error must answer: what went wrong, what was expected, what to do about it. Include context (session ID, searched paths, received input).
- **Fail fast, fail loud**: Assert preconditions at function entry. Never silently swallow errors (`catch (err) { /* ignore */ }` is forbidden). If something "shouldn't happen," throw — don't return null.
- **Async safety**: Every `async` function needs top-level try-catch. Every `.then()` needs `.catch()`. Event handlers calling async code must wrap in try-catch.
