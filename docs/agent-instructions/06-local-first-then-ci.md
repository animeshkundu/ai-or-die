# Local-First, Then CI

This document covers the project's testing workflow at every layer — unit, server-integration, and end-to-end (E2E) — and how to use CI as the cross-platform verification gate. For the broader testing taxonomy (E2E, exploratory, manual device), see `docs/agent-instructions/02-testing-and-validation.md`.

## The rule

**Run all tests locally. When local is green, push. CI runs on GitHub Actions runners as the final cross-platform verification across Windows + Linux + clean-checkout `npm ci`.**

- **Local first.** Unit tests, server integration tests, and the relevant E2E spec(s) for the surface you changed must pass on your machine before you push. "It compiles" or "the unit tests pass" is not enough; the e2e scenario covering your change must run green locally.
- **CI is the merge gate.** The branch only merges when CI is green on both `ubuntu-latest` and `windows-latest`. CI catches platform-specific bugs (Windows path separators, ConPTY differences, line-ending issues) and environment-specific regressions (clean-checkout `npm ci` vs your incrementally-updated `node_modules`, slow-CDN behaviour, Playwright version drift) that local cannot.
- **Local-pass is necessary but not sufficient.** A bug that escapes both your local run AND CI is a real bug class — but a bug that local would have caught and you skipped past is wasted CI cycles and a slower team.

## Why both layers

The previous "CI-only" rule (every test runs only on the GitHub runner; local checks are forbidden) optimised for one thing: eliminating "works on my machine" disagreements. It traded that against three real costs that surfaced repeatedly:

