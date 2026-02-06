# E2E Testing Specification

This document outlines the end-to-end testing strategy for the ai-or-die web application, covering framework selection, architectural decisions, and the full test plan.

## 1. Research Findings

### 1.1 Testing WebSocket-Based Node.js Apps

**Recommended approach: Mocha + native `ws` client.**

The `ws` npm package (already a project dependency) doubles as both server and client library. For Mocha-based integration tests, the pattern is straightforward:

- Start the server in a `before()` hook via the `ClaudeCodeWebServer` class
- Create `ws` client connections in each test
- Tear down in `after()` hooks

This avoids adding any new dependencies. The `ws` client supports the same event model as the browser `WebSocket` API, making test code transferable.

Alternative approaches considered and rejected:
- **jest-websocket-mock** -- Jest-specific, doesn't fit our Mocha setup
- **mock-socket** -- Adds a mock layer we don't need; we want real server integration
- **MSW (Mock Service Worker)** -- Overkill for server-side WebSocket testing

**Sources:**
- [Integration testing WebSocket server in Node.JS (Medium)](https://medium.com/@basavarajkn/integration-testing-websocket-server-in-node-js-2997d107414c)
- [WebSocket Tests: Complete Guide 2025 (VideoSDK)](https://www.videosdk.live/developer-hub/websocket/websocket-tests)
- [ws GitHub repository](https://github.com/websockets/ws)

### 1.2 Testing xterm.js Terminal Emulation E2E

xterm.js itself uses Playwright for its integration test suite, running tests against the browser-rendered terminal canvas. For our use case, however, the critical path is **server-side**: data flows from the spawned CLI process through node-pty, over WebSocket, to the client. The xterm.js rendering layer is a display concern.

**Our strategy splits into two tiers:**

| Tier | What it tests | Tool |
|------|--------------|------|
| Server E2E | Server boot, WebSocket protocol, session lifecycle, PTY I/O | Mocha + `ws` client |
| Browser E2E (future) | xterm.js rendering, keyboard input, UI interactions | Playwright |

For the initial test suite, Tier 1 (server E2E) provides the highest coverage-to-effort ratio. It validates the entire backend pipeline without requiring a browser.

**Sources:**
- [xterm.js Contributing Wiki](https://github.com/xtermjs/xterm.js/wiki/Contributing)
- [Playwright E2E Guide 2026 (DeviQA)](https://www.deviqa.com/blog/guide-to-playwright-end-to-end-testing-in-2025/)

### 1.3 Testing node-pty Without Real CLI Tools

The key insight: **we don't need to mock node-pty at all**. The `TerminalBridge` already spawns the user's default shell (bash on Linux, PowerShell on Windows). A shell is a perfectly valid "mock tool" -- we can:

1. Start a terminal session (spawns bash/powershell)
2. Send `echo "test input"` as input
3. Verify the echoed output appears in the WebSocket stream

This tests the full node-pty pipeline (spawn, write, read, resize, kill) using a real pseudo-terminal, without needing Claude/Copilot/Gemini installed. The `TerminalBridge.isAvailable()` always returns `true` since a shell is always present.

For CI environments where specific tool bridges need validation, lightweight mock scripts can simulate CLI behavior:

```bash
#!/bin/bash
# mock-tool.sh -- Simulates a CLI tool
echo "Mock Tool v1.0"
while IFS= read -r line; do
    echo "Response: $line"
done
```

**Sources:**
- [node-pty GitHub (microsoft/node-pty)](https://github.com/microsoft/node-pty)
- [Node.js PTY Deep Dive (w3tutorials)](https://www.w3tutorials.net/blog/nodejs-pty/)

### 1.4 Express + WebSocket E2E Best Practices (2025/2026)

Current best practices for testing Express + WebSocket servers:

1. **Decouple server from port binding** -- The `ClaudeCodeWebServer` class already supports this via `start()` returning a promise. Use port 0 for auto-assignment in tests.
2. **Lifecycle in hooks** -- `before()` starts server, `after()` calls `close()`. Keep server instances per `describe` block to avoid cross-contamination.
3. **Async-first** -- Mocha 11.x natively handles async/await and returned promises.
4. **Timeout management** -- WebSocket tests need longer timeouts (5-10s) for PTY spawn + output propagation.
5. **Parallel safety** -- Each test suite uses a unique port (0 = OS-assigned) and isolated session state.

**Sources:**
- [Fullstack Open: E2E Testing with Playwright](https://fullstackopen.com/en/part5/end_to_end_testing_playwright/)
- [Testing Socket.io With Mocha and Chai](https://alexzywiak.github.io/testing-socket-io-with-mocha-and-chai/index.html)

### 1.5 Can Playwright/Puppeteer Test xterm.js Terminals?

**Yes, but with caveats.**

xterm.js renders to a `<canvas>` element (via its WebGL or Canvas renderer), which means standard DOM selectors don't work for reading terminal content. Approaches:

- **xterm.js API access via `page.evaluate()`** -- Expose the `Terminal` instance on `window`, then call `terminal.buffer.active.getLine(row).translateToString()` to read terminal content programmatically.
- **Keyboard simulation** -- Playwright's `page.keyboard.type()` sends keystrokes that xterm.js captures.
- **Screenshot comparison** -- Visual regression testing via `page.screenshot()` comparisons.

For the initial test suite, browser-level tests are **deferred**. The server E2E tests with `ws` clients cover the critical data path. Browser tests can be added later as a Playwright layer when UI regression testing becomes a priority.

**Sources:**
- [Playwright GitHub](https://github.com/microsoft/playwright)
- [xterm.js GitHub](https://github.com/xtermjs/xterm.js)

---

## 2. Test Architecture

### 2.1 Design Principles

- **No new dependencies** -- Use Mocha (devDependency), `ws` and `assert` (both already available)
- **Real server, real PTY** -- No mocking of node-pty or WebSocket; test the actual stack
- **Mock the tools, not the infrastructure** -- Use bash/echo as the "tool" instead of Claude/Copilot
- **Cross-platform** -- Tests must pass on Linux and Windows CI; use `TerminalBridge` (shell) as the universal tool
- **Deterministic** -- Avoid timing-dependent assertions; use event-driven waits with timeouts
- **Isolated** -- Each test suite starts its own server on an ephemeral port

### 2.2 File Structure

```
test/
  session-store.test.js      # Existing: unit tests for SessionStore
  claude-bridge.test.js       # Existing: unit tests for ClaudeBridge
  server-alias.test.js        # Existing: unit tests for server aliases
  e2e.test.js                 # NEW: server E2E tests (this spec)
```

### 2.3 Helper Utilities (embedded in test file)

```javascript
// Wait for a specific WebSocket message type
function waitForMessage(ws, type, timeoutMs = 5000) { ... }

// Create an authenticated WebSocket connection
function connectWs(port, token, sessionId) { ... }

// Send a typed message and await a specific response type
function sendAndWait(ws, message, expectedType, timeoutMs) { ... }
```

---

## 3. Test Plan

### 3.1 Server Boot & Health (`describe('Server lifecycle')`)

| Test | What it validates |
|------|-------------------|
| Server starts on ephemeral port | `ClaudeCodeWebServer.start()` resolves; port > 0 |
| Health endpoint returns OK | `GET /api/health` -> `{ status: 'ok' }` |
| Config endpoint returns tool info | `GET /api/config` -> contains `tools.terminal.available: true` |
| Server shuts down cleanly | `server.close()` completes without error |

### 3.2 Authentication (`describe('Authentication')`)

| Test | What it validates |
|------|-------------------|
| Auth-enabled: valid token accepted | `GET /api/health` with `Bearer <token>` -> 200 |
| Auth-enabled: invalid token rejected | `GET /api/health` with wrong token -> 401 |
| Auth-enabled: missing token rejected | `GET /api/health` with no auth -> 401 |
| Auth-enabled: WS with valid token connects | WS `?token=<token>` -> receives `connected` message |
| Auth-enabled: WS with invalid token rejected | WS `?token=wrong` -> connection refused |
| No-auth mode: all requests accepted | `noAuth: true` -> health endpoint accessible without token |

### 3.3 WebSocket Connection (`describe('WebSocket connection')`)

| Test | What it validates |
|------|-------------------|
| Connection receives `connected` message | First message is `{ type: 'connected', connectionId: <uuid> }` |
| Ping/pong works | Send `{ type: 'ping' }` -> receive `{ type: 'pong' }` |
| Clean disconnect | Close WS -> no server errors |

### 3.4 Session Management (`describe('Session management')`)

| Test | What it validates |
|------|-------------------|
| Create session via WS | Send `create_session` -> receive `session_created` with `sessionId` |
| Create session via REST | `POST /api/sessions/create` -> 200 with `sessionId` |
| List sessions | `GET /api/sessions/list` -> includes created session |
| Join existing session | Send `join_session` with valid ID -> receive `session_joined` with output buffer |
| Join non-existent session | Send `join_session` with bad ID -> receive `error` |
| Leave session | Send `leave_session` -> receive `session_left` |
| Delete session via REST | `DELETE /api/sessions/:id` -> 200, session gone from list |
| Delete non-existent session | `DELETE /api/sessions/bad-id` -> 404 |

### 3.5 Tool Session Lifecycle (`describe('Terminal tool session')`)

| Test | What it validates |
|------|-------------------|
| Start terminal session | Send `start_terminal` -> receive `terminal_started` |
| Terminal produces output | After start, receive `output` messages (shell prompt) |
| Send input, receive output | Send `echo hello` -> output contains `hello` |
| Resize terminal | Send `resize` with new cols/rows -> no error |
| Stop terminal session | Send `stop` -> receive `exit` message |
| Cannot start two tools in same session | Start terminal, then start terminal again -> receive `error` |
| Echo unique marker through terminal (cross-platform) | Start terminal -> drain initial output -> send `echo MARKER` -> verify marker in collected output -> stop |

### 3.6 Input/Output Round-Trip (`describe('I/O round-trip')`)

| Test | What it validates |
|------|-------------------|
| Echo command round-trip | Send `echo MARKER_STRING` -> output stream contains `MARKER_STRING` |
| Multi-line output | Send command producing multiple lines -> all lines received |
| Special characters | Send `echo "hello world & <test>"` -> output preserves content |
| Output buffer replay | Join session -> `session_joined` includes prior output in buffer |

### 3.7 Multi-Session (`describe('Multi-session management')`)

| Test | What it validates |
|------|-------------------|
| Create multiple sessions | Create 3 sessions -> list shows 3 |
| Sessions are isolated | Start terminal in session A, send input -> session B gets no output |
| Switch sessions | Leave session A, join session B -> receive B's buffer |
| Delete active session | Delete session with running terminal -> process stops, session removed |

---

## 4. Cross-Platform Considerations

### 4.1 Shell Differences

| Aspect | Linux/macOS | Windows |
|--------|-------------|---------|
| Default shell | bash/zsh | PowerShell/cmd |
| Echo command | `echo hello` | `echo hello` (works in both) |
| Line endings | `\n` | `\r\n` |
| Exit command | `exit` | `exit` |
| Prompt detection | `$` or `#` | `PS C:\>` or `>` |

The test suite uses `echo` for I/O validation, which works identically across shells. Output assertions use substring matching (`.includes()`) rather than exact string comparison to handle prompt/formatting differences.

### 4.2 CI Matrix

```yaml
# Example GitHub Actions matrix
strategy:
  matrix:
    os: [ubuntu-latest, windows-latest]
    node: [18, 20, 22]
```

### 4.3 Timeout Handling

PTY process startup varies by platform. Windows ConPTY is slower than Unix PTY. Tests use:
- 5s default message timeout
- 10s timeout for PTY output propagation
- 30s Mocha suite timeout

---

## 5. Future Enhancements

### 5.1 Browser E2E with Playwright (Tier 2)

When browser-level testing is needed:

```javascript
// Example Playwright test structure
test('terminal displays tool output', async ({ page }) => {
  await page.goto(`http://localhost:${port}?token=${authToken}`);

  // Wait for xterm.js canvas to render
  await page.waitForSelector('.xterm-screen canvas');

  // Read terminal content via xterm API
  const content = await page.evaluate(() => {
    const term = window.__terminal__;
    const buffer = term.buffer.active;
    let text = '';
    for (let i = 0; i < buffer.cursorY + 1; i++) {
      text += buffer.getLine(i).translateToString(true) + '\n';
    }
    return text;
  });

  expect(content).toContain('expected output');
});
```

### 5.2 Mock Tool Scripts

For testing specific tool bridge behaviors (trust prompts, dangerous mode flags):

```bash
#!/bin/bash
# test/fixtures/mock-claude.sh
echo "Claude Code v1.0.0 (mock)"
echo "Do you trust the files in this folder?"
read -r response
echo "Trust accepted: $response"
while IFS= read -r line; do
    echo "Assistant: I received '$line'"
done
```

### 5.3 Performance/Load Testing

- Concurrent WebSocket connections (50-100 simultaneous)
- Session creation throughput
- Output streaming latency under load
- Memory usage with many active PTY sessions

---

## 6. Dependencies

No new dependencies required.

| Package | Role | Status |
|---------|------|--------|
| `mocha` | Test runner | Already in devDependencies |
| `assert` | Assertions | Node.js built-in |
| `ws` | WebSocket client in tests | Already in dependencies |
| `http` | HTTP client for REST endpoints | Node.js built-in |
| `node-pty` | PTY spawning (via bridges) | Already in dependencies |
