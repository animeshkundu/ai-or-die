# CI-First Testing

This document covers Tier 1 (True E2E Tests) of the project's testing hierarchy. E2E tests on CI are the source of truth for regression. For the full three-tier testing hierarchy — E2E, Copilot agent exploratory testing, and manual device testing — see `docs/agent-instructions/02-testing-and-validation.md`.

## E2E Tests Are the Source of Truth

End-to-end tests are the only true way to validate that the system works. Unit tests verify isolated logic. E2E tests prove the whole system -- server, WebSocket, terminal, browser UI -- actually functions as a user would experience it.

A feature is not done until its E2E tests pass on GitHub runners. If unit tests pass but E2E fails, the feature is broken. Period. No exceptions. No "it works on my machine." The GitHub runner is the only machine that matters.

Every new feature must have E2E test coverage. Every bug fix must have a regression E2E test. The E2E suite is the contract that tells the next agent "this is what working looks like."

### Long E2E waits indicate bugs

If an E2E test requires long waits or generous timeouts to pass, that is a signal of a bug in the product code, not a test timing issue. No real user is going to wait 30 seconds for a terminal to respond or 10 seconds for a WebSocket to connect. If the test needs that much patience, the code is too slow and must be fixed. Tightening test timeouts is a legitimate way to catch performance regressions -- the test should reflect realistic user expectations, not compensate for sluggish code.

## The Rule: CI Only

CI is the only authority on whether code works. Never consider a feature done based on local results alone.

Why:

- Local environments accumulate stale state, cached modules, and leftover config
- Native modules like `@lydell/node-pty` may not compile correctly locally
- Playwright browsers may be outdated or misconfigured locally
- Local testing only proves it works on one machine, one platform
- CI runs on both ubuntu-latest AND windows-latest -- that is the real test
- CI gives fresh, reproducible, cross-platform results every single time

You may run quick local checks for rapid iteration (e.g., syntax checks, single-file linting), but a feature is not done until CI passes. The GitHub runner is the only environment whose results count.

## The Workflow

```
Write code
    |
    v
Push to branch
    |
    v
Open draft PR (triggers CI automatically)
    |
    v
Wait for CI results (~5-7 minutes)
    |
    v
Read results: all green? --> Done
    |
    v (if red)
Download failure artifacts
    |
    v
Read traces, screenshots, terminal buffers
    |
    v
Fix the issue
    |
    v
Push again --> CI runs again --> repeat until green
```

Use `gh pr create --draft` to trigger CI without requesting review. Use `gh run watch` to monitor CI progress from the terminal.

## CI Job Map

The CI pipeline is defined in `.github/workflows/ci.yml`. It runs these jobs in parallel, each on both ubuntu-latest and windows-latest:

| Job | What it tests | Playwright Project | Tests |
|-----|--------------|-------------------|-------|
| `test` | Unit tests (Mocha) | N/A | `test/*.test.js` |
| `test-browser-golden` | Fresh user flow with real CLI | `golden-path` | `01-golden-path.spec.js` |
| `test-browser-functional-core` | Core terminal features | `functional-core` | `02-terminal-io`, `03-clipboard`, `04-context-menu`, `05-tab-switching` |
| `test-browser-functional-extended` | Extended features | `functional-extended` | `06-large-paste`, `07-vim-and-session`, `09-image-paste`, `09-background-notifications` |
| `test-browser-mobile` | Mobile viewport behavior | `mobile-iphone`, `mobile-pixel` | `08-mobile-portrait.spec.js` |
| `test-browser-visual` | Screenshot regression | `visual-regression` | `09-visual-regression.spec.js` |
| `test-browser-new-features` | Latest features | `new-features` | `10-command-palette` through `14-nerd-font-rendering` |
| `build-binary` | SEA binary build + smoke test | N/A | `scripts/smoke-test-binary.js` |

Total: 16 parallel job executions (8 job types x 2 platforms). All must pass for a green CI.

