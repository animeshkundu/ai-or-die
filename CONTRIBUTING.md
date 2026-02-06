# Contributing to ai-or-die

Thanks for your interest in contributing! This guide covers how to set up the project, run it locally, write tests, and open quality pull requests.

## Project Structure

- `bin/ai-or-die.js`: CLI entry point; parses flags and starts the server.
- `src/server.js`: Express + WebSocket server, routes, session wiring.
- `src/base-bridge.js`: Shared bridge logic for all CLI tools.
- `src/claude-bridge.js`, `src/codex-bridge.js`, etc.: Tool-specific bridges extending BaseBridge.
- `src/copilot-bridge.js`, `src/gemini-bridge.js`, `src/terminal-bridge.js`: New tool bridges.
- `src/utils/*`: Helpers (auth token handling, session persistence).
- `src/public/*`: Browser UI assets (HTML/JS/CSS) served by the server.
- `test/*.test.js`: Mocha unit tests.
- `docs/`: Technical documentation, specs, ADRs, and agent instructions.

## Setup

```bash
git clone https://github.com/animeshkundu/ai-or-die.git
cd ai-or-die
npm install
npm run dev
```

## Testing

```bash
npm test
```

Write tests in `test/` as `name.test.js`. Use Mocha with Node's `assert`. Mock process spawns — avoid network calls or real CLI invocations in tests.

## Coding Style

- **Language**: Node.js (CommonJS)
- **Indentation**: 2 spaces, semicolons, single quotes
- **Files**: kebab-case for modules, PascalCase for classes, camelCase for functions
- **Tests**: `*.test.js` in `test/`
- **Cross-platform**: Always use `os.homedir()`, `path.join()`, and platform-aware command discovery

## Adding a New Tool

1. Create `src/yourname-bridge.js` extending `BaseBridge`
2. Register it in `src/server.js` (import, instantiate, add to `getBridgeForAgent()`)
3. Add WebSocket handler for `start_yourtool` in `handleMessage()`
4. The UI generates cards dynamically from `/api/config` — no HTML changes needed

See [docs/architecture/bridge-pattern.md](docs/architecture/bridge-pattern.md) for the full guide.

## Pull Request Guidelines

- Concise description with linked issues
- Include tests for behavior changes
- Update relevant docs in `docs/specs/` when changing code
- Screenshots/GIFs for UI-facing changes
- Follow Conventional Commits (`feat:`, `fix:`, `chore:`)

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add Gemini CLI bridge support
fix(bridge): handle Windows path separators in command discovery
chore(release): v0.1.0
```

## Documentation

Before making code changes, check:
- `docs/agent-instructions/` for development protocols
- `docs/adrs/` for past architectural decisions
- `docs/specs/` for the relevant module specification

After making code changes, update the corresponding spec.
