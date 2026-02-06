# Testing and Validation

## Coverage Target

Target 90% code coverage for all new code. This is not optional for new features or refactors. Existing code without tests should be covered when modified.

## Test-Driven Approach

Write tests alongside implementation, not after. The workflow:

1. Write the test describing expected behavior
2. Implement the code to make the test pass
3. Refactor if needed, keeping tests green

## Test Framework

- **Framework**: Mocha with Node.js built-in `assert`
- **Location**: `test/` directory
- **Naming**: `name.test.js`
- **Running**: `npm test`

## Test Guidelines

- Write fast, isolated unit tests
- Avoid network calls and real CLI spawning in tests — mock process spawns
- Use temp directories for file system tests (see `session-store.test.js` pattern)
- Test cross-platform behavior: path construction, command resolution, shell detection

## Self-Validation

Before committing, every agent must:

1. Run `npm test` — all tests pass
2. Run `npm start` — server boots without errors
3. Run `scripts/validate.sh` (Linux) or `scripts/validate.ps1` (Windows)
4. Verify the change doesn't break existing functionality

## What to Test

### For Bridge Changes
- Command discovery on mock file systems
- Session lifecycle (start, input, resize, stop)
- Error handling (command not found, process crash)
- Platform-specific paths

### For Server Changes
- REST API responses (status codes, JSON structure)
- WebSocket message handling
- Session creation and deletion
- Auth middleware behavior

### For Client Changes
- Manual browser testing (create session, select tool, verify output)
- Check mobile responsiveness
- Verify WebSocket reconnection

## When Tests Fail

If tests fail, fix them before moving on. Do not:
- Skip failing tests
- Comment out assertions
- Reduce coverage to make the build pass
- Commit with known failures