1. **Hidden bugs that local would have caught instantly.** During the `feat/file-browser-monaco` PR a missing `_renderTextContent` markdown branch (engineer's `bd82802` fix-up) silently fell through to the Monaco code preview path; every markdown preview was broken in production. A 30-second `clickFile('vanilla.md')` against `npm run dev` would have surfaced it before any push. So would a `npx playwright test e2e/tests/16-…spec.js`.
2. **Lockfile / dependency drift caught by `npm ci` in CI but not in `npm install` locally.** `001e600` regenerated `package-lock.json` after a `jsdom` devDep was added without a lockfile bump — CI's clean-checkout `npm ci` failed where a developer's incremental `npm install` happily picked up the new dep. Running `rm -rf node_modules && npm ci` locally before push would have caught it.
3. **CI feedback loop is slow.** Each push → draft PR → CI cycle is 5-7 minutes on a green run, and 10-15 minutes when failures need artifact download + diagnosis. A local run of the same scenario is sub-second to seconds. Iteration that fits in the local loop ships hours faster.

The combination — local first, CI second — keeps the "works on my machine" guarantee (because CI on a clean Linux + Windows runner remains the merge gate) while reclaiming the local feedback loop for everything else.

## Workflow

```
Write code
    |
    v
Run unit tests:        npm test
    |
    v
Run integration tests: npm run test:integration  (if relevant)
    |
    v
Run e2e for your change:
  npx playwright test e2e/tests/<your-spec>.spec.js
    |
    v
All local green? --> push
    |                      |
    v (if local red)       v
fix locally,           open draft PR (triggers CI on push)
re-run, repeat             |
                           v
                       wait ~5-7 min for CI
                           |
                           v
                       all green? --> ready for review
                           |
                           v (if red)
                       download failure artifacts,
                       reproduce locally if possible,
                       fix, push, repeat
```

Use `gh pr create --draft` to trigger CI without requesting review. Use `gh run watch` to monitor CI from the terminal.

## Local commands

| Goal | Command | Notes |
|---|---|---|
| Unit tests (mocha) | `npm test` | Runs `test/*.test.js`. Sub-second to seconds for the full suite. |
| Single unit file | `npx mocha --reporter min test/<file>.test.js` | For tight iteration on one file. |
| Lint / syntax check | `node --check <file.js>` | Cheapest sanity check; catches typos before any test run. |
| Single e2e spec | `npx playwright test e2e/tests/<spec>.spec.js` | Runs ONE spec; full suite is slow locally. |
| Single e2e scenario | `npx playwright test e2e/tests/<spec>.spec.js --grep "<scenario name>"` | Faster iteration when narrowing a failure. |
| E2e with debug UI | `npx playwright test ... --headed --debug` | Step through with the inspector; only do this when you need the visual. |
| Clean-room dependency check | `rm -rf node_modules && npm ci` | Mimics what CI does on every push. Run before pushing if you've touched `package.json` / `package-lock.json`. |
| Dev server | `npm run dev` | Starts the app; use to manually exercise UI changes. |

**Ports:** every test that spins up a server uses `createServer({ port: 0, ... })` — kernel-assigned high port (always > 11000 in practice). **Never use port 7777 in tests.** The dev server defaults to port 7777 for the developer; tests must avoid it so they don't conflict with a running dev session.

## Long e2e waits indicate bugs

If an e2e test requires long waits or generous timeouts to pass, that is a signal of a bug in the product code, not a test timing issue. No real user is going to wait 30 seconds for a terminal to respond or 10 seconds for a WebSocket to connect. If the test needs that much patience, the code is too slow and must be fixed. Tightening test timeouts is a legitimate way to catch performance regressions — the test should reflect realistic user expectations, not compensate for sluggish code.

## CI: the cross-platform verification layer

CI is the second gate. It runs the same suites you ran locally, but on:

- **`ubuntu-latest`** AND **`windows-latest`** in parallel (every job, both platforms).
- A **clean checkout** with `npm ci` from the lockfile — no `node_modules` carry-over.
- The **upstream Playwright browsers** at the version your `package-lock.json` pins.
- A **headless** environment with no GPU, no native window manager, and no jit-warmed V8 heap.

Things CI catches that local doesn't:

- **Windows-specific path handling.** Forward-slash vs backslash separators, drive-letter resolution (`C:\` vs `/`), `realpath()` symlink behaviour. Always test on Windows for any code that touches paths.
- **`npm ci` lockfile drift.** A new dep without a lockfile bump fails CI's clean install but passes your local incremental `npm install`.
- **Cold-start / network-dependent timing.** Slow CDN fetches, cold V8 heap startup, or bundler cache misses can expose race conditions that local's warm cache hides.
- **Test isolation issues.** When a test leaks state into another (a stray timer, an unclosed server), parallel CI workers surface it; sequential local runs may not.
- **Native-module compilation differences.** `@lydell/node-pty` and similar may compile differently on the runner's compiler version vs your local toolchain.

When local is green and CI is red, the bug is real — read the failure artifacts and reproduce.

## CI job map

The CI pipeline is defined in `.github/workflows/ci.yml`. Jobs run in parallel, each on both `ubuntu-latest` and `windows-latest`:

| Job | What it tests | Playwright project | Tests |
|---|---|---|---|
| `test` | Unit tests (mocha) | N/A | `test/*.test.js` |
| `test-browser-golden` | Fresh user flow with real CLI | `golden-path` | `01-golden-path.spec.js` |
| `test-browser-functional-core` | Core terminal features | `functional-core` | `02-terminal-io`, `03-clipboard`, `04-context-menu`, `05-tab-switching` |
| `test-browser-functional-extended` | Extended features | `functional-extended` | `06-large-paste`, `07-vim-and-session`, `09-image-paste`, `09-background-notifications` |
| `test-browser-mobile` | Mobile viewport behaviour | `mobile-iphone`, `mobile-pixel` | `08-mobile-portrait.spec.js` |
| `test-browser-visual` | Screenshot regression | `visual-regression` | `09-visual-regression.spec.js` |
| `test-browser-new-features` | Latest features (10-14) | `new-features` | `10-command-palette` through `14-nerd-font-rendering` |
| `test-browser-integrations` | File-browser rich viewers + search | (see `playwright.config.js`) | `15-file-browser-rich-viewers`, `16-file-browser-rich-viewers-ui` |
| `build-binary` | SEA binary build + smoke test | N/A | `scripts/smoke-test-binary.js` |

Total: 16+ parallel job executions (8+ job types × 2 platforms). All must pass for green CI.

### Playwright project configuration

The Playwright config at `e2e/playwright.config.js` defines how test files map to projects:

- `golden-path` matches `01-golden-path.spec.js`
- `functional-core` matches `/0[2-5]-.*\.spec\.js/`
- `functional-extended` matches `/0[6-7]-.*\.spec\.js|09-image-paste\.spec\.js|09-background-.*\.spec\.js/`
- `mobile-iphone` and `mobile-pixel` both match `08-mobile-portrait.spec.js` (with device-specific viewports)
- `visual-regression` matches `09-visual-regression.spec.js`
- `new-features` matches `/1[0-4]-.*\.spec\.js/`
- File-browser rich-viewer specs (`15-`, `16-`) are matched by their respective project configs.

## Reading CI failures

When CI fails:

1. **Go to the Actions tab** on the PR. Find the failed run.
2. **Identify the failing job.** Note the platform (ubuntu vs windows).
3. **Read the job log.** Expand the failed step, look for the error message.
4. **Try to reproduce locally.** If it's deterministic, you'll catch it on a `npx playwright test ...` run. If it's CI-only (genuine platform-specific or `npm ci`-only), download the artifacts.
5. **Download artifacts.** Each browser test job uploads on failure:
   - `playwright-{job}-{os}.zip` — test results, screenshots, traces
   - `screenshot-baselines-{os}` — visual regression baselines (visual job only)
   - `screenshot-diffs-{os}` — visual diff images (visual job only, on failure)

### What the artifacts contain

- **Screenshots:** captured on failure — shows what the browser actually rendered.
- **Traces:** Playwright trace files — DOM snapshots, network requests, console logs at each test step (captured on first retry via `trace: 'on-first-retry'`).
- **Terminal buffer:** the xterm.js buffer content at failure time.
- **WebSocket logs:** messages exchanged between client and server.
- **Console logs:** browser console output captured by `setupPageCapture()`.

### Platform-specific failure signatures

- **Fails on Windows only:** usually path handling (`\\` vs `/`), shell command differences (`where` vs `which`), ConPTY buffering, or line-ending issues.
- **Fails on Linux only:** usually permission issues, case-sensitive file names, or missing system dependencies.
- **Fails on both:** real bug in application logic — but probably also fails locally; reproduce there first.
- **Fails on CI but green locally:** suspect `npm ci` lockfile drift, cold-start timing, headless browser quirks, or test isolation across parallel workers.

## Using Playwright traces

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

This is the most powerful debugging tool available. Use it whenever a CI failure isn't obvious from the screenshot alone.

## Check history before debugging

Before investigating any failure (local or CI), check `docs/history/` for known issues and prior solutions. The problem may already be solved. If it's new, document the solution after fixing (see `07-docs-hygiene.md` for format).

## E2E tests as debugging tools

E2E tests serve dual purpose: validation and documentation.

### Understanding expected behaviour

Each spec file demonstrates how a feature should work. Before modifying a feature, read its test first — it shows the intended behaviour more precisely than any spec document.

### When a test fails, consider both sides

A failing test means something is wrong, but the bug could live in either place:

- **Product code bug** — the code doesn't work as intended. Fix the code, not the test (see ADR-0006).
- **Test mistake** — the test has incorrect assertions, wrong selectors, bad timing, or flawed assumptions about expected behaviour.

Always investigate both possibilities before committing a fix. Read the test carefully — does it actually test the right thing? Then read the product code — does it actually do what the spec says? Fixing the wrong side creates a false sense of security.

### Reproducing bugs

1. Find the closest existing test to the reported behaviour.
2. Modify it (or add a new test case) to reproduce the issue locally.
3. Confirm the test fails for the right reason.
4. Determine whether the bug is in the code or the test.
5. Fix the correct side.
6. Re-run locally — test passes.
7. Push — CI confirms the fix on both platforms.

### Adding regression tests

Every bug fix must include an E2E or unit test that would have caught the bug. This prevents regression and documents the fix for future agents.

## Creating new e2e tests

### Naming convention

Tests are numbered by category:

- `01-*` — Golden path (fresh user flow)
- `02-05` — Core functional features (functional-core project)
- `06-07` — Extended functional features (functional-extended project)
- `08-*` — Mobile-specific
- `09-*` — Cross-cutting: `09-image-paste` and `09-background-notifications` in functional-extended, `09-visual-regression` in visual-regression project
- `10-14` — New features (`new-features` project)
- `15+` — File-browser rich viewers and beyond

Add new tests with the next available number in the appropriate range. If you need to extend a project's regex (e.g. adding `15+`), update both `e2e/playwright.config.js` and `.github/workflows/ci.yml`.

### Test structure

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

### Available helpers

From `e2e/helpers/terminal-helpers.js`:

- `waitForAppReady(page)` — wait for app to fully initialise.
- `waitForTerminalCanvas(page)` — wait for xterm.js container to render.
- `focusTerminal(page)` — focus the terminal textarea for keyboard input.
- `typeInTerminal(page, text)` — type text into the terminal with per-character delay.
- `pressKey(page, key)` — press a key or key combination (e.g. `'Enter'`, `'Control+c'`).
- `readTerminalContent(page)` — read current terminal buffer via xterm.js API.
- `waitForTerminalText(page, text, timeout)` — wait for specific text in the terminal.
- `getTerminalDimensions(page)` — get terminal cols and rows.
- `setupPageCapture(page)` — capture WebSocket messages and console logs (call before `page.goto()`).
- `attachFailureArtifacts(page, testInfo)` — attach debug artifacts on test failure (call in `afterEach`).
- `waitForWebSocket(page)` — wait for WebSocket connection to open.
- `joinSessionAndStartTerminal(page, sessionId)` — full session setup.

From `e2e/helpers/server-factory.js`:

- `createServer()` — start a test server instance, returns `{ server, port, url }` (port 0 → kernel-assigned high port).
- `createSessionViaApi(port, name)` — create a session via REST API, returns sessionId.

### Registering in Playwright config

Add new tests to the appropriate project in `e2e/playwright.config.js` by updating the `testMatch` pattern. Then update the corresponding CI job in `.github/workflows/ci.yml` if the new test does not already match an existing project regex.

## Performance budget: 5-minute target, 7-minute max

The entire CI pipeline must complete within 5 minutes wall-clock time. 7 minutes is the absolute maximum acceptable. The per-job timeout is 9 minutes as a safety net for runner queue delays, but any job consistently hitting 7+ minutes must be investigated and optimised.

To hit this budget:

- **Parallelise aggressively.** All independent Playwright projects run in separate parallel jobs. Never run projects sequentially within a single job unless they share expensive state.
- **Minimise setup overhead.** Each CI job spends 2-3 minutes on checkout, `npm ci`, and Playwright install. Consolidate small test projects into fewer jobs to reduce redundant setup.
- **No unnecessary dependencies.** Do not add `needs:` between jobs unless one job consumes artifacts from another. Unit tests and browser tests run in parallel from the start.
- **Increase Playwright workers.** Use `--workers=2` or more within each job for parallel test execution.

When adding new e2e tests, verify the pipeline still completes under 5 minutes. If it doesn't, split the slowest job or consolidate the smallest ones.

## Notes on related rules

- **CLAUDE.md rule 5** is the canonical short-form of this policy: "Local-first testing; CI as cross-platform verification."
- **ADR-0015 (autonomous factory protocol)** documents a "local quality gates" pattern for the autonomous factory context. Under the new local-first-then-CI rule, the factory's local-only quality gates remain valid — they are now consistent with the project default rather than an explicit override. ADR-0015's wording about "overriding the CI-first mandate" is historical; the substantive guidance (which gates the factory runs locally) still applies.