### Playwright Project Configuration

The Playwright config at `e2e/playwright.config.js` defines how test files map to projects:

- `golden-path` matches `01-golden-path.spec.js`
- `functional-core` matches `/0[2-5]-.*\.spec\.js/`
- `functional-extended` matches `/0[6-7]-.*\.spec\.js|09-image-paste\.spec\.js|09-background-.*\.spec\.js/`
- `mobile-iphone` and `mobile-pixel` both match `08-mobile-portrait.spec.js` (with device-specific viewports)
- `visual-regression` matches `09-visual-regression.spec.js`
- `new-features` matches `/1[0-4]-.*\.spec\.js/`

## Reading CI Failures

When CI fails:

1. **Go to the Actions tab** on the PR. Find the failed run.
2. **Identify the failing job.** Note which platform (ubuntu vs windows).
3. **Read the job log.** Expand the failed step, look for the error message.
4. **Download artifacts.** Each browser test job uploads artifacts on failure:
   - `playwright-{job}-{os}.zip` -- contains test results, screenshots, traces
   - `screenshot-baselines-{os}` -- visual regression baselines (visual job only)
   - `screenshot-diffs-{os}` -- visual diff images (visual job only, on failure)

### What the artifacts contain

- **Screenshots**: Captured on failure -- shows what the browser actually rendered
- **Traces**: Playwright trace files -- DOM snapshots, network requests, console logs at each test step (captured on first retry via `trace: 'on-first-retry'`)
- **Terminal buffer**: The xterm.js buffer content at failure time -- shows what the terminal displayed
- **WebSocket logs**: Messages exchanged between client and server
- **Console logs**: Browser console output captured by `setupPageCapture()`

### Platform-specific failures

- **Fails on Windows only**: Usually path handling (`\\` vs `/`), shell command differences (`where` vs `which`), ConPTY buffering, or line ending issues
- **Fails on Linux only**: Usually permission issues, case-sensitive file names, or missing system dependencies
- **Fails on both**: Real bug in application logic

## Using Playwright Traces

Download the trace from CI artifacts and view it:

```bash
# Download artifacts (use gh CLI)
gh run download <run-id> -n playwright-functional-core-ubuntu-latest

# View trace in browser
npx playwright show-trace e2e/test-results/path-to-trace.zip
```

The trace viewer shows:

- Step-by-step test execution with timestamps
- DOM snapshot at each step (inspectable)
- Network requests and responses
- Console log entries
- Screenshots before and after each action

This is the most powerful debugging tool available. Use it.

## Check History Before Debugging

Before investigating any CI failure, check `docs/history/` for known issues and prior solutions. The problem may already be solved. If it's new, document the solution after fixing (see `07-docs-hygiene.md` for format).

## E2E Tests as Debugging Tools

E2E tests serve dual purpose: validation and documentation.

### Understanding expected behavior

Each spec file demonstrates how a feature should work. Before modifying a feature, read its test first -- it shows the intended behavior more precisely than any spec document.

### When a test fails, consider both sides

A failing test means something is wrong, but the bug could live in either place:

- **Product code bug** -- The code doesn't work as intended. Fix the code, not the test (see ADR-0006).
- **Test mistake** -- The test has incorrect assertions, wrong selectors, bad timing, or flawed assumptions about expected behavior.

Always investigate both possibilities before committing a fix. Read the test carefully -- does it actually test the right thing? Then read the product code -- does it actually do what the spec says? Fixing the wrong side creates a false sense of security.

### Reproducing bugs

1. Find the closest existing test to the reported behavior
2. Modify it (or add a new test case) to reproduce the issue
3. Push to CI -- if the test fails, you have confirmed the bug
4. Determine whether the bug is in the code or the test
5. Fix the correct side
6. Push again -- test should pass, confirming the fix

### Adding regression tests

Every bug fix must include an E2E test that would have caught the bug. This prevents regression and documents the fix for future agents.

