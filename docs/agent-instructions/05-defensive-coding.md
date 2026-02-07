# Defensive Coding

## Validate at Boundaries

Trust nothing that crosses a system boundary. Every REST endpoint, WebSocket handler, and bridge method should validate its inputs before processing.

Where boundaries exist in this codebase:

- REST API handlers in `src/server.js` -- validate request params, body, headers
- WebSocket message handlers -- validate `type` field, required fields per message type
- Bridge methods (`startSession`, `sendInput`, `resize`) -- validate sessionId exists, dimensions are positive integers
- Client-to-server messages -- validate session ownership, check session is active

Pattern:

```javascript
// Bad
handleMessage(wsId, message) {
  const session = this.sessions.get(message.sessionId);
  session.bridge.sendInput(message.data); // crashes if session doesn't exist
}

// Good
handleMessage(wsId, message) {
  if (!message.sessionId) {
    return this.sendError(wsId, 'Missing sessionId');
  }
  const session = this.sessions.get(message.sessionId);
  if (!session) {
    return this.sendError(wsId, `Session '${message.sessionId}' not found`);
  }
  if (!session.active) {
    return this.sendError(wsId, `Session '${message.sessionId}' is not active`);
  }
  session.bridge.sendInput(message.data);
}
```

## Error Messages Are UI

Error messages are read by other agents trying to debug. Make them actionable.

Every error message should answer three questions:

1. What went wrong?
2. What was expected?
3. What should be done about it?

```javascript
// Bad
throw new Error('Invalid');
throw new Error('Not found');
throw new Error('Failed');

// Good
throw new Error(`Session '${sessionId}' not found. Available sessions: [${[...sessions.keys()].join(', ')}]`);
throw new Error(`Bridge '${toolId}' is not available. Run 'which ${command}' to verify installation. Searched paths: ${searchPaths.join(', ')}`);
throw new Error(`WebSocket message missing required field 'type'. Received: ${JSON.stringify(message)}`);
```

## Cross-Platform Landmines

This codebase runs on both Windows and Linux. Every line of code that touches the filesystem, spawns a process, or handles paths must account for both.

### Paths

- ALWAYS use `path.join()`, never string concatenation with `/` or `\\`
- Use `os.homedir()`, never `process.env.HOME` (undefined on Windows)
- File paths are case-insensitive on Windows, case-sensitive on Linux
- Use `path.resolve()` to normalize paths before comparison

### Process Spawning

- `where` on Windows, `which` on Linux -- check `process.platform`
- Windows uses ConPTY, Linux uses standard PTY -- different buffering behavior
- Executable extensions: `.exe`, `.cmd` on Windows, none on Linux
- Shell: `cmd.exe` or `powershell.exe` on Windows, `bash` or `sh` on Linux

### Line Endings

- Never match output with exact strings -- use `.includes()` or `.trim()`
- Windows may inject `\r\n` where Linux gives `\n`
- PTY output may contain ANSI escape sequences -- strip them before comparing

### The ConPTY Quirks

- Writes larger than 4096 bytes can overflow the ConPTY buffer on Windows
- Solution: chunked writes with delays (see `base-bridge.js` chunked write pattern)
- ConPTY may echo input back -- don't assume output is only from the spawned process

## Async Safety

Node.js is async-first. Unhandled promise rejections crash the process.

Rules:

- Every `async` function must have try-catch at the top level
- Every `.then()` chain must have a `.catch()`
- Event handlers that call async code must wrap in try-catch
- Use the spawn watchdog pattern from `base-bridge.js`: set a timer when spawning a process, kill it if no output arrives within 30 seconds

```javascript
// Bad -- unhandled rejection if startSession throws
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  this.startSession(msg.sessionId);
});

// Good
ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data);
    this.startSession(msg.sessionId).catch(err => {
      console.error(`Failed to start session ${msg.sessionId}:`, err);
      this.sendError(wsId, err.message);
    });
  } catch (err) {
    console.error('Failed to parse WebSocket message:', err);
  }
});
```

## Fail Fast, Fail Loud

Silent failures are the worst kind. They create bugs that surface hours or sessions later, with no trail.

- Assert preconditions at function entry -- don't wait until line 50 to discover the input was invalid
- Log errors with full context before re-throwing: what function, what inputs, what state
- Never `catch` and silently swallow: `catch (err) { /* ignore */ }` -- this is forbidden
- If something "shouldn't happen," make it throw, not silently return null

```javascript
// Bad -- silent null propagation
function getSession(id) {
  return sessions.get(id); // returns undefined silently
}

// Good -- fail fast with context
function getSession(id) {
  const session = sessions.get(id);
  if (!session) {
    throw new Error(`getSession: no session with id '${id}'. Active sessions: ${sessions.size}`);
  }
  return session;
}
```

## The "Fresh Machine" Test

Before considering any code complete, ask yourself: "Would this work on a brand new GitHub Actions runner with nothing pre-installed except Node.js 22?"

This means:

- No reliance on globally installed tools (unless you check for them and give a clear error)
- No hardcoded paths that only exist on your dev machine
- No cached `node_modules` assumptions -- `npm ci` installs from scratch
- No file system state left over from previous runs
- No environment variables that aren't set in CI

If the answer is "maybe," add a runtime check:

```javascript
const commandPath = await this.findCommandAsync();
if (!commandPath) {
  throw new Error(
    `${this.toolName} CLI not found. Searched: ${this.searchPaths.join(', ')}. ` +
    `Install ${this.toolName} or add it to PATH.`
  );
}
```