## Creating New E2E Tests

### Naming Convention

Tests are numbered by category:

- `01-*` -- Golden path (fresh user flow)
- `02-05` -- Core functional features (functional-core project)
- `06-07` -- Extended functional features (functional-extended project)
- `08-*` -- Mobile-specific
- `09-*` -- Cross-cutting: `09-image-paste` and `09-background-notifications` in functional-extended, `09-visual-regression` in visual-regression project
- `10-14` -- New features

Add new tests with the next available number in the appropriate range. Currently the highest number is `14-nerd-font-rendering.spec.js`.

### Test Structure

```javascript
const { test, expect } = require('@playwright/test');
const { createServer, createSessionViaApi } = require('../helpers/server-factory');
const {
  waitForAppReady,
  waitForTerminalCanvas,
  typeInTerminal,
  waitForTerminalText,
  setupPageCapture,
  attachFailureArtifacts,
  joinSessionAndStartTerminal,
} = require('../helpers/terminal-helpers');

test.describe('Feature Name', () => {
  let server, port, url;

  test.beforeAll(async () => {
    ({ server, port, url } = await createServer());
  });

  test.afterAll(async () => {
    if (server) server.close();
  });

  test.afterEach(async ({ page }, testInfo) => {
    await attachFailureArtifacts(page, testInfo);
  });

  test('should do the expected thing', async ({ page }) => {
    setupPageCapture(page);
    const sessionId = await createSessionViaApi(port, `Test_${Date.now()}`);
    await page.goto(url);
    await waitForAppReady(page);
    await waitForTerminalCanvas(page);
    await joinSessionAndStartTerminal(page, sessionId);
    // ... test logic using terminal helpers
  });
});
```

### Available Helpers

From `e2e/helpers/terminal-helpers.js`:

- `waitForAppReady(page)` -- Wait for app to fully initialize
- `waitForTerminalCanvas(page)` -- Wait for xterm.js container to render
- `focusTerminal(page)` -- Focus the terminal textarea for keyboard input
- `typeInTerminal(page, text)` -- Type text into the terminal with per-character delay
- `pressKey(page, key)` -- Press a key or key combination (e.g. `'Enter'`, `'Control+c'`)
- `readTerminalContent(page)` -- Read current terminal buffer via xterm.js API
- `waitForTerminalText(page, text, timeout)` -- Wait for specific text to appear in terminal
- `getTerminalDimensions(page)` -- Get terminal cols and rows
- `setupPageCapture(page)` -- Capture WebSocket messages and console logs (call before `page.goto()`)
- `attachFailureArtifacts(page, testInfo)` -- Attach debug artifacts on test failure (call in `afterEach`)
- `waitForWebSocket(page)` -- Wait for WebSocket connection to be open
- `joinSessionAndStartTerminal(page, sessionId)` -- Full session setup: join session and start terminal tool

From `e2e/helpers/server-factory.js`:

- `createServer()` -- Start a test server instance, returns `{ server, port, url }`
- `createSessionViaApi(port, name)` -- Create a session via REST API, returns sessionId

### Registering in Playwright Config

Add new tests to the appropriate project in `e2e/playwright.config.js` by updating the `testMatch` pattern. Then update the corresponding CI job in `.github/workflows/ci.yml` if the new test does not already match an existing project regex.

For new feature tests numbered 10-14, they automatically match the `new-features` project regex `/1[0-4]-.*\.spec\.js/`. If you need number 15+, update the regex.

## Performance Budget

No single CI job should take more than 7 minutes. This is a hard limit.

Fast CI feedback is critical for the push-fix-push workflow. If a job exceeds 7 minutes:

1. Check if the job has too many tests -- split into sub-groups
2. Check for tests with excessive waits or timeouts that could be tightened
3. Consider splitting the job into multiple CI matrix entries
4. Open an issue to track and fix the performance regression

Monitor job times after adding new E2E tests. Growth is expected, but the 7-minute budget must hold.
